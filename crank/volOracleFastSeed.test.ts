// ============================================================================
// crank/volOracleFastSeed.test.ts -- SLICE 1 fast-seed loop unit tests
// ============================================================================
//
// Vanilla TS + node:assert, same tiny runner as volOracleCrank.test.ts.
//   run: npx ts-node --transpile-only -r tsconfig-paths/register \
//          volOracleFastSeed.test.ts
//
// The whole point of the FastSeedDeps seam is that the interesting behaviour --
// what gets seeded, what gets skipped, what happens when two loops collide --
// is provable without an RPC, a wallet, or Hermes. Every test here drives real
// production code paths through fakes; none of them re-implement the logic.
//
// WHAT IS DELIBERATELY NOT COVERED: buildFastSeedDeps (it is the chain wiring
// -- proven by the deploy-side verification, not by a fake) and the real
// initialize_vol_oracle tx (the hourly pass has shipped that build for months
// and this loop reuses the identical helper).
// ============================================================================

import assert from "node:assert/strict";

import {
  FAST_SEED_DEFAULTS,
  fastSeedConfigFromEnv,
  fastSeedTick,
  newFastSeedState,
  nextBackoffMs,
  runFastSeedLoop,
  selectSeedCandidates,
  type FastSeedConfig,
  type FastSeedDeps,
  type FastSeedMarket,
  type SeedCandidate,
} from "./volOracleFastSeed";

// ---- Tiny runner -----------------------------------------------------------

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ---- Fixtures --------------------------------------------------------------

/** Deterministic 64-hex feed id from a seed byte. */
function feedHex(seed: number): string {
  return Array.from({ length: 32 }, (_, i) =>
    (((seed * 31 + i) & 0xff) as number).toString(16).padStart(2, "0"),
  ).join("");
}

function market(over: Partial<FastSeedMarket> = {}): FastSeedMarket {
  return {
    assetName: "NEWCOIN",
    assetClass: 0, // crypto -> seed_vol 0.80 exists
    oracleSource: 0, // Pyth
    feedIdHex: feedHex(1),
    ...over,
  };
}

const CFG: FastSeedConfig = {
  pollMs: 1,
  fullSweepMs: 1_000_000, // never trip the safety sweep unless a test wants it
  backoffBaseMs: 1000,
  backoffMaxMs: 8000,
  disabled: false,
};

type Call = { name: string; arg: unknown };

/** A recording fake for the whole outside world. */
function makeDeps(over: Partial<FastSeedDeps> & {
  markets?: FastSeedMarket[];
  existing?: Set<string>;
  watermark?: number;
  seedThrows?: boolean;
  /** Feeds that "appear" on chain the moment seedOracle throws (race sim). */
  appearsOnFailure?: Set<string>;
} = {}) {
  const calls: Call[] = [];
  const existing = over.existing ?? new Set<string>();
  const appears = over.appearsOnFailure ?? new Set<string>();
  let clock = 1_000_000;

  const deps: FastSeedDeps = {
    marketWatermark: async () => {
      calls.push({ name: "marketWatermark", arg: null });
      return over.watermark ?? 1;
    },
    listMarkets: async () => {
      calls.push({ name: "listMarkets", arg: null });
      return over.markets ?? [];
    },
    oraclesExisting: async (hexes: string[]) => {
      calls.push({ name: "oraclesExisting", arg: [...hexes] });
      return new Set(hexes.filter((h) => existing.has(h)));
    },
    seedOracle: async (c: SeedCandidate) => {
      calls.push({ name: "seedOracle", arg: c.feedIdHex });
      if (over.seedThrows) {
        // Simulate the loser of an init race: the account now exists.
        for (const h of appears) existing.add(h);
        throw new Error("Allocate: account already in use");
      }
      existing.add(c.feedIdHex);
      return `sig-${c.assetName}`;
    },
    now: () => clock,
    ...(over.marketWatermark ? { marketWatermark: over.marketWatermark } : {}),
  };
  return {
    deps,
    calls,
    existing,
    names: () => calls.map((c) => c.name),
    countOf: (n: string) => calls.filter((c) => c.name === n).length,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const noopLog = () => {};

// ============================================================================
// THE CORE CONTRACT -- a market without an oracle gets one; one with an oracle
// is left alone. These two are the reason the slice exists.
// ============================================================================

test("RED-FIRST: a market with no oracle IS seeded, with its class seed_vol", async () => {
  const m = market({ assetName: "NEWCOIN", assetClass: 0, feedIdHex: feedHex(7) });
  const f = makeDeps({ markets: [m] });
  const state = newFastSeedState();

  const report = await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);

  assert.equal(report.seeded, 1, "the missing oracle must be seeded");
  assert.equal(report.failures, 0);
  assert.equal(f.countOf("seedOracle"), 1, "seedOracle called exactly once");
  assert.equal(f.calls.find((c) => c.name === "seedOracle")?.arg, m.feedIdHex);
  assert.ok(state.seeded.has(m.feedIdHex), "feed recorded as seeded");
  assert.equal(state.seededTotal, 1);
});

test("RED-FIRST: an already-seeded market is SKIPPED (no tx, no spend)", async () => {
  const m = market({ feedIdHex: feedHex(8) });
  const f = makeDeps({ markets: [m], existing: new Set([m.feedIdHex]) });
  const state = newFastSeedState();

  const report = await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);

  assert.equal(report.seeded, 0, "nothing to seed");
  assert.equal(f.countOf("seedOracle"), 0, "must NOT submit a tx");
  assert.ok(state.seeded.has(m.feedIdHex), "existence is cached for later ticks");
});

test("a second tick after seeding does no chain work at all (monotonic cache)", async () => {
  const m = market({ feedIdHex: feedHex(9) });
  const f = makeDeps({ markets: [m] });
  const state = newFastSeedState();

  await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);
  const afterFirst = f.countOf("seedOracle");
  // Force a sweep on the second tick so we are testing the seeded-cache, not
  // the watermark short-circuit.
  state.lastWatermark = -1;
  const second = await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);

  assert.equal(afterFirst, 1);
  assert.equal(f.countOf("seedOracle"), 1, "no second init for the same feed");
  assert.equal(second.seeded, 0);
});

test("the seeded cache short-circuits BEFORE the existence read, not after", async () => {
  // Written after a deliberate-break run showed the previous test still passed
  // with the `state.seeded` skip removed: the fake's existence read filtered the
  // candidate out anyway, so behaviour looked identical and only the RPC bill
  // changed. The cache is a COST contract, so it needs a cost assertion.
  const m = market({ feedIdHex: feedHex(10) });
  const f = makeDeps({ markets: [m], existing: new Set([m.feedIdHex]) });
  const state = newFastSeedState();
  state.seeded.add(m.feedIdHex); // we already know this one

  await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);

  assert.equal(f.countOf("listMarkets"), 1, "it did sweep");
  assert.equal(
    f.countOf("oraclesExisting"),
    0,
    "a known-seeded board must cost ZERO existence reads",
  );
  assert.equal(f.countOf("seedOracle"), 0);
});

// ============================================================================
// THE CHEAP POLL -- an unchanged watermark must cost exactly one small RPC.
// ============================================================================

test("unchanged watermark short-circuits: no enumeration, no existence read", async () => {
  const f = makeDeps({ markets: [market()], watermark: 42 });
  const state = newFastSeedState();

  await fastSeedTick(f.deps, state, new Set(), CFG, noopLog); // first tick sweeps
  const before = f.calls.length;
  const second = await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);

  assert.equal(second.swept, false, "second tick must not sweep");
  assert.equal(
    f.calls.length - before,
    1,
    "exactly ONE call (the watermark read) on a quiet tick",
  );
  assert.equal(f.calls[f.calls.length - 1].name, "marketWatermark");
});

test("a moved watermark forces a sweep", async () => {
  let wm = 10;
  const m = market({ feedIdHex: feedHex(11) });
  const f = makeDeps({ markets: [m] });
  (f.deps as any).marketWatermark = async () => wm;
  const state = newFastSeedState();

  await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);
  wm = 11; // a market was born
  const second = await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);

  assert.equal(second.swept, true, "watermark moved -> must sweep");
  assert.equal(second.watermark, 11);
});

test("a watermark read that FAILS sweeps anyway (never miss a birth)", async () => {
  const m = market({ feedIdHex: feedHex(12) });
  const f = makeDeps({ markets: [m] });
  (f.deps as any).marketWatermark = async () => {
    throw new Error("rpc down");
  };
  const state = newFastSeedState();

  const report = await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);

  assert.equal(report.swept, true, "unreadable watermark must not silence the loop");
  assert.equal(report.seeded, 1, "and the missing oracle still gets seeded");
});

test("the safety sweep fires even when the watermark never moves", async () => {
  const f = makeDeps({ markets: [market({ feedIdHex: feedHex(13) })], watermark: 5 });
  const state = newFastSeedState();
  const cfg = { ...CFG, fullSweepMs: 10_000 };

  await fastSeedTick(f.deps, state, new Set(), cfg, noopLog);
  const quiet = await fastSeedTick(f.deps, state, new Set(), cfg, noopLog);
  assert.equal(quiet.swept, false);

  f.advance(10_001);
  const forced = await fastSeedTick(f.deps, state, new Set(), cfg, noopLog);
  assert.equal(forced.swept, true, "fullSweepMs elapsed -> sweep regardless");
});

// ============================================================================
// IDEMPOTENCY / RACE -- a collision must be a clean skip, never an error loop.
// ============================================================================

test("RACE: init reverts but the PDA now exists -> clean skip, NOT a failure", async () => {
  const m = market({ feedIdHex: feedHex(21) });
  const f = makeDeps({
    markets: [m],
    seedThrows: true,
    appearsOnFailure: new Set([m.feedIdHex]), // the hourly pass won
  });
  const state = newFastSeedState();

  const report = await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);

  assert.equal(report.raceSkips, 1, "losing the race is a SUCCESS outcome");
  assert.equal(report.failures, 0, "and must never be counted as a failure");
  assert.ok(state.seeded.has(m.feedIdHex), "the oracle exists -> remember it");
  assert.equal(state.backoff.has(m.feedIdHex), false, "no backoff on a won race");
  assert.equal(state.failures, 0);
});

test("RACE: repeated ticks after a lost race do NOT retry (no error loop)", async () => {
  const m = market({ feedIdHex: feedHex(22) });
  const f = makeDeps({
    markets: [m],
    seedThrows: true,
    appearsOnFailure: new Set([m.feedIdHex]),
  });
  const state = newFastSeedState();

  await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);
  state.lastWatermark = -1; // force another sweep
  await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);

  assert.equal(f.countOf("seedOracle"), 1, "exactly one attempt, ever");
});

test("a feed the hourly pass owns (inFlight) is skipped this tick", async () => {
  const m = market({ feedIdHex: feedHex(23) });
  const f = makeDeps({ markets: [m] });
  const state = newFastSeedState();
  const inFlight = new Set([m.feedIdHex]);

  const report = await fastSeedTick(f.deps, state, new Set(inFlight), CFG, noopLog);

  assert.equal(report.seeded, 0);
  assert.equal(f.countOf("seedOracle"), 0, "must not double-submit");
});

test("inFlight is released after a seed, success or failure", async () => {
  const m = market({ feedIdHex: feedHex(24) });
  const inFlight = new Set<string>();

  const ok = makeDeps({ markets: [m] });
  await fastSeedTick(ok.deps, newFastSeedState(), inFlight, CFG, noopLog);
  assert.equal(inFlight.size, 0, "released after success");

  const bad = makeDeps({ markets: [m], seedThrows: true });
  await fastSeedTick(bad.deps, newFastSeedState(), inFlight, CFG, noopLog);
  assert.equal(inFlight.size, 0, "released after failure too");
});

// ============================================================================
// BACKOFF -- an unseedable feed (e.g. an equity outside NYSE hours) must decay,
// not hammer Hermes every two minutes forever.
// ============================================================================

test("a real failure (PDA still missing) sets a backoff and is not retried inside it", async () => {
  const m = market({ assetName: "FDX", assetClass: 2, feedIdHex: feedHex(31) });
  const f = makeDeps({ markets: [m], seedThrows: true }); // never appears
  const state = newFastSeedState();

  const first = await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);
  assert.equal(first.failures, 1);
  assert.equal(first.raceSkips, 0);
  assert.equal(state.backoff.get(m.feedIdHex)?.attempts, 1);

  state.lastWatermark = -1;
  await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);
  assert.equal(f.countOf("seedOracle"), 1, "inside the backoff window -> no retry");

  f.advance(CFG.backoffBaseMs + 1);
  state.lastWatermark = -1;
  await fastSeedTick(f.deps, state, new Set(), CFG, noopLog);
  assert.equal(f.countOf("seedOracle"), 2, "past the window -> retried once");
  assert.equal(state.backoff.get(m.feedIdHex)?.attempts, 2, "and the delay grows");
});

test("nextBackoffMs doubles and caps", () => {
  assert.equal(nextBackoffMs(0, 1000, 8000), 1000);
  assert.equal(nextBackoffMs(1, 1000, 8000), 2000);
  assert.equal(nextBackoffMs(2, 1000, 8000), 4000);
  assert.equal(nextBackoffMs(3, 1000, 8000), 8000);
  assert.equal(nextBackoffMs(9, 1000, 8000), 8000, "capped, never unbounded");
  assert.equal(nextBackoffMs(0, 10_000, 5000), 5000, "cap wins over a large base");
});

// ============================================================================
// SCOPE GUARDS -- what this loop must never touch.
// ============================================================================

test("a Switchboard market is NEVER a candidate (sbOracleCrank owns that PDA)", () => {
  const sb = market({ assetName: "AAPL", oracleSource: 1, feedIdHex: feedHex(41) });
  const sel = selectSeedCandidates([sb], newFastSeedState(), new Set(), 0);

  assert.equal(sel.candidates.length, 0);
  assert.equal(sel.skippedSb, 1, "and the skip is COUNTED, not silent");
});

test("a first-party market (oracle_source 2) with no ring is NEVER Pyth-seeded (its lane seeds it, at the ceremony)", () => {
  const fp = market({ assetName: "SOL", oracleSource: 2, feedIdHex: feedHex(44) });
  const sel = selectSeedCandidates([fp], newFastSeedState(), new Set(), 0);

  assert.equal(sel.candidates.length, 0, "no ring on chain, and still not a candidate");
  assert.equal(sel.skippedSb, 0, "it is not Switchboard");
  assert.equal(sel.skippedNonPyth, 1, "counted under its own reason");
});

test("an unknown oracle_source byte is never seeded either", () => {
  const odd = market({ assetName: "ODD", oracleSource: 3, feedIdHex: feedHex(45) });
  const sel = selectSeedCandidates([odd], newFastSeedState(), new Set(), 0);
  assert.equal(sel.candidates.length, 0);
  assert.equal(sel.skippedNonPyth, 1);
});

test("an unknown asset_class is skipped, never seeded with the 0 sentinel", () => {
  const weird = market({ assetClass: 99, feedIdHex: feedHex(42) });
  const sel = selectSeedCandidates([weird], newFastSeedState(), new Set(), 0);

  assert.equal(sel.candidates.length, 0);
  assert.equal(sel.skippedNoSeedVol, 1);
});

test("markets sharing one feed produce ONE candidate", () => {
  const hex = feedHex(43);
  const sel = selectSeedCandidates(
    [market({ assetName: "A", feedIdHex: hex }), market({ assetName: "B", feedIdHex: hex })],
    newFastSeedState(),
    new Set(),
    0,
  );
  assert.equal(sel.candidates.length, 1, "one oracle serves every market on the feed");
});

test("every candidate carries its class seed_vol (crypto 0.80 x 1e12)", () => {
  const sel = selectSeedCandidates([market({ assetClass: 0 })], newFastSeedState(), new Set(), 0);
  assert.equal(sel.candidates[0].seedVol, 800_000_000_000);
});

// ============================================================================
// CONFIG -- the Number("") trap that already cost the writer its crypto board.
// ============================================================================

test('empty-string env vars mean UNSET, never 0 (the Number("") trap)', () => {
  const cfg = fastSeedConfigFromEnv({
    OPTA_VOL_FAST_POLL_MS: "",
    OPTA_VOL_FAST_SWEEP_MS: "   ",
    OPTA_VOL_FAST_BACKOFF_MAX_MS: "",
  });
  assert.equal(cfg.pollMs, FAST_SEED_DEFAULTS.pollMs);
  assert.equal(cfg.fullSweepMs, FAST_SEED_DEFAULTS.fullSweepMs);
  assert.equal(cfg.backoffMaxMs, FAST_SEED_DEFAULTS.backoffMaxMs);
  assert.ok(cfg.pollMs > 0, "a zero poll would be a busy-loop");
});

test("unset env => documented defaults; garbage and non-positive values fall back", () => {
  assert.deepEqual(fastSeedConfigFromEnv({}), FAST_SEED_DEFAULTS);
  assert.equal(fastSeedConfigFromEnv({ OPTA_VOL_FAST_POLL_MS: "abc" }).pollMs, 120_000);
  assert.equal(fastSeedConfigFromEnv({ OPTA_VOL_FAST_POLL_MS: "0" }).pollMs, 120_000);
  assert.equal(fastSeedConfigFromEnv({ OPTA_VOL_FAST_POLL_MS: "-5" }).pollMs, 120_000);
});

test("a real override is honoured, and drives the first backoff step", () => {
  const cfg = fastSeedConfigFromEnv({ OPTA_VOL_FAST_POLL_MS: "30000" });
  assert.equal(cfg.pollMs, 30_000);
  assert.equal(cfg.backoffBaseMs, 30_000, "never retry faster than the loop ticks");
});

test("OPTA_VOL_FAST_DISABLED=1 disables; anything else does not", () => {
  assert.equal(fastSeedConfigFromEnv({ OPTA_VOL_FAST_DISABLED: "1" }).disabled, true);
  assert.equal(fastSeedConfigFromEnv({ OPTA_VOL_FAST_DISABLED: "0" }).disabled, false);
  assert.equal(fastSeedConfigFromEnv({ OPTA_VOL_FAST_DISABLED: "" }).disabled, false);
  assert.equal(fastSeedConfigFromEnv({}).disabled, false);
});

// ============================================================================
// HEARTBEAT -- the loop must speak on a tick where it does nothing. A silent
// healthy loop is indistinguishable from a dead one.
// ============================================================================

test("the loop emits a heartbeat on a tick that seeds NOTHING", async () => {
  const m = market({ feedIdHex: feedHex(51) });
  const f = makeDeps({ markets: [m], existing: new Set([m.feedIdHex]) });
  const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];

  let ticks = 0;
  const ctx: any = {
    log: (_l: string, msg: string, fields?: Record<string, unknown>) =>
      lines.push({ msg, fields }),
    shouldShutdown: () => ticks++ >= 1, // one tick, then stop
  };

  await runFastSeedLoop(ctx, new Set(), { ...CFG, pollMs: 1 }, f.deps);

  const hb = lines.filter((l) => l.fields?.event === "vol-fast-seed-heartbeat");
  assert.equal(hb.length, 1, "exactly one heartbeat for one tick");
  assert.equal(hb[0].fields?.seededTotal, 0, "nothing seeded -- and it still spoke");
  assert.equal(hb[0].fields?.ticks, 1);
  assert.equal(hb[0].fields?.oraclesKnown, 1, "counters a monitor can diff");
  assert.equal(f.countOf("seedOracle"), 0);
});

test("the heartbeat still fires when the tick itself fails", async () => {
  const f = makeDeps({});
  (f.deps as any).marketWatermark = async () => {
    throw new Error("rpc down");
  };
  (f.deps as any).listMarkets = async () => {
    throw new Error("rpc down");
  };
  const lines: Array<{ fields?: Record<string, unknown> }> = [];
  let ticks = 0;
  const ctx: any = {
    log: (_l: string, _m: string, fields?: Record<string, unknown>) => lines.push({ fields }),
    shouldShutdown: () => ticks++ >= 1,
  };

  await runFastSeedLoop(ctx, new Set(), { ...CFG, pollMs: 1 }, f.deps);

  assert.equal(
    lines.filter((l) => l.fields?.event === "vol-fast-seed-heartbeat").length,
    1,
    "a broken RPC must not silence the monitor signal",
  );
});

test("a disabled loop says so and returns immediately", async () => {
  const lines: string[] = [];
  const ctx: any = {
    log: (_l: string, msg: string) => lines.push(msg),
    shouldShutdown: () => false, // would spin forever if not disabled
  };
  await runFastSeedLoop(ctx, new Set(), { ...CFG, disabled: true }, makeDeps({}).deps);
  assert.ok(lines.some((l) => l.includes("DISABLED")));
});

// ---- Runner ----------------------------------------------------------------

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`✗ ${t.name}`);
      console.error(`  ${err}`);
      if ((err as any)?.stack) console.error((err as any).stack);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("test runner crashed:", err);
  process.exit(1);
});
