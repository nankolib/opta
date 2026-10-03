// Unit tests for the sweep quarantine. No chain, no clock of its own.
// Run: ts-node --transpile-only -r tsconfig-paths/register sweepQuarantine.test.ts
import assert from "node:assert/strict";
import { SweepQuarantine, QUARANTINE_AFTER_FAILURES, QUARANTINE_RETRY_MS, quarantineKey } from "./sweepQuarantine";

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }

const T0 = 1_790_000_000_000;
const K = quarantineKey("6GfxUovAaPKrGh5PaqdesXEdeAQuWAavKNSuiWz2fuuK", "4w2MLAKU5kaEZHSZqGNsuu4grbnB5z9HMVXLPGepBsaR");

test("constants: three simulation failures, retried daily", () => {
  assert.equal(QUARANTINE_AFTER_FAILURES, 3);
  assert.equal(QUARANTINE_RETRY_MS, 24 * 60 * 60 * 1000);
});

test("a fresh batch is attempted", () => {
  const q = new SweepQuarantine();
  assert.deepEqual(q.decide(K, T0), { attempt: true, reason: "fresh" });
});

test("the transition: failures 1 and 2 keep attempting; the third quarantines, and says so exactly once", () => {
  const q = new SweepQuarantine();
  assert.deepEqual(q.recordFailure(K, T0), { quarantined: false, transitioned: false, failures: 1 });
  assert.deepEqual(q.decide(K, T0 + 1), { attempt: true, reason: "fresh" });
  assert.deepEqual(q.recordFailure(K, T0 + 1), { quarantined: false, transitioned: false, failures: 2 });
  assert.deepEqual(q.decide(K, T0 + 2), { attempt: true, reason: "fresh" });
  const third = q.recordFailure(K, T0 + 2);
  assert.deepEqual(third, { quarantined: true, transitioned: true, failures: 3 });
  assert.deepEqual(q.decide(K, T0 + 3), { attempt: false, reason: "quarantined", retryAtMs: T0 + 2 + QUARANTINE_RETRY_MS });
});

test("while quarantined nothing is attempted for a day, on every tick", () => {
  const q = new SweepQuarantine();
  for (let i = 0; i < 3; i++) q.recordFailure(K, T0);
  for (let t = T0 + 1; t < T0 + QUARANTINE_RETRY_MS; t += 5 * 60 * 1000) assert.equal(q.decide(K, t).attempt, false, `t=${t}`);
});

test("after a day it is retried once; a failed retry re-quarantines without a second transition", () => {
  const q = new SweepQuarantine();
  for (let i = 0; i < 3; i++) q.recordFailure(K, T0);
  const due = T0 + QUARANTINE_RETRY_MS;
  assert.deepEqual(q.decide(K, due), { attempt: true, reason: "daily-retry" });
  const r = q.recordFailure(K, due);
  assert.equal(r.quarantined, true);
  assert.equal(r.transitioned, false, "the quarantine was announced on failure 3; the retry does not announce again");
  assert.equal(r.failures, 4);
  assert.deepEqual(q.decide(K, due + 1), { attempt: false, reason: "quarantined", retryAtMs: due + QUARANTINE_RETRY_MS });
});

test("a success clears the key entirely", () => {
  const q = new SweepQuarantine();
  for (let i = 0; i < 3; i++) q.recordFailure(K, T0);
  q.recordSuccess(K);
  assert.deepEqual(q.decide(K, T0 + 1), { attempt: true, reason: "fresh" });
  assert.equal(q.size(), 0);
});

test("keys are independent", () => {
  const q = new SweepQuarantine();
  const K2 = quarantineKey("vaultB", "mintB");
  for (let i = 0; i < 3; i++) q.recordFailure(K, T0);
  assert.equal(q.decide(K2, T0 + 1).attempt, true);
  assert.equal(q.decide(K, T0 + 1).attempt, false);
});

test("state survives a round trip through JSON (what the crank persists across restarts)", () => {
  const q = new SweepQuarantine();
  for (let i = 0; i < 3; i++) q.recordFailure(K, T0);
  q.recordFailure(quarantineKey("v2", "m2"), T0);
  const back = SweepQuarantine.fromJSON(JSON.parse(JSON.stringify(q.toJSON())));
  assert.equal(back.decide(K, T0 + 1).attempt, false);
  assert.equal(back.decide(quarantineKey("v2", "m2"), T0 + 1).attempt, true);
  assert.equal(back.size(), 2);
});

test("a malformed persisted file is ignored, not fatal", () => {
  for (const bad of [null, 7, "x", [], { entries: "nope" }, { entries: [{ key: 1 }] }]) {
    const q = SweepQuarantine.fromJSON(bad as any);
    assert.equal(q.size(), 0);
  }
});

test("summary counts quarantined keys for the heartbeat", () => {
  const q = new SweepQuarantine();
  for (let i = 0; i < 3; i++) q.recordFailure(K, T0);
  q.recordFailure(quarantineKey("v2", "m2"), T0);
  assert.deepEqual(q.summary(T0 + 1), { tracked: 2, quarantined: 1, dueForRetry: 0 });
  assert.deepEqual(q.summary(T0 + QUARANTINE_RETRY_MS), { tracked: 2, quarantined: 1, dueForRetry: 1 });
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; console.log("  ok   " + t.name); }
    catch (e) { fail++; console.log("  FAIL " + t.name + "\n       " + String((e as any)?.message ?? e).split("\n")[0]); }
  }
  console.log(`\nsweepQuarantine: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
