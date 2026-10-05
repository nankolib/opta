// Unit tests for the source-2 settle lane. No chain: every I/O is injected, and
// the wire shape is built through the REAL program coder against both IDL copies.
// Run: ts-node --transpile-only -r tsconfig-paths/register optaSettleCrank.test.ts
import assert from "node:assert/strict";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import {
  SETTLE_WINDOW_SECS, DISCOVERY_INTERVAL_SECS, OPTA_SETTLE_MARKER,
  phaseOf, decideSettleSend, enumerateSource2Tuples, settleAccounts, buildSettleExpiryIx,
  settlementSeedFromIdl, recordSnapshot, settleFeedSnapshot, recordPdaFor, marketPdaFor,
  OptaSettleScheduler, runOptaSettleCrank,
  type OptaSettleContext, type OptaSettleDeps, type Source2Tuple,
} from "./optaSettleCrank";
import { feedPdaFor } from "./optaVolCrank";
import type { AccountRecord } from "./settleRouting";

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }

const EXP = 1_800_000_000;
const PID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const feedBytes = (b: number) => Array.from(Buffer.alloc(32, b));

// ---- window boundaries -------------------------------------------------------
test("phase: before expiry is pending; expiry..expiry+300 is in-window; +301 is past", () => {
  assert.equal(phaseOf(EXP, EXP - 1), "pending");
  assert.equal(phaseOf(EXP, EXP), "in-window");
  assert.equal(phaseOf(EXP, EXP + SETTLE_WINDOW_SECS), "in-window");
  assert.equal(phaseOf(EXP, EXP + SETTLE_WINDOW_SECS + 1), "past-window");
  assert.equal(SETTLE_WINDOW_SECS, 300, "mirrors SB_SETTLE_WINDOW_SECS in settle_expiry.rs");
});
test("send gate: a push with publish_time == expiry sends, at expiry itself (no +35 s floor)", () => {
  assert.deepEqual(decideSettleSend({ publishTime: EXP }, EXP, EXP), { send: true });
  assert.deepEqual(decideSettleSend({ publishTime: EXP + 1 }, EXP, EXP + 1), { send: true });
  assert.deepEqual(decideSettleSend({ publishTime: EXP + 3 }, EXP, EXP + 34), { send: true });
});
test("send gate: sends at expiry+300, refuses at expiry+301", () => {
  assert.deepEqual(decideSettleSend({ publishTime: EXP + 290 }, EXP, EXP + 300), { send: true });
  assert.deepEqual(decideSettleSend({ publishTime: EXP + 290 }, EXP, EXP + 301), { send: false, reason: "window-elapsed" });
});
test("send gate: refuses before expiry even when the feed is fresh", () => {
  assert.deepEqual(decideSettleSend({ publishTime: EXP - 2 }, EXP, EXP - 1), { send: false, reason: "pre-expiry" });
});

// ---- first-post-expiry price selection ----------------------------------------
test("send gate: a pre-expiry print is never sent, however fresh", () => {
  assert.deepEqual(decideSettleSend({ publishTime: EXP - 1 }, EXP, EXP + 5), { send: false, reason: "no-post-expiry-push" });
  assert.deepEqual(decideSettleSend({ publishTime: EXP - 1 }, EXP, EXP + 299), { send: false, reason: "no-post-expiry-push" });
});
test("send gate: an absent feed account waits, it does not send", () => {
  assert.deepEqual(decideSettleSend(null, EXP, EXP + 5), { send: false, reason: "no-feed" });
});

// ---- enumeration --------------------------------------------------------------
function market(asset: string, oracleSource: number | undefined, b: number): AccountRecord {
  return { publicKey: marketPdaFor(PID, asset), account: { assetName: asset, oracleSource, pythFeedId: feedBytes(b) } };
}
function vault(m: AccountRecord, expiry: number, flags: { isSettled?: boolean; voided?: boolean } = {}): AccountRecord {
  return { publicKey: Keypair.generate().publicKey, account: { market: m.publicKey, expiry: new anchor.BN(expiry), isSettled: !!flags.isSettled, voided: !!flags.voided } };
}
test("enumeration: only source-2 markets produce tuples (0, 1 and 3 do not)", () => {
  const ms = [market("AAA", 0, 1), market("XAU", 1, 2), market("SOL", 2, 3), market("ODD", 3, 4), market("OLD", undefined, 5)];
  const vs = ms.map((m) => vault(m, EXP));
  const r = enumerateSource2Tuples(PID, vs, ms);
  assert.deepEqual(r.tuples.map((t) => t.key), [`SOL:${EXP}`]);
});
test("enumeration: a voided vault never enumerates", () => {
  const sol = market("SOL", 2, 3);
  const r = enumerateSource2Tuples(PID, [vault(sol, EXP, { voided: true }), vault(sol, EXP, { voided: true })], [sol]);
  assert.equal(r.tuples.length, 0);
});
test("enumeration: a settled vault never enumerates; one live vault keeps the tuple live", () => {
  const sol = market("SOL", 2, 3);
  const r = enumerateSource2Tuples(PID, [vault(sol, EXP, { isSettled: true }), vault(sol, EXP, { voided: true }), vault(sol, EXP)], [sol]);
  assert.equal(r.tuples.length, 1);
  assert.equal(r.tuples[0].liveVaults, 1);
});
test("enumeration: future and past expiries both enumerate; the phase is decided later, on cluster time", () => {
  const sol = market("SOL", 2, 3);
  const r = enumerateSource2Tuples(PID, [vault(sol, EXP + 600), vault(sol, EXP - 600), vault(sol, EXP + 600)], [sol]);
  assert.deepEqual(r.tuples.map((t) => `${t.key}x${t.liveVaults}`), [`SOL:${EXP - 600}x1`, `SOL:${EXP + 600}x2`]);
});
test("enumeration: a market whose address is not the PDA of its own name is refused", () => {
  const fake: AccountRecord = { publicKey: Keypair.generate().publicKey, account: { assetName: "SOL", oracleSource: 2, pythFeedId: feedBytes(3) } };
  const r = enumerateSource2Tuples(PID, [vault(fake, EXP)], [fake]);
  assert.equal(r.tuples.length, 0);
  assert.equal(r.refusedMarkets, 1);
});

// ---- the wire shape, through the REAL coder, for BOTH IDL copies ---------------
function realProgram(idlPath: string): anchor.Program {
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const provider = new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {});
  return new anchor.Program(idl as anchor.Idl, provider);
}
const IDLS: Array<[string, string]> = [
  ["crank/idl", path.join(__dirname, "idl", "opta.json")],
  ["app/src/idl (the one bot.ts loads)", path.join(__dirname, "..", "app", "src", "idl", "opta.json")],
];
test("settleAccounts: Pyth None, three SB None, the feed in the trailing slot", () => {
  const c = Keypair.generate().publicKey, m = Keypair.generate().publicKey, r = Keypair.generate().publicKey, f = Keypair.generate().publicKey;
  const a = settleAccounts(c, m, r, f);
  assert.deepEqual(Object.keys(a), ["caller", "market", "priceUpdate", "settlementRecord", "systemProgram", "sbQueue", "sbSlothashes", "sbInstructions", "optaPriceFeed"]);
  assert.equal(a.priceUpdate, null); assert.equal(a.sbQueue, null); assert.equal(a.sbSlothashes, null); assert.equal(a.sbInstructions, null);
  assert.equal(a.optaPriceFeed, f); assert.equal(a.systemProgram, SystemProgram.programId);
});
for (const [label, idlPath] of IDLS) {
  test(`P4 contract [${label}]: settle_expiry built through the real coder carries the feed last and nulls as the program id`, async () => {
    const p = realProgram(idlPath);
    const caller = Keypair.generate().publicKey;
    const fb = feedBytes(9);
    const ix = await buildSettleExpiryIx(p, caller, "SOL", EXP, fb);
    const raw = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const def = raw.instructions.find((i: any) => i.name === "settle_expiry");
    assert.equal(ix.programId.toBase58(), p.programId.toBase58());
    assert.equal(ix.keys.length, def.accounts.length, "one meta per IDL account, optionals included");
    const byName: Record<string, any> = {};
    def.accounts.forEach((a: any, i: number) => { byName[a.name] = ix.keys[i]; });
    assert.equal(byName.caller.pubkey.toBase58(), caller.toBase58());
    assert.equal(byName.caller.isSigner, true); assert.equal(byName.caller.isWritable, true);
    assert.equal(byName.market.pubkey.toBase58(), marketPdaFor(p.programId, "SOL").toBase58());
    assert.equal(byName.settlement_record.pubkey.toBase58(), recordPdaFor(p, "SOL", EXP).toBase58());
    assert.equal(byName.settlement_record.isWritable, true);
    assert.equal(byName.system_program.pubkey.toBase58(), SystemProgram.programId.toBase58());
    for (const n of ["price_update", "sb_queue", "sb_slothashes", "sb_instructions"]) {
      assert.equal(byName[n].pubkey.toBase58(), p.programId.toBase58(), `${n} is None, encoded as the program id`);
    }
    assert.equal(def.accounts[def.accounts.length - 1].name, "opta_price_feed", "the feed is the trailing account in the IDL");
    assert.equal(ix.keys[ix.keys.length - 1].pubkey.toBase58(), feedPdaFor(p.programId, fb).toBase58());
    assert.equal(ix.keys[ix.keys.length - 1].isWritable, false);
    // data = discriminator + borsh(string asset) + i64 expiry
    const want = Buffer.concat([
      Buffer.from(def.discriminator), Buffer.from([3, 0, 0, 0]), Buffer.from("SOL"),
      new anchor.BN(EXP).toArrayLike(Buffer, "le", 8),
    ]);
    assert.equal(Buffer.from(ix.data).toString("hex"), want.toString("hex"));
  });
  test(`P4 contract [${label}]: the record seed is read from the IDL's own PDA spec, raw and camelCased alike`, () => {
    const raw = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const p = realProgram(idlPath);
    assert.equal(settlementSeedFromIdl(raw).toString(), "settlement");
    assert.equal(settlementSeedFromIdl(p.idl).toString(), "settlement");
    const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(EXP));
    const byHand = PublicKey.findProgramAddressSync([Buffer.from("settlement"), Buffer.from("SOL"), b], p.programId)[0];
    assert.equal(recordPdaFor(p, "SOL", EXP).toBase58(), byHand.toBase58());
  });
  test(`P4 contract [${label}]: record and feed decode identically through the Program coder (camelCase) and the raw coder (snake_case)`, async () => {
    const raw = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const p = realProgram(idlPath);
    const camel = p.coder.accounts as any;
    const snake = new anchor.BorshAccountsCoder(raw) as any;
    const recBuf: Buffer = await camel.encode("settlementRecord", {
      assetName: "SOL", expiry: new anchor.BN(EXP), settlementPrice: new anchor.BN("118340000"),
      settledAt: new anchor.BN(EXP + 40), pythPublishTime: new anchor.BN(EXP + 34), bump: 254,
    });
    const want = { asset: "SOL", expiry: EXP, price6dec: 118340000n, settledAt: EXP + 40, publishTime: EXP + 34 };
    const viaCamel = camel.decode("settlementRecord", recBuf);
    const viaSnake = snake.decode("SettlementRecord", recBuf);
    assert.equal(viaCamel.pyth_publish_time, undefined); assert.equal(viaSnake.pythPublishTime, undefined);
    assert.deepEqual(recordSnapshot(viaCamel), want);
    assert.deepEqual(recordSnapshot(viaSnake), want);
    const feedBuf: Buffer = await camel.encode("optaPriceFeed", {
      feedId: feedBytes(7), price6Dec: new anchor.BN("118340000"), conf6Dec: new anchor.BN(1000),
      publishTime: new anchor.BN(EXP + 34), slot: new anchor.BN(1), authority: Keypair.generate().publicKey,
      prevPrice6Dec: new anchor.BN(0), prevPublishTime: new anchor.BN(0), frozen: false, bump: 255,
    });
    const wantFeed = { frozen: false, publishTime: EXP + 34, price6dec: 118340000n };
    assert.deepEqual(settleFeedSnapshot(camel.decode("optaPriceFeed", feedBuf)), wantFeed);
    assert.deepEqual(settleFeedSnapshot(snake.decode("OptaPriceFeed", feedBuf)), wantFeed);
  });
}
test("a decoded record missing a field is a SHAPE error, never a silent null", () => {
  assert.throws(() => recordSnapshot({ assetName: "SOL", expiry: 1, settlementPrice: 1, settledAt: 1 }), /pythPublishTime/);
  assert.throws(() => settleFeedSnapshot({ frozen: false, publishTime: 1 }), /price6Dec/);
});

// ---- the scheduler, on a virtual clock ----------------------------------------
interface World {
  now: number;                       // cluster seconds
  feedPublish: number | null;        // current feed publish_time (null = no account)
  pushes: number[];                  // scheduled push times (each becomes publish_time when now >= it)
  record: { publishTime: number; price6dec: bigint; settledAt: number } | null;
  vaults: AccountRecord[];
  markets: AccountRecord[];
  sends: Array<{ key: string; at: number }>;
  scans: number[];
  sendFails: number;                 // fail this many sends first
  recordAppearsOnFail: boolean;
  logs: any[];
}
function world(over: Partial<World> = {}): World {
  const sol = market("SOL", 2, 3);
  return {
    now: EXP - 1000, feedPublish: EXP - 1030, pushes: [], record: null,
    vaults: [vault(sol, EXP)], markets: [sol], sends: [], scans: [], sendFails: 0, recordAppearsOnFail: false, logs: [], ...over,
  };
}
function advance(w: World, secs: number) {
  w.now += secs;
  for (const p of w.pushes) if (p <= w.now && (w.feedPublish === null || p > w.feedPublish)) w.feedPublish = p;
}
function harness(w: World, dryRun = false): { ctx: OptaSettleContext; deps: OptaSettleDeps } {
  let shutdown = false;
  const ctx: OptaSettleContext = {
    programId: PID, caller: Keypair.generate().publicKey, dryRun,
    log: (level, msg, fields) => w.logs.push({ level, msg, ...(fields ?? {}) }),
    shouldShutdown: () => shutdown,
  };
  (ctx as any).stop = () => { shutdown = true; };
  const deps: OptaSettleDeps = {
    scan: async () => { w.scans.push(w.now); return { markets: w.markets, vaults: w.vaults, undecodable: 0 }; },
    clusterNow: async () => w.now,
    fetchFeed: async () => (w.feedPublish === null ? null : { frozen: false, publishTime: w.feedPublish, price6dec: BigInt(w.feedPublish % 1000) + 100_000_000n }),
    fetchRecord: async () => (w.record ? { asset: "SOL", expiry: EXP, ...w.record } : null),
    sendSettle: async (t: Source2Tuple) => {
      w.sends.push({ key: t.key, at: w.now });
      if (w.sendFails > 0) {
        w.sendFails -= 1;
        if (w.recordAppearsOnFail) w.record = { publishTime: w.feedPublish!, price6dec: 1n, settledAt: w.now };
        throw new Error("simulated send failure");
      }
      w.record = { publishTime: w.feedPublish!, price6dec: BigInt(w.feedPublish! % 1000) + 100_000_000n, settledAt: w.now };
      return { sig: "SIG" + w.sends.length, slot: 500 + w.sends.length, blockTime: w.now };
    },
    sleep: async (ms: number) => { advance(w, Math.max(1, Math.ceil(ms / 1000))); },
    nowMs: () => w.now * 1000,
  };
  return { ctx, deps };
}
const msgs = (w: World, m: string) => w.logs.filter((l) => l.msg === m);

test("scheduler: nothing is sent before expiry", async () => {
  const w = world(); const { ctx, deps } = harness(w);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover(); await s.step();
  assert.equal(w.sends.length, 0);
  assert.equal(msgs(w, "opta-settle tuple discovered").length, 1);
  assert.equal(msgs(w, "opta-settle tuple discovered")[0].expiry, EXP);
});
test("scheduler: waits on a pre-expiry print, sends on first sight of the post-expiry push", async () => {
  const w = world({ now: EXP, feedPublish: EXP - 30, pushes: [EXP + 33, EXP + 98] });
  const { ctx, deps } = harness(w);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover();
  for (let i = 0; i < 40 && w.sends.length === 0; i++) { await s.step(); advance(w, 2); }
  assert.equal(w.sends.length, 1);
  assert.ok(w.sends[0].at >= EXP + 33 && w.sends[0].at <= EXP + 35, `sent at +${w.sends[0].at - EXP}`);
  const done = msgs(w, "opta-settle settled");
  assert.equal(done.length, 1);
  assert.equal(done[0].recordPublishTime, EXP + 33);
  assert.equal(done[0].firstPostExpiryPushTime, EXP + 33);
  assert.equal(done[0].keeperLatencySecs, 0);
  assert.equal(done[0].recordInsideWindow, true);
  assert.equal(done[0].txInsideWindow, true);
});
test("scheduler: a record that is already there is success and nothing is sent (idempotent by state)", async () => {
  const w = world({ now: EXP + 10, feedPublish: EXP + 5, record: { publishTime: EXP + 5, price6dec: 1n, settledAt: EXP + 6 } });
  const { ctx, deps } = harness(w);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover(); await s.step(); await s.step();
  assert.equal(w.sends.length, 0);
  assert.equal(msgs(w, "opta-settle record present").length, 1, "logged once, then the tuple is done");
});
test("scheduler: a failed send is retried inside the window, spaced, and still inside it", async () => {
  const w = world({ now: EXP + 1, feedPublish: EXP - 30, pushes: [EXP + 20, EXP + 85], sendFails: 1 });
  const { ctx, deps } = harness(w);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover();
  for (let i = 0; i < 80 && !w.record; i++) { await s.step(); advance(w, 2); }
  assert.equal(w.sends.length, 2);
  assert.ok(w.sends[1].at - w.sends[0].at >= 5, "retries are spaced, not a busy loop");
  assert.ok(w.sends[1].at <= EXP + 300);
  assert.equal(msgs(w, "opta-settle send failed (will retry inside the window)").length, 1);
  const done = msgs(w, "opta-settle settled")[0];
  assert.equal(done.firstPostExpiryPushTime, EXP + 20);
});
test("scheduler: a failed send whose record then exists is success (someone else wrote it)", async () => {
  const w = world({ now: EXP + 40, feedPublish: EXP + 35, sendFails: 1, recordAppearsOnFail: true });
  const { ctx, deps } = harness(w);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover();
  for (let i = 0; i < 10; i++) { await s.step(); advance(w, 2); }
  assert.equal(w.sends.length, 1);
  assert.equal(msgs(w, "opta-settle record present").length, 1);
});
test("scheduler: no post-expiry push by +300 is dead-feed, logged once, never sent, never retried", async () => {
  const w = world({ now: EXP - 5, feedPublish: EXP - 40 });
  const { ctx, deps } = harness(w);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover();
  for (let i = 0; i < 200; i++) { await s.step(); advance(w, 2); }
  assert.ok(w.now > EXP + 301);
  assert.equal(w.sends.length, 0);
  assert.equal(msgs(w, "opta-settle tuple dead-feed").length, 1);
  await s.discover(); await s.step(); await s.discover(); await s.step();
  assert.equal(msgs(w, "opta-settle tuple dead-feed").length, 1, "still once after two more discoveries");
});
test("scheduler: a tuple first seen at expiry+301 logs dead-feed once and is skipped on the next tick", async () => {
  const w = world({ now: EXP + 301, feedPublish: EXP + 290 });
  const { ctx, deps } = harness(w);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover(); await s.step();
  assert.equal(msgs(w, "opta-settle tuple dead-feed").length, 1);
  assert.equal(msgs(w, "opta-settle tuple dead-feed")[0].secondsPastExpiry, 301);
  assert.equal(msgs(w, "opta-settle tuple discovered").length, 0, "a dead tuple is not announced as discovered");
  advance(w, 360);
  await s.discover(); await s.step();
  assert.equal(msgs(w, "opta-settle tuple dead-feed").length, 1);
  assert.equal(w.sends.length, 0);
});
test("scheduler: a past-window tuple that has a record is awaiting fan-out, not dead-feed", async () => {
  const w = world({ now: EXP + 900, feedPublish: EXP + 890, record: { publishTime: EXP + 33, price6dec: 1n, settledAt: EXP + 40 } });
  const { ctx, deps } = harness(w);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover(); await s.step(); await s.step();
  assert.equal(msgs(w, "opta-settle tuple dead-feed").length, 0);
  assert.equal(msgs(w, "opta-settle record present").length, 1);
});
test("scheduler: dry-run never sends", async () => {
  const w = world({ now: EXP + 40, feedPublish: EXP + 35 });
  const { ctx, deps } = harness(w, true);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover(); await s.step(); await s.step();
  assert.equal(w.sends.length, 0);
  assert.equal(msgs(w, "opta-settle WOULD-SEND (dry-run, NOT sent)").length, 1, "and says so once per tuple");
});
test("scheduler: a tuple whose vaults all become voided leaves the set", async () => {
  const w = world({ now: EXP - 500 });
  const { ctx, deps } = harness(w);
  const s = new OptaSettleScheduler(ctx, deps);
  await s.discover();
  assert.equal(s.tupleCount(), 1);
  w.vaults = w.vaults.map((v) => ({ ...v, account: { ...v.account, voided: true } }));
  await s.discover();
  assert.equal(s.tupleCount(), 0);
});

// ---- discovery cadence, end to end on the virtual clock -------------------------
test("loop: a tuple created 10 minutes before its expiry is picked up and settled", async () => {
  const sol = market("SOL", 2, 3);
  const T0 = EXP - 600;                                    // creation time
  const w = world({ now: T0 - 1800, feedPublish: T0 - 1830, vaults: [], markets: [sol], pushes: [] });
  for (let t = T0 - 1800; t < EXP + 400; t += 65) w.pushes.push(t);
  const { ctx, deps } = harness(w);
  const realScan = deps.scan;
  const created = vault(sol, EXP);
  deps.scan = async () => { w.vaults = w.now >= T0 ? [created] : []; return realScan(); };
  const realSleep = deps.sleep;
  deps.sleep = async (ms) => { await realSleep(ms); if (w.record || w.now > EXP + 400) (ctx as any).stop(); };
  await runOptaSettleCrank(ctx, deps);
  const disc = msgs(w, "opta-settle tuple discovered");
  assert.equal(disc.length, 1);
  assert.ok(disc[0].at - T0 <= 300, `discovered ${disc[0].at - T0}s after creation`);
  assert.ok(w.record, "record written");
  assert.equal(w.sends.length, 1);
  assert.ok(w.sends[0].at >= EXP && w.sends[0].at <= EXP + 300, `sent at +${w.sends[0].at - EXP}`);
  assert.ok(w.record!.publishTime >= EXP && w.record!.publishTime <= EXP + 300);
});
test("loop: discovery re-scans at least every 5 minutes", async () => {
  const w = world({ now: EXP - 4000, vaults: [] });
  const { ctx, deps } = harness(w);
  const realSleep = deps.sleep;
  deps.sleep = async (ms) => { await realSleep(ms); if (w.now > EXP - 1000) (ctx as any).stop(); };
  await runOptaSettleCrank(ctx, deps);
  assert.ok(w.scans.length >= 9, `scans: ${w.scans.length}`);
  for (let i = 1; i < w.scans.length; i++) assert.ok(w.scans[i] - w.scans[i - 1] <= 300, `gap ${w.scans[i] - w.scans[i - 1]}s`);
  assert.ok(DISCOVERY_INTERVAL_SECS <= 300);
});
test("loop: a scan that throws is logged and the next one still runs", async () => {
  const w = world({ now: EXP - 2000, vaults: [] });
  const { ctx, deps } = harness(w);
  let n = 0; const realScan = deps.scan;
  deps.scan = async () => { n += 1; if (n === 1) throw new Error("rpc down"); return realScan(); };
  const realSleep = deps.sleep;
  deps.sleep = async (ms) => { await realSleep(ms); if (w.now > EXP - 1000) (ctx as any).stop(); };
  await runOptaSettleCrank(ctx, deps);
  assert.equal(msgs(w, "opta-settle discovery failed (will retry)").length, 1);
  assert.ok(w.scans.length >= 1);
});
test("the boot marker names the lane", () => {
  assert.match(OPTA_SETTLE_MARKER, /^source2-settle-v\d+$/);
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; console.log("  ok   " + t.name); }
    catch (e) { fail++; console.log("  FAIL " + t.name + "\n       " + String((e as any)?.message ?? e).split("\n")[0]); }
  }
  console.log(`\noptaSettleCrank: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
