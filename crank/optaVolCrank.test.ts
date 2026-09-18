// Unit tests for the Opta vol-sample lane. No chain: every I/O is injected.
// Run: ts-node --transpile-only -r tsconfig-paths/register optaVolCrank.test.ts
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  decidePush, partitionOptaMarkets, pushAccounts, tickOnce, feedPdaFor, volOraclePdaFor,
  OPTA_FEED_READ_MAX_AGE_SECS, VOL_MIN_PUSH_INTERVAL_SECS,
  type OptaVolCrankContext, type OptaVolDeps, type FeedSnapshot, type OracleSnapshot,
} from "./optaVolCrank";

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }

const NOW = 1_800_000_000;
const fresh: FeedSnapshot = { frozen: false, publishTime: NOW - 30, price6dec: 1n };
const warm: OracleSnapshot = { lastSampleTs: NOW - 3600, sampleCount: 200 };

// ---- decidePush: mirrors the on-chain guards ---------------------------------
test("pushes on a fresh feed with an on-cadence oracle", () => {
  assert.deepEqual(decidePush(fresh, warm, NOW), { push: true });
});
test("refuses when the feed account is absent", () => {
  assert.deepEqual(decidePush(null, warm, NOW), { push: false, reason: "no-feed" });
});
test("refuses when the vol oracle is absent (this lane never inits)", () => {
  assert.deepEqual(decidePush(fresh, null, NOW), { push: false, reason: "no-oracle" });
});
test("refuses a frozen feed", () => {
  assert.deepEqual(decidePush({ ...fresh, frozen: true }, warm, NOW), { push: false, reason: "frozen" });
});
test("refuses a stale feed at exactly max-age + 1", () => {
  const stale = { ...fresh, publishTime: NOW - OPTA_FEED_READ_MAX_AGE_SECS - 1 };
  assert.deepEqual(decidePush(stale, warm, NOW), { push: false, reason: "stale-feed" });
  const edge = { ...fresh, publishTime: NOW - OPTA_FEED_READ_MAX_AGE_SECS };
  assert.deepEqual(decidePush(edge, warm, NOW), { push: true }, "max-age itself is still fresh (<= on-chain)");
});
test("refuses a never-pushed feed (publish_time 0)", () => {
  assert.deepEqual(decidePush({ ...fresh, publishTime: 0 }, warm, NOW), { push: false, reason: "stale-feed" });
});
test("rate-limits inside the 55-minute window, allows at the boundary", () => {
  assert.deepEqual(decidePush(fresh, { ...warm, lastSampleTs: NOW - VOL_MIN_PUSH_INTERVAL_SECS + 1 }, NOW), { push: false, reason: "rate-limit" });
  assert.deepEqual(decidePush(fresh, { ...warm, lastSampleTs: NOW - VOL_MIN_PUSH_INTERVAL_SECS }, NOW), { push: true });
});
test("a freshly reset oracle (lastSampleTs 0) is pushable immediately — the seed push", () => {
  assert.deepEqual(decidePush(fresh, { lastSampleTs: 0, sampleCount: 0 }, NOW), { push: true });
});
test("stale-feed wins over rate-limit (do not even consider the cadence on a dead feed)", () => {
  const stale = { ...fresh, publishTime: NOW - 10_000 };
  assert.deepEqual(decidePush(stale, { ...warm, lastSampleTs: NOW - 10 }, NOW), { push: false, reason: "stale-feed" });
});

// ---- partition: only source 2 -----------------------------------------------
test("partitionOptaMarkets keeps exactly oracle_source == 2", () => {
  const mk = (s: number) => ({ publicKey: Keypair.generate().publicKey, account: { oracleSource: s } });
  const r = partitionOptaMarkets([mk(0), mk(1), mk(2), mk(2), mk(7)]);
  assert.equal(r.opta.length, 2); assert.equal(r.other, 3);
});

// ---- wire shape --------------------------------------------------------------
test("pushAccounts: Pyth None, three SB None, feed in the trailing slot", () => {
  const s = Keypair.generate().publicKey, v = Keypair.generate().publicKey, f = Keypair.generate().publicKey;
  const a = pushAccounts(s, v, f);
  assert.deepEqual(Object.keys(a), ["signer", "priceUpdate", "volOracle", "systemProgram", "sbQueue", "sbSlothashes", "sbInstructions", "optaPriceFeed"]);
  assert.equal(a.priceUpdate, null); assert.equal(a.sbQueue, null); assert.equal(a.sbSlothashes, null); assert.equal(a.sbInstructions, null);
  assert.equal(a.optaPriceFeed, f); assert.equal(a.systemProgram, SystemProgram.programId);
});
test("PDAs derive from the market's feed_id under the given program", () => {
  const pid = Keypair.generate().publicKey; const bytes = Array.from({ length: 32 }, (_, i) => i);
  assert.notEqual(feedPdaFor(pid, bytes).toBase58(), volOraclePdaFor(pid, bytes).toBase58());
  assert.equal(feedPdaFor(pid, bytes).toBase58(), feedPdaFor(pid, bytes).toBase58());
});

// ---- tickOnce with injected deps --------------------------------------------
function ctxWith(dryRun = false): { ctx: OptaVolCrankContext; logs: any[] } {
  const logs: any[] = [];
  const ctx = {
    connection: {} as any, wallet: { publicKey: Keypair.generate().publicKey } as any,
    program: { programId: Keypair.generate().publicKey, account: {}, methods: {}, provider: {} } as any,
    log: (level: string, msg: string, fields?: any) => logs.push({ level, msg, ...(fields ?? {}) }),
    shouldShutdown: () => false, dryRun,
  } as OptaVolCrankContext;
  return { ctx, logs };
}
function depsWith(over: Partial<OptaVolDeps>, feedBytesList: number[][]): { deps: OptaVolDeps; sent: string[] } {
  const sent: string[] = [];
  const deps: OptaVolDeps = {
    fetchMarkets: async () => feedBytesList.map((b) => ({ publicKey: Keypair.generate().publicKey, account: { oracleSource: 2, pythFeedId: b } })),
    fetchFeed: async () => fresh,
    fetchOracle: async () => warm,
    sendPush: async (b) => { sent.push(Buffer.from(b).toString("hex").slice(0, 8)); return "sig-" + sent.length; },
    now: () => NOW,
    ...over,
  };
  return { deps, sent };
}
const B1 = Array.from({ length: 32 }, () => 1), B2 = Array.from({ length: 32 }, () => 2);

test("tickOnce pushes every source-2 feed once, dedupes shared feed ids", async () => {
  const { ctx } = ctxWith();
  const { deps, sent } = depsWith({}, [B1, B2, B1]);   // two markets share B1
  const r = await tickOnce(ctx, deps);
  assert.equal(r.optaMarkets, 3); assert.equal(r.feedsConsidered, 2); assert.equal(r.pushed, 2);
  assert.deepEqual(sent, ["01010101", "02020202"]);
});
test("tickOnce ignores source-0 and source-1 markets entirely", async () => {
  const { ctx } = ctxWith();
  const { deps, sent } = depsWith({
    fetchMarkets: async () => [
      { publicKey: Keypair.generate().publicKey, account: { oracleSource: 0, pythFeedId: B1 } },
      { publicKey: Keypair.generate().publicKey, account: { oracleSource: 1, pythFeedId: B2 } },
    ],
  }, []);
  const r = await tickOnce(ctx, deps);
  assert.equal(r.marketsSeen, 2); assert.equal(r.optaMarkets, 0); assert.equal(r.pushed, 0); assert.deepEqual(sent, []);
});
test("tickOnce skips a stale feed without sending, and says why", async () => {
  const { ctx, logs } = ctxWith();
  const { deps, sent } = depsWith({ fetchFeed: async () => ({ ...fresh, publishTime: NOW - 1000 }) }, [B1]);
  const r = await tickOnce(ctx, deps);
  assert.equal(r.skippedStaleFeed, 1); assert.equal(r.pushed, 0); assert.deepEqual(sent, []);
  assert.ok(logs.some((l) => l.msg === "opta-vol push skipped" && l.reason === "stale-feed" && l.level === "warn"));
});
test("tickOnce counts a send failure as errored and continues to the next feed", async () => {
  const { ctx } = ctxWith();
  let n = 0;
  const { deps } = depsWith({ sendPush: async () => { n += 1; if (n === 1) throw new Error("boom"); return "ok"; } }, [B1, B2]);
  const r = await tickOnce(ctx, deps);
  assert.equal(r.errored, 1); assert.equal(r.pushed, 1);
});
test("dry-run never calls sendPush but reports the would-push", async () => {
  const { ctx, logs } = ctxWith(true);
  const { deps, sent } = depsWith({}, [B1]);
  const r = await tickOnce(ctx, deps);
  assert.equal(r.pushed, 1); assert.deepEqual(sent, []);
  assert.ok(logs.some((l) => /WOULD-PUSH/.test(l.msg)));
});
test("shutdown mid-tick stops before the next feed", async () => {
  const { ctx } = ctxWith();
  let calls = 0; (ctx as any).shouldShutdown = () => calls++ > 0;
  const { deps, sent } = depsWith({}, [B1, B2]);
  const r = await tickOnce(ctx, deps);
  assert.equal(r.feedsConsidered, 1); assert.equal(sent.length, 1);
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; console.log("  ok   " + t.name); }
    catch (e) { fail++; console.log("  FAIL " + t.name + "\n       " + String((e as any)?.message ?? e).split("\n")[0]); }
  }
  console.log(`\noptaVolCrank: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
