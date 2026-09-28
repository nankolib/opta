// =============================================================================
// crank/livenessCrank.ts — source-liveness probe loop (Phase 2a)
// =============================================================================
//
// Maintains the shared liveness map (livenessStore.ts) that the FE reads (via the
// sb-create endpoint's GET /liveness) to route create-time source selection in
// Phase 2b. Probes two source families on independent cadences:
//
//   Pyth (cheap, batched, frequent): one Hermes /v2/updates/price/latest call for
//     many feed ids → publish_time per feed. Live = now - publish_time <= max age.
//     A stale publish_time or a missing feed → miss (this naturally marks
//     off-hours equities/FX dead — correct). Hermes 404s the WHOLE call if ANY id
//     is unknown, so a failed chunk is recursively split to isolate the bad id.
//
//   Switchboard (per-feed, less frequent): crossbar.simulateJobs of the feed's
//     job spec (the same call the Phase-1 cross-check uses). A successful simulate
//     with a positive price = a hit; bounded retries per probe absorb the ~3/15
//     gateway flakiness.
//
// HYSTERESIS (protects the one SB asset from flicker): a hit flips dead->live
// IMMEDIATELY (misses reset to 0); a miss flips live->dead ONLY after
// DEAD_AFTER_MISSES consecutive misses. A single transient simulateJobs / Hermes
// miss therefore never marks a feed dead — the state holds.
//
// SCOPING NOTE (flag for review): by default this probes TradFi Pyth feeds
// (classes 1-4) + all SB feeds, NOT the full Hermes catalog. Crypto (class 0) is
// ~always-live AND the FE defaults crypto->Pyth regardless, so probing the
// hundreds of crypto feeds every cycle is pure Hermes load for ~zero value — a
// missing crypto entry just makes the FE use its static default (Pyth), which is
// already correct. Set OPTA_LIVENESS_PROBE_ALL=1 to probe the entire catalog.
//
// ISOLATION: every probe call is wrapped (per-chunk / per-feed try/catch) so a
// transient failure never escapes the loop. Mounted in bot.ts's Promise.all set
// with the same fail-loud wrapper as the other side-loops; only a genuine bug
// (not a transient probe error) would propagate -> supervisor restart.
// =============================================================================

import { CrossbarClient } from "@switchboard-xyz/common";
import { fetchCatalog } from "@app/utils/hermesCatalog";
import { SB_FEED_DATA } from "@app/utils/sbFeedData";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { hexFromBytes } from "@app/utils/format";
import type { Program } from "@coral-xyz/anchor";
import { lookupSbFeed } from "./sbFeedRegistry";
import { setLivenessMap, type FeedLiveness } from "./livenessStore";
import { livenessSourceOf } from "./settleRouting";
import { feedPdaFor, feedSnapshot, OPTA_FEED_READ_MAX_AGE_SECS } from "./optaVolCrank";

export interface LivenessCrankContext {
  hermesBase: string;
  /** For scanning existing on-chain markets (their feed ids are always probed). */
  program: Program<any>;
  log: (
    level: "info" | "warn" | "error",
    msg: string,
    fields?: Record<string, unknown>,
  ) => void;
  shouldShutdown: () => boolean;
}

/** Marquee TradFi the create UI is likely to offer. Resolved to feed ids against
 *  the live catalog by `suggestedTicker`; unmatched tickers are simply skipped.
 *  Crypto is intentionally absent — it's ~always-live and the FE defaults
 *  crypto→Pyth, so probing it is wasted Hermes load. */
const CURATED_TICKERS = new Set<string>([
  "XAU", "XAG", "XPT", "XPD", "WTI", "BRENT", "USOIL", "UKOIL", "NATGAS", // commodity (1)
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDCNH", // forex (3)
  "AAPL", "TSLA", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AMD", "NFLX", "COIN", // equity (2)
  "SPY", "QQQ", // etf (4)
]);

export interface LivenessCrankOptions {
  tickOnce?: boolean;
}

// ---- tunables (env-overridable) --------------------------------------------
const numEnv = (v: string | undefined, d: number) => {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : d;
};
const PYTH_PROBE_MS = numEnv(process.env.OPTA_LIVENESS_PYTH_MS, 60_000);
const SB_PROBE_MS = numEnv(process.env.OPTA_LIVENESS_SB_MS, 180_000);
const CATALOG_REFRESH_MS = numEnv(process.env.OPTA_LIVENESS_CATALOG_MS, 3_600_000);
const PYTH_LIVE_MAX_AGE_SECS = numEnv(process.env.OPTA_LIVENESS_PYTH_MAX_AGE_S, 120);
const HERMES_BATCH = numEnv(process.env.OPTA_LIVENESS_HERMES_BATCH, 50);
/** K — flip live->dead only after this many CONSECUTIVE misses (hysteresis). */
const DEAD_AFTER_MISSES = numEnv(process.env.OPTA_LIVENESS_DEAD_AFTER, 3);
const SB_SIMULATE_ATTEMPTS = numEnv(process.env.OPTA_LIVENESS_SB_ATTEMPTS, 4);
const PROBE_ALL_PYTH = (process.env.OPTA_LIVENESS_PROBE_ALL ?? "") === "1";
// Stage 3: honor the self-hosted crossbar (OPTA_CROSSBAR_URL) so ALL live SB
// traffic — including this liveness resolver — routes through the VPS crossbar,
// not the public endpoint. Mirrors sbOracleCrank.ts. Falls back to public.
const CROSSBAR_URL = process.env.OPTA_CROSSBAR_URL ?? "https://crossbar.switchboard.xyz";
const SHUTDOWN_CHECK_MS = 5000;

const short = (e: unknown) => String((e as any)?.message ?? e).slice(0, 200);
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const norm = (hex: string) => hex.toLowerCase().replace(/^0x/, "");

/** First finite, positive numeric value in a Crossbar simulateJobs results array. */
function firstNumber(results: unknown[] | null | undefined): number | null {
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    const n = typeof r === "number" ? r : typeof r === "string" ? parseFloat(r) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

interface FeedState {
  source: 0 | 1 | 2;
  /** Source 2 only: the feed_id bytes, to derive the OptaPriceFeed PDA. */
  feedBytes?: number[];
  jobs?: Array<Record<string, unknown>>; // SB only
  live: boolean;
  asOf: number;
  samples: number | null;
  misses: number;
}

/** Probe a chunk of Pyth ids into `out` (id -> publish_time). On a non-200 (Hermes
 *  404s the whole call if ANY id is unknown) recursively split to isolate the bad
 *  id; a failing singleton stays absent -> counted a miss by the caller. */
async function probePythInto(
  ids: string[],
  hermesBase: string,
  out: Map<string, number>,
): Promise<void> {
  if (ids.length === 0) return;
  const qs = ids.map((h) => `ids[]=0x${h}`).join("&");
  const url = `${hermesBase}/v2/updates/price/latest?${qs}&encoding=base64`;
  let ok = false;
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const json: any = await resp.json();
      for (const p of json?.parsed ?? []) {
        const id = norm(String(p?.id ?? ""));
        const pt = p?.price?.publish_time;
        if (id && typeof pt === "number") out.set(id, pt);
      }
      ok = true;
    }
  } catch {
    /* network/parse error → treat as a failed chunk, split below */
  }
  if (ok || ids.length === 1) return;
  const mid = ids.length >> 1;
  await probePythInto(ids.slice(0, mid), hermesBase, out);
  await probePythInto(ids.slice(mid), hermesBase, out);
}

/**
 * Run the liveness probe loop. Resolves only on shutdown (or after one tick when
 * opts.tickOnce). Defensive throughout — transient probe failures are caught and
 * logged, never propagated.
 */
export async function runLivenessCrank(
  ctx: LivenessCrankContext,
  opts: LivenessCrankOptions,
): Promise<void> {
  const crossbar = new CrossbarClient(CROSSBAR_URL);
  const state = new Map<string, FeedState>(); // feedIdHex -> state
  let lastCatalog = 0;
  let lastSb = 0;

  const markHit = (s: FeedState, asOf: number) => {
    s.live = true;
    s.misses = 0;
    s.asOf = asOf;
  };
  const markMiss = (s: FeedState) => {
    s.misses += 1;
    if (s.misses >= DEAD_AFTER_MISSES) s.live = false;
  };

  const refreshFeedSet = async () => {
    // (a) SB feeds — always (the high-value set).
    for (const d of SB_FEED_DATA) {
      const id = norm(d.feedHashHex);
      if (!state.has(id)) {
        const entry = lookupSbFeed(id);
        state.set(id, {
          source: 1,
          jobs: entry?.jobs,
          live: false,
          asOf: 0,
          samples: d.minOracleSamples ?? null,
          misses: 0,
        });
      }
    }

    // (b) Feeds backing EXISTING on-chain markets — so the FE has liveness for
    //     anything already deployed, regardless of the curated list.
    try {
      const markets = await safeFetchAll<any>(ctx.program, "optionsMarket");
      for (const m of markets) {
        // Routed by the source byte. A first-party market (2) used to be filed as
        // Pyth and probed against a price service that has never carried its
        // feed; an unknown byte belongs to no family and is not tracked.
        const src = livenessSourceOf(m.account.oracleSource);
        if (src === null) continue;
        const id = norm(hexFromBytes(m.account.pythFeedId as number[]));
        if (!state.has(id)) {
          const sb = src === 1 ? lookupSbFeed(id) : undefined;
          state.set(id, {
            source: src,
            feedBytes: src === 2 ? Array.from(m.account.pythFeedId as number[]) : undefined,
            jobs: sb?.jobs,
            live: false,
            asOf: 0,
            samples: sb?.minOracleSamples ?? null,
            misses: 0,
          });
        }
      }
    } catch (e) {
      ctx.log("warn", "liveness market scan failed (keeping prior feed set)", {
        err: short(e),
      });
    }

    // (c) Curated marquee Pyth feeds, resolved from the catalog by ticker.
    //     PROBE_ALL escape hatch reverts to the entire TradFi catalog.
    try {
      const entries = await fetchCatalog(ctx.hermesBase);
      let curatedAdded = 0;
      const matched: string[] = [];
      for (const e of entries) {
        const isCurated = CURATED_TICKERS.has(e.suggestedTicker.toUpperCase());
        const include = PROBE_ALL_PYTH ? e.suggestedAssetClass !== 0 : isCurated;
        if (!include) continue;
        if (isCurated && !PROBE_ALL_PYTH) matched.push(e.suggestedTicker.toUpperCase());
        const id = norm(e.feedIdHex);
        if (!state.has(id)) {
          state.set(id, { source: 0, live: false, asOf: 0, samples: null, misses: 0 });
          curatedAdded++;
        }
      }
      const skipped = PROBE_ALL_PYTH
        ? []
        : [...CURATED_TICKERS].filter((t) => !matched.includes(t));
      ctx.log("info", "liveness feed-set refreshed", {
        mode: PROBE_ALL_PYTH ? "full-catalog" : "scoped",
        pythTracked: [...state.values()].filter((s) => s.source === 0).length,
        sbTracked: [...state.values()].filter((s) => s.source === 1).length,
        optaTracked: [...state.values()].filter((s) => s.source === 2).length,
        curatedAdded,
        curatedMatched: matched.sort(),
        curatedSkipped: skipped.sort(),
      });
    } catch (e) {
      ctx.log("warn", "liveness catalog refresh failed (keeping prior feed set)", {
        err: short(e),
      });
    }
  };

  const probePyth = async () => {
    const ids = [...state.entries()]
      .filter(([, s]) => s.source === 0)
      .map(([id]) => id);
    if (ids.length === 0) return;
    const pt = new Map<string, number>();
    for (let i = 0; i < ids.length; i += HERMES_BATCH) {
      await probePythInto(ids.slice(i, i + HERMES_BATCH), ctx.hermesBase, pt);
    }
    const now = nowSec();
    let live = 0;
    for (const id of ids) {
      const s = state.get(id)!;
      const t = pt.get(id);
      if (t !== undefined && now - t <= PYTH_LIVE_MAX_AGE_SECS) {
        markHit(s, t);
        live++;
      } else {
        markMiss(s);
      }
    }
    ctx.log("info", "liveness Pyth probe", { tracked: ids.length, live });
  };

  const probeSb = async () => {
    let live = 0;
    let total = 0;
    for (const [, s] of state) {
      if (s.source !== 1 || !s.jobs) continue;
      total++;
      let price: number | null = null;
      for (let a = 1; a <= SB_SIMULATE_ATTEMPTS && price === null; a++) {
        try {
          const resp = await crossbar.simulateJobs({ jobs: s.jobs as any });
          if (!resp.error) price = firstNumber(resp.results);
        } catch {
          /* transient gateway miss — retry */
        }
      }
      if (price !== null) {
        markHit(s, nowSec());
        live++;
      } else {
        markMiss(s);
      }
    }
    if (total > 0) ctx.log("info", "liveness SB probe", { tracked: total, live });
  };

  // First-party feeds: live means the on-chain feed account is unfrozen and its
  // last push is inside the read max-age the program itself enforces.
  const probeOpta = async () => {
    let live = 0;
    let total = 0;
    for (const [, s] of state) {
      if (s.source !== 2 || !s.feedBytes) continue;
      total++;
      try {
        const f = feedSnapshot(
          await (ctx.program.account as any).optaPriceFeed.fetch(
            feedPdaFor(ctx.program.programId, s.feedBytes),
          ),
        );
        if (!f.frozen && nowSec() - f.publishTime <= OPTA_FEED_READ_MAX_AGE_SECS) {
          markHit(s, f.publishTime);
          live++;
        } else {
          markMiss(s);
        }
      } catch {
        markMiss(s);
      }
    }
    if (total > 0) ctx.log("info", "liveness first-party probe", { tracked: total, live });
  };

  const publish = () => {
    const feeds: Record<string, FeedLiveness> = {};
    for (const [id, s] of state) {
      feeds[id] = { source: s.source, live: s.live, asOf: s.asOf, samples: s.samples };
    }
    setLivenessMap({ updatedAt: nowSec(), feeds });
  };

  ctx.log("info", "liveness crank started", {
    pythProbeMs: PYTH_PROBE_MS,
    sbProbeMs: SB_PROBE_MS,
    pythMaxAgeS: PYTH_LIVE_MAX_AGE_SECS,
    deadAfterMisses: DEAD_AFTER_MISSES,
    probeAllPyth: PROBE_ALL_PYTH,
    tickOnce: !!opts.tickOnce,
  });

  do {
    if (Date.now() - lastCatalog >= CATALOG_REFRESH_MS) {
      await refreshFeedSet();
      lastCatalog = Date.now();
    }
    await probePyth();
    await probeOpta();
    if (Date.now() - lastSb >= SB_PROBE_MS) {
      await probeSb();
      lastSb = Date.now();
    }
    publish();

    if (opts.tickOnce) break;

    // Interruptible sleep (SHUTDOWN_CHECK_MS granularity) until the next Pyth tick.
    let slept = 0;
    while (slept < PYTH_PROBE_MS && !ctx.shouldShutdown()) {
      const chunk = Math.min(PYTH_PROBE_MS - slept, SHUTDOWN_CHECK_MS);
      await sleep(chunk);
      slept += chunk;
    }
  } while (!ctx.shouldShutdown());

  ctx.log("info", "liveness crank stopped cleanly");
}
