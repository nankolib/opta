// ============================================================================
// crank/fpOracleCrank.ts — the first-party oracle push lane
// ============================================================================
//
// Fetch a median from the PUSH venues, write it on-chain, then independently
// re-derive a reference from the VERIFY venues and record both. The verification
// is not a nice-to-have bolted on at the end of the soak — it is the artifact the
// soak is judged on (S3/S4/S10), so it is written on every single tick, in the
// same code path as the push, and a push whose verification could not be
// computed is recorded as such rather than quietly counted as fine.
//
// WHAT THIS LANE WILL NOT DO
//   - It will not push a thin sample. <3 responders on the push side aborts the
//     tick. A "median" of two disagreeing venues is a number nobody quoted.
//   - It will not push a disagreeing sample. Spread beyond MAX_PUSH_SPREAD_BPS
//     aborts the tick: when venues disagree that badly, one of them is wrong and
//     we do not get to guess which.
//   - It will not verify against its own sources. Enforced at module load by
//     fpOracleRegistry's assertDisjoint(), not by convention here.
//   - It will not send unless explicitly told to. OPTA_FP_DRY_RUN defaults ON.
//
// GATES (mirror the SB lane's shape so ops muscle memory transfers):
//   OPTA_FP_CRANK_DISABLED=1  → bot/unit skips this loop entirely.
//   OPTA_FP_DRY_RUN (default "1" = ON) → fetch + build + simulate + log, NEVER send.
//   OPTA_FP_FORCE_FEED=<hex[,hex]> → restrict the tick to these feeds.
//   OPTA_FP_INTERVAL_MS (default 60000) → tick cadence.
//   OPTA_FP_JSONL (default <stateDir>/fp-oracle-samples.jsonl) → the soak artifact.
//
// RESEED REPORTING. A push landing more than RESEED_GAP_SECS after the previous
// one is flagged `reseed: true` in the JSONL and logged distinctly. The on-chain
// program emits its own `reseed:` log for the same condition. Both exist because
// a reseed is held to the same 50 bps verify gate as any other sample, and a
// reseed you cannot identify is a reseed you cannot check.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";

import {
  FP_FEEDS, lookupFpFeed, normFeedHash, resolvePath, median, spreadBps,
  type FpFeedEntry, type SourceSpec,
} from "./fpOracleRegistry";

// ---- tunables ---------------------------------------------------------------

/** Hard floor on responders per side. Not configurable: below 3 a median is an
 *  average, and S10's verification stops meaning anything. */
export const MIN_RESPONDERS = 3;
/** Abort the tick if the push venues disagree by more than this. */
export const MAX_PUSH_SPREAD_BPS = 200;
/** Mirrors OPTA_FEED_RESEED_GAP_SECS on-chain. Reporting only. */
export const RESEED_GAP_SECS = 900;
/** Per-request timeout. A slow venue must not stall the whole tick. */
export const FETCH_TIMEOUT_MS = 6_000;
/** The GLOBAL S3 accuracy gate, kept as the ceiling no per-feed gate may exceed
 *  (registry check). The gate actually recorded per sample is
 *  `entry.verifyGateBps` (D3, per feed). Not enforced here -- the crank does not
 *  get to decide its own soak result. */
export const VERIFY_GATE_BPS = 50;
/** VERIFY-QUALITY GATE (D3 ruling (b), 2026-09-18). When the verify venues
 *  disagree among THEMSELVES by more than this, the reference median is not a
 *  reliable measurement of anything and the S3 gate is NOT evaluated for the
 *  tick: within_gate = null, reference_unreliable = true. The push still goes
 *  out (the push side is judged by MAX_PUSH_SPREAD_BPS, separately). Chosen
 *  from the soak: every XRP delta over 19 bps had verify_spread 20-45 while
 *  push_spread was tight; the other four feeds never exceeded 12 at their
 *  worst samples. Without this a 2x-max re-fit reads the reference's noise as
 *  the feed's error and loosens the gate (XRP: 90). */
export const VERIFY_QUALITY_MAX_SPREAD_BPS = 20;

export const OPTA_PRICE_FEED_SEED = "opta_price_feed";

// ---- types ------------------------------------------------------------------

// "debug" is for absorbed, non-actionable conditions that must stay greppable
// without becoming journal noise -- e.g. the web3.js transport rejection the
// push path plugs at source (see fpOracleMain.ts / ledger section 22).
export type FpLogLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type FpLogger = (level: FpLogLevel, msg: string, fields?: Record<string, unknown>) => void;

export interface FpCrankContext {
  connection: Connection;
  /** anchor.Wallet whose payer is the ORACLE AUTHORITY, never the admin. */
  wallet: anchor.Wallet;
  program: anchor.Program<any>;
  log: FpLogger;
  shouldShutdown: () => boolean;
  dryRun: boolean;
  forceFeeds: string[];
  jsonlPath: string;
  intervalMs: number;
}

/** One line of the soak artifact. */
export interface SampleRecord {
  ts: string;
  feed: string;
  symbol: string;
  pushed_price: number | null;
  reference_median: number | null;
  bps_delta: number | null;
  within_gate: boolean | null;
  gate_bps: number;
  push_sources: string[];
  push_values: number[];
  push_spread_bps: number | null;
  verify_sources: string[];
  verify_values: number[];
  verify_spread_bps: number | null;
  /** True when verify_spread_bps > VERIFY_QUALITY_MAX_SPREAD_BPS; within_gate is null then. */
  reference_unreliable: boolean;
  reseed: boolean;
  gap_secs: number | null;
  status: "sent" | "dry-run" | "aborted" | "failed";
  reason?: string;
  sig?: string;
}

export interface FpTickReport {
  feedsConsidered: number;
  pushed: number;
  aborted: number;
  failed: number;
  reseeds: number;
  outsideGate: number;
  /** Ticks whose reference failed the verify-quality gate (S3 not evaluated). */
  referenceUnreliable: number;
  durationMs: number;
}

// ---- fetching ---------------------------------------------------------------

interface Quote { id: string; value: number }

async function fetchOne(s: SourceSpec): Promise<Quote | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(s.url, { signal: ac.signal, headers: { "User-Agent": "opta-fp-oracle/1" } });
    if (!r.ok) return null;
    const v = Number(resolvePath(await r.json(), s.path));
    return Number.isFinite(v) && v > 0 ? { id: s.id, value: v } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** All sources in parallel; failures drop out rather than failing the set. */
async function fetchSide(sources: SourceSpec[]): Promise<Quote[]> {
  const out = await Promise.all(sources.map(fetchOne));
  return out.filter((q): q is Quote => q !== null);
}

// ---- JSONL ------------------------------------------------------------------

function appendSample(p: string, rec: SampleRecord, log: FpLogger): void {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf-8");
  } catch (e) {
    // A lost artifact line is a lost soak sample, so this is a real warning —
    // but it must never take the lane down. S2 counts landed pushes, and a push
    // that landed is still a push even if we failed to write it down.
    log("warn", "fp-oracle: JSONL append failed", { err: String(e), path: p });
  }
}

// ---- one feed, one tick -----------------------------------------------------

export async function tickFeed(
  ctx: FpCrankContext,
  entry: FpFeedEntry,
  report: FpTickReport,
): Promise<void> {
  const feedHex = normFeedHash(entry.feedHashHex);
  const feedBytes = Array.from(Buffer.from(feedHex, "hex"));
  const [feedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(OPTA_PRICE_FEED_SEED), Buffer.from(feedBytes)],
    ctx.program.programId,
  );

  const base = {
    ts: new Date().toISOString(),
    feed: feedHex.slice(0, 10),
    symbol: entry.symbol,
    gate_bps: entry.verifyGateBps,
  };

  // BOTH sides are fetched every tick, and they are fetched CONCURRENTLY and
  // BEFORE the send. Fetching the reference after the push would compare the
  // pushed price against a market that has since moved, which quietly inflates
  // every bps_delta in the artifact.
  const [pushQ, verifyQ] = await Promise.all([
    fetchSide(entry.push),
    fetchSide(entry.verify),
  ]);

  const pushVals = pushQ.map((q) => q.value);
  const verifyVals = verifyQ.map((q) => q.value);
  const pushSpread = pushVals.length >= 2 ? spreadBps(pushVals) : null;
  const verifySpread = verifyVals.length >= 2 ? spreadBps(verifyVals) : null;
  const refUnreliable = verifySpread !== null && verifySpread > VERIFY_QUALITY_MAX_SPREAD_BPS;

  const abort = (reason: string): void => {
    report.aborted += 1;
    ctx.log("warn", "fp-oracle: tick aborted", { feed: base.feed, symbol: entry.symbol, reason });
    appendSample(ctx.jsonlPath, {
      ...base, pushed_price: null, reference_median: null, bps_delta: null,
      within_gate: null,
      push_sources: pushQ.map((q) => q.id), push_values: pushVals, push_spread_bps: pushSpread,
      verify_sources: verifyQ.map((q) => q.id), verify_values: verifyVals, verify_spread_bps: verifySpread, reference_unreliable: refUnreliable,
      reseed: false, gap_secs: null, status: "aborted", reason,
    }, ctx.log);
  };

  if (pushQ.length < MIN_RESPONDERS) {
    return abort(`push responders ${pushQ.length} < ${MIN_RESPONDERS}`);
  }
  if (pushSpread !== null && pushSpread > MAX_PUSH_SPREAD_BPS) {
    return abort(`push spread ${pushSpread.toFixed(1)}bps > ${MAX_PUSH_SPREAD_BPS}`);
  }

  const price = median(pushVals);
  const price6dec = Math.round(price * 1e6);
  // Confidence = half the observed push spread, in the same 6-dec unit. An
  // honest self-report: it is exactly how much our own sources disagreed, and
  // the on-chain read gate gets to reject it if that is too wide.
  const conf6dec = Math.max(
    1,
    Math.round(((Math.max(...pushVals) - Math.min(...pushVals)) / 2) * 1e6),
  );

  // Reference from the DISJOINT verify set. Recorded even when thin — a missing
  // reference must be visible in the artifact, never silently absent.
  const refMedian = verifyQ.length >= MIN_RESPONDERS ? median(verifyVals) : null;
  const bpsDelta = refMedian !== null && refMedian > 0
    ? Math.abs(price - refMedian) / refMedian * 10_000
    : null;
  // Per-feed gate (D3), and NOT evaluated at all when the reference is itself
  // unreliable (verify-quality gate) -- a null here is "could not judge", which
  // is a different fact from "outside the gate" and is counted separately.
  const withinGate = bpsDelta === null || refUnreliable ? null : bpsDelta <= entry.verifyGateBps;
  if (refUnreliable) {
    report.referenceUnreliable += 1;
    ctx.log("info", "fp-oracle: reference UNRELIABLE — verify venues disagree beyond the quality floor; S3 not evaluated this tick", {
      feed: base.feed, symbol: entry.symbol, verifySpread: verifySpread?.toFixed(1),
      floor: VERIFY_QUALITY_MAX_SPREAD_BPS, bpsDelta: bpsDelta?.toFixed(1),
    });
  }

  // Prior on-chain state, for reseed classification and a local pre-check.
  let gapSecs: number | null = null;
  let reseed = false;
  try {
    const acct: any = await (ctx.program.account as any).optaPriceFeed.fetch(feedPda);
    const prevPublish = Number(acct.publishTime);
    if (prevPublish > 0) {
      gapSecs = Math.floor(Date.now() / 1000) - prevPublish;
      reseed = gapSecs > RESEED_GAP_SECS;
    }
  } catch {
    // No feed account yet — genesis. Deliberately NOT auto-pushed: the genesis
    // price is the one value the breaker can never check, so it is a ceremony
    // (spec 4.2b), not a crank action.
    return abort("feed PDA absent — genesis is a ceremony, not a crank push");
  }

  const publishTime = Math.floor(Date.now() / 1000);
  const rec: SampleRecord = {
    ...base,
    pushed_price: price,
    reference_median: refMedian,
    bps_delta: bpsDelta,
    within_gate: withinGate,
    push_sources: pushQ.map((q) => q.id),
    push_values: pushVals,
    push_spread_bps: pushSpread,
    verify_sources: verifyQ.map((q) => q.id),
    verify_values: verifyVals,
    verify_spread_bps: verifySpread, reference_unreliable: refUnreliable,
    reseed,
    gap_secs: gapSecs,
    status: ctx.dryRun ? "dry-run" : "sent",
  };

  if (reseed) {
    report.reseeds += 1;
    // Distinct from a normal push, at warn, carrying the reference — a reseed is
    // an unguarded-ish moment (the band is wide) and the soak holds it to the
    // same 50 bps gate as everything else.
    ctx.log("warn", "fp-oracle: RESEED", {
      feed: base.feed, symbol: entry.symbol, gapSecs,
      price, refMedian, bpsDelta: bpsDelta?.toFixed(1), withinGate,
    });
  }
  if (withinGate === false) {
    report.outsideGate += 1;
    ctx.log("warn", "fp-oracle: sample OUTSIDE verify gate (S3 breach candidate)", {
      feed: base.feed, symbol: entry.symbol,
      price, refMedian, bpsDelta: bpsDelta?.toFixed(1), gate: entry.verifyGateBps,
    });
  }

  const ix = await ctx.program.methods
    .pushOptaPrice(feedBytes, new BN(price6dec), new BN(conf6dec), new BN(publishTime))
    .accountsStrict({ authority: ctx.wallet.publicKey, optaPriceFeed: feedPda })
    .instruction();
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 });

  if (ctx.dryRun) {
    ctx.log("info", "fp-oracle: WOULD-PUSH (dry-run, NOT sent)", {
      feed: base.feed, symbol: entry.symbol, price, conf: conf6dec / 1e6,
      refMedian, bpsDelta: bpsDelta?.toFixed(1), withinGate, reseed,
      pushSources: rec.push_sources, verifySources: rec.verify_sources,
    });
    report.pushed += 1;
    appendSample(ctx.jsonlPath, rec, ctx.log);
    return;
  }

  try {
    const sig = await ctx.program.provider.sendAndConfirm!(
      new (await import("@solana/web3.js")).Transaction().add(cu, ix),
      [],
      { commitment: "confirmed" },
    );
    rec.sig = sig;
    report.pushed += 1;
    ctx.log("info", "fp-oracle: push sent", {
      feed: base.feed, symbol: entry.symbol, price, sig,
      bpsDelta: bpsDelta?.toFixed(1), withinGate,
    });
  } catch (e) {
    rec.status = "failed";
    rec.reason = String(e).slice(0, 300);
    report.failed += 1;
    ctx.log("warn", "fp-oracle: push failed", {
      feed: base.feed, symbol: entry.symbol, err: rec.reason,
    });
  }
  appendSample(ctx.jsonlPath, rec, ctx.log);
}

// ---- the loop ---------------------------------------------------------------

export async function runFpOracleTick(ctx: FpCrankContext): Promise<FpTickReport> {
  const t0 = Date.now();
  const report: FpTickReport = {
    feedsConsidered: 0, pushed: 0, aborted: 0, failed: 0,
    reseeds: 0, outsideGate: 0, referenceUnreliable: 0, durationMs: 0,
  };
  const wanted = ctx.forceFeeds.length > 0
    ? ctx.forceFeeds.map((h) => lookupFpFeed(h)).filter((f): f is FpFeedEntry => !!f)
    : FP_FEEDS;
  report.feedsConsidered = wanted.length;

  for (const entry of wanted) {
    if (ctx.shouldShutdown()) break;
    try {
      await tickFeed(ctx, entry, report);
    } catch (e) {
      // Per-feed crash isolation: one broken feed must not cost the other four
      // their tick.
      report.failed += 1;
      ctx.log("error", "fp-oracle: feed tick crashed", {
        symbol: entry.symbol, err: String(e),
      });
    }
  }
  report.durationMs = Date.now() - t0;
  return report;
}

export async function runFpOracleCrank(ctx: FpCrankContext, opts: { tickOnce?: boolean } = {}): Promise<void> {
  ctx.log("info", "fp-oracle crank started", {
    dryRun: ctx.dryRun,
    feeds: (ctx.forceFeeds.length > 0 ? ctx.forceFeeds.length : FP_FEEDS.length),
    intervalMs: ctx.intervalMs,
    jsonl: ctx.jsonlPath,
    authority: ctx.wallet.publicKey.toBase58(),
    minResponders: MIN_RESPONDERS,
    maxPushSpreadBps: MAX_PUSH_SPREAD_BPS,
    verifyGateBps: VERIFY_GATE_BPS,
  });

  for (;;) {
    if (ctx.shouldShutdown()) break;
    try {
      const r = await runFpOracleTick(ctx);
      ctx.log("info", "fp-oracle tick complete", { ...r });
    } catch (e) {
      ctx.log("error", "fp-oracle tick crashed (will retry next interval)", { err: String(e) });
    }
    if (opts.tickOnce) break;
    await new Promise((res) => setTimeout(res, ctx.intervalMs));
  }
  ctx.log("info", "fp-oracle crank stopped cleanly");
}
