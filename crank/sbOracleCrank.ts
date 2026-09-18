// ============================================================================
// crank/sbOracleCrank.ts — Stage 3 1c-ii-A: Switchboard VolOracle warming crank
// ============================================================================
//
// The 5th crank side-loop. Structural sibling of volOracleCrank.ts: hourly,
// wall-clock-aligned, per-feed-isolated. Warms SB-sourced VolOracles by posting
// fresh signed Switchboard quotes through push_vol_sample's SB arm (the path
// proven live by the 1c-i-A devnet smoke).
//
// PER TICK: safeFetchAll("optionsMarket") → filter oracle_source==1 → dedup
// feedHashes → filter to registry-supported → per-feed init-or-push.
//   - if no VolOracle yet: birth via initialize_vol_oracle(feedHash, source=1,
//     seed_vol), price_update=null — seed-at-birth UN-DEFERS the SB feed-
//     existence proof to birth, so birth now attaches the 3 SB accounts + a
//     fresh signed quote ([CU, ed25519, init], like the push) and seeds the
//     per-class day-0 vol. (Pre-seed-at-birth this was a no-account 2-ix tx
//     with the SB proof deferred to the first push.)
//   - else: warming push — resolve jobs (registry) → fetch fresh quote via
//     buildManagedQuoteUpdateIxs (self-packed ed25519) → build
//     [CU, ed25519Ix, push_vol_sample(+SB accounts, price_update:null)] →
//     simulate-gate → (dry-run) log + STOP / (live) send + confirm.
//
// GATES (mirror the trigger keeper):
//   OPTA_SB_CRANK_DISABLED=1  → bot.ts skips spawning this loop entirely.
//   OPTA_SB_DRY_RUN (default "1" = ON) → build + simulate + log, NEVER send.
//   OPTA_SB_FORCE_FEED=<hex[,hex]>  → dev/ops hook: process these feedHashes even
//     if no on-chain SB market references them yet (used to dry-run the push path
//     against the 1c-i-A unlisted gold VolOracle before create-SB-market deploys).
//
// SCOPE: warming push ONLY (writes VolOracle.last_spot_price). SB settle-at-expiry
// is 1c-ii-B — this loop never touches the settle path.
//
// Single-tick smoke: TICK_ONCE=1 runs one tick and returns.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, PublicKey, ComputeBudgetProgram, SystemProgram, Ed25519Program,
  TransactionMessage, VersionedTransaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  Queue, AnchorUtils, ON_DEMAND_DEVNET_PID, ON_DEMAND_DEVNET_QUEUE,
  SPL_SYSVAR_SLOT_HASHES_ID, SPL_SYSVAR_INSTRUCTIONS_ID,
} from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";
import BN from "bn.js";

import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { hexFromBytes } from "@app/utils/format";
import { VOL_ORACLE_SEED } from "@app/utils/constants";
import { seedVolForAssetClass } from "@app/utils/seedVol";

import { buildManagedQuoteUpdateIxs, type CapturedBuild } from "./switchboardQuotePost";
import { buildSbSettlementRecord, archiveSbSettlement } from "./settlementArchive";
import {
  lookupSbFeed, isSupportedSbFeed, listSupportedFeeds, buildOracleFeed,
  normFeedHash, type SbFeedEntry,
} from "./sbFeedRegistry";

// ---- Types -----------------------------------------------------------------

export type SbCrankLogLevel = "info" | "warn" | "error" | "fatal";
export type SbCrankLogger = (
  level: SbCrankLogLevel,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface SbOracleCrankContext {
  connection: Connection;
  /** anchor.Wallet — needs `.payer` (live send) + `.publicKey`. */
  wallet: anchor.Wallet;
  program: anchor.Program<Opta>;
  log: SbCrankLogger;
  shouldShutdown: () => boolean;
  /** OPTA_SB_DRY_RUN — when true, build + simulate + log, NEVER send. */
  dryRun: boolean;
  /** OPTA_SB_FORCE_FEED — extra feedHashes to process regardless of discovery. */
  forceFeeds: string[];
  /** OPTA_SB_FORCE_SETTLE — synthetic settle targets (asset:expiry:feedHash) for
   *  dry-run proof without a discoverable SB market+vault. */
  forceSettles: ForcedSettle[];
}

export interface ForcedSettle {
  asset: string;
  expiry: number;
  feedHashHex: string;
}

/** A discovered SB market record (oracle_source==1), cached for the settle pass. */
export interface SbMarketRec {
  marketPda: PublicKey;
  assetName: string;
  feedHashHex: string;
  assetClass: number;
}

export interface SbOracleCrankOptions {
  tickOnce?: boolean;
}

export interface SbSettleReport {
  sbVaultsScanned: number;
  settleTuplesInWindow: number;
  settleTuplesPastWindow: number;   // expired but past the 300s window → reclaim path
  settled: number;                  // settled (or would-settle in dry-run)
  settleErrored: number;
  archived: number;                 // confirmed settles whose attestation reached the JSONL
  archiveErrored: number;           // confirmed settles whose archive missed a sink
}

export interface SbTickReport {
  marketsScanned: number;
  sbMarketsFound: number;
  feedsSupported: number;
  feedsSkippedUnsupported: number;
  feedsInitialized: number;     // birthed (or would-birth in dry-run)
  feedsPushed: number;          // pushed (or would-push in dry-run)
  feedsErrored: number;
  failedFeeds: string[];        // feedHashes that errored this pass (→ mid-hour retry)
  durationMs: number;
}

/** SB-SDK clients, bootstrapped once per run. */
interface SbClients {
  qObj: Queue;
  crossbar: CrossbarClient;
}

// ---- Constants -------------------------------------------------------------

const SHUTDOWN_CHECK_MS = 5000;
const PUSH_CU_LIMIT = 400_000;
/** Bounded retry per feed: the SB gateway is ~3/15 clean (root-cause doc). Each
 *  attempt RE-FETCHES a fresh quote (a quote past ~512 slots / ~3.5 min is
 *  unrecoverable). After this many misses we log-and-continue so one bad feed
 *  never stalls the whole tick. */
const SB_PUSH_MAX_ATTEMPTS = 8;
/** Inter-feed stagger in the warming pass — avoid a same-second N-feed burst
 *  against the oracle gateway (belt-and-suspenders alongside the self-hosted
 *  crossbar). */
const SB_FEED_STAGGER_MS = 7000;
const CROSSBAR_URL = process.env.OPTA_CROSSBAR_URL ?? "https://crossbar.switchboard.xyz";

// ---- Settle-at-expiry (1c-ii-B) --------------------------------------------
/** On-chain SB settle window (must match settle_expiry.rs SB_SETTLE_WINDOW_SECS).
 *  settle_expiry's SB arm reverts SwitchboardSettleWindowElapsed past this. */
const SB_SETTLE_WINDOW_SECS = 300;
/** Near-expiry settle-check sub-cadence: the loop wakes this often to catch SB
 *  vaults inside the 300s window (the hourly warming cadence is far too coarse).
 *  45s ≪ 250s leaves comfortable margin for fetch+land inside the window. */
const SETTLE_CHECK_INTERVAL_MS = 45_000;
/** Bounded retry per settle tuple (mirrors SB_PUSH_MAX_ATTEMPTS): each attempt
 *  re-fetches a FRESH quote. A miss → next settle-check tick retries (still inside
 *  the window if time remains); a full miss → reclaim_unsettled (holders forfeit,
 *  no fund loss — timing is optimization, not correctness). */
const SB_SETTLE_MAX_ATTEMPTS = 3;
const HOUR_MS = 60 * 60 * 1000;
const SETTLEMENT_SEED = "settlement";
const SETTLE_CU_LIMIT = 400_000;

// ---- Bootstrap -------------------------------------------------------------

async function bootstrapSbClients(ctx: SbOracleCrankContext): Promise<SbClients> {
  const sbProgram = await AnchorUtils.loadProgramFromConnection(
    ctx.connection,
    ctx.wallet,
    ON_DEMAND_DEVNET_PID,
  );
  const qObj = new Queue(sbProgram, ON_DEMAND_DEVNET_QUEUE);
  const crossbar = new CrossbarClient(CROSSBAR_URL);
  return { qObj, crossbar };
}

// ---- Main loop -------------------------------------------------------------

export async function runSbOracleCrank(
  ctx: SbOracleCrankContext,
  options: SbOracleCrankOptions = {},
): Promise<void> {
  ctx.log("info", "sb-oracle crank started", {
    dryRun: ctx.dryRun,
    tickOnce: !!options.tickOnce,
    supportedFeeds: listSupportedFeeds().map((f) => `${f.symbol}:${f.feedHashHex.slice(0, 8)}`),
    forceFeeds: ctx.forceFeeds.map((f) => f.slice(0, 8)),
  });

  let sb: SbClients;
  try {
    sb = await bootstrapSbClients(ctx);
  } catch (err) {
    ctx.log("error", "sb-oracle bootstrap failed (SB SDK / RPC)", { err: String(err) });
    throw err;
  }

  if (options.tickOnce) {
    try {
      const report = await tickOnce(ctx, sb);
      ctx.log("info", "sb-oracle crank exiting (TICK_ONCE)", { ...report });
    } catch (err) {
      ctx.log("error", "sb-oracle TICK_ONCE crashed", { err: String(err) });
      throw err;
    }
    return;
  }

  // DUAL CADENCE: warming push is HOURLY (vol samples are hourly); the SB
  // settle-check is FAST (~45s) so it catches expiries inside the 300s window.
  // One loop, two cadences: it wakes every SETTLE_CHECK_INTERVAL_MS to run the
  // settle pass (cheap — a no-op when there are no SB markets), and refreshes the
  // SB-market cache + runs the warming push when the wall-clock hour rolls over.
  let sbMarkets = await discoverSbMarketsGuarded(ctx);
  let lastReport = await runWarmingGuard(ctx, sb, sbMarkets);
  let lastWarmHour = Math.floor(Date.now() / HOUR_MS);

  // Mid-hour retry: a feed that fails the hourly warming push is retried at
  // +10/+20/+30min so a transient miss can't silently eat the 2h reseed window
  // (VOL_ORACLE_MAX_SAMPLE_GAP_SECS). Seeded from each hourly pass's failedFeeds.
  const RETRY_DELAYS_MS = [10, 20, 30].map((m) => m * 60_000);
  const retryQueue = new Map<string, { idx: number; dueMs: number }>();
  const seedRetries = (r: SbTickReport | null) => {
    retryQueue.clear();
    for (const f of r?.failedFeeds ?? [])
      retryQueue.set(f, { idx: 0, dueMs: Date.now() + RETRY_DELAYS_MS[0] });
  };
  seedRetries(lastReport);

  while (!ctx.shouldShutdown()) {
    await sleepInterruptibly(SETTLE_CHECK_INTERVAL_MS, ctx.shouldShutdown);
    if (ctx.shouldShutdown()) break;

    // Fast settle-check every tick (uses the cached SB-market set).
    await runSettleGuard(ctx, sb, sbMarkets);

    // Mid-hour retries for feeds that failed this hour's warming push. Each
    // due feed re-runs the push path (already-birthed → class unused); success
    // clears it, else it reschedules until the +30min slot is exhausted.
    for (const [feed, st] of [...retryQueue]) {
      if (ctx.shouldShutdown()) break;
      if (Date.now() < st.dueMs) continue;
      const r: SbTickReport = {
        marketsScanned: 0, sbMarketsFound: 0, feedsSupported: 0,
        feedsSkippedUnsupported: 0, feedsInitialized: 0, feedsPushed: 0,
        feedsErrored: 0, failedFeeds: [], durationMs: 0,
      };
      await processOneSbFeed(ctx, sb, feed, undefined, r);
      if (r.feedsPushed > 0) {
        retryQueue.delete(feed);
        ctx.log("info", "sb-oracle mid-hour retry OK", { feed: feed.slice(0, 10) });
      } else if (st.idx + 1 >= RETRY_DELAYS_MS.length) {
        retryQueue.delete(feed);
        ctx.log("warn", "sb-oracle mid-hour retries exhausted", { feed: feed.slice(0, 10) });
      } else {
        st.idx += 1;
        st.dueMs = Date.now() + RETRY_DELAYS_MS[st.idx];
      }
    }

    // Hourly: re-discover markets + warming push.
    const hr = Math.floor(Date.now() / HOUR_MS);
    if (hr > lastWarmHour) {
      sbMarkets = await discoverSbMarketsGuarded(ctx);
      lastReport = await runWarmingGuard(ctx, sb, sbMarkets);
      seedRetries(lastReport);
      lastWarmHour = hr;
    }
  }
  ctx.log("info", "sb-oracle crank stopped cleanly");
}

async function discoverSbMarketsGuarded(ctx: SbOracleCrankContext): Promise<SbMarketRec[]> {
  try {
    return await discoverSbMarkets(ctx);
  } catch (err) {
    ctx.log("error", "sb-oracle market discovery failed (will retry next cycle)", { err: String(err) });
    return [];
  }
}

async function runWarmingGuard(ctx: SbOracleCrankContext, sb: SbClients, sbMarkets: SbMarketRec[]): Promise<SbTickReport | null> {
  try {
    return await runWarmingTick(ctx, sb, sbMarkets);
  } catch (err) {
    ctx.log("error", "sb-oracle warming tick crashed (will retry next hour)", {
      err: String(err), stack: (err as any)?.stack,
    });
    return null;
  }
}

async function runSettleGuard(ctx: SbOracleCrankContext, sb: SbClients, sbMarkets: SbMarketRec[]): Promise<void> {
  try {
    await settleCheckTick(ctx, sb, sbMarkets);
  } catch (err) {
    ctx.log("error", "sb-oracle settle-check crashed (will retry next interval)", {
      err: String(err), stack: (err as any)?.stack,
    });
  }
}

// ---- Discovery -------------------------------------------------------------

/** Scan optionsMarket for SB markets (oracle_source==1). Returns the records the
 *  warming pass + the settle pass both consume. */
export async function discoverSbMarkets(ctx: SbOracleCrankContext): Promise<SbMarketRec[]> {
  const markets = await safeFetchAll<any>(ctx.program, "optionsMarket");
  const out: SbMarketRec[] = [];
  for (const m of markets) {
    if (m.account.oracleSource !== 1) continue;
    out.push({
      marketPda: m.publicKey,
      assetName: m.account.assetName as string,
      feedHashHex: normFeedHash(hexFromBytes(m.account.pythFeedId as number[])),
      assetClass: m.account.assetClass as number,
    });
  }
  return out;
}

// ---- One full pass (TICK_ONCE / harness): discover → warm → settle-check ----

export async function tickOnce(
  ctx: SbOracleCrankContext,
  sb: SbClients,
): Promise<SbTickReport & SbSettleReport> {
  const sbMarkets = await discoverSbMarketsGuarded(ctx);
  const warm = await runWarmingTick(ctx, sb, sbMarkets);
  const settle = await settleCheckTick(ctx, sb, sbMarkets);
  return { ...warm, ...settle };
}

// ---- Warming pass (hourly) -------------------------------------------------

export async function runWarmingTick(
  ctx: SbOracleCrankContext,
  sb: SbClients,
  sbMarkets: SbMarketRec[],
): Promise<SbTickReport> {
  const startMs = Date.now();
  const report: SbTickReport = {
    marketsScanned: 0, sbMarketsFound: sbMarkets.length, feedsSupported: 0,
    feedsSkippedUnsupported: 0, feedsInitialized: 0, feedsPushed: 0,
    feedsErrored: 0, failedFeeds: [], durationMs: 0,
  };

  const seen = new Set<string>();
  const feedHashes: string[] = [];
  const pushFeed = (hex: string) => {
    const k = normFeedHash(hex);
    if (k.length !== 64 || seen.has(k)) return;
    seen.add(k);
    feedHashes.push(k);
  };
  for (const m of sbMarkets) pushFeed(m.feedHashHex);
  // OPTA_SB_FORCE_FEED — dev/ops hook (process even with no discoverable market).
  for (const f of ctx.forceFeeds) pushFeed(f);

  const supported = feedHashes.filter((h) => isSupportedSbFeed(h));
  const unsupported = feedHashes.filter((h) => !isSupportedSbFeed(h));
  report.feedsSupported = supported.length;
  report.feedsSkippedUnsupported = unsupported.length;
  for (const h of unsupported) {
    ctx.log("warn", "sb-oracle skip: feedHash not in registry", { feed: h.slice(0, 10) });
  }

  ctx.log("info", "sb-oracle warming tick: discovered SB feeds", {
    sbMarkets: sbMarkets.length, supported: supported.length,
    unsupported: unsupported.length, forced: ctx.forceFeeds.length,
  });

  // feedHash → asset_class from the on-chain SB markets — drives the per-class
  // day-0 seed_vol at birth. A FORCE_FEED with no on-chain market has no class:
  // its birth is skipped (the warming push path still runs unaffected).
  const classByFeed = new Map<string, number>();
  for (const m of sbMarkets) {
    if (!classByFeed.has(m.feedHashHex)) classByFeed.set(m.feedHashHex, m.assetClass);
  }

  for (let i = 0; i < supported.length; i++) {
    if (ctx.shouldShutdown()) break;
    // Stagger feeds ~7s apart (skip before the first) so the pass isn't a
    // same-second N-feed burst against the oracle gateway.
    if (i > 0) await sleepInterruptibly(SB_FEED_STAGGER_MS, ctx.shouldShutdown);
    const errBefore = report.feedsErrored;
    await processOneSbFeed(ctx, sb, supported[i], classByFeed.get(supported[i]), report);
    if (report.feedsErrored > errBefore) report.failedFeeds.push(supported[i]);
  }

  report.durationMs = Date.now() - startMs;
  ctx.log("info", "sb-oracle warming tick complete", { ...report });
  return report;
}

export async function processOneSbFeed(
  ctx: SbOracleCrankContext,
  sb: SbClients,
  feedHashHex: string,
  assetClass: number | undefined,
  report: SbTickReport,
): Promise<void> {
  const entry = lookupSbFeed(feedHashHex);
  if (!entry) {
    // Defensive: tickOnce already filtered to supported, but keep isolation.
    report.feedsSkippedUnsupported += 1;
    return;
  }
  const feedShort = entry.feedHashHex.slice(0, 10);
  const feedIdBytes = Array.from(Buffer.from(entry.feedHashHex, "hex"));
  const [oraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedIdBytes)],
    ctx.program.programId,
  );

  let existing: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    existing = await ctx.connection.getAccountInfo(oraclePda);
  } catch (err) {
    ctx.log("error", "sb-oracle existence check failed", {
      feed: feedShort, pda: oraclePda.toBase58(), err: String(err),
    });
    report.feedsErrored += 1;
    return;
  }

  if (!existing) {
    await birthSbOracle(ctx, sb, entry, feedIdBytes, oraclePda, feedShort, assetClass, report);
    return;
  }
  await warmingPushWithRetry(ctx, sb, entry, oraclePda, feedShort, report);
}

// ---- Birth (initialize_vol_oracle, oracle_source=1, SB-quote-proven) --------
// Seed-at-birth UN-DEFERS the SB feed-existence proof to birth: initialize_vol_
// oracle now reads spot from a fresh signed quote, so SB birth requires the 3 SB
// accounts + a self-packed ed25519 quote (same [CU, ed25519, ix] shape as the
// warming push), plus the per-class day-0 seed_vol. A FORCE_FEED with no
// on-chain market has no asset_class → birth is skipped (never birth an unseeded
// SB oracle; the warming push path is unaffected).

async function birthSbOracle(
  ctx: SbOracleCrankContext,
  sb: SbClients,
  entry: SbFeedEntry,
  feedIdBytes: number[],
  oraclePda: PublicKey,
  feedShort: string,
  assetClass: number | undefined,
  report: SbTickReport,
): Promise<void> {
  // Resolve the per-class day-0 seed_vol. Skip BIRTH (not the whole feed) if the
  // class is unresolved — a missing class must not seed 0 (= "no seed").
  let seedVol: number;
  try {
    seedVol = seedVolForAssetClass(assetClass as number);
  } catch (err) {
    ctx.log("warn", "sb-oracle skip birth: unresolved seed_vol (no asset_class)", {
      feed: feedShort, err: String(err),
    });
    return;
  }

  const feed = buildOracleFeed(entry);
  const edPid = Ed25519Program.programId.toBase58();

  try {
    // (a) fetch a FRESH signed quote → self-packed ed25519 ix. This IS the
    //     un-deferred SB feed-existence proof (initialize_vol_oracle verifies it).
    let edIx: TransactionInstruction;
    try {
      const { ixs } = await buildManagedQuoteUpdateIxs(
        sb.qObj, sb.crossbar, feed, ctx.wallet.publicKey,
        { numSignatures: 2, instructionIdx: 1 },
      );
      const found = ixs.find((ix) => ix.programId.toBase58() === edPid);
      if (!found) throw new Error("no ed25519 ix in managed-update output");
      edIx = found;
    } catch (err) {
      ctx.log("info", "sb-oracle birth quote fetch/pack failed (retry next tick)", {
        feed: feedShort, err: String(err).slice(0, 140),
      });
      report.feedsErrored += 1;
      return;
    }

    // (b) [CU, ed25519(idx 1), initialize_vol_oracle(source=1, seed_vol, +SB accounts)].
    //     Cast `any` (DEFERRED-DEPLOY): the @app/idl/opta TYPE is stale for the SB
    //     surface (3-arg init + the init/push SB accounts not synced into
    //     app/src/idl) — the RUNTIME-loaded IDL has them. UN-`as any` post IDL sync.
    const birthIx = await (ctx.program.methods as any)
      .initializeVolOracle(feedIdBytes, 1, new BN(seedVol)) // oracle_source = Switchboard
      .accounts({
        initializer: ctx.wallet.publicKey,
        priceUpdate: null, // SB path: spot comes from the verified quote, not Pyth
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
        sbQueue: entry.queue,
        sbSlothashes: SPL_SYSVAR_SLOT_HASHES_ID,
        sbInstructions: SPL_SYSVAR_INSTRUCTIONS_ID, optaPriceFeed: null,
      })
      .instruction();
    const instructions = [cuLimitIx(), edIx, birthIx];

    const sim = await simulate(ctx, instructions);
    if (sim.err) {
      ctx.log("warn", "sb-oracle birth sim failed (retry next tick)", {
        feed: feedShort, err: JSON.stringify(sim.err),
      });
      report.feedsErrored += 1;
      return;
    }
    if (ctx.dryRun) {
      ctx.log("info", "WOULD-BIRTH sb vol-oracle (dry-run, NOT sent)", {
        feed: feedShort, pda: oraclePda.toBase58(), oracleSource: 1, seedVol, simOk: true,
      });
      report.feedsInitialized += 1;
      return;
    }
    const sig = await send(ctx, instructions);
    ctx.log("info", "sb-oracle birthed", { feed: feedShort, pda: oraclePda.toBase58(), seedVol, sig });
    report.feedsInitialized += 1;
  } catch (err) {
    ctx.log("error", "sb-oracle birth failed", { feed: feedShort, err: String(err) });
    report.feedsErrored += 1;
  }
}

// ---- Warming push (bounded retry-with-fresh-quote) -------------------------

async function warmingPushWithRetry(
  ctx: SbOracleCrankContext,
  sb: SbClients,
  entry: SbFeedEntry,
  oraclePda: PublicKey,
  feedShort: string,
  report: SbTickReport,
): Promise<void> {
  const feed = buildOracleFeed(entry);
  const edPid = Ed25519Program.programId.toBase58();

  for (let attempt = 1; attempt <= SB_PUSH_MAX_ATTEMPTS; attempt++) {
    if (ctx.shouldShutdown()) return;

    // (a) fetch a FRESH signed quote → corrected (self-packed) ed25519 ix.
    let edIx: TransactionInstruction;
    try {
      const { ixs } = await buildManagedQuoteUpdateIxs(
        sb.qObj, sb.crossbar, feed, ctx.wallet.publicKey,
        { numSignatures: 2, instructionIdx: 1 },
      );
      const found = ixs.find((ix) => ix.programId.toBase58() === edPid);
      if (!found) throw new Error("no ed25519 ix in managed-update output");
      edIx = found;
    } catch (err) {
      ctx.log("info", "sb-oracle quote fetch/pack failed (re-fetch fresh)", {
        feed: feedShort, attempt, err: String(err).slice(0, 140),
      });
      continue;
    }

    // (b) [CU, ed25519(idx 1), push_vol_sample(+SB accounts, price_update:null)].
    //     Cast to `any` — see birthSbOracle: the @app/idl/opta type is stale for
    //     the push SB account surface; the runtime-loaded IDL has it.
    const pushIx = await (ctx.program.methods as any)
      .pushVolSample()
      .accounts({
        signer: ctx.wallet.publicKey,
        priceUpdate: null,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
        sbQueue: entry.queue,
        sbSlothashes: SPL_SYSVAR_SLOT_HASHES_ID,
        sbInstructions: SPL_SYSVAR_INSTRUCTIONS_ID, optaPriceFeed: null,
      })
      .instruction();
    const instructions = [cuLimitIx(), edIx, pushIx];

    // (c) simulate-gate.
    const sim = await simulate(ctx, instructions);
    if (sim.err) {
      ctx.log("info", "sb-oracle push sim err (re-fetch fresh)", {
        feed: feedShort, attempt, err: JSON.stringify(sim.err),
      });
      continue;
    }

    if (ctx.dryRun) {
      ctx.log("info", "WOULD-SEND sb push (dry-run, NOT sent)", {
        feed: feedShort, pda: oraclePda.toBase58(), attempt,
        cuUnits: PUSH_CU_LIMIT, ed25519Bytes: edIx.data.length, simOk: true,
      });
      report.feedsPushed += 1;
      return;
    }

    try {
      const sig = await send(ctx, instructions);
      ctx.log("info", "sb-oracle push sent", { feed: feedShort, pda: oraclePda.toBase58(), sig });
      report.feedsPushed += 1;
    } catch (err) {
      // anti-blind-retry: a failed send re-fetches a fresh quote, never resends.
      ctx.log("info", "sb-oracle push send failed (re-fetch fresh)", {
        feed: feedShort, attempt, err: String(err).slice(0, 140),
      });
      continue;
    }
    return;
  }

  ctx.log("warn", "sb-oracle push failed after max attempts (retry next tick)", {
    feed: feedShort, attempts: SB_PUSH_MAX_ATTEMPTS,
  });
  report.feedsErrored += 1;
}

// ---- Settle-at-expiry pass (fast cadence) ----------------------------------

/**
 * Discover SB vaults that are expired-and-unsettled AND still inside the 300s
 * window, group by (asset, expiry), and settle each via the SB arm of
 * settle_expiry. Vaults past the window are counted (→ reclaim_unsettled, no
 * fund loss) but not chased. Fast-path no-op when there are no SB markets and no
 * forced targets (skips the sharedVault GPA — the common case until create-SB-
 * market deploys).
 */
export async function settleCheckTick(
  ctx: SbOracleCrankContext,
  sb: SbClients,
  sbMarkets: SbMarketRec[],
): Promise<SbSettleReport> {
  const report: SbSettleReport = {
    sbVaultsScanned: 0, settleTuplesInWindow: 0, settleTuplesPastWindow: 0,
    settled: 0, settleErrored: 0, archived: 0, archiveErrored: 0,
  };

  const targets = new Map<string, ForcedSettle>(); // key = asset:expiry

  if (sbMarkets.length > 0) {
    const marketByPda = new Map<string, SbMarketRec>();
    for (const m of sbMarkets) marketByPda.set(m.marketPda.toBase58(), m);
    const vaults = await safeFetchAll<any>(ctx.program, "sharedVault");
    const now = Math.floor(Date.now() / 1000);
    for (const v of vaults) {
      const mkt = marketByPda.get((v.account.market as PublicKey).toBase58());
      if (!mkt) continue;                       // not an SB market's vault
      report.sbVaultsScanned += 1;
      if (v.account.isSettled) continue;
      const expiry = typeof v.account.expiry === "number"
        ? v.account.expiry : v.account.expiry.toNumber();
      if (expiry >= now) continue;              // not expired yet
      if (now - expiry > SB_SETTLE_WINDOW_SECS) { // past window → reclaim path
        report.settleTuplesPastWindow += 1;
        continue;
      }
      targets.set(`${mkt.assetName}:${expiry}`, {
        asset: mkt.assetName, expiry, feedHashHex: mkt.feedHashHex,
      });
    }
  }

  // OPTA_SB_FORCE_SETTLE — synthetic targets (dry-run proof without a real vault).
  for (const f of ctx.forceSettles) targets.set(`${f.asset}:${f.expiry}`, f);

  report.settleTuplesInWindow = targets.size;
  if (targets.size === 0) return report;        // no-op (the common case)

  ctx.log("info", "sb-oracle settle-check: tuples in window", {
    inWindow: targets.size, pastWindow: report.settleTuplesPastWindow,
    forced: ctx.forceSettles.length,
  });

  for (const t of targets.values()) {
    if (ctx.shouldShutdown()) break;
    await settleSbTuple(ctx, sb, t, report);
  }

  // Settle-report log — surfaces settle + self-index counters for this pass.
  ctx.log("info", "sb-oracle settle-check complete", {
    settled: report.settled, settleErrored: report.settleErrored,
    archived: report.archived, archiveErrored: report.archiveErrored,
  });
  return report;
}

/**
 * Settle one (asset, expiry) tuple via the SB arm of settle_expiry. Bounded
 * retry-with-fresh-quote. The SB account set is IDENTICAL to the push arm
 * (queue/slothashes/instructions + on-chain-derived ed25519); only the non-SB
 * accounts differ (settlement_record/market/caller vs vol_oracle/signer).
 */
async function settleSbTuple(
  ctx: SbOracleCrankContext,
  sb: SbClients,
  t: ForcedSettle,
  report: SbSettleReport,
): Promise<void> {
  const entry = lookupSbFeed(t.feedHashHex);
  if (!entry) {
    ctx.log("warn", "sb-oracle settle skip: feedHash not in registry", {
      asset: t.asset, feed: t.feedHashHex.slice(0, 10),
    });
    report.settleErrored += 1;
    return;
  }
  const expiryBN = new BN(t.expiry);
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(t.asset)], ctx.program.programId);
  const [settlementPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SETTLEMENT_SEED), Buffer.from(t.asset), expiryBN.toArrayLike(Buffer, "le", 8)],
    ctx.program.programId);

  const feed = buildOracleFeed(entry);
  const edPid = Ed25519Program.programId.toBase58();
  const isForced = ctx.forceSettles.some((f) => f.asset === t.asset && f.expiry === t.expiry);

  for (let attempt = 1; attempt <= SB_SETTLE_MAX_ATTEMPTS; attempt++) {
    if (ctx.shouldShutdown()) return;

    // (a) fetch a FRESH signed quote → self-packed ed25519 ix (same as push).
    //     Keep `captured` (the verified oracle triples) in scope so a REAL
    //     confirmed settle below can archive a re-verifiable attestation.
    let edIx: TransactionInstruction;
    let captured: CapturedBuild | undefined;
    try {
      const { ixs, captured: cap } = await buildManagedQuoteUpdateIxs(
        sb.qObj, sb.crossbar, feed, ctx.wallet.publicKey,
        { numSignatures: 2, instructionIdx: 1 });
      const found = ixs.find((ix) => ix.programId.toBase58() === edPid);
      if (!found) throw new Error("no ed25519 ix in managed-update output");
      edIx = found;
      captured = cap;
    } catch (err) {
      ctx.log("info", "sb-oracle settle quote fetch/pack failed (re-fetch fresh)", {
        asset: t.asset, attempt, err: String(err).slice(0, 140),
      });
      continue;
    }

    // (b) [CU, ed25519(idx 1), settle_expiry(asset, expiry, +SB accounts)].
    //     Cast to `any` (same as push) — @app/idl/opta is stale for settle's SB
    //     accounts; the runtime-loaded IDL has them.
    const settleIx = await (ctx.program.methods as any)
      .settleExpiry(t.asset, expiryBN)
      .accounts({
        caller: ctx.wallet.publicKey,
        market: marketPda,
        priceUpdate: null,            // SB path → no Pyth account
        settlementRecord: settlementPda,
        systemProgram: SystemProgram.programId,
        sbQueue: entry.queue,
        sbSlothashes: SPL_SYSVAR_SLOT_HASHES_ID,
        sbInstructions: SPL_SYSVAR_INSTRUCTIONS_ID, optaPriceFeed: null,
      })
      .instruction();
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: SETTLE_CU_LIMIT }), edIx, settleIx,
    ];

    // (c) simulate-gate.
    const sim = await simulate(ctx, instructions);
    if (sim.err) {
      const errStr = JSON.stringify(sim.err);
      // A WIRING failure (SB accounts/ed25519/sysvar) would be a real bug — stop.
      if (/SwitchboardAccountsMissing|NoEd25519Instruction|InvalidSwitchboardSysvar/.test(errStr)) {
        ctx.log("error", "sb-oracle settle WIRING bug (SB accounts/ed25519)", {
          asset: t.asset, err: errStr.slice(0, 160),
        });
        report.settleErrored += 1;
        return;
      }
      // FORCED dry-run target has no real market → reverts at account load
      // (AccountNotInitialized) — EXPECTED; proves the tx is well-formed up to the
      // missing market (past the SB-account wiring).
      if (isForced) {
        ctx.log("info", "sb-oracle settle FORCED-PROOF: tx well-formed (reverts at missing market, NOT wiring)", {
          asset: t.asset, accounts: settleIx.keys.length, ed25519Bytes: edIx.data.length,
          simErr: errStr.slice(0, 120),
        });
        return;
      }
      ctx.log("info", "sb-oracle settle sim err (re-fetch fresh)", {
        asset: t.asset, attempt, err: errStr.slice(0, 160),
      });
      continue;
    }

    if (ctx.dryRun) {
      ctx.log("info", "WOULD-SEND sb settle (dry-run, NOT sent)", {
        asset: t.asset, expiry: t.expiry, attempt,
        accounts: settleIx.keys.length, ed25519Bytes: edIx.data.length, simOk: true,
      });
      report.settled += 1;
      return;
    }

    try {
      const sig = await send(ctx, instructions);
      ctx.log("info", "sb-oracle settle sent", { asset: t.asset, expiry: t.expiry, sig });
      report.settled += 1;

      // Self-index (Stage 3 Slice 3): archive a re-verifiable attestation for
      // this REAL confirmed settle. NON-THROWING — a failure here never
      // reverses or disrupts the settle; only the archive counters move.
      try {
        if (!captured) throw new Error("captured triples missing at archive time");
        const sr: any = await ctx.program.account.settlementRecord.fetch(settlementPda);
        const record = buildSbSettlementRecord({
          asset: t.asset,
          expiry: t.expiry,
          edIxData: edIx.data,
          captured,
          feedHashHex: t.feedHashHex,
          settlementPrice: Number(sr.settlementPrice),
          // For an SB market pyth_publish_time is REPURPOSED to hold recent_slot.
          recentSlot: Number(sr.pythPublishTime),
          settleTxSig: sig,
          queuePubkey: entry.queue.toBase58(),
          programId: entry.quoteProgram.toBase58(),
          marketPubkey: marketPda.toBase58(),
          settlementRecordPubkey: settlementPda.toBase58(),
          capturedAtIso: new Date().toISOString(),
        });
        const res = await archiveSbSettlement(record, {
          log: (m, f) => ctx.log("warn", m, f),
        });
        if (res.jsonlOk) report.archived += 1;
        if (!res.jsonlOk || !res.upstashOk) report.archiveErrored += 1;
      } catch (archErr) {
        report.archiveErrored += 1;
        ctx.log("warn", "sb-oracle settle archive failed (non-fatal)", {
          asset: t.asset, expiry: t.expiry, err: String(archErr).slice(0, 140),
        });
      }
    } catch (err) {
      ctx.log("info", "sb-oracle settle send failed (re-fetch fresh)", {
        asset: t.asset, attempt, err: String(err).slice(0, 140),
      });
      continue;
    }
    return;
  }

  ctx.log("warn", "sb-oracle settle failed after max attempts (→ reclaim_unsettled after 7d)", {
    asset: t.asset, attempts: SB_SETTLE_MAX_ATTEMPTS,
  });
  report.settleErrored += 1;
}

// ---- Tx helpers ------------------------------------------------------------

function cuLimitIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units: PUSH_CU_LIMIT });
}

async function buildTx(
  ctx: SbOracleCrankContext,
  instructions: TransactionInstruction[],
): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
  const bh = await ctx.connection.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: ctx.wallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions,
    }).compileToV0Message(),
  );
  return { tx, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
}

/** Build + simulate (sigVerify off, replace-blockhash). NEVER sends. */
async function simulate(
  ctx: SbOracleCrankContext,
  instructions: TransactionInstruction[],
): Promise<{ err: unknown; logs: string[] | null }> {
  const { tx } = await buildTx(ctx, instructions);
  const sim = await ctx.connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
  });
  return { err: sim.value.err, logs: sim.value.logs ?? null };
}

/** Sign + send + confirm. Only reached when !dryRun. */
async function send(
  ctx: SbOracleCrankContext,
  instructions: TransactionInstruction[],
): Promise<string> {
  const { tx, blockhash, lastValidBlockHeight } = await buildTx(ctx, instructions);
  tx.sign([ctx.wallet.payer]);
  const sig = await ctx.connection.sendTransaction(tx, { skipPreflight: false });
  const conf = await ctx.connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight }, "confirmed",
  );
  if (conf.value.err) throw new Error(`confirm err: ${JSON.stringify(conf.value.err)} sig=${sig}`);
  return sig;
}

// ---- Misc ------------------------------------------------------------------

async function sleepInterruptibly(totalMs: number, shouldStop: () => boolean): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0 && !shouldStop()) {
    const chunk = Math.min(remaining, SHUTDOWN_CHECK_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}

/** Parse OPTA_SB_FORCE_FEED (comma-separated feedHashes). */
export function parseForceFeeds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => normFeedHash(s.trim())).filter((s) => s.length === 64);
}

/** Parse OPTA_SB_FORCE_SETTLE (comma-separated `asset:expiry:feedHash` triples) —
 *  synthetic settle targets for dry-run proof without a discoverable SB vault. */
export function parseForceSettles(raw: string | undefined): ForcedSettle[] {
  if (!raw) return [];
  const out: ForcedSettle[] = [];
  for (const part of raw.split(",")) {
    const [asset, expiryRaw, feedRaw] = part.split(":").map((s) => s.trim());
    const expiry = parseInt(expiryRaw, 10);
    const feedHashHex = normFeedHash(feedRaw ?? "");
    if (asset && Number.isFinite(expiry) && feedHashHex.length === 64) {
      out.push({ asset, expiry, feedHashHex });
    }
  }
  return out;
}
