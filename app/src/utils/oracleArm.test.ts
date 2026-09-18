// Plug wave 1 — the FE builder arm. Run: node --test src/utils/oracleArm.test.ts
//
// The claim under test is NOT an assertion in a comment: for oracle_source 0
// and 1 the instructions built against the post-plug IDL must carry the SAME
// data bytes and the SAME leading accounts as the ones built against the
// pre-plug IDL (frozen at commit 13b4bca as __fixtures__/opta.idl.pre-plug.json),
// plus exactly one trailing program-id sentinel — which the program reads as
// None. For source 2 the trailing slot carries the feed PDA and nothing else
// moves. If any of that drifts, these fail.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  chooseOracleArm, spotSourceOf, optaPriceFeedPda, decodeOptaFeed,
  ORACLE_SOURCE_OPTA, OPTA_FEED_MIN_LEN, UnknownOracleSourceError,
  decodeVolOracleWarmup, writeWarmupGate, VOL_ORACLE_WARMUP_SAMPLES, VOL_ORACLE_ACCOUNT_LEN,
  VOL_ORACLE_SAMPLE_COUNT_OFFSET, VOL_ORACLE_SOURCE_OFFSET,
} from "./oracleArm";
import { chooseExerciseArm, EXERCISE_ACCOUNT_INDEX } from "./exerciseArm";
import { buildOptaExerciseAmericanIx } from "./pythPullPost";

const here = fileURLToPath(new URL(".", import.meta.url));
const PRE = JSON.parse(readFileSync(here + "__fixtures__/opta.idl.pre-plug.json", "utf8"));
const NOW = JSON.parse(readFileSync(here + "../idl/opta.json", "utf8"));
const provider = new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {});
const pre = new Program(PRE as any, provider);
const now = new Program(NOW as any, provider);
const PID = now.programId;
const K = () => Keypair.generate().publicKey;
const FEED = "baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2";
const feedBytes = Array.from(Buffer.from(FEED, "hex"));

test("arm choice: 0 -> pyth, 1 -> switchboard, 2 -> opta, anything else throws", () => {
  assert.equal(chooseOracleArm(0), "pyth");
  assert.equal(chooseOracleArm(1), "switchboard");
  assert.equal(chooseOracleArm(2), "opta");
  assert.equal(chooseExerciseArm(2), "opta");
  for (const bad of [3, 7, undefined, null, "2"]) assert.throws(() => chooseOracleArm(bad), UnknownOracleSourceError);
  assert.equal(spotSourceOf(2), 2); assert.equal(spotSourceOf(1), 1); assert.equal(spotSourceOf(0), 0); assert.equal(spotSourceOf(9), 0);
});

test("the feed PDA is [\"opta_price_feed\", feed_id] under the program", () => {
  const pda = optaPriceFeedPda(FEED, PID);
  const [want] = PublicKey.findProgramAddressSync([Buffer.from("opta_price_feed"), Buffer.from(FEED, "hex")], PID);
  assert.equal(pda.toBase58(), want.toBase58());
  assert.equal(optaPriceFeedPda("0x" + FEED.toUpperCase(), PID).toBase58(), want.toBase58(), "0x and case are normalised");
  assert.throws(() => optaPriceFeedPda("abcd", PID));
});

test("decodeOptaFeed reads price/publish_time and refuses frozen or unpushed", () => {
  const d = new Uint8Array(OPTA_FEED_MIN_LEN);
  const v = new DataView(d.buffer);
  v.setBigUint64(40, 78_122_940_000n, true); v.setBigInt64(56, 1_789_726_159n, true);
  assert.deepEqual(decodeOptaFeed(d), { spot: 78122.94, asOf: 1789726159, frozen: false });
  d[120] = 1; assert.equal(decodeOptaFeed(d), null, "frozen");
  d[120] = 0; v.setBigUint64(40, 0n, true); assert.equal(decodeOptaFeed(d), null, "never pushed");
  assert.equal(decodeOptaFeed(new Uint8Array(10)), null, "short account");
});

// ---- byte-identity for sources 0 and 1 -------------------------------------
const exerciseAccounts = (priceUpdate: PublicKey | null, sb: boolean) => ({
  holder: K(), sharedVault: K(), market: K(), priceUpdate, vaultMintRecord: K(), optionMint: K(),
  holderOptionAccount: K(), vaultUsdcAccount: K(), holderUsdcAccount: K(), token2022Program: K(), tokenProgram: K(),
  sbQueue: sb ? K() : null, sbSlothashes: sb ? K() : null, sbInstructions: sb ? K() : null,
  writerAskPot: null, writerAskPotUsdc: null, protocolState: null,
});

async function pair(name: string, argsFn: (p: Program) => any, accts: Record<string, PublicKey | null>) {
  const a = await argsFn(pre).accountsPartial(accts as any).instruction();
  const b = await argsFn(now).accountsPartial({ ...accts, optaPriceFeed: null } as any).instruction();
  assert.ok(Buffer.from(a.data).equals(Buffer.from(b.data)), name + ": instruction DATA differs");
  assert.equal(b.keys.length, a.keys.length + 1, name + ": exactly one account appended");
  for (let i = 0; i < a.keys.length; i++) {
    assert.equal(b.keys[i].pubkey.toBase58(), a.keys[i].pubkey.toBase58(), name + `: key ${i} moved`);
    assert.equal(b.keys[i].isSigner, a.keys[i].isSigner); assert.equal(b.keys[i].isWritable, a.keys[i].isWritable);
  }
  const last = b.keys[b.keys.length - 1];
  assert.ok(last.pubkey.equals(PID) && !last.isSigner && !last.isWritable, name + ": trailing slot must be the program-id sentinel");
  return { a, b };
}

test("exercise_american, source 0 (Pyth): same data, same 17 leading keys, +1 sentinel", async () => {
  const { b } = await pair("exercise pyth", (p) => p.methods.exerciseAmerican(new BN(3)), exerciseAccounts(K(), false));
  assert.equal(b.keys.length, 18);
});
test("exercise_american, source 1 (Switchboard): same data, same leading keys, +1 sentinel at index 17", async () => {
  const { b } = await pair("exercise sb", (p) => p.methods.exerciseAmerican(new BN(3)), exerciseAccounts(null, true));
  assert.ok(b.keys[EXERCISE_ACCOUNT_INDEX.optaPriceFeed].pubkey.equals(PID));
});
test("create_market, source 0: same data, +1 sentinel", async () => {
  const accts = { creator: K(), protocolState: K(), market: K(), priceUpdate: K(), systemProgram: SystemProgram.programId, sbQueue: null, sbSlothashes: null, sbInstructions: null };
  await pair("create", (p) => p.methods.createMarket("BTC", feedBytes, 0, 0), accts);
});
test("initialize_vol_oracle, source 0: same data, +1 sentinel", async () => {
  const accts = { initializer: K(), priceUpdate: K(), volOracle: K(), systemProgram: SystemProgram.programId, sbQueue: null, sbSlothashes: null, sbInstructions: null };
  await pair("init vol", (p) => p.methods.initializeVolOracle(feedBytes, 0, new BN(0)), accts);
});
test("settle_expiry, source 0: same data, +1 sentinel", async () => {
  const accts = { caller: K(), market: K(), priceUpdate: K(), settlementRecord: K(), systemProgram: SystemProgram.programId, sbQueue: null, sbSlothashes: null, sbInstructions: null };
  await pair("settle", (p) => p.methods.settleExpiry("BTC", new BN(1_800_000_000)), accts);
});

// ---- the source-2 arm ---------------------------------------------------------
test("opta exercise: no price_update, no SB accounts, feed PDA in the trailing slot, same data as the Pyth build", async () => {
  const holder = K();
  const params = { feedIdHex: FEED, quantity: 3, sharedVault: K(), market: K(), vaultMintRecord: K(), optionMint: K(), holderOptionAccount: K(), vaultUsdcAccount: K(), holderUsdcAccount: K() };
  const ix = await buildOptaExerciseAmericanIx(now as any, holder, params);
  const I = EXERCISE_ACCOUNT_INDEX;
  assert.equal(ix.keys.length, 18);
  assert.ok(ix.keys[I.priceUpdate].pubkey.equals(PID), "price_update is None");
  for (const i of [I.sbQueue, I.sbSlothashes, I.sbInstructions, I.writerAskPot, I.writerAskPotUsdc, I.protocolState]) assert.ok(ix.keys[i].pubkey.equals(PID), "slot " + i + " is None");
  assert.equal(ix.keys[I.optaPriceFeed].pubkey.toBase58(), optaPriceFeedPda(FEED, PID).toBase58(), "feed PDA in the trailing slot");
  assert.equal(ix.keys[I.holder].pubkey.toBase58(), holder.toBase58());
  assert.ok(ix.keys[I.holder].isSigner);
  const pyth = await now.methods.exerciseAmerican(new BN(3)).accountsPartial({ ...exerciseAccounts(K(), false), optaPriceFeed: null } as any).instruction();
  assert.ok(Buffer.from(ix.data).equals(Buffer.from(pyth.data)), "instruction data identical across arms");
  assert.equal(ORACLE_SOURCE_OPTA, 2);
});

// ---- what did NOT change: trigger placement and minting carry no price ------
test("trigger placement and mint builders carry no oracle account; exactly the price-readers gained the trailing slot", () => {
  const ORACLE = /^(price_update|sb_queue|sb_slothashes|sb_instructions|opta_price_feed)$/;
  const byName = new Map<string, string[]>(NOW.instructions.map((ix: any) => [ix.name, ix.accounts.map((a: any) => a.name)]));
  for (const name of ["place_trigger", "cancel_trigger", "mint_from_vault", "create_and_deposit", "fill_writer_ask"]) {
    const names = byName.get(name);
    assert.ok(names, name + " missing from the IDL");
    assert.deepEqual(names!.filter((n) => ORACLE.test(n)), [], name + " carries an oracle account");
  }
  // The feed-management instructions (init/push/freeze/authority/close) take
  // the feed as a REQUIRED account; the plug added it as an OPTIONAL trailing
  // account to exactly the price-readers below and nothing else.
  const carriers = NOW.instructions
    .filter((ix: any) => ix.accounts.some((a: any) => a.name === "opta_price_feed" && a.optional === true))
    .map((ix: any) => ix.name).sort();
  const required = NOW.instructions
    .filter((ix: any) => ix.accounts.some((a: any) => a.name === "opta_price_feed" && !a.optional))
    .map((ix: any) => ix.name).sort();
  assert.deepEqual(required, ["close_opta_price_feed", "init_opta_price_feed", "push_opta_price", "set_feed_authority", "set_feed_frozen"]);
  assert.deepEqual(carriers, [
    "create_market", "execute_trigger", "exercise_american", "initialize_vol_oracle",
    "push_vol_sample", "set_oracle_source", "settle_expiry",
  ]);
  for (const ix of NOW.instructions) {
    if (!carriers.includes(ix.name)) continue;
    const last = ix.accounts[ix.accounts.length - 1];
    assert.equal(last.name, "opta_price_feed", ix.name + ": the feed is the TRAILING account");
    assert.equal(last.optional, true, ix.name + ": and it is optional");
  }
  // execute_trigger is the crank's instruction; the FE never builds it.
  assert.equal(byName.get("place_trigger")!.includes("opta_price_feed"), false);
});

// ---- write-gate through vol warmup (D2 condition 2) ---------------------------
test("write-gate: sources 0/1 never gated; source 2 gated until 168 samples; unread = gated", () => {
  for (const src of [0, 1, 7]) for (const n of [null, 0, 167, 720]) assert.equal(writeWarmupGate(src, n), null);
  assert.match(writeWarmupGate(2, null)!, /first pricing week/);
  assert.match(writeWarmupGate(2, undefined)!, /first pricing week/);
  assert.match(writeWarmupGate(2, 0)!, /0 of 168/);
  assert.match(writeWarmupGate(2, 167)!, /167 of 168/);
  assert.equal(writeWarmupGate(2, VOL_ORACLE_WARMUP_SAMPLES), null, "self-lifts at exactly 168");
  assert.equal(writeWarmupGate(2, 720), null);
  for (const g of [writeWarmupGate(2, null)!, writeWarmupGate(2, 5)!]) assert.doesNotMatch(g, /pyth|switchboard|hermes|vendor/i);
});

test("decodeVolOracleWarmup reads sample_count and oracle_source at the live-verified offsets", () => {
  const d = new Uint8Array(VOL_ORACLE_ACCOUNT_LEN);
  const v = new DataView(d.buffer);
  v.setUint16(VOL_ORACLE_SAMPLE_COUNT_OFFSET, 720, true); d[VOL_ORACLE_SOURCE_OFFSET] = 1;
  assert.deepEqual(decodeVolOracleWarmup(d), { sampleCount: 720, oracleSource: 1 }, "the BTC oracle as read on 2026-09-18");
  v.setUint16(VOL_ORACLE_SAMPLE_COUNT_OFFSET, 42, true); d[VOL_ORACLE_SOURCE_OFFSET] = 2;
  const w = decodeVolOracleWarmup(d)!;
  assert.deepEqual(w, { sampleCount: 42, oracleSource: 2 });
  assert.match(writeWarmupGate(w.oracleSource, w.sampleCount)!, /42 of 168/);
  assert.equal(decodeVolOracleWarmup(new Uint8Array(100)), null, "short buffer");
});
