// ============================================================================
// crank/fpOracleCrank.test.ts -- decision-logic tests for the FP-ORACLE lane
// ============================================================================
//
// Vanilla TS + node:assert, matching volOracleCrank.test.ts. Run with:
//   node crank/node_modules/ts-node/dist/bin.js --transpile-only crank/fpOracleCrank.test.ts
//
// WHAT THIS COVERS -- the decisions the lane makes before it ever signs:
//   - the >=3-responder floor aborts rather than pushing a thin median
//   - the spread band aborts rather than pushing a disputed price
//   - bps_delta is computed against the DISJOINT verify set, and within_gate
//     reflects the 50 bps S3 gate
//   - reseed classification from the on-chain gap
//   - genesis is refused as a crank action (it is a ceremony)
//   - every outcome writes exactly one JSONL line -- the soak artifact must not
//     silently lose the ticks that went wrong, which are the interesting ones
//
// WHAT IT DOES NOT COVER: the real send. That needs a funded authority and a
// live feed PDA and belongs to the devnet smoke, not to a unit test.
//
// Network and chain are both injected: `global.fetch` is stubbed per-URL and the
// Anchor program is a hand-rolled double. No test here touches a venue or an RPC.
// ============================================================================

import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

import {
  tickFeed, MIN_RESPONDERS, MAX_PUSH_SPREAD_BPS, VERIFY_GATE_BPS, VERIFY_QUALITY_MAX_SPREAD_BPS, RESEED_GAP_SECS,
  type FpCrankContext, type FpTickReport, type SampleRecord,
} from "./fpOracleCrank";
import { FP_FEEDS, assertDisjoint, median, spreadBps, resolvePath } from "./fpOracleRegistry";

const BTC = FP_FEEDS.find((f) => f.symbol === "BTC/USD")!;

let tmpDir = "";
function freshJsonl(): string {
  if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-oracle-test-"));
  return path.join(tmpDir, `s${Math.random().toString(36).slice(2)}.jsonl`);
}
function readSamples(p: string): SampleRecord[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Stub global.fetch: map a substring of the URL to a numeric price (or null to fail). */
function stubFetch(byUrlFragment: Array<[string, number | null]>): () => void {
  const orig = global.fetch;
  (global as any).fetch = async (url: string) => {
    for (const [frag, val] of byUrlFragment) {
      if (String(url).includes(frag)) {
        if (val === null) return { ok: false, status: 503, json: async () => ({}) } as any;
        // Shape the body to whatever path THIS venue's spec expects, so the test
        // exercises the real resolvePath wiring rather than a convenient stub.
        if (frag.includes("crypto.com")) return { ok: true, json: async () => ({ result: { data: [{ a: String(val) }] } }) } as any;
        if (frag.includes("coinbase")) return { ok: true, json: async () => ({ price: String(val) }) } as any;
        if (frag.includes("okx")) return { ok: true, json: async () => ({ data: [{ last: String(val) }] }) } as any;
        if (frag.includes("gateio")) return { ok: true, json: async () => [{ last: String(val) }] } as any;
        if (frag.includes("kucoin")) return { ok: true, json: async () => ({ data: { price: String(val) } }) } as any;
        if (frag.includes("bitget")) return { ok: true, json: async () => ({ data: [{ lastPr: String(val) }] }) } as any;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  };
  return () => { (global as any).fetch = orig; };
}

/** Program double. `publishTime === null` means the feed PDA does not exist. */
function fakeProgram(publishTime: number | null) {
  return {
    programId: new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq"),
    account: {
      optaPriceFeed: {
        fetch: async () => {
          if (publishTime === null) throw new Error("Account does not exist");
          return { publishTime };
        },
      },
    },
    methods: {
      pushOptaPrice: () => ({
        accountsStrict: () => ({ instruction: async () => ({ keys: [], programId: null, data: Buffer.alloc(0) }) }),
      }),
    },
    provider: {},
  } as any;
}

function ctxFor(program: any, jsonl: string): FpCrankContext {
  return {
    connection: {} as any,
    wallet: { publicKey: new PublicKey("11111111111111111111111111111111") } as any,
    program,
    log: () => {},
    shouldShutdown: () => false,
    dryRun: true,             // never send from a unit test
    forceFeeds: [],
    jsonlPath: jsonl,
    intervalMs: 60_000,
  };
}
const emptyReport = (): FpTickReport => ({
  feedsConsidered: 0, pushed: 0, aborted: 0, failed: 0, reseeds: 0, outsideGate: 0, referenceUnreliable: 0, durationMs: 0,
});

// ---- pure helpers ----------------------------------------------------------

{
  assert.equal(median([3, 1, 2]), 2, "odd median");
  assert.equal(median([4, 1, 2, 3]), 2.5, "even median averages the middle pair");
  assert.equal(spreadBps([100, 100, 100]), 0, "identical sources have no spread");
  assert.ok(Math.abs(spreadBps([99, 100, 101]) - 200) < 0.001, "1% either side is 200bps");
  assert.equal(resolvePath({ data: [{ last: "7" }] }, "data[0].last"), "7", "indexed path");
  assert.equal(resolvePath([{ last: "8" }], "[0].last"), "8", "leading-index path");
  assert.equal(resolvePath({ a: { b: 1 } }, "a.c"), undefined, "missing key is undefined");
  console.log("  ok  pure helpers");
}

// ---- S10 guard is live in this build ---------------------------------------

{
  const { checked } = assertDisjoint();
  assert.equal(checked, FP_FEEDS.length);
  for (const f of FP_FEEDS) {
    const overlap = f.push.map((s) => s.id).filter((id) => f.verify.some((v) => v.id === id));
    assert.deepEqual(overlap, [], `${f.symbol} push/verify overlap`);
  }
  console.log(`  ok  S10 disjointness holds for all ${checked} feeds`);
}

// ---- happy path -------------------------------------------------------------

async function main() {
  {
    const jsonl = freshJsonl();
    const un = stubFetch([
      ["crypto.com", 100], ["coinbase", 100.02], ["okx", 99.98],   // push median 100
      ["gateio", 100.01], ["kucoin", 100.0], ["bitget", 100.02], // verify median 100.01
    ]);
    const rep = emptyReport();
    await tickFeed(ctxFor(fakeProgram(Math.floor(Date.now() / 1000) - 60), jsonl), BTC, rep);
    un();
    const s = readSamples(jsonl);
    assert.equal(s.length, 1, "exactly one artifact line per tick");
    assert.equal(s[0].status, "dry-run");
    assert.equal(rep.pushed, 1);
    assert.ok(Math.abs(s[0].pushed_price! - 100) < 1e-9, "pushed the push-side median");
    assert.ok(Math.abs(s[0].reference_median! - 100.01) < 1e-9, "reference from the verify set");
    assert.equal(s[0].within_gate, true, `delta ${s[0].bps_delta} must be inside ${VERIFY_GATE_BPS}bps`);
    assert.deepEqual(s[0].push_sources.sort(), ["coinbase", "cryptocom", "okx"]);
    assert.deepEqual(s[0].verify_sources.sort(), ["bitget", "gate", "kucoin"]);
    assert.equal(s[0].reseed, false);
    console.log("  ok  happy path: pushes the median, verifies against the disjoint set");
  }

  // ---- responder floor ------------------------------------------------------
  {
    const jsonl = freshJsonl();
    const un = stubFetch([
      ["crypto.com", 100], ["coinbase", 100.02], ["okx", null],   // only 2 push responders
      ["gateio", 100], ["kucoin", 100], ["bitget", 100],
    ]);
    const rep = emptyReport();
    await tickFeed(ctxFor(fakeProgram(Math.floor(Date.now() / 1000) - 60), jsonl), BTC, rep);
    un();
    const s = readSamples(jsonl);
    assert.equal(rep.aborted, 1, "a thin push set must abort, not push");
    assert.equal(rep.pushed, 0);
    assert.equal(s[0].status, "aborted");
    assert.match(s[0].reason!, /push responders 2 < 3/);
    assert.equal(s[0].pushed_price, null, "an aborted tick records no price");
    console.log(`  ok  responder floor: <${MIN_RESPONDERS} aborts and is recorded`);
  }

  // ---- spread band ----------------------------------------------------------
  {
    const jsonl = freshJsonl();
    const un = stubFetch([
      ["crypto.com", 100], ["coinbase", 100], ["okx", 110],  // ~1000bps spread
      ["gateio", 100], ["kucoin", 100], ["bitget", 100],
    ]);
    const rep = emptyReport();
    await tickFeed(ctxFor(fakeProgram(Math.floor(Date.now() / 1000) - 60), jsonl), BTC, rep);
    un();
    const s = readSamples(jsonl);
    assert.equal(rep.aborted, 1, "disagreeing venues must abort");
    assert.match(s[0].reason!, /push spread/);
    assert.ok(s[0].push_spread_bps! > MAX_PUSH_SPREAD_BPS);
    console.log(`  ok  spread band: >${MAX_PUSH_SPREAD_BPS}bps disagreement aborts`);
  }

  // ---- verify gate breach ---------------------------------------------------
  {
    const jsonl = freshJsonl();
    const un = stubFetch([
      ["crypto.com", 100], ["coinbase", 100], ["okx", 100],       // push 100
      ["gateio", 105], ["kucoin", 105], ["bitget", 105],        // reference 105 -> ~476bps
    ]);
    const rep = emptyReport();
    await tickFeed(ctxFor(fakeProgram(Math.floor(Date.now() / 1000) - 60), jsonl), BTC, rep);
    un();
    const s = readSamples(jsonl);
    // It still PUSHES — the crank does not get to fail its own soak. It records
    // the breach so S3 can be judged from the artifact.
    assert.equal(rep.pushed, 1, "a gate breach is recorded, not silently suppressed");
    assert.equal(rep.outsideGate, 1);
    assert.equal(s[0].within_gate, false);
    assert.ok(s[0].bps_delta! > VERIFY_GATE_BPS);
    console.log("  ok  verify-gate breach is flagged in the artifact, not hidden");
  }

  // ---- D3: per-feed gate is what gets recorded ------------------------------
  {
    const XRP = FP_FEEDS.find((f) => f.symbol === "XRP/USD")!;
    assert.equal(BTC.verifyGateBps, 30, "BTC re-fit 2026-09-18");
    assert.equal(XRP.verifyGateBps, 50, "XRP held at the global gate (D3 ruling b)");
    const jsonl = freshJsonl();
    const un = stubFetch([
      ["crypto.com", 100], ["coinbase", 100], ["okx", 100],       // push 100
      ["gateio", 100.4], ["kucoin", 100.4], ["bitget", 100.4],  // reference +40bps: inside 50, OUTSIDE 30
    ]);
    const rep = emptyReport();
    await tickFeed(ctxFor(fakeProgram(Math.floor(Date.now() / 1000) - 60), jsonl), BTC, rep);
    un();
    const s = readSamples(jsonl);
    assert.equal(s[0].gate_bps, 30, "the per-feed gate is the one written to the artifact");
    assert.equal(s[0].within_gate, false, "40bps is outside BTC gate 30 even though inside the old global 50");
    assert.equal(rep.outsideGate, 1);
    console.log("  ok  D3: per-feed gate (BTC 30) is recorded and judged, not the global 50");
  }

  // ---- D3 ruling (b): verify-quality gate -----------------------------------
  {
    const jsonl = freshJsonl();
    // Verify venues DISAGREE among themselves by ~300bps (1.3102 / 1.3055 pattern
    // from the soak, exaggerated): the reference is not a measurement this tick.
    const un = stubFetch([
      ["crypto.com", 100], ["coinbase", 100], ["okx", 100],
      ["gateio", 98.5], ["kucoin", 101.5], ["bitget", 100],
    ]);
    const rep = emptyReport();
    await tickFeed(ctxFor(fakeProgram(Math.floor(Date.now() / 1000) - 60), jsonl), BTC, rep);
    un();
    const s = readSamples(jsonl);
    assert.equal(rep.pushed, 1, "the push still goes out -- the push side was tight");
    assert.ok(s[0].verify_spread_bps! > VERIFY_QUALITY_MAX_SPREAD_BPS);
    assert.equal(s[0].reference_unreliable, true);
    assert.equal(s[0].within_gate, null, "S3 is NOT evaluated against an unreliable reference");
    assert.equal(rep.outsideGate, 0, "an unreliable reference is not a breach");
    assert.equal(rep.referenceUnreliable, 1, "...it is counted on its own");
    console.log("  ok  verify-quality gate: disagreeing reference => within_gate null, counted separately");
  }
  {
    // And the converse must hold, or the gate above proves nothing: a TIGHT
    // reference exactly at the floor is still judged.
    const jsonl = freshJsonl();
    const un = stubFetch([
      ["crypto.com", 100], ["coinbase", 100], ["okx", 100],
      ["gateio", 100], ["kucoin", 100.19], ["bitget", 100.1],   // spread ~19bps: under the 20 floor
    ]);
    const rep = emptyReport();
    await tickFeed(ctxFor(fakeProgram(Math.floor(Date.now() / 1000) - 60), jsonl), BTC, rep);
    un();
    const s = readSamples(jsonl);
    assert.equal(s[0].reference_unreliable, false);
    assert.notEqual(s[0].within_gate, null, "a reference under the floor IS judged");
    assert.equal(rep.referenceUnreliable, 0);
    console.log("  ok  verify-quality gate: a reference under the floor is still judged (the gate can fail)");
  }

  // ---- reseed classification ------------------------------------------------
  {
    const jsonl = freshJsonl();
    const un = stubFetch([
      ["crypto.com", 100], ["coinbase", 100], ["okx", 100],
      ["gateio", 100], ["kucoin", 100], ["bitget", 100],
    ]);
    const rep = emptyReport();
    const stale = Math.floor(Date.now() / 1000) - (RESEED_GAP_SECS + 120);
    await tickFeed(ctxFor(fakeProgram(stale), jsonl), BTC, rep);
    un();
    const s = readSamples(jsonl);
    assert.equal(rep.reseeds, 1, "a gap beyond the threshold must be classified");
    assert.equal(s[0].reseed, true);
    assert.ok(s[0].gap_secs! > RESEED_GAP_SECS);
    assert.equal(s[0].within_gate, true, "a reseed is still held to the same gate");
    console.log(`  ok  reseed: gap >${RESEED_GAP_SECS}s flagged distinct and still gated`);
  }

  // ---- genesis is a ceremony -------------------------------------------------
  {
    const jsonl = freshJsonl();
    const un = stubFetch([
      ["crypto.com", 100], ["coinbase", 100], ["okx", 100],
      ["gateio", 100], ["kucoin", 100], ["bitget", 100],
    ]);
    const rep = emptyReport();
    await tickFeed(ctxFor(fakeProgram(null), jsonl), BTC, rep);  // no feed PDA
    un();
    const s = readSamples(jsonl);
    assert.equal(rep.pushed, 0, "the crank must never write a genesis price");
    assert.equal(rep.aborted, 1);
    assert.match(s[0].reason!, /genesis is a ceremony/);
    console.log("  ok  genesis: crank refuses to set the one price the breaker cannot check");
  }

  console.log("\nfpOracleCrank: all decision-logic tests passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
