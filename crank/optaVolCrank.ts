// ============================================================================
// crank/optaVolCrank.ts -- vol-sample lane for ORACLE_SOURCE_OPTA markets
// ============================================================================
//
// Layer 2 of the FP-ORACLE plug. After set_oracle_source flips a market to
// source 2, its VolOracle can only be advanced by a push_vol_sample whose Opta
// arm reads the market's OptaPriceFeed. The Pyth lane (volOracleCrank) and the
// SB lane (sbOracleCrank) skip source-2 oracles; this lane serves them.
//
// WHAT IT DOES NOT DO, deliberately:
//   - It never holds or loads the oracle AUTHORITY key. push_vol_sample is
//     permissionless; this lane signs with the ordinary crank wallet. The key
//     that writes prices stays in its own unit (spec 6.3), unchanged.
//   - It never pushes to an OptaPriceFeed. That is the fp-oracle lane's job.
//   - It never initialises a VolOracle. Wave-1 oracles already exist (flipped
//     from SB by set_oracle_source, then reset+seeded by the D2 ceremony).
//
// Cadence is hourly on the boundary, like the Pyth lane, so the on-chain
// VOL_ORACLE_MIN_PUSH_INTERVAL_SECS (55 min) is never the thing that fails.
//
// Every decision is a pure function and every I/O is injected, so the tick is
// unit-testable without a chain (see optaVolCrank.test.ts).
//
// Flag: OPTA_VOL_OPTA_ENABLED=1 spawns it from bot.ts. Default OFF.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, ComputeBudgetProgram, SystemProgram, Transaction } from "@solana/web3.js";
import { VOL_ORACLE_SEED } from "@app/utils/constants";
import { hexFromBytes } from "@app/utils/format";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { dedupeFeedIds, msUntilNextHourBoundary } from "./volOracleCrank";

export const ORACLE_SOURCE_OPTA = 2;
export const OPTA_PRICE_FEED_SEED = "opta_price_feed";
/** Mirrors on-chain OPTA_FEED_READ_MAX_AGE_SECS. A push against a feed older
 *  than this would be refused with OptaFeedStale; skip locally instead. */
export const OPTA_FEED_READ_MAX_AGE_SECS = 180;
/** Mirrors VOL_ORACLE_MIN_PUSH_INTERVAL_SECS. */
export const VOL_MIN_PUSH_INTERVAL_SECS = 55 * 60;
export const PUSH_CU_LIMIT = 200_000;

export type OptaVolLogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type OptaVolLogger = (level: OptaVolLogLevel, msg: string, fields?: Record<string, unknown>) => void;

export interface OptaVolCrankContext {
  connection: Connection;
  /** The ordinary crank wallet. NOT the oracle authority. */
  wallet: anchor.Wallet;
  program: anchor.Program<any>;
  log: OptaVolLogger;
  shouldShutdown: () => boolean;
  dryRun: boolean;
}

export interface OptaVolTickReport {
  marketsSeen: number;
  optaMarkets: number;
  feedsConsidered: number;
  pushed: number;
  skippedStaleFeed: number;
  skippedFrozenFeed: number;
  skippedRateLimit: number;
  skippedNoOracle: number;
  skippedNoFeed: number;
  errored: number;
}

/** Only the markets whose oracle_source byte says Opta. Everything else belongs
 *  to another lane and is left alone. */
export function partitionOptaMarkets<T extends { account: { oracleSource?: number } }>(
  markets: T[],
): { opta: T[]; other: number } {
  const opta = markets.filter((m) => Number(m.account.oracleSource) === ORACLE_SOURCE_OPTA);
  return { opta, other: markets.length - opta.length };
}

export interface FeedSnapshot { frozen: boolean; publishTime: number; price6dec: bigint }
export interface OracleSnapshot { lastSampleTs: number; sampleCount: number }

export type PushDecision =
  | { push: true }
  | { push: false; reason: "no-feed" | "no-oracle" | "frozen" | "stale-feed" | "rate-limit" };

/** The whole pre-flight, as a pure function. Mirrors the on-chain guards so a
 *  refusal is predicted locally and no fee is spent finding it out. */
export function decidePush(
  feed: FeedSnapshot | null,
  oracle: OracleSnapshot | null,
  nowSecs: number,
  maxAgeSecs = OPTA_FEED_READ_MAX_AGE_SECS,
  minIntervalSecs = VOL_MIN_PUSH_INTERVAL_SECS,
): PushDecision {
  if (!feed) return { push: false, reason: "no-feed" };
  if (!oracle) return { push: false, reason: "no-oracle" };
  if (feed.frozen) return { push: false, reason: "frozen" };
  if (feed.publishTime <= 0 || nowSecs - feed.publishTime > maxAgeSecs) return { push: false, reason: "stale-feed" };
  // Seed / reseed pushes (lastSampleTs == 0, or a gap) are always allowed by the
  // program; the rate limit only applies inside a live cadence.
  if (oracle.lastSampleTs > 0 && nowSecs - oracle.lastSampleTs < minIntervalSecs) {
    return { push: false, reason: "rate-limit" };
  }
  return { push: true };
}

/** Everything the tick touches outside its own logic. Injected for tests. */
export interface OptaVolDeps {
  fetchMarkets: () => Promise<Array<{ publicKey: PublicKey; account: any }>>;
  fetchFeed: (pda: PublicKey) => Promise<FeedSnapshot | null>;
  fetchOracle: (pda: PublicKey) => Promise<OracleSnapshot | null>;
  sendPush: (feedBytes: number[], volOraclePda: PublicKey, feedPda: PublicKey) => Promise<string>;
  now: () => number;
}

export function feedPdaFor(programId: PublicKey, feedBytes: number[]): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(OPTA_PRICE_FEED_SEED), Buffer.from(feedBytes)], programId,
  )[0];
}
export function volOraclePdaFor(programId: PublicKey, feedBytes: number[]): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedBytes)], programId,
  )[0];
}

/** The account list for push_vol_sample on an Opta-sourced oracle. Exported so
 *  a test can pin the wire shape: price_update None, the three SB optionals
 *  None, and the feed in the trailing slot. */
export function pushAccounts(signer: PublicKey, volOracle: PublicKey, optaPriceFeed: PublicKey) {
  return {
    signer,
    priceUpdate: null,
    volOracle,
    systemProgram: SystemProgram.programId,
    sbQueue: null,
    sbSlothashes: null,
    sbInstructions: null,
    optaPriceFeed,
  };
}

// ---- decoded-account adapters -------------------------------------------------
//
// `program.account.X.fetch` decodes through the PROGRAM-level coder, which
// camelCases every IDL field: `price_6dec` arrives as `price6Dec` (capital D —
// the camelcase rule treats the digit as a word boundary), not `price6dec`.
// The first live tick after the BTC flip (2026-09-18 14:10Z) read `price6dec`,
// got undefined, threw inside a bare catch and reported a present, fresh feed
// as "no-feed" — every hour, forever. These adapters are strict: a missing
// field is a shape error that surfaces as `errored` + a log line, never a
// silent "absent". Exported so the tests decode through the REAL coder.
function must(o: any, k: string, what: string): any {
  if (o == null || o[k] === undefined) throw new Error(`opta-vol: decoded ${what} has no field "${k}" (keys: ${o ? Object.keys(o).join(",") : "none"})`);
  return o[k];
}
export function feedSnapshot(f: any): FeedSnapshot {
  return {
    frozen: !!must(f, "frozen", "OptaPriceFeed"),
    publishTime: Number(must(f, "publishTime", "OptaPriceFeed")),
    price6dec: BigInt(must(f, "price6Dec", "OptaPriceFeed").toString()),
  };
}
export function oracleSnapshot(o: any): OracleSnapshot {
  return {
    lastSampleTs: Number(must(o, "lastSampleTs", "VolOracle")),
    sampleCount: Number(must(o, "sampleCount", "VolOracle")),
  };
}
/** True for the "account does not exist" failure of anchor's fetch — the only
 *  failure that legitimately means "absent". Anything else propagates. */
function isAbsent(err: unknown): boolean {
  return /does not exist|could not find|Account not found/i.test(String(err));
}

export function realDeps(ctx: OptaVolCrankContext): OptaVolDeps {
  const acct = ctx.program.account as any;
  return {
    fetchMarkets: () => safeFetchAll<any>(ctx.program, "optionsMarket"),
    fetchFeed: async (pda) => {
      let f: any;
      try { f = await acct.optaPriceFeed.fetch(pda); } catch (err) { if (isAbsent(err)) return null; throw err; }
      return feedSnapshot(f);
    },
    fetchOracle: async (pda) => {
      let o: any;
      try { o = await acct.volOracle.fetch(pda); } catch (err) { if (isAbsent(err)) return null; throw err; }
      return oracleSnapshot(o);
    },
    sendPush: async (_feedBytes, volOracle, optaPriceFeed) => {
      // Cast: the runtime IDL carries the trailing optional; Program<any> makes
      // the typed builder recurse forever (same cast sbOracleCrank uses).
      const ix = await (ctx.program.methods as any)
        .pushVolSample()
        .accounts(pushAccounts(ctx.wallet.publicKey, volOracle, optaPriceFeed))
        .instruction();
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: PUSH_CU_LIMIT }), ix,
      );
      return ctx.program.provider.sendAndConfirm!(tx, [], { commitment: "confirmed" });
    },
    now: () => Math.floor(Date.now() / 1000),
  };
}

export async function tickOnce(ctx: OptaVolCrankContext, deps: OptaVolDeps = realDeps(ctx)): Promise<OptaVolTickReport> {
  const report: OptaVolTickReport = {
    marketsSeen: 0, optaMarkets: 0, feedsConsidered: 0, pushed: 0,
    skippedStaleFeed: 0, skippedFrozenFeed: 0, skippedRateLimit: 0,
    skippedNoOracle: 0, skippedNoFeed: 0, errored: 0,
  };
  const all = await deps.fetchMarkets();
  report.marketsSeen = all.length;
  const { opta } = partitionOptaMarkets(all);
  report.optaMarkets = opta.length;
  const feeds = dedupeFeedIds(opta.map((m) => Array.from(m.account.pythFeedId as number[])));
  const programId = ctx.program.programId;

  for (const feedBytes of feeds) {
    if (ctx.shouldShutdown()) break;
    report.feedsConsidered += 1;
    const feedShort = hexFromBytes(feedBytes).slice(0, 8);
    const feedPda = feedPdaFor(programId, feedBytes);
    const oraclePda = volOraclePdaFor(programId, feedBytes);
    let feed: FeedSnapshot | null, oracle: OracleSnapshot | null;
    try {
      [feed, oracle] = await Promise.all([deps.fetchFeed(feedPda), deps.fetchOracle(oraclePda)]);
    } catch (err) {
      // A read that fails for any reason other than "absent" is an error, not a
      // skip: it is counted and logged with the cause, so a decode-shape drift
      // can never masquerade as a missing feed again.
      report.errored += 1;
      ctx.log("error", "opta-vol read failed", { feed: feedShort, err: String(err).slice(0, 300) });
      continue;
    }
    const now = deps.now();
    const d = decidePush(feed, oracle, now);
    if (!d.push) {
      const k = {
        "no-feed": "skippedNoFeed", "no-oracle": "skippedNoOracle", "frozen": "skippedFrozenFeed",
        "stale-feed": "skippedStaleFeed", "rate-limit": "skippedRateLimit",
      }[d.reason] as keyof OptaVolTickReport;
      (report[k] as number) += 1;
      ctx.log(d.reason === "rate-limit" ? "debug" : "warn", "opta-vol push skipped", {
        feed: feedShort, reason: d.reason,
        feedAgeSecs: feed ? now - feed.publishTime : null,
        oracleAgeSecs: oracle ? now - oracle.lastSampleTs : null,
      });
      continue;
    }
    if (ctx.dryRun) {
      ctx.log("info", "opta-vol WOULD-PUSH (dry-run, NOT sent)", { feed: feedShort, volOracle: oraclePda.toBase58(), optaPriceFeed: feedPda.toBase58() });
      report.pushed += 1;
      continue;
    }
    try {
      const sig = await deps.sendPush(feedBytes, oraclePda, feedPda);
      report.pushed += 1;
      ctx.log("info", "opta-vol push sent", { feed: feedShort, volOracle: oraclePda.toBase58(), sig, sampleCountBefore: oracle!.sampleCount });
    } catch (err) {
      report.errored += 1;
      ctx.log("warn", "opta-vol push failed", { feed: feedShort, err: String(err).slice(0, 300) });
    }
  }
  return report;
}

export interface OptaVolCrankOptions { tickOnce?: boolean }

export async function runOptaVolCrank(ctx: OptaVolCrankContext, options: OptaVolCrankOptions = {}): Promise<void> {
  ctx.log("info", "opta-vol crank started", { dryRun: ctx.dryRun, tickOnce: !!options.tickOnce, maxAgeSecs: OPTA_FEED_READ_MAX_AGE_SECS });
  const guarded = async () => {
    try {
      const r = await tickOnce(ctx);
      ctx.log("info", "opta-vol tick complete", { ...r });
    } catch (err) {
      ctx.log("error", "opta-vol tick crashed (will retry next hour)", { err: String(err).slice(0, 300) });
    }
  };
  await guarded();
  if (options.tickOnce) return;
  while (!ctx.shouldShutdown()) {
    const wait = msUntilNextHourBoundary(Date.now());
    const step = 5_000;
    let slept = 0;
    while (slept < wait && !ctx.shouldShutdown()) {
      await new Promise((r) => setTimeout(r, Math.min(step, wait - slept)));
      slept += step;
    }
    if (ctx.shouldShutdown()) break;
    await guarded();
  }
  ctx.log("info", "opta-vol crank stopped cleanly");
}
