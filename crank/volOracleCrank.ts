// ============================================================================
// crank/volOracleCrank.ts -- Phase 2 Stage B VolOracle crank
// ============================================================================
//
// Hourly side-loop spawned by crank/bot.ts. Responsibilities:
//   1. Discover all assets (unique Pyth feed_ids) from on-chain OptionsMarket
//      accounts. Zero-touch: new asset registration -> next tick auto-includes.
//   2. For each unique feed_id, derive the VolOracle PDA. If it doesn't
//      exist, atomically `initialize_vol_oracle` + `push_vol_sample` (seed).
//      If it does exist, `push_vol_sample` (normal).
//   3. Log a structured outcome per asset; sleep until the next wall-clock
//      hour boundary (NOT setTimeout-from-now -- alignment matters so a
//      restart doesn't drift the schedule).
//
// Per Stage B locked-decisions: gaps are skipped, no backfill. A per-feed
// failure logs and continues to the next feed; the downstream staleness
// gate in `realized_vol_annualized` blocks unsafe reads.
//
// Owner: this file is the off-chain glue. All math, validation, and ring
// updates live on-chain (see programs/opta/src/instructions/push_vol_sample.rs
// and state/vol_oracle.rs). This module never touches sample bytes directly.
//
// Single-tick smoke path: set `TICK_ONCE=1` in the env to run exactly one
// tick and exit. Used for devnet rollout verification + future debugging.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { hexFromBytes } from "@app/utils/format";
import { VOL_ORACLE_SEED } from "@app/utils/constants";
import { seedVolForAssetClass } from "@app/utils/seedVol";
import {
  buildPostUpdateAndInitializeVolOracleTx,
  buildPostUpdateAndPushVolSampleTx,
  submitWithFallback,
  type SignerWallet,
} from "@app/utils/pythPullPost";
// SLICE 1 — the reactive fast-seed loop lives in its own module (the logic is
// substantial and independently testable); this file owns the hourly cadence
// and the shared in-flight hand-off between the two.
import { runFastSeedLoop, type FastSeedConfig } from "./volOracleFastSeed";
import { routeForSource } from "./settleRouting";

// ---- Types -----------------------------------------------------------------

export type VolCrankLogLevel = "info" | "warn" | "error" | "fatal";
export type VolCrankLogger = (
  level: VolCrankLogLevel,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface VolOracleCrankContext {
  connection: Connection;
  wallet: SignerWallet;
  program: anchor.Program<Opta>;
  hermesBase: string;
  log: VolCrankLogger;
  /** Polled between ticks + during interruptible sleep. */
  shouldShutdown: () => boolean;
}

export interface VolOracleCrankOptions {
  /** When true, run exactly one tick and return; for smoke testing. */
  tickOnce?: boolean;
  /** SLICE 1 fast-seed loop config. Omitted → env defaults (see fastSeedConfigFromEnv). */
  fastSeed?: FastSeedConfig;
}

export interface TickReport {
  feedsDiscovered: number;
  feedsInitialized: number;
  feedsPushed: number;
  feedsSkippedRateLimit: number;
  feedsSkippedStalePyth: number;
  feedsSkippedOther: number;
  feedsErrored: number;
  /** Stage 3: Switchboard-sourced markets dropped before discovery (this crank
   *  is Pyth-only; SB vol is sbOracleCrank's job). Keeps the skip visible. */
  marketsSkippedSb: number;
  /** First-party markets (oracle_source==2) left to optaVolCrank, and markets
   *  whose source byte is unknown and belong to no lane. */
  marketsSkippedOpta: number;
  marketsRefused: number;
  durationMs: number;
}

// ---- Constants -------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
/** Granularity at which interruptible sleep checks the shutdown flag. */
const SHUTDOWN_CHECK_MS = 5000;

// ---- Main loop -------------------------------------------------------------

/**
 * Long-running entry point. Spawned by crank/bot.ts inside the
 * fail-loud Promise.all wrapper. Returns only when shouldShutdown()
 * returns true OR when an upstream throw bubbles out of tickOnce()'s
 * own try/catch (which it shouldn't -- the per-tick handler logs and
 * swallows so the loop survives).
 */
export async function runVolOracleCrank(
  ctx: VolOracleCrankContext,
  options: VolOracleCrankOptions = {},
): Promise<void> {
  ctx.log("info", "vol-oracle crank started", {
    hermesBase: ctx.hermesBase,
    tickOnce: !!options.tickOnce,
  });

  if (options.tickOnce) {
    try {
      // TICK_ONCE exercises the HOURLY pass only. The fast-seed loop is a
      // continuous-mode construct (it is defined by its cadence); running one
      // of its ticks here would prove nothing the hourly pass doesn't.
      const report = await tickOnce(ctx);
      ctx.log("info", "vol-oracle crank exiting (TICK_ONCE)", { ...report });
    } catch (err) {
      // In TICK_ONCE mode we re-throw so the operator gets a non-zero exit.
      ctx.log("error", "vol-oracle TICK_ONCE crashed", { err: String(err) });
      throw err;
    }
    return;
  }

  // Continuous mode. Tick first thing on boot so the operator sees activity
  // immediately (and new assets get initialized without an hour-long wait).
  // Then align to the next wall-clock hour boundary.
  await runTickWithGuard(ctx);

  // SLICE 1 — the two loops share ONE `inFlight` set so the hourly pass and the
  // fast-seed loop can never both submit an init for the same feed inside this
  // process. Cross-process races (a second crank, an operator script) are caught
  // by the fast loop's post-failure existence re-check, not by this set.
  const inFlight = new Set<string>();

  await Promise.all([
    runHourlyLoop(ctx, inFlight),
    runFastSeedLoop(ctx, inFlight, options.fastSeed),
  ]);

  ctx.log("info", "vol-oracle crank stopped cleanly");
}

/** The original hourly cadence, extracted verbatim so the fast loop can run
 *  beside it. Behaviour unchanged bar the shared `inFlight` hand-off. */
async function runHourlyLoop(
  ctx: VolOracleCrankContext,
  inFlight: Set<string>,
): Promise<void> {
  while (!ctx.shouldShutdown()) {
    const sleepMs = msUntilNextHourBoundary(Date.now());
    ctx.log("info", "vol-oracle crank sleeping until next hour boundary", {
      sleepMs,
      wakeAt: new Date(Date.now() + sleepMs).toISOString(),
    });
    await sleepInterruptibly(sleepMs, ctx.shouldShutdown);
    if (ctx.shouldShutdown()) break;
    await runTickWithGuard(ctx, inFlight);
  }
}

/** Wrapper that logs + swallows tick-level exceptions so the loop survives. */
async function runTickWithGuard(
  ctx: VolOracleCrankContext,
  inFlight?: Set<string>,
): Promise<void> {
  try {
    await tickOnce(ctx, inFlight);
  } catch (err) {
    ctx.log("error", "vol-oracle tick crashed (will retry next hour)", {
      err: String(err),
      stack: (err as any)?.stack,
    });
  }
}

// ---- One tick --------------------------------------------------------------

/**
 * One pass: discover -> dedupe -> per-feed init-or-push -> log report.
 * Exported for the TICK_ONCE smoke path and future test harness use.
 *
 * Per-feed failures are isolated (one bad feed doesn't block the others).
 * Per-tick failures (e.g., RPC enumeration fails) bubble up to the loop's
 * try/catch.
 */
export async function tickOnce(
  ctx: VolOracleCrankContext,
  /** SLICE 1: feeds the fast-seed loop is mid-init on. A feed in this set is
   *  SKIPPED by this pass's init branch — the other loop owns it this instant.
   *  Optional so TICK_ONCE and the existing tests call in unchanged. */
  inFlight?: Set<string>,
): Promise<TickReport> {
  const startMs = Date.now();
  const report: TickReport = {
    feedsDiscovered: 0,
    feedsInitialized: 0,
    feedsPushed: 0,
    feedsSkippedRateLimit: 0,
    feedsSkippedStalePyth: 0,
    feedsSkippedOther: 0,
    feedsErrored: 0,
    marketsSkippedSb: 0,
    marketsSkippedOpta: 0,
    marketsRefused: 0,
    durationMs: 0,
  };

  // Discover via safeFetchAll: raw getProgramAccounts + discriminator
  // memcmp + per-account decode with shape filtering. The hardened
  // pattern that handles HANDOFF §11 orphan accounts cleanly.
  const allMarkets = await safeFetchAll<any>(ctx.program, "optionsMarket");
  // Stage 3 guard: the Pyth vol crank must NEVER touch a Switchboard-sourced
  // market (oracle_source==1) — it would corrupt or fail the SB VolOracle PDA
  // (see partitionPythMarkets). Mirror the Pyth settle-loop skip in bot.ts.
  const { pyth: markets, skippedSb, skippedOpta, refused } = partitionPythMarkets(allMarkets);
  report.marketsSkippedSb = skippedSb;
  report.marketsSkippedOpta = skippedOpta;
  report.marketsRefused = refused;
  const allFeeds: number[][] = markets.map(
    (m) => m.account.pythFeedId as number[],
  );
  const uniqueFeeds = dedupeFeedIds(allFeeds);
  report.feedsDiscovered = uniqueFeeds.length;

  // feedHash → asset_class (first market per feed wins; markets that share a
  // feed agree on class in practice). Drives the per-class day-0 seed_vol that
  // initialize_vol_oracle now seeds at birth (instant-tradeable arc).
  const classByFeed = new Map<string, number>();
  for (const m of markets) {
    const hex = hexFromBytes(m.account.pythFeedId as number[]);
    if (!classByFeed.has(hex)) classByFeed.set(hex, m.account.assetClass as number);
  }

  ctx.log("info", "vol-oracle tick: discovered feeds", {
    markets: markets.length,
    marketsSkippedSb: report.marketsSkippedSb,
    marketsSkippedOpta: report.marketsSkippedOpta,
    marketsRefused: report.marketsRefused,
    uniqueFeeds: uniqueFeeds.length,
  });

  for (const feedIdBytes of uniqueFeeds) {
    if (ctx.shouldShutdown()) break;
    // Resolve the per-class day-0 seed_vol for this feed. Skip (log, don't crash
    // the loop) if the class is unresolved — shouldn't happen (asset_class is
    // bounded 0-4 at create), but a missing class must not seed 0 (= "no seed").
    let seedVol: number;
    try {
      seedVol = seedVolForAssetClass(classByFeed.get(hexFromBytes(feedIdBytes)) as number);
    } catch (err) {
      ctx.log("warn", "vol-oracle skip: unresolved seed_vol for feed", {
        feed: hexFromBytes(feedIdBytes).slice(0, 8),
        err: String(err),
      });
      continue;
    }
    await processOneFeed(ctx, feedIdBytes, seedVol, report, inFlight);
  }

  report.durationMs = Date.now() - startMs;
  ctx.log("info", "vol-oracle tick complete", { ...report });
  return report;
}

async function processOneFeed(
  ctx: VolOracleCrankContext,
  feedIdBytes: number[],
  seedVol: number,
  report: TickReport,
  inFlight?: Set<string>,
): Promise<void> {
  const feedIdHex = hexFromBytes(feedIdBytes);
  const feedShort = feedIdHex.slice(0, 8);
  const [oraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedIdBytes)],
    ctx.program.programId,
  );

  // Existence check decides init-vs-push branch.
  let existing: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    existing = await ctx.connection.getAccountInfo(oraclePda);
  } catch (err) {
    ctx.log("error", "vol-oracle existence check failed", {
      feed: feedShort,
      pda: oraclePda.toBase58(),
      err: String(err),
    });
    report.feedsErrored += 1;
    return;
  }

  if (!existing) {
    // SLICE 1 collision guard. The fast-seed loop may be mid-init on this exact
    // feed right now (it read the same "missing" state seconds ago). Anchor's
    // plain `init` would make the loser revert "already in use", which is a
    // correct on-chain outcome but a spurious ERROR in the crank's log stream —
    // and this pass would then count it under feedsErrored, which is what a
    // monitor pages on. Skipping is free: the fast loop will finish the init,
    // and this feed's first push lands on the next hourly pass.
    if (inFlight?.has(feedIdHex)) {
      ctx.log("info", "vol-oracle init skipped (fast-seed loop owns this feed)", {
        feed: feedShort,
        pda: oraclePda.toBase58(),
      });
      report.feedsSkippedOther += 1;
      return;
    }

    // -------- Init + immediate seed --------
    // Two txs back-to-back. The seed push goes through the seed branch
    // (last_spot_price == 0) which skips the rate-limit check, so they
    // can fire instantaneously without VolOraclePushTooSoon. Doing the
    // seed now (instead of waiting for the next hourly tick) saves one
    // hour off the 7-day warmup countdown for new assets.
    try {
      const initTxs = await buildPostUpdateAndInitializeVolOracleTx(
        ctx.program,
        ctx.wallet,
        feedIdHex,
        seedVol,
        ctx.hermesBase,
      );
      const initSig = await submitWithFallback(ctx.connection, ctx.wallet, initTxs);
      ctx.log("info", "vol-oracle init", {
        feed: feedShort,
        pda: oraclePda.toBase58(),
        sig: initSig,
      });
      report.feedsInitialized += 1;
    } catch (err) {
      ctx.log("error", "vol-oracle init failed", {
        feed: feedShort,
        pda: oraclePda.toBase58(),
        err: String(err),
      });
      report.feedsErrored += 1;
      return;
    }
    // Seed push (separate try; init may have succeeded even if seed fails)
    try {
      const pushTxs = await buildPostUpdateAndPushVolSampleTx(
        ctx.program,
        ctx.wallet,
        feedIdHex,
        ctx.hermesBase,
      );
      const pushSig = await submitWithFallback(ctx.connection, ctx.wallet, pushTxs);
      ctx.log("info", "vol-oracle seed-push", {
        feed: feedShort,
        pda: oraclePda.toBase58(),
        sig: pushSig,
        note: "warmup starts now: 168 hourly samples (~7 days) required",
      });
      report.feedsPushed += 1;
    } catch (err) {
      // Init succeeded; seed will retry on next tick (rate limit doesn't
      // fire because last_spot_price is still 0).
      ctx.log("warn", "vol-oracle seed-push failed (next tick retries)", {
        feed: feedShort,
        err: String(err),
      });
      report.feedsErrored += 1;
    }
    return;
  }

  // -------- Normal push --------
  try {
    const pushTxs = await buildPostUpdateAndPushVolSampleTx(
      ctx.program,
      ctx.wallet,
      feedIdHex,
      ctx.hermesBase,
    );
    const sig = await submitWithFallback(ctx.connection, ctx.wallet, pushTxs);
    ctx.log("info", "vol-oracle push", {
      feed: feedShort,
      pda: oraclePda.toBase58(),
      sig,
    });
    report.feedsPushed += 1;
  } catch (err) {
    const cls = classifyPushError(err);
    const level: VolCrankLogLevel = cls === "other" ? "warn" : "info";
    ctx.log(level, "vol-oracle push skipped", {
      feed: feedShort,
      pda: oraclePda.toBase58(),
      class: cls,
      err: String(err),
    });
    switch (cls) {
      case "rate-limit":
        report.feedsSkippedRateLimit += 1;
        break;
      case "stale-pyth":
        report.feedsSkippedStalePyth += 1;
        break;
      default:
        report.feedsSkippedOther += 1;
    }
  }
}

// ---- Helpers (exported for unit tests) -------------------------------------

/**
 * Stage 3 guard: partition fetched markets into the Pyth-sourced set this crank
 * serves, dropping Switchboard-sourced markets (oracle_source==1). SB markets
 * store their SB feedHash in pyth_feed_id, which derives the SAME VolOracle PDA
 * ([b"vol_oracle", feed_id]) that sbOracleCrank owns — so a Pyth push here would
 * either win an init race and seed a Pyth-source oracle (corruption) or be
 * rejected by push_vol_sample's SB arm. See runTick.
 */
export function partitionPythMarkets<T extends { account: { oracleSource?: number } }>(
  markets: T[],
): { pyth: T[]; skippedSb: number; skippedOpta: number; refused: number } {
  // Routed, not "everything that is not Switchboard": a first-party market
  // (oracle_source==2) has its own lane (optaVolCrank) and an unknown byte has
  // none. Both used to fall through to this lane (ops ledger 66).
  const pyth: T[] = [];
  let skippedSb = 0, skippedOpta = 0, refused = 0;
  for (const m of markets) {
    const route = routeForSource(m.account.oracleSource);
    if (route === "pyth") pyth.push(m);
    else if (route === "switchboard") skippedSb += 1;
    else if (route === "opta") skippedOpta += 1;
    else refused += 1;
  }
  return { pyth, skippedSb, skippedOpta, refused };
}

/**
 * Dedupe a list of 32-byte feed_ids. Multiple OptionsMarket accounts can
 * share a feed_id (e.g. SOL-CALL and SOL-PUT markets both point at the
 * same SOL/USD feed); we only need one VolOracle per feed.
 *
 * Key is the lowercase hex of the bytes; preserves first-seen ordering
 * so tick logs are stable.
 */
export function dedupeFeedIds(feeds: number[][]): number[][] {
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const f of feeds) {
    if (!Array.isArray(f) || f.length !== 32) continue;
    const key = Buffer.from(f).toString("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Milliseconds until the next wall-clock hour boundary. Used to align
 * the crank cadence so a restart at minute 23 still fires at minute 0
 * of the next hour, not at minute 23 of the next hour.
 *
 * Edge: when called exactly at a boundary (remainder == 0) returns a
 * full HOUR_MS so we don't fire twice in the same second.
 *
 * Pure function -- exported for unit tests.
 */
export function msUntilNextHourBoundary(nowMs: number): number {
  const remainder = nowMs % HOUR_MS;
  const sleep = HOUR_MS - remainder;
  return sleep === HOUR_MS && remainder === 0 ? HOUR_MS : sleep;
}

/** Classify a push_vol_sample revert into a coarse-grained category for logs. */
function classifyPushError(
  err: unknown,
): "rate-limit" | "stale-pyth" | "other" {
  const s = String(err);
  if (s.includes("VolOraclePushTooSoon")) return "rate-limit";
  if (s.includes("VolOraclePriceStale")) return "stale-pyth";
  return "other";
}

/** Sleep `totalMs` but wake every SHUTDOWN_CHECK_MS to check the flag. */
async function sleepInterruptibly(
  totalMs: number,
  shouldStop: () => boolean,
): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0 && !shouldStop()) {
    const chunk = Math.min(remaining, SHUTDOWN_CHECK_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}
