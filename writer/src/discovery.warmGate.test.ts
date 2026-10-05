// Contract test (P4) for the WARMING SOURCE-2 GATE in discovery.oracleStateOf.
// The VolOracle is ENCODED and DECODED through the real Anchor coder from the
// writer's own IDL copy, so a key-name drift (`sample_count` vs `sampleCount`,
// `oracle_source` vs `oracleSource`) fails here instead of silently reading 0
// in production. Pure: no RPC, no keys, induces nothing.
//   cd writer && npx ts-node --transpile-only src/discovery.warmGate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnchorProvider, BorshAccountsCoder, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { oracleStateOf, ORACLE_SOURCE_OPTA } from "./discovery";

const idl = JSON.parse(readFileSync(join(__dirname, "..", "idl", "opta.json"), "utf8"));
// TWO real decoders. The raw accounts coder emits the IDL's snake_case keys; the
// Program's coder (what `program.account.volOracle.fetch` uses at runtime) emits
// camelCase. Ledger 39: a lane once read `price6dec` where the coder emitted
// `price6Dec`. Every case below must resolve identically through BOTH.
const rawCoder = new BorshAccountsCoder(idl);
const program = new Program(idl as any, new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}));
const decoders: Array<[string, (b: Buffer) => any]> = [
  ["raw BorshAccountsCoder", (b) => rawCoder.decode("VolOracle", b)],
  ["Program coder (runtime fetch path)", (b) => program.coder.accounts.decode("volOracle", b)],
];
// Live-verified byte offsets (app/src/utils/oracleArm.ts, ledger 35/40): the
// coder-encoded buffer must put the two gate fields exactly there.
const SAMPLE_COUNT_OFFSET = 5850, SOURCE_OFFSET = 5853;
const NOW = 1_790_180_000;

function encodeVolOracle(f: { sampleCount: number; oracleSource: number; seedVol: number; lastSampleTs?: number; spot?: number }): Buffer {
  // Bytes laid out by hand from the IDL (disc 8 | i128 | i128 | [u8;32] | [i64;720] |
  // i64 last_sample_ts | i64 last_spot_price | u16 head | u16 sample_count | u8 bump |
  // u8 oracle_source | [u8;2] | i64 seed_vol). The REAL coder decodes them below —
  // that is the contract: its key names and the offsets both have to agree.
  const disc = Buffer.from(idl.accounts.find((a: any) => a.name === "VolOracle").discriminator);
  const body = Buffer.alloc(16 + 16 + 32 + 720 * 8 + 8 + 8 + 2 + 2 + 1 + 1 + 2 + 8);
  let o = 16 + 16 + 32 + 720 * 8;
  body.writeBigInt64LE(BigInt(f.lastSampleTs ?? NOW - 600), o); o += 8;
  body.writeBigInt64LE(BigInt(f.spot ?? 118_910_000_000_000), o); o += 8;
  body.writeUInt16LE(0, o); o += 2;
  body.writeUInt16LE(f.sampleCount, o); o += 2;
  body.writeUInt8(254, o); o += 1;
  body.writeUInt8(f.oracleSource, o); o += 1;
  o += 2;
  body.writeBigInt64LE(BigInt(f.seedVol), o);
  return Buffer.concat([disc, body]);
}

test("contract: the gate fields sit at the live-verified offsets and BOTH real decoders resolve them", () => {
  const buf = encodeVolOracle({ sampleCount: 39, oracleSource: 2, seedVol: 539_896_606_574 });
  assert.equal(buf.readUInt16LE(SAMPLE_COUNT_OFFSET), 39, "sample_count @5850");
  assert.equal(buf.readUInt8(SOURCE_OFFSET), 2, "oracle_source @5853");
  const keys = decoders.map(([name, d]) => [name, Object.keys(d(buf)).sort().join(",")] as const);
  assert.notEqual(keys[0][1], keys[1][1], "the two decoders are expected to spell keys differently (snake vs camel); if they agree this test is no longer exercising the drift");
  for (const [name, d] of decoders) {
    const st = oracleStateOf(d(buf), NOW);
    assert.equal(st.samples, 39, `${name}: sample_count not resolved (keys: ${Object.keys(d(buf)).join(",")})`);
    assert.equal(st.oracleSource, 2, `${name}: oracle_source not resolved`);
    assert.equal(st.seedVol, 539_896_606_574, `${name}: seed_vol not resolved`);
  }
});

test("source 2 + seeded + fresh but < 168 samples -> CLOSED (the SOL/XRP shape of 2026-09-23)", () => {
  for (const [name, decode] of decoders) for (const n of [0, 1, 39, 167]) {
    const s = oracleStateOf(decode(encodeVolOracle({ sampleCount: n, oracleSource: 2, seedVol: 539_896_606_574 })), NOW);
    assert.equal(s.ready, false, `${name}: sampleCount ${n} must not be ready`);
    assert.equal(s.reason, `source2-warmup:${n}/168`);
    assert.equal(s.oracleSource, ORACLE_SOURCE_OPTA);
  }
});

test("source 2 lifts at exactly 168, seeded or not", () => {
  for (const [name, decode] of decoders) for (const seed of [0, 539_896_606_574]) for (const n of [168, 169, 720]) {
    const s = oracleStateOf(decode(encodeVolOracle({ sampleCount: n, oracleSource: 2, seedVol: seed })), NOW);
    assert.equal(s.ready, true, `${name}: sampleCount ${n} seed ${seed}`); assert.equal(s.reason, "ok");
  }
});

test("sources 0/1 keep the old rule: seeded OR warm is enough (no behaviour change off the Opta lane)", () => {
  for (const [name, decode] of decoders) for (const src of [0, 1]) {
    assert.equal(oracleStateOf(decode(encodeVolOracle({ sampleCount: 0, oracleSource: src, seedVol: 800_000_000_000 })), NOW).ready, true, `${name}: src ${src} seeded`);
    assert.equal(oracleStateOf(decode(encodeVolOracle({ sampleCount: 720, oracleSource: src, seedVol: 0 })), NOW).ready, true, `${name}: src ${src} warm`);
    const cold = oracleStateOf(decode(encodeVolOracle({ sampleCount: 5, oracleSource: src, seedVol: 0 })), NOW);
    assert.equal(cold.ready, false); assert.equal(cold.reason, "oracle-warmup");
  }
});

test("staleness still wins over everything (a stale source-2 ring reads oracle-stale, not the gate)", () => {
  for (const [, decode] of decoders) {
    const s = oracleStateOf(decode(encodeVolOracle({ sampleCount: 39, oracleSource: 2, seedVol: 1, lastSampleTs: NOW - 7 * 3600 })), NOW);
    assert.equal(s.ready, false); assert.equal(s.reason, "oracle-stale");
  }
});

test("a drifted decode (snake_case keys, as an old coder would emit) does NOT open the gate", () => {
  // The fallbacks read snake_case too; whichever spelling arrives, source 2 below 168 stays closed.
  const s = oracleStateOf({ sample_count: 39, oracle_source: 2, seed_vol: 1, last_sample_ts: NOW - 60, last_spot_price: 1e14 }, NOW);
  assert.equal(s.ready, false); assert.match(s.reason, /source2-warmup/);
});
