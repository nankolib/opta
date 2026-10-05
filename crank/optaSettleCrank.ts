// ============================================================================
// crank/optaSettleCrank.ts -- settle lane for ORACLE_SOURCE_OPTA markets
// ============================================================================
//
// settle_expiry's first-party arm has no history to read: it persists the
// CURRENT feed price, and only if
//
//     now >= expiry,  now - expiry <= 300 s,  feed.publish_time >= expiry
//
// (settle_expiry.rs, opta_price_read.rs). The window is shorter than the
// settle/finalize tick, which comes round about every six minutes, so a tuple
// on a source-2 market cannot be settled from that loop. Until 2026-09-28 it
// was not settled at all: it was routed to the Pyth builder (ops ledger 66).
//
// This lane is keyed on expiry timestamps, not on a poll:
//
//   discover   every DISCOVERY_INTERVAL_SECS, by its own scan of the chain
//              (never the shared account cache), list every tuple on a
//              source-2 market that still has a live vault
//   wake       at the tuple's expiry, on cluster time
//   poll       the feed account until it carries a push with
//              publish_time >= expiry
//   send       on first sight of that push; retry inside the window
//   stop       at expiry + 300 s: the tuple is dead-feed, logged once, and
//              never attempted again (reclaim voids it after the grace)
//
// Idempotent by state: a SettlementRecord that exists is success, whoever
// wrote it. It is read before every send and after every failure.
//
// The instruction is ported from the ceremony tool that settled BTC on
// 2026-09-19 (opta-ops l3-btc/l3-settle.js, ledger 41): same account list, and
// the record seed read from the IDL's own PDA spec.
//
// WHAT IT DOES NOT DO: settle_vault. Leg 2 reads no oracle and stays with the
// fan-out in bot.ts, which asks only whether a record exists.
//
// Flags: OPTA_SETTLE_OPTA_ENABLED=1 spawns it from bot.ts (default OFF);
//        OPTA_SETTLE_OPTA_DRY_RUN=0 lets it send (default dry-run).
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, PublicKey, ComputeBudgetProgram, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { MARKET_SEED } from "@app/utils/constants";
import { feedPdaFor, type FeedSnapshot } from "./optaVolCrank";
import { routeForSource, isLiveVault, expiryOf, type AccountRecord } from "./settleRouting";

/** Carried on the crank's boot line so the deployed generation is assertable
 *  from the journal alone. */
export const OPTA_SETTLE_MARKER = "source2-settle-v1";
/** Mirrors SB_SETTLE_WINDOW_SECS (settle_expiry.rs), which the first-party arm shares. */
export const SETTLE_WINDOW_SECS = 300;
/** Re-scan cadence. Below five minutes, so with the idle sleep cap a new tuple
 *  is seen within five minutes of its creation. */
export const DISCOVERY_INTERVAL_SECS = 240;
export const FEED_POLL_MS = 2_000;
export const RETRY_MIN_MS = 5_000;
export const IDLE_MAX_MS = 30_000;
export const SETTLE_CU_LIMIT = 200_000;

export type OptaSettleLogLevel = "debug" | "info" | "warn" | "error";
export type OptaSettleLogger = (level: OptaSettleLogLevel, msg: string, fields?: Record<string, unknown>) => void;

export interface OptaSettleContext {
  programId: PublicKey;
  /** The ordinary crank wallet. settle_expiry is permissionless; the caller pays the record rent. */
  caller: PublicKey;
  dryRun: boolean;
  log: OptaSettleLogger;
  shouldShutdown: () => boolean;
}

export interface Source2Tuple {
  /** `${asset}:${expiry}` */
  key: string;
  asset: string;
  expiry: number;
  market: PublicKey;
  feedBytes: number[];
  liveVaults: number;
}

export interface RecordSnapshot {
  asset: string;
  expiry: number;
  price6dec: bigint;
  settledAt: number;
  /** The record's `pyth_publish_time` slot: for this arm, the feed's publish_time. */
  publishTime: number;
}

export interface SettleSendResult { sig: string; slot: number; blockTime: number | null }

/** Everything the lane touches outside its own logic. Injected for tests. */
export interface OptaSettleDeps {
  scan: () => Promise<{ markets: AccountRecord[]; vaults: AccountRecord[]; undecodable: number }>;
  clusterNow: () => Promise<number>;
  fetchFeed: (t: Source2Tuple) => Promise<FeedSnapshot | null>;
  fetchRecord: (t: Source2Tuple) => Promise<RecordSnapshot | null>;
  sendSettle: (t: Source2Tuple) => Promise<SettleSendResult>;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
}

// ---- pure decisions -------------------------------------------------------------

export type TuplePhase = "pending" | "in-window" | "past-window";

export function phaseOf(expiry: number, nowSecs: number, windowSecs = SETTLE_WINDOW_SECS): TuplePhase {
  if (nowSecs < expiry) return "pending";
  return nowSecs - expiry <= windowSecs ? "in-window" : "past-window";
}

export type SettleSendDecision =
  | { send: true }
  | { send: false; reason: "pre-expiry" | "window-elapsed" | "no-feed" | "no-post-expiry-push" };

/** The send gate. Inside the window the only condition is that the feed account
 *  carries a push published at or after expiry. There is no time floor: the
 *  program has none, and the push is what makes the price a settlement price. */
export function decideSettleSend(
  feed: { publishTime: number } | null,
  expiry: number,
  nowSecs: number,
  windowSecs = SETTLE_WINDOW_SECS,
): SettleSendDecision {
  const phase = phaseOf(expiry, nowSecs, windowSecs);
  if (phase === "pending") return { send: false, reason: "pre-expiry" };
  if (phase === "past-window") return { send: false, reason: "window-elapsed" };
  if (!feed) return { send: false, reason: "no-feed" };
  if (feed.publishTime < expiry) return { send: false, reason: "no-post-expiry-push" };
  return { send: true };
}

export function marketPdaFor(programId: PublicKey, asset: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from(asset)], programId)[0];
}

/**
 * Every tuple on a source-2 market that still has a live vault, whatever its
 * expiry. The phase is decided later against cluster time.
 *
 * A market is taken only if its address is the PDA of its own asset name: the
 * name goes into the instruction and into the record seed, and a legacy account
 * decoded as garbage must not reach either.
 */
export function enumerateSource2Tuples(
  programId: PublicKey,
  vaults: AccountRecord[],
  markets: AccountRecord[],
): { tuples: Source2Tuple[]; source2Markets: number; refusedMarkets: number } {
  const byPda = new Map<string, { asset: string; market: PublicKey; feedBytes: number[] }>();
  let refusedMarkets = 0;
  for (const m of markets) {
    if (routeForSource(m.account.oracleSource) !== "opta") continue;
    const asset = m.account.assetName;
    if (typeof asset !== "string" || !asset || !marketPdaFor(programId, asset).equals(m.publicKey)) {
      refusedMarkets += 1;
      continue;
    }
    byPda.set(m.publicKey.toBase58(), {
      asset, market: m.publicKey, feedBytes: Array.from(m.account.pythFeedId as number[]),
    });
  }
  const grouped = new Map<string, Source2Tuple>();
  for (const v of vaults) {
    if (!isLiveVault(v.account)) continue;
    const mk = byPda.get((v.account.market as PublicKey).toBase58());
    if (!mk) continue;
    const expiry = expiryOf(v.account);
    const key = `${mk.asset}:${expiry}`;
    const existing = grouped.get(key);
    if (existing) existing.liveVaults += 1;
    else grouped.set(key, { key, asset: mk.asset, expiry, market: mk.market, feedBytes: mk.feedBytes, liveVaults: 1 });
  }
  const tuples = Array.from(grouped.values()).sort((a, b) => a.expiry - b.expiry || a.asset.localeCompare(b.asset));
  return { tuples, source2Markets: byPda.size, refusedMarkets };
}

// ---- wire shape -----------------------------------------------------------------

/** The account list for settle_expiry on a first-party market: price_update
 *  None, the three Switchboard optionals None, the feed in the trailing slot. */
export function settleAccounts(caller: PublicKey, market: PublicKey, settlementRecord: PublicKey, optaPriceFeed: PublicKey) {
  return {
    caller,
    market,
    priceUpdate: null,
    settlementRecord,
    systemProgram: SystemProgram.programId,
    sbQueue: null,
    sbSlothashes: null,
    sbInstructions: null,
    optaPriceFeed,
  };
}

/** The record seed prefix, read from the IDL's own PDA spec (never hand-typed).
 *  Works on the raw IDL (snake_case) and on a Program's camelCased copy. */
export function settlementSeedFromIdl(idl: any): Buffer {
  const ix = (idl?.instructions ?? []).find((i: any) => i.name === "settle_expiry" || i.name === "settleExpiry");
  if (!ix) throw new Error("opta-settle: the IDL has no settle_expiry instruction");
  const acc = (ix.accounts ?? []).find((a: any) => a.name === "settlement_record" || a.name === "settlementRecord");
  const seed = acc?.pda?.seeds?.[0];
  if (!seed || seed.kind !== "const" || !seed.value) throw new Error("opta-settle: settlement_record has no const seed in the IDL");
  return Buffer.from(seed.value);
}

export function recordPdaFor(program: anchor.Program<any>, asset: string, expiry: number): PublicKey {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(expiry));
  return PublicKey.findProgramAddressSync(
    [settlementSeedFromIdl(program.idl), Buffer.from(asset), b], program.programId,
  )[0];
}

export async function buildSettleExpiryIx(
  program: anchor.Program<any>,
  caller: PublicKey,
  asset: string,
  expiry: number,
  feedBytes: number[],
): Promise<TransactionInstruction> {
  const market = marketPdaFor(program.programId, asset);
  const record = recordPdaFor(program, asset, expiry);
  const feed = feedPdaFor(program.programId, feedBytes);
  // Cast: Program<any> makes the typed builder recurse (same cast optaVolCrank uses).
  return (program.methods as any)
    .settleExpiry(asset, new anchor.BN(expiry))
    .accountsPartial(settleAccounts(caller, market, record, feed))
    .instruction();
}

// ---- decoded-account adapters -----------------------------------------------------
//
// The Program coder camelCases every field (`pyth_publish_time` arrives as
// `pythPublishTime`, `price_6dec` as `price6Dec`); the raw BorshAccountsCoder
// the ceremony tools use does not. Either may be handed to these. A field
// present under neither spelling is a shape error, never a silent default --
// the 2026-09-18 vol lane read a missing key as "no feed" for an hour.
function pick(o: any, camel: string, snake: string, what: string): any {
  if (o != null && o[camel] !== undefined) return o[camel];
  if (o != null && o[snake] !== undefined) return o[snake];
  throw new Error(`opta-settle: decoded ${what} has no field "${camel}" / "${snake}" (keys: ${o ? Object.keys(o).join(",") : "none"})`);
}
export function recordSnapshot(r: any): RecordSnapshot {
  return {
    asset: String(pick(r, "assetName", "asset_name", "SettlementRecord")),
    expiry: Number(pick(r, "expiry", "expiry", "SettlementRecord")),
    price6dec: BigInt(pick(r, "settlementPrice", "settlement_price", "SettlementRecord").toString()),
    settledAt: Number(pick(r, "settledAt", "settled_at", "SettlementRecord")),
    publishTime: Number(pick(r, "pythPublishTime", "pyth_publish_time", "SettlementRecord")),
  };
}
export function settleFeedSnapshot(f: any): FeedSnapshot {
  return {
    frozen: !!pick(f, "frozen", "frozen", "OptaPriceFeed"),
    publishTime: Number(pick(f, "publishTime", "publish_time", "OptaPriceFeed")),
    price6dec: BigInt(pick(f, "price6Dec", "price_6dec", "OptaPriceFeed").toString()),
  };
}

// ---- scheduler --------------------------------------------------------------------

interface TupleState {
  tuple: Source2Tuple;
  status: "active" | "done" | "dead";
  /** publish_time of the first push seen at or after expiry. */
  firstPostExpiryPush: number | null;
  /** True when a pre-expiry print was seen first, i.e. the lane was already
   *  polling when the first post-expiry push landed. */
  polledFromBeforePush: boolean;
  lastSendAtMs: number;
  dryRunLogged: boolean;
}

const iso = (s: number) => new Date(s * 1000).toISOString();

export class OptaSettleScheduler {
  private states = new Map<string, TupleState>();

  constructor(private ctx: OptaSettleContext, private deps: OptaSettleDeps) {}

  tupleCount(): number { return this.states.size; }

  /** Re-scan the chain and reconcile the tuple set. New tuples that can still
   *  be settled are announced once, with their expiry. */
  async discover(): Promise<void> {
    const { markets, vaults, undecodable } = await this.deps.scan();
    const { tuples, source2Markets, refusedMarkets } = enumerateSource2Tuples(this.ctx.programId, vaults, markets);
    const now = await this.deps.clusterNow();
    const seen = new Set<string>();
    for (const t of tuples) {
      seen.add(t.key);
      const st = this.states.get(t.key);
      if (st) { st.tuple = t; continue; }
      this.states.set(t.key, {
        tuple: t, status: "active", firstPostExpiryPush: null, polledFromBeforePush: false,
        lastSendAtMs: Number.NEGATIVE_INFINITY, dryRunLogged: false,
      });
      if (phaseOf(t.expiry, now) !== "past-window") {
        this.ctx.log("info", "opta-settle tuple discovered", {
          asset: t.asset, expiry: t.expiry, expiryIso: iso(t.expiry), liveVaults: t.liveVaults,
          secondsToExpiry: t.expiry - now, at: now,
        });
      }
    }
    // A tuple with no live vault left (settled by the fan-out, or voided) is gone.
    for (const k of [...this.states.keys()]) if (!seen.has(k)) this.states.delete(k);
    const all = [...this.states.values()];
    this.ctx.log("info", "opta-settle discovery", {
      source2Markets, refusedMarkets, vaultsScanned: vaults.length, undecodable,
      tuples: all.length,
      pending: all.filter((s) => s.status === "active" && phaseOf(s.tuple.expiry, now) === "pending").length,
      inWindow: all.filter((s) => s.status === "active" && phaseOf(s.tuple.expiry, now) === "in-window").length,
      done: all.filter((s) => s.status === "done").length,
      deadFeed: all.filter((s) => s.status === "dead").length,
      at: now,
    });
  }

  private recordPresent(st: TupleState, rec: RecordSnapshot, now: number, note: string): void {
    st.status = "done";
    this.ctx.log("info", "opta-settle record present", {
      asset: st.tuple.asset, expiry: st.tuple.expiry, note,
      recordPublishTime: rec.publishTime, recordPrice6dec: rec.price6dec.toString(), settledAt: rec.settledAt,
      secondsPastExpiry: now - st.tuple.expiry,
    });
  }

  /** One pass over the tuples. Returns how long the loop may sleep. */
  async step(): Promise<number> {
    const now = await this.deps.clusterNow();
    let wait = IDLE_MAX_MS;
    for (const st of this.states.values()) {
      if (this.ctx.shouldShutdown()) break;
      if (st.status !== "active") continue;
      const t = st.tuple;
      const phase = phaseOf(t.expiry, now);

      if (phase === "pending") {
        wait = Math.min(wait, Math.max(250, (t.expiry - now) * 1000));
        continue;
      }

      if (phase === "past-window") {
        const rec = await this.deps.fetchRecord(t);
        if (rec) { this.recordPresent(st, rec, now, "record exists; settle_vault fan-out is the main tick's"); continue; }
        st.status = "dead";
        this.ctx.log("warn", "opta-settle tuple dead-feed", {
          asset: t.asset, expiry: t.expiry, expiryIso: iso(t.expiry), liveVaults: t.liveVaults,
          secondsPastExpiry: now - t.expiry, windowSecs: SETTLE_WINDOW_SECS,
          firstPostExpiryPushTime: st.firstPostExpiryPush,
          note: "no settlement record inside the window; not retried; reclaim voids it after the grace",
        });
        continue;
      }

      // in-window
      wait = Math.min(wait, FEED_POLL_MS);
      const before = await this.deps.fetchRecord(t);
      if (before) { this.recordPresent(st, before, now, "record already written"); continue; }

      const feed = await this.deps.fetchFeed(t);
      if (feed) {
        if (feed.publishTime < t.expiry) st.polledFromBeforePush = true;
        else if (st.firstPostExpiryPush === null) st.firstPostExpiryPush = feed.publishTime;
      }
      const d = decideSettleSend(feed, t.expiry, now);
      if (!d.send) continue;

      if (this.ctx.dryRun) {
        if (!st.dryRunLogged) {
          st.dryRunLogged = true;
          this.ctx.log("info", "opta-settle WOULD-SEND (dry-run, NOT sent)", {
            asset: t.asset, expiry: t.expiry, feedPublishTime: feed!.publishTime, secondsPastExpiry: now - t.expiry,
          });
        }
        continue;
      }
      if (this.deps.nowMs() - st.lastSendAtMs < RETRY_MIN_MS) continue;
      st.lastSendAtMs = this.deps.nowMs();

      try {
        const sent = await this.deps.sendSettle(t);
        const rec = await this.deps.fetchRecord(t);
        if (!rec) throw new Error(`settle_expiry confirmed (${sent.sig}) but the record does not read back`);
        st.status = "done";
        const first = st.firstPostExpiryPush;
        this.ctx.log("info", "opta-settle settled", {
          asset: t.asset, expiry: t.expiry, expiryIso: iso(t.expiry), liveVaults: t.liveVaults,
          sig: sent.sig, slot: sent.slot, txBlockTime: sent.blockTime,
          txSecondsAfterExpiry: sent.blockTime === null ? null : sent.blockTime - t.expiry,
          txInsideWindow: sent.blockTime !== null && sent.blockTime >= t.expiry && sent.blockTime - t.expiry <= SETTLE_WINDOW_SECS,
          recordPublishTime: rec.publishTime,
          recordInsideWindow: rec.publishTime >= t.expiry && rec.publishTime - t.expiry <= SETTLE_WINDOW_SECS,
          recordPrice6dec: rec.price6dec.toString(), settledAt: rec.settledAt,
          firstPostExpiryPushTime: first,
          firstPushSeenLanding: st.polledFromBeforePush,
          keeperLatencySecs: first === null ? null : rec.publishTime - first,
        });
      } catch (err) {
        // Someone else may have written it, or ours may have landed without a confirmation.
        const rec = await this.deps.fetchRecord(t).catch(() => null);
        if (rec) { this.recordPresent(st, rec, now, "record present after a failed send"); continue; }
        this.ctx.log("warn", "opta-settle send failed (will retry inside the window)", {
          asset: t.asset, expiry: t.expiry, secondsPastExpiry: now - t.expiry, err: String(err).slice(0, 400),
        });
      }
    }
    return wait;
  }
}

export async function runOptaSettleCrank(ctx: OptaSettleContext, deps: OptaSettleDeps): Promise<void> {
  ctx.log("info", "opta-settle crank started", {
    marker: OPTA_SETTLE_MARKER, dryRun: ctx.dryRun, windowSecs: SETTLE_WINDOW_SECS,
    discoveryIntervalSecs: DISCOVERY_INTERVAL_SECS, feedPollMs: FEED_POLL_MS,
  });
  const s = new OptaSettleScheduler(ctx, deps);
  let nextDiscoveryMs = deps.nowMs();
  while (!ctx.shouldShutdown()) {
    if (deps.nowMs() >= nextDiscoveryMs) {
      try {
        await s.discover();
        nextDiscoveryMs = deps.nowMs() + DISCOVERY_INTERVAL_SECS * 1000;
      } catch (err) {
        nextDiscoveryMs = deps.nowMs() + 30_000;
        ctx.log("warn", "opta-settle discovery failed (will retry)", { err: String(err).slice(0, 300) });
      }
    }
    let wait = FEED_POLL_MS;
    try {
      wait = await s.step();
    } catch (err) {
      ctx.log("warn", "opta-settle step failed (will retry)", { err: String(err).slice(0, 300) });
    }
    if (ctx.shouldShutdown()) break;
    await deps.sleep(Math.max(250, Math.min(wait, nextDiscoveryMs - deps.nowMs())));
  }
  ctx.log("info", "opta-settle crank stopped cleanly");
}

// ---- real I/O ---------------------------------------------------------------------

export interface OptaSettleRuntime {
  connection: Connection;
  wallet: anchor.Wallet;
  program: anchor.Program<any>;
}

function isAbsent(err: unknown): boolean {
  return /does not exist|could not find|Account not found/i.test(String(err));
}

export function realDeps(rt: OptaSettleRuntime, ctx: OptaSettleContext): OptaSettleDeps {
  const { connection, program } = rt;
  const coder = program.coder.accounts as any;
  const discFilter = (name: string) => {
    const m = coder.memcmp(name);
    return { memcmp: { offset: m.offset ?? 0, bytes: m.bytes as string } };
  };
  /** cluster - local, from the last successful read. Used only to ride out a
   *  failed getBlockTime; never a substitute for reading the cluster. */
  let offset: { secs: number; atMs: number } | null = null;

  return {
    // Its own scan, straight from the chain. safeFetchAll would hand back the
    // shared scan cache, and a tuple created ten minutes before its expiry
    // must not depend on when that cache was last refreshed.
    scan: async () => {
      let undecodable = 0;
      const markets: AccountRecord[] = [];
      for (const { pubkey, account } of await connection.getProgramAccounts(program.programId, {
        commitment: "confirmed", filters: [discFilter("optionsMarket")],
      })) {
        try { markets.push({ publicKey: pubkey, account: coder.decode("optionsMarket", account.data) }); }
        catch { /* legacy market layout: belongs to no lane */ }
      }
      const vaults: AccountRecord[] = [];
      for (const m of markets) {
        if (routeForSource(m.account.oracleSource) !== "opta") continue;
        for (const { pubkey, account } of await connection.getProgramAccounts(program.programId, {
          commitment: "confirmed",
          filters: [discFilter("sharedVault"), { memcmp: { offset: 8, bytes: m.publicKey.toBase58() } }],
        })) {
          try { vaults.push({ publicKey: pubkey, account: coder.decode("sharedVault", account.data) }); }
          catch { undecodable += 1; }
        }
      }
      return { markets, vaults, undecodable };
    },
    clusterNow: async () => {
      try {
        const t = await connection.getBlockTime(await connection.getSlot("confirmed"));
        if (t === null) throw new Error("no block time for the current slot");
        offset = { secs: t - Math.floor(Date.now() / 1000), atMs: Date.now() };
        return t;
      } catch (err) {
        if (offset && Date.now() - offset.atMs <= 10 * 60 * 1000) {
          return Math.floor(Date.now() / 1000) + offset.secs;
        }
        throw err;
      }
    },
    fetchFeed: async (t) => {
      let f: any;
      try { f = await (program.account as any).optaPriceFeed.fetch(feedPdaFor(program.programId, t.feedBytes), "confirmed"); }
      catch (err) { if (isAbsent(err)) return null; throw err; }
      return settleFeedSnapshot(f);
    },
    fetchRecord: async (t) => {
      const info = await connection.getAccountInfo(recordPdaFor(program, t.asset, t.expiry), "confirmed");
      if (!info) return null;
      return recordSnapshot(coder.decode("settlementRecord", info.data));
    },
    sendSettle: async (t) => {
      const ix = await buildSettleExpiryIx(program, ctx.caller, t.asset, t.expiry, t.feedBytes);
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: SETTLE_CU_LIMIT }), ix);
      const sig = await program.provider.sendAndConfirm!(tx, [], { commitment: "confirmed" });
      const st = (await connection.getSignatureStatuses([sig])).value[0];
      const slot = st?.slot ?? 0;
      let blockTime: number | null = null;
      try { blockTime = slot ? await connection.getBlockTime(slot) : null; } catch { blockTime = null; }
      return { sig, slot, blockTime };
    },
    sleep: async (ms) => {
      let left = ms;
      while (left > 0 && !ctx.shouldShutdown()) {
        const step = Math.min(1_000, left);
        await new Promise((r) => setTimeout(r, step));
        left -= step;
      }
    },
    nowMs: () => Date.now(),
  };
}
