// ============================================================================
// crank/volOracleFastSeed.ts -- SLICE 1: reactive VolOracle seeding
// ============================================================================
//
// THE GAP THIS CLOSES. `create_market` is permissionless and instant, but a
// market is unwritable until its VolOracle PDA exists: /write's volOracleBlock
// gate (app/src/pages/write/terminal/useWriteController.ts:254-260) disables
// submit, and mint_from_vault would revert 3007 anyway. Until now the ONLY
// thing that created that PDA was volOracleCrank's hourly pass, aligned to the
// wall-clock hour -- so a market created at 14:01 was dead until 15:00.
//
// useVolOracleStatus.ts:19-22 claims a "W2" reactive seeder already closes this
// window "from hours to seconds" via onLogs(MarketCreated). It does not exist:
// there is no MarketCreated event in the program (create_market.rs emits only
// msg!) and no listener anywhere in this repo. This module is that promise,
// built the way the program actually allows -- by polling, because there is no
// event to subscribe to and adding one is a program change this slice avoids.
//
// SCOPE: Pyth-sourced markets ONLY, the same partition the hourly pass enforces
// (see partitionPythMarkets). Not a limitation in practice -- a Switchboard
// create is gated to the ~23 curated feeds (crank/sbCreateMarketEndpoint.ts
// rejects anything else), every one of which already has an oracle, so an SB
// market is born instantly writable. The reachable 60-minute gap is exactly the
// Pyth set: every non-curated asset a user can actually create.
//
// WHAT SEEDING COSTS. initialize_vol_oracle is NOT price-free -- it reads spot
// from the same quote that proves feed existence and stores it, because
// price_american gates on spot + freshness BEFORE it reads vol. So this module
// does the identical Hermes-backed two-tx build the hourly pass does
// (buildPostUpdateAndInitializeVolOracleTx). A feed whose Hermes price is
// unavailable -- an equity outside NYSE hours -- CANNOT be seeded, by physics
// rather than policy. Hence the per-feed backoff: an unseedable feed degrades
// to a slow retry instead of hammering Hermes every two minutes forever.
//
// POLL COST. Steady state is ONE small getAccountInfo per tick.
// ProtocolState.total_markets is a monotonic counter bumped once per first
// create_market (create_market.rs:185-189), so an unchanged watermark proves no
// market was born and the expensive enumeration is skipped entirely. A full
// sweep runs anyway every OPTA_VOL_FAST_SWEEP_MS, so a watermark we mis-read
// costs latency, never correctness. Measured against devnet 2026-08-11:
// watermark read 123 B / ~385 ms; full enumeration 464 accounts / 39.9 KB /
// ~641 ms.
// ============================================================================

import { PublicKey } from "@solana/web3.js";

import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { hexFromBytes } from "@app/utils/format";
import { PROTOCOL_SEED, VOL_ORACLE_SEED } from "@app/utils/constants";
import { seedVolForAssetClass } from "@app/utils/seedVol";
import {
  buildPostUpdateAndInitializeVolOracleTx,
  submitWithFallback,
} from "@app/utils/pythPullPost";

// Type-only import: erased at compile time, so this does NOT create a runtime
// import cycle with volOracleCrank.ts (which imports runFastSeedLoop from here).
import type { VolCrankLogger, VolOracleCrankContext } from "./volOracleCrank";
import { routeForSource } from "./settleRouting";

/** Granularity at which interruptible sleep checks the shutdown flag. */
const SHUTDOWN_CHECK_MS = 5000;

// ---- Config ----------------------------------------------------------------

/** Tunables for the fast-seed loop. All env-overridable. */
export interface FastSeedConfig {
  /** Poll cadence. OPTA_VOL_FAST_POLL_MS, default 120_000 (2 min). */
  pollMs: number;
  /** Force a full enumeration this often even when the watermark is unchanged.
   *  OPTA_VOL_FAST_SWEEP_MS, default 1_800_000 (30 min). */
  fullSweepMs: number;
  /** First retry delay after a failed seed; doubles per attempt. */
  backoffBaseMs: number;
  /** Ceiling on the per-feed backoff. OPTA_VOL_FAST_BACKOFF_MAX_MS. */
  backoffMaxMs: number;
  /** When true the loop is not spawned. OPTA_VOL_FAST_DISABLED=1. */
  disabled: boolean;
}

export const FAST_SEED_DEFAULTS: FastSeedConfig = {
  pollMs: 120_000,
  fullSweepMs: 30 * 60_000,
  backoffBaseMs: 120_000,
  backoffMaxMs: 30 * 60_000,
  disabled: false,
};

/**
 * Read the fast-seed config from the environment, falling back to defaults.
 *
 * Empty string is treated as UNSET. `Number("") === 0` and `Number.isFinite(0)`
 * is true, so a naive parse would turn a cleared variable into a zero-millisecond
 * poll -- the same shape of trap that silently deny-listed the entire crypto
 * board through OPTA_WRITER_EXCLUDE_CLASSES (writer/src/env.ts). Non-positive
 * and non-finite values fall back rather than being obeyed.
 */
export function fastSeedConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): FastSeedConfig {
  const num = (raw: string | undefined, dflt: number): number => {
    if (raw === undefined || raw.trim() === "") return dflt;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const pollMs = num(env.OPTA_VOL_FAST_POLL_MS, FAST_SEED_DEFAULTS.pollMs);
  return {
    pollMs,
    fullSweepMs: num(env.OPTA_VOL_FAST_SWEEP_MS, FAST_SEED_DEFAULTS.fullSweepMs),
    // The first retry waits one poll interval -- retrying sooner than the loop
    // ticks would be meaningless.
    backoffBaseMs: pollMs,
    backoffMaxMs: num(
      env.OPTA_VOL_FAST_BACKOFF_MAX_MS,
      FAST_SEED_DEFAULTS.backoffMaxMs,
    ),
    disabled: (env.OPTA_VOL_FAST_DISABLED ?? "") === "1",
  };
}

// ---- State -----------------------------------------------------------------

/** One decoded market, reduced to what seeding needs. */
export interface FastSeedMarket {
  assetName: string;
  assetClass: number;
  oracleSource: number;
  /** 64-char lowercase hex, no 0x. */
  feedIdHex: string;
}

/** A feed this tick intends to seed, plus the label context for its log line. */
export interface SeedCandidate extends FastSeedMarket {
  seedVol: number;
}

/**
 * Mutable loop state, alive for the process lifetime.
 *
 * `seeded` is monotonic and never re-verified: VolOracle accounts are created
 * with plain `init` and no instruction ever closes one, so "this feed has an
 * oracle" is a fact that cannot become false. That is what makes the steady
 * state cost one small RPC call.
 */
export interface FastSeedState {
  seeded: Set<string>;
  backoff: Map<string, { attempts: number; nextAtMs: number }>;
  /** Last ProtocolState.total_markets seen; null before the first read. */
  lastWatermark: number | null;
  lastSweepMs: number;
  /** Cumulative counters -- a monitor diffs these across heartbeats. */
  ticks: number;
  sweeps: number;
  seededTotal: number;
  raceSkips: number;
  failures: number;
}

export function newFastSeedState(): FastSeedState {
  return {
    seeded: new Set(),
    backoff: new Map(),
    lastWatermark: null,
    lastSweepMs: 0,
    ticks: 0,
    sweeps: 0,
    seededTotal: 0,
    raceSkips: 0,
    failures: 0,
  };
}

/** Exponential backoff, capped. Pure -- exported for unit tests. */
export function nextBackoffMs(
  attempts: number,
  baseMs: number,
  maxMs: number,
): number {
  if (attempts <= 0) return Math.min(baseMs, maxMs);
  return Math.min(baseMs * Math.pow(2, attempts), maxMs);
}

// ---- Candidate selection (pure) --------------------------------------------

export interface SelectResult {
  candidates: SeedCandidate[];
  skippedSb: number;
  /** First-party (oracle_source 2) and unknown sources: never Pyth-seeded.
   *  A first-party ring is seeded by its own ceremony, not by this loop. */
  skippedNonPyth: number;
  skippedSeeded: number;
  skippedBackoff: number;
  skippedInFlight: number;
  skippedNoSeedVol: number;
}

/**
 * Decide which discovered markets this tick should try to seed.
 *
 * PURE -- no I/O, no clock of its own. Every exclusion is COUNTED rather than
 * silently dropped, so the heartbeat can prove the loop looked at the whole
 * board even on a tick where it does nothing.
 *
 * Switchboard is excluded FIRST: an SB market stores its SB feedHash in
 * pyth_feed_id and therefore derives the SAME VolOracle PDA that sbOracleCrank
 * owns. Seeding it from here would either win an init race and birth a
 * Pyth-sourced oracle for an SB feed (corruption that push_vol_sample can never
 * repair) or be rejected downstream. Same guard, same reason, as
 * partitionPythMarkets.
 */
export function selectSeedCandidates(
  markets: FastSeedMarket[],
  state: FastSeedState,
  inFlight: ReadonlySet<string>,
  nowMs: number,
): SelectResult {
  const candidates: SeedCandidate[] = [];
  const seenFeed = new Set<string>();
  let skippedSb = 0;
  let skippedNonPyth = 0;
  let skippedSeeded = 0;
  let skippedBackoff = 0;
  let skippedInFlight = 0;
  let skippedNoSeedVol = 0;

  for (const m of markets) {
    const route = routeForSource(m.oracleSource);
    if (route === "switchboard") {
      skippedSb += 1;
      continue;
    }
    if (route !== "pyth") {
      // Source 2 (and any byte this build does not know) has no Pyth feed to
      // seed from. Until 2026-10-03 only source 1 was excluded here, so a
      // first-party market with no ring would have been Pyth-seeded.
      skippedNonPyth += 1;
      continue;
    }
    // Dedupe by feed: many markets can share one feed, one oracle serves all.
    if (seenFeed.has(m.feedIdHex)) continue;
    seenFeed.add(m.feedIdHex);

    if (state.seeded.has(m.feedIdHex)) {
      skippedSeeded += 1;
      continue;
    }
    const b = state.backoff.get(m.feedIdHex);
    if (b && nowMs < b.nextAtMs) {
      skippedBackoff += 1;
      continue;
    }
    if (inFlight.has(m.feedIdHex)) {
      skippedInFlight += 1;
      continue;
    }
    // A class with no seed_vol must NOT be seeded with 0 -- that is the on-chain
    // "no seed" sentinel and would birth an oracle price_american refuses to use.
    let seedVol: number;
    try {
      seedVol = seedVolForAssetClass(m.assetClass);
    } catch {
      skippedNoSeedVol += 1;
      continue;
    }
    candidates.push({ ...m, seedVol });
  }

  return {
    candidates,
    skippedSb,
    skippedNonPyth,
    skippedSeeded,
    skippedBackoff,
    skippedInFlight,
    skippedNoSeedVol,
  };
}

// ---- One tick --------------------------------------------------------------

/** Everything the tick needs from the outside world. Injected so the tick is
 *  unit-testable without an RPC, a wallet, or Hermes. */
export interface FastSeedDeps {
  /** ProtocolState.total_markets -- the cheap change detector. */
  marketWatermark: () => Promise<number>;
  /** Full enumeration of decodable markets. */
  listMarkets: () => Promise<FastSeedMarket[]>;
  /** Which of these feeds already have a VolOracle on chain. */
  oraclesExisting: (feedIdHexes: string[]) => Promise<Set<string>>;
  /** initialize_vol_oracle. Resolves to the signature. */
  seedOracle: (c: SeedCandidate) => Promise<string>;
  now: () => number;
}

export interface FastSeedTickReport {
  swept: boolean;
  watermark: number | null;
  marketsSeen: number;
  candidates: number;
  seeded: number;
  raceSkips: number;
  failures: number;
  durationMs: number;
}

/**
 * One fast-seed tick.
 *
 * NEVER THROWS. A watermark read that fails degrades to "sweep anyway" -- we
 * would rather pay one enumeration than miss a birth -- and every per-feed
 * failure is isolated to that feed.
 */
export async function fastSeedTick(
  deps: FastSeedDeps,
  state: FastSeedState,
  inFlight: Set<string>,
  cfg: FastSeedConfig,
  log: VolCrankLogger,
): Promise<FastSeedTickReport> {
  const startMs = deps.now();
  state.ticks += 1;

  let watermark: number | null = null;
  let watermarkFailed = false;
  try {
    watermark = await deps.marketWatermark();
  } catch (err) {
    watermarkFailed = true;
    log("warn", "vol-oracle fast-seed watermark read failed (sweeping anyway)", {
      err: String(err).slice(0, 200),
    });
  }

  const swept =
    watermarkFailed ||
    state.lastWatermark === null ||
    watermark !== state.lastWatermark ||
    startMs - state.lastSweepMs >= cfg.fullSweepMs;

  const report: FastSeedTickReport = {
    swept,
    watermark,
    marketsSeen: 0,
    candidates: 0,
    seeded: 0,
    raceSkips: 0,
    failures: 0,
    durationMs: 0,
  };

  if (!swept) {
    report.durationMs = deps.now() - startMs;
    return report;
  }

  state.sweeps += 1;
  state.lastSweepMs = startMs;
  if (!watermarkFailed) state.lastWatermark = watermark;

  let markets: FastSeedMarket[];
  try {
    markets = await deps.listMarkets();
  } catch (err) {
    log("warn", "vol-oracle fast-seed enumeration failed (retry next tick)", {
      err: String(err).slice(0, 200),
    });
    report.durationMs = deps.now() - startMs;
    return report;
  }
  report.marketsSeen = markets.length;

  const sel = selectSeedCandidates(markets, state, inFlight, deps.now());
  if (sel.candidates.length === 0) {
    report.durationMs = deps.now() - startMs;
    return report;
  }

  // One batched existence read before spending anything. This is also how a
  // fresh process learns, on its first tick, that the whole board is seeded.
  let existing: Set<string>;
  try {
    existing = await deps.oraclesExisting(sel.candidates.map((c) => c.feedIdHex));
  } catch (err) {
    log("warn", "vol-oracle fast-seed existence check failed (retry next tick)", {
      err: String(err).slice(0, 200),
    });
    report.durationMs = deps.now() - startMs;
    return report;
  }
  for (const hex of existing) state.seeded.add(hex);

  const todo = sel.candidates.filter((c) => !existing.has(c.feedIdHex));
  report.candidates = todo.length;

  for (const c of todo) {
    inFlight.add(c.feedIdHex);
    try {
      const sig = await deps.seedOracle(c);
      state.seeded.add(c.feedIdHex);
      state.backoff.delete(c.feedIdHex);
      state.seededTotal += 1;
      report.seeded += 1;
      log("info", "vol-oracle fast-seed", {
        event: "vol-fast-seed",
        asset: c.assetName,
        class: c.assetClass,
        source: c.oracleSource,
        feed: c.feedIdHex.slice(0, 8),
        seedVol: c.seedVol,
        sig,
      });
    } catch (err) {
      // IDEMPOTENCY BY STATE, NOT BY ERROR STRING.
      //
      // Anchor's plain `init` reverts "already in use" when another writer won
      // the race, but that text reaches us through the runtime, web3.js and a
      // send wrapper, any of which can re-shape it. Matching on the string would
      // make correctness depend on prose. So we ask the chain what is true now:
      // if the PDA exists, we LOST the race and that is a SUCCESS -- the oracle
      // is there, which is the only outcome this loop exists to produce. Only a
      // still-missing PDA is a real failure, and only that earns a backoff.
      let nowExists = false;
      try {
        nowExists = (await deps.oraclesExisting([c.feedIdHex])).has(c.feedIdHex);
      } catch {
        /* re-check unavailable -- fall through to the failure path */
      }
      if (nowExists) {
        state.seeded.add(c.feedIdHex);
        state.backoff.delete(c.feedIdHex);
        state.raceSkips += 1;
        report.raceSkips += 1;
        log("info", "vol-oracle fast-seed: oracle already existed (race, clean skip)", {
          event: "vol-fast-seed-race",
          asset: c.assetName,
          feed: c.feedIdHex.slice(0, 8),
        });
      } else {
        const prev = state.backoff.get(c.feedIdHex)?.attempts ?? 0;
        const attempts = prev + 1;
        const delay = nextBackoffMs(prev, cfg.backoffBaseMs, cfg.backoffMaxMs);
        state.backoff.set(c.feedIdHex, { attempts, nextAtMs: deps.now() + delay });
        state.failures += 1;
        report.failures += 1;
        log("warn", "vol-oracle fast-seed failed (backing off)", {
          event: "vol-fast-seed-fail",
          asset: c.assetName,
          class: c.assetClass,
          feed: c.feedIdHex.slice(0, 8),
          attempts,
          retryInMs: delay,
          err: String(err).slice(0, 200),
        });
      }
    } finally {
      inFlight.delete(c.feedIdHex);
    }
  }

  report.durationMs = deps.now() - startMs;
  return report;
}

// ---- The loop --------------------------------------------------------------

/**
 * The continuous fast-seed loop.
 *
 * HEARTBEAT: one structured line EVERY tick, seeded or not. A loop that only
 * speaks when it acts is indistinguishable from a loop that died -- and this one
 * is EXPECTED to do nothing on a healthy board, so "nothing happened" has to be
 * an assertion a monitor can see, carrying cumulative counters it can diff.
 */
export async function runFastSeedLoop(
  ctx: VolOracleCrankContext,
  inFlight: Set<string>,
  cfgIn?: FastSeedConfig,
  /** Test seam ONLY. Production passes nothing and gets buildFastSeedDeps(ctx);
   *  the heartbeat contract is worth asserting without an RPC behind it. */
  depsIn?: FastSeedDeps,
): Promise<void> {
  const cfg = cfgIn ?? fastSeedConfigFromEnv();
  if (cfg.disabled) {
    ctx.log("info", "vol-oracle fast-seed loop DISABLED via OPTA_VOL_FAST_DISABLED=1", {});
    return;
  }
  ctx.log("info", "vol-oracle fast-seed loop started", {
    pollMs: cfg.pollMs,
    fullSweepMs: cfg.fullSweepMs,
    backoffMaxMs: cfg.backoffMaxMs,
  });

  const state = newFastSeedState();
  const deps = depsIn ?? buildFastSeedDeps(ctx);

  while (!ctx.shouldShutdown()) {
    let report: FastSeedTickReport | null = null;
    try {
      report = await fastSeedTick(deps, state, inFlight, cfg, ctx.log);
    } catch (err) {
      // fastSeedTick is written not to throw; this is the belt on the braces.
      ctx.log("error", "vol-oracle fast-seed tick crashed (loop survives)", {
        err: String(err),
        stack: (err as any)?.stack,
      });
    }
    ctx.log("info", "vol-oracle fast-seed heartbeat", {
      event: "vol-fast-seed-heartbeat",
      ticks: state.ticks,
      sweeps: state.sweeps,
      swept: report?.swept ?? false,
      watermark: report?.watermark ?? null,
      marketsSeen: report?.marketsSeen ?? 0,
      oraclesKnown: state.seeded.size,
      backingOff: state.backoff.size,
      inFlight: inFlight.size,
      seededTotal: state.seededTotal,
      raceSkipsTotal: state.raceSkips,
      failuresTotal: state.failures,
      durationMs: report?.durationMs ?? 0,
    });
    await sleepInterruptibly(cfg.pollMs, ctx.shouldShutdown);
  }

  ctx.log("info", "vol-oracle fast-seed loop stopped cleanly", {
    ticks: state.ticks,
    seededTotal: state.seededTotal,
  });
}

/** Wire the injectable deps to the real chain. Separate from the loop so the
 *  loop's logic stays testable with fakes. */
export function buildFastSeedDeps(ctx: VolOracleCrankContext): FastSeedDeps {
  return {
    marketWatermark: async () => {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from(PROTOCOL_SEED)],
        ctx.program.programId,
      );
      const ps: any = await (ctx.program.account as any).protocolState.fetch(pda);
      return Number(ps.totalMarkets);
    },
    listMarkets: async () => {
      // The same decoder the hourly pass uses -- ONE source of truth for "what
      // is a market", so the two loops can never disagree about the board.
      const all = await safeFetchAll<any>(ctx.program, "optionsMarket");
      return all.map(
        (m): FastSeedMarket => ({
          assetName: String(m.account.assetName ?? ""),
          assetClass: Number(m.account.assetClass ?? -1),
          oracleSource: Number(m.account.oracleSource ?? 0),
          feedIdHex: hexFromBytes(m.account.pythFeedId as number[]),
        }),
      );
    },
    oraclesExisting: async (feedIdHexes: string[]) => {
      const out = new Set<string>();
      if (feedIdHexes.length === 0) return out;
      const pdas = feedIdHexes.map(
        (hex) =>
          PublicKey.findProgramAddressSync(
            [Buffer.from(VOL_ORACLE_SEED), Buffer.from(hex, "hex")],
            ctx.program.programId,
          )[0],
      );
      // getMultipleAccountsInfo caps at 100 keys per call.
      for (let i = 0; i < pdas.length; i += 100) {
        const slice = pdas.slice(i, i + 100);
        const infos = await ctx.connection.getMultipleAccountsInfo(slice, "confirmed");
        for (let j = 0; j < slice.length; j++) {
          const acct = infos[j];
          if (acct && acct.owner.equals(ctx.program.programId)) {
            out.add(feedIdHexes[i + j]);
          }
        }
      }
      return out;
    },
    seedOracle: async (c: SeedCandidate) => {
      // Byte-identical build to the hourly pass's init branch -- same helper,
      // same Hermes base, same two-tx submit. The ONLY difference is WHEN it
      // runs. The follow-on seed push is deliberately left to the hourly pass:
      // init already writes last_spot_price + last_sample_ts, so the market is
      // priceable the moment this lands, and a push now would revert
      // VolOraclePushTooSoon anyway (see initialize_vol_oracle's header).
      const txs = await buildPostUpdateAndInitializeVolOracleTx(
        ctx.program,
        ctx.wallet,
        c.feedIdHex,
        c.seedVol,
        ctx.hermesBase,
      );
      return submitWithFallback(ctx.connection, ctx.wallet, txs);
    },
    now: () => Date.now(),
  };
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
