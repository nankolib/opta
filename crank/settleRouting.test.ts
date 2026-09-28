// Unit tests for settle-lane routing. No chain.
// Run: ts-node --transpile-only -r tsconfig-paths/register settleRouting.test.ts
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  routeForSource, isLiveVault, livenessSourceOf, computePythExpiredTuples, assertPythTuple,
  type AccountRecord,
} from "./settleRouting";
import { partitionPythMarkets } from "./volOracleCrank";

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }

const NOW = 1_800_000_000;
const feed = (b: number) => Array.from(Buffer.alloc(32, b));
function market(asset: string, oracleSource: number | undefined, b = 1): AccountRecord {
  return { publicKey: Keypair.generate().publicKey, account: { assetName: asset, oracleSource, pythFeedId: feed(b) } };
}
function vault(m: AccountRecord, expiry: number, flags: { isSettled?: boolean; voided?: boolean } = {}): AccountRecord {
  return { publicKey: Keypair.generate().publicKey, account: { market: m.publicKey as PublicKey, expiry, isSettled: !!flags.isSettled, voided: !!flags.voided } };
}

// ---- source routing: 0 Pyth / 1 SB / 2 first-party / 3 refuse -----------------
test("route: source 0 goes to the Pyth lane", () => { assert.equal(routeForSource(0), "pyth"); });
test("route: a legacy market with no source byte (undefined) is Pyth", () => {
  assert.equal(routeForSource(undefined), "pyth");
  assert.equal(routeForSource(null), "pyth");
});
test("route: source 1 goes to the Switchboard lane", () => { assert.equal(routeForSource(1), "switchboard"); });
test("route: source 2 goes to the first-party lane", () => { assert.equal(routeForSource(2), "opta"); });
test("route: source 3 is refused, and so is anything else that is not 0, 1 or 2", () => {
  for (const s of [3, 4, 7, 255, -1, 1.5, NaN, "2x", {}]) assert.equal(routeForSource(s as any), "refuse", `source ${String(s)}`);
});

// ---- live vault rule ---------------------------------------------------------
test("a vault is live only if it is neither settled nor voided", () => {
  assert.equal(isLiveVault({ isSettled: false, voided: false }), true);
  assert.equal(isLiveVault({ isSettled: true, voided: false }), false);
  assert.equal(isLiveVault({ isSettled: false, voided: true }), false);
  assert.equal(isLiveVault({ isSettled: true, voided: true }), false);
});
test("a vault decoded from a layout with no voided field is live when unsettled", () => {
  assert.equal(isLiveVault({ isSettled: false }), true);
});

// ---- the Pyth enumeration ----------------------------------------------------
test("Pyth enumeration: a source-2 tuple never enumerates", () => {
  const sol = market("SOL", 2);
  const r = computePythExpiredTuples([vault(sol, NOW - 400), vault(sol, NOW - 400)], [sol], NOW);
  assert.equal(r.tuples.length, 0);
  assert.equal(r.skipped.opta, 2);
});
test("Pyth enumeration: a source-1 tuple never enumerates (unchanged)", () => {
  const xau = market("XAU", 1);
  const r = computePythExpiredTuples([vault(xau, NOW - 400)], [xau], NOW);
  assert.equal(r.tuples.length, 0);
  assert.equal(r.skipped.switchboard, 1);
});
test("Pyth enumeration: a source-3 tuple is refused and counted", () => {
  const odd = market("ODD", 3);
  const r = computePythExpiredTuples([vault(odd, NOW - 400)], [odd], NOW);
  assert.equal(r.tuples.length, 0);
  assert.equal(r.skipped.refused, 1);
});
test("Pyth enumeration: source 0 and legacy-undefined tuples enumerate, grouped by (asset, expiry)", () => {
  const a = market("AAA", 0, 1), b = market("BBB", undefined, 2);
  const r = computePythExpiredTuples(
    [vault(a, NOW - 100), vault(a, NOW - 100), vault(a, NOW - 50), vault(b, NOW - 100)], [a, b], NOW);
  assert.deepEqual(r.tuples.map((t) => `${t.key}x${t.vaultPdas.length}`), [`AAA:${NOW - 100}x2`, `BBB:${NOW - 100}x1`, `AAA:${NOW - 50}x1`]);
  assert.ok(r.tuples.every((t) => t.oracleSource === 0));
});
test("Pyth enumeration: a voided vault never enumerates", () => {
  const a = market("AAA", 0);
  const r = computePythExpiredTuples([vault(a, NOW - 100, { voided: true }), vault(a, NOW - 100, { voided: true })], [a], NOW);
  assert.equal(r.tuples.length, 0, "a tuple whose every vault is voided is not live");
  assert.equal(r.skipped.voided, 2);
});
test("Pyth enumeration: a tuple with one live vault among voided ones enumerates with the live vault only", () => {
  const a = market("AAA", 0);
  const live = vault(a, NOW - 100);
  const r = computePythExpiredTuples([vault(a, NOW - 100, { voided: true }), live], [a], NOW);
  assert.equal(r.tuples.length, 1);
  assert.deepEqual(r.tuples[0].vaultPdas.map((p) => p.toBase58()), [live.publicKey.toBase58()]);
});
test("Pyth enumeration: settled and unexpired vaults never enumerate (unchanged)", () => {
  const a = market("AAA", 0);
  const r = computePythExpiredTuples([vault(a, NOW - 100, { isSettled: true }), vault(a, NOW + 100), vault(a, NOW)], [a], NOW);
  assert.equal(r.tuples.length, 0);
});
test("the mix found on chain 2026-09-28 (nine tuples on four source-2 markets) enumerates nothing", () => {
  const ms = ["BTC", "ETH", "SOL", "XRP"].map((n, i) => market(n, 2, i + 1));
  const vs: AccountRecord[] = [];
  for (const m of ms) { vs.push(vault(m, NOW - 2_000_000, { voided: true })); vs.push(vault(m, NOW - 300_000)); }
  vs.push(vault(ms[0], NOW - 9_000_000, { voided: true }));
  const r = computePythExpiredTuples(vs, ms, NOW);
  assert.equal(r.tuples.length, 0);
});

// ---- the guard at the Pyth builder's call site --------------------------------
test("GUARD: a source-2 tuple reaching the Pyth builder throws", () => {
  assert.throws(() => assertPythTuple({ asset: "SOL", expiry: NOW, oracleSource: 2 }), /source 2.*Pyth settle builder/);
});
test("GUARD: source 1 and source 3 also throw at the Pyth builder", () => {
  assert.throws(() => assertPythTuple({ asset: "XAU", expiry: NOW, oracleSource: 1 }), /Pyth settle builder/);
  assert.throws(() => assertPythTuple({ asset: "ODD", expiry: NOW, oracleSource: 3 }), /Pyth settle builder/);
});
test("GUARD: a source-0 tuple passes", () => {
  assert.doesNotThrow(() => assertPythTuple({ asset: "AAA", expiry: NOW, oracleSource: 0 }));
});

// ---- the Pyth vol lane -------------------------------------------------------
test("Pyth vol lane: source 2 is excluded and counted apart from Switchboard", () => {
  const mk = (s: number | undefined) => ({ publicKey: Keypair.generate().publicKey, account: { oracleSource: s } });
  const r: any = partitionPythMarkets([mk(0), mk(undefined), mk(1), mk(2), mk(2), mk(3)]);
  assert.equal(r.pyth.length, 2, "only source 0 and legacy-undefined stay");
  assert.equal(r.skippedSb, 1);
  assert.equal(r.skippedOpta, 2);
  assert.equal(r.refused, 1);
});

// ---- liveness classification -------------------------------------------------
test("liveness: source 2 is classified as 2, not as 0", () => {
  assert.equal(livenessSourceOf(2), 2);
  assert.equal(livenessSourceOf(1), 1);
  assert.equal(livenessSourceOf(0), 0);
  assert.equal(livenessSourceOf(undefined), 0);
});
test("liveness: an unknown source is not tracked", () => {
  assert.equal(livenessSourceOf(3), null);
  assert.equal(livenessSourceOf(255), null);
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; console.log("  ok   " + t.name); }
    catch (e) { fail++; console.log("  FAIL " + t.name + "\n       " + String((e as any)?.message ?? e).split("\n")[0]); }
  }
  console.log(`\nsettleRouting: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
