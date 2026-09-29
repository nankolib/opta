// Gates for the FE side of first-party-market (oracle_source 2) visibility.
// The modules under test live in app/src; they are loaded here because crank/
// has the runner (ts-node + tsconfig-paths) and app/ has none.
//
// Run (from crank/): ts-node --transpile-only -r tsconfig-paths/register source2Visibility.test.ts
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";

import * as pythPullPost from "@app/utils/pythPullPost";
import * as spotSources from "@app/hooks/spotSources";
import {
  classifySettleTuples, actionable, unsettleable,
  SB_SETTLE_WINDOW_SECS, PYTH_MAX_AGE_SECS,
  type MarketRow, type VaultRow, type RecordRow,
} from "@app/pages/portfolio/settleTuples";

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }

const PID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const SOL_FEED = "e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463";

// ---- 1. the Pyth settle builder refuses a first-party market ------------------
//
// buildPostUpdateAndSettleTx passes `optaPriceFeed: null`. For a source-2 market
// that instruction cannot succeed, so the builder must not emit it: it reads the
// market and throws before it asks the price service for anything.

function fakeProgram(oracleSource: unknown, calls: { marketFetch: number }) {
  return {
    programId: PID,
    provider: { connection: {} },
    account: {
      optionsMarket: {
        fetch: async (_pda: PublicKey) => { calls.marketFetch += 1; return { assetName: "SOL", oracleSource }; },
      },
    },
  } as any;
}
const wallet = { publicKey: Keypair.generate().publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any;

async function withFetchStub<T>(fn: (seen: string[]) => Promise<T>): Promise<T> {
  const seen: string[] = [];
  const real = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: any) => { seen.push(String(url)); throw new Error("PRICE-SERVICE-REACHED"); };
  try { return await fn(seen); } finally { (globalThis as any).fetch = real; }
}

test("settle builder: a source-2 market is refused, and the price service is never asked", async () => {
  await withFetchStub(async (seen) => {
    const calls = { marketFetch: 0 };
    await assert.rejects(
      () => pythPullPost.buildPostUpdateAndSettleTx(fakeProgram(2, calls), wallet, "SOL", 1_790_606_436, SOL_FEED, "https://price.invalid"),
      (e: any) => e?.name === "SettleSourceRefusedError" && e.oracleSource === 2 && e.asset === "SOL",
    );
    assert.equal(calls.marketFetch, 1, "the builder read the market itself");
    assert.deepEqual(seen, [], "nothing was requested from the price service");
  });
});

test("settle builder: the refusal names no vendor", async () => {
  await withFetchStub(async () => {
    try {
      await pythPullPost.buildPostUpdateAndSettleTx(fakeProgram(2, { marketFetch: 0 }), wallet, "SOL", 1, SOL_FEED, "https://price.invalid");
      assert.fail("must throw");
    } catch (e: any) {
      assert.equal(e.name, "SettleSourceRefusedError");
      assert.doesNotMatch(String(e.message), /pyth|switchboard|hermes|opta price feed/i);
    }
  });
});

test("settle builder: a source-0 market is not refused (it goes on to the price service)", async () => {
  await withFetchStub(async (seen) => {
    await assert.rejects(
      () => pythPullPost.buildPostUpdateAndSettleTx(fakeProgram(0, { marketFetch: 0 }), wallet, "AAA", 1_790_606_436, SOL_FEED, "https://price.invalid"),
      (e: any) => e?.name !== "SettleSourceRefusedError",
    );
    assert.ok(seen.length >= 1, "the Pyth path was taken");
  });
});

test("settle builder: a market that cannot be read is an error, not a settle", async () => {
  await withFetchStub(async (seen) => {
    const p = fakeProgram(0, { marketFetch: 0 });
    p.account.optionsMarket.fetch = async () => { throw new Error("rpc down"); };
    await assert.rejects(
      () => pythPullPost.buildPostUpdateAndSettleTx(p, wallet, "SOL", 1, SOL_FEED, "https://price.invalid"),
      /rpc down/,
    );
    assert.deepEqual(seen, []);
  });
});

test("assertPythSettleSource: 0 and absent pass; 2 throws; an unknown byte throws", () => {
  const f = (pythPullPost as any).assertPythSettleSource;
  assert.equal(typeof f, "function");
  assert.doesNotThrow(() => f("AAA", 1, 0));
  assert.doesNotThrow(() => f("OLD", 1, undefined));
  assert.throws(() => f("SOL", 1, 2), (e: any) => e.name === "SettleSourceRefusedError");
  assert.throws(() => f("ODD", 1, 3), (e: any) => e.name === "SettleSourceRefusedError");
});

// ---- 2. the settle list never offers a manual settle on a source-2 tuple --------

const NOW = Date.parse("2026-09-29T08:00:00Z") / 1000;
const MK: MarketRow[] = [
  { pda: "mSOL", assetName: "SOL", feedIdHex: SOL_FEED, oracleSource: 2 },
  { pda: "mAAA", assetName: "AAA", feedIdHex: "aa", oracleSource: 0 },
  { pda: "mODD", assetName: "ODD", feedIdHex: "bb", oracleSource: 3 },
];
const v = (pda: string, market: string, expiry: number, extra: Partial<VaultRow> = {}): VaultRow => ({ pda, market, expiry, isSettled: false, ...extra });

test("settle list: source 2 with no record is keeper-only inside the window, never offered", () => {
  const t = classifySettleTuples([v("v1", "mSOL", NOW - 100)], MK, [], NOW);
  assert.equal(t.length, 1);
  assert.equal(t[0].cls, "crankOnly");
  assert.equal(t[0].oracleSource, 2);
  assert.equal(actionable(t).length, 0);
  assert.equal(unsettleable(t).length, 0);
});
test("settle list: source 2 with no record past the window is unsettleable, never offered", () => {
  for (const age of [SB_SETTLE_WINDOW_SECS + 1, 86_400, 4 * 86_400, PYTH_MAX_AGE_SECS - 1]) {
    const t = classifySettleTuples([v("v1", "mSOL", NOW - age)], MK, [], NOW);
    assert.equal(t[0].cls, "dark", `age ${age}`);
    assert.notEqual(t[0].cls, "pyth");
    assert.equal(actionable(t).length, 0);
  }
});
test("settle list: source 2 WITH a record is settleable (the oracle-free fan-out)", () => {
  const rec: RecordRow[] = [{ assetName: "SOL", expiry: NOW - 500 }];
  const t = classifySettleTuples([v("v1", "mSOL", NOW - 500)], MK, rec, NOW);
  assert.equal(t[0].cls, "settleable");
  assert.equal(actionable(t).length, 1);
});
test("settle list: an unknown source is never offered either", () => {
  const t = classifySettleTuples([v("v1", "mODD", NOW - 100), v("v2", "mODD", NOW - 5000)], MK, [], NOW);
  assert.equal(actionable(t).length, 0);
});
test("settle list: a Pyth tuple is still offered (unchanged)", () => {
  const t = classifySettleTuples([v("v1", "mAAA", NOW - 5000)], MK, [], NOW);
  assert.equal(t[0].cls, "pyth");
  assert.equal(actionable(t).length, 1);
});
// ---- 3. the trade dock's spot entries keep source 2 ------------------------------

test("dock spot entries: a source-2 market stays source 2 and routes to the first-party reader", () => {
  const f = (spotSources as any).spotEntriesFromMarkets;
  assert.equal(typeof f, "function");
  const bytes = Array.from(Buffer.from(SOL_FEED, "hex"));
  const entries = f([
    { account: { assetName: "SOL", pythFeedId: bytes, oracleSource: 2 } },
    { account: { assetName: "XAU", pythFeedId: Array.from(Buffer.alloc(32, 7)), oracleSource: 1 } },
    { account: { assetName: "AAA", pythFeedId: Array.from(Buffer.alloc(32, 8)), oracleSource: 0 } },
    { account: { assetName: "OLD", pythFeedId: Array.from(Buffer.alloc(32, 9)) } },
    { account: { assetName: "SOL", pythFeedId: bytes, oracleSource: 2 } },
    { account: { assetName: "", pythFeedId: bytes, oracleSource: 2 } },
  ]);
  assert.deepEqual(entries.map((e: any) => `${e.ticker}:${e.oracleSource}`), ["SOL:2", "XAU:1", "AAA:0", "OLD:0"]);
  assert.equal(entries[0].feedIdHex, SOL_FEED);
  const split = spotSources.splitBySource(entries);
  assert.deepEqual(split.optaFeeds.map((x) => x.ticker), ["SOL"]);
  assert.deepEqual(split.sbFeeds.map((x) => x.ticker), ["XAU"]);
  assert.deepEqual(split.pythFeeds.map((x) => x.ticker), ["AAA", "OLD"]);
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; console.log("  ok   " + t.name); }
    catch (e) { fail++; console.log("  FAIL " + t.name + "\n       " + String((e as any)?.message ?? e).split("\n")[0]); }
  }
  console.log(`\nsource2Visibility: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
