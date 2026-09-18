// =============================================================================
// tests/bankrun/sb-vol-oracle-routing.test.ts  (Stage 3 wiring 1a-iii)
//
// The keystone proofs for routing push_vol_sample by VolOracle.oracle_source,
// which rides on a SIZE-PRESERVING padding-byte claim (no migration, no realloc):
//
//   (4a) LEGACY ACCOUNT LOAD (THE GATE): a VolOracle written by the OLD struct
//        is byte-for-byte a NEW VolOracle whose oracle_source byte (the leading
//        byte of the old 11-byte _padding, offset 5845 in struct / 5853 in the
//        account incl. 8-byte disc) is 0. We hand-roll exactly such an account
//        via setAccount — with known ring markers — and prove the NEW code
//        load()s it without panic and reads oracle_source == 0 == Pyth.
//   (4b) RING-BUFFER INTACT + Pyth sampling byte-identical: that same legacy
//        account, pushed once, advances head/sample_count and last_spot_price
//        exactly, and pre-existing samples are untouched (offsets unshifted).
//   (5)  SB-arm wiring: flip the oracle's byte 5853 to 1 (Switchboard) and assert
//        routing (missing accts → 6065; no ed25519 → 6067; valid non-SB ed25519
//        → reverts inside the QuoteVerifier). This also PINS oracle_source to
//        offset 5853 — proving the claimed padding byte is the field.
// =============================================================================

import { assert } from "chai";
import {
  SystemProgram, Keypair, Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY,
} from "@solana/web3.js";
import { setupEnv, getClockUnix, setClockUnix, BN } from "./helpers";
import { injectPythFixture } from "./bootstrap";
import { serializePriceUpdateV2 } from "../_pyth_fixtures";

// Account-relative byte offsets (incl. the 8-byte Anchor discriminator).
const OFF_SAMPLES = 8 + 64;          // samples[0]
const OFF_LAST_SAMPLE_TS = 8 + 5824; // i64
const OFF_LAST_SPOT = 8 + 5832;      // i64
const OFF_HEAD = 8 + 5840;           // u16
const OFF_SAMPLE_COUNT = 8 + 5842;   // u16
const OFF_ORACLE_SOURCE = 8 + 5845;  // u8  (claimed from old _padding[0])
const SCALE = 1_000_000_000_000n;    // solmath 1e12

const pushBody = (feedHex: string, priceUsd: number, publishTime: number) =>
  serializePriceUpdateV2({
    feedIdHex: feedHex, price: BigInt(priceUsd) * 100_000_000n, conf: 1_000_000n, exponent: -8,
    publishTime: BigInt(publishTime), prevPublishTime: BigInt(publishTime - 1),
    emaPrice: BigInt(priceUsd) * 100_000_000n, emaConf: 1_000_000n,
  });

async function rawOracle(e: any): Promise<Buffer> {
  const acc = await e.h.context.banksClient.getAccount(e.volOracle);
  return Buffer.from(acc.data);
}
async function writeOracle(e: any, data: Buffer) {
  const acc = await e.h.context.banksClient.getAccount(e.volOracle);
  e.h.context.setAccount(e.volOracle, {
    lamports: acc.lamports, data, owner: acc.owner,
    executable: acc.executable, rentEpoch: Number(acc.rentEpoch),
  });
}

describe("bankrun: Stage 3 1a-iii — push_vol_sample oracle_source routing", function () {
  this.timeout(180_000);

  it("(4a/4b) LEGACY load: new code reads a hand-rolled pre-migration oracle as Pyth; ring intact", async () => {
    const e = await setupEnv("SBVOL1", "sbvol1", 100); // synth-warms a real VolOracle
    const clk = await getClockUnix(e.h.context);

    // Hand-roll a LEGACY account: known sample_count/head/last_spot, a marker
    // sample at index 0, and oracle_source byte = 0 (what the old _padding held).
    const data = await rawOracle(e);
    data.writeBigInt64LE(12345n, OFF_SAMPLES);                  // samples[0] marker
    data.writeBigInt64LE(BigInt(clk - 10), OFF_LAST_SAMPLE_TS); // old enough for rate-limit + < gap
    data.writeBigInt64LE(100n * SCALE, OFF_LAST_SPOT);          // last_spot = $100 (normal-branch, not seed)
    data.writeUInt16LE(200, OFF_HEAD);
    data.writeUInt16LE(200, OFF_SAMPLE_COUNT);
    data[OFF_ORACLE_SOURCE] = 0;                                // legacy padding byte → Pyth
    await writeOracle(e, data);

    // Push a fresh Pyth sample at $101. Routes Pyth (oracle_source==0).
    await setClockUnix(e.h.context, clk);
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pushBody(e.feedHex, 101, clk - 1));
    await e.opta.methods.pushVolSample().accountsStrict({
      signer: e.admin.publicKey, priceUpdate: fix, volOracle: e.volOracle,
      systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    }).rpc();

    const o: any = await e.opta.account.volOracle.fetch(e.volOracle);
    // (4a) loaded without panic and routed Pyth (the push succeeded at all).
    assert.equal(o.oracleSource, 0, "legacy byte 5853 reads as oracle_source = 0 = Pyth");
    // (4b) ring advanced from the INJECTED 200, marker preserved, spot updated.
    assert.equal(o.sampleCount, 201, "append branch ran on legacy count (200 → 201)");
    assert.equal(o.head, 201, "head advanced 200 → 201");
    assert.equal(o.samples[0].toString(), "12345", "pre-existing sample[0] untouched (ring intact)");
    assert.notEqual(o.samples[200].toString(), "0", "new log_return appended at head=200");
    assert.equal(o.lastSpotPrice.toString(), (101n * SCALE).toString(), "last_spot_price updated to $101");
    console.log(`    (4a/4b) legacy load OK: oracle_source=${o.oracleSource} count 200→${o.sampleCount} sample[0]=${o.samples[0]} ring intact`);
  });

  it("(5a) SB oracle + missing SB accounts → SwitchboardAccountsMissing (6065)", async () => {
    const e = await setupEnv("SBVOL2", "sbvol2", 100);
    const data = await rawOracle(e); data[OFF_ORACLE_SOURCE] = 1; await writeOracle(e, data); // flip to Switchboard
    const clk = await getClockUnix(e.h.context);
    await setClockUnix(e.h.context, clk);
    let err = "";
    try {
      await e.opta.methods.pushVolSample().accountsStrict({
        signer: e.admin.publicKey, priceUpdate: null, volOracle: e.volOracle,
        systemProgram: SystemProgram.programId,
        sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      }).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (5a) ${err.slice(0, 120)}`);
    assert.match(err, /SwitchboardAccountsMissing|6065/, "SB oracle must require the SB accounts");
  });

  it("(5b) SB oracle + SB accounts but no ed25519 ix → NoEd25519Instruction (6067)", async () => {
    const e = await setupEnv("SBVOL3", "sbvol3", 100);
    const data = await rawOracle(e); data[OFF_ORACLE_SOURCE] = 1; await writeOracle(e, data);
    const clk = await getClockUnix(e.h.context);
    await setClockUnix(e.h.context, clk);
    let err = "";
    try {
      await e.opta.methods.pushVolSample().accountsStrict({
        signer: e.admin.publicKey, priceUpdate: null, volOracle: e.volOracle,
        systemProgram: SystemProgram.programId,
        sbQueue: Keypair.generate().publicKey, sbSlothashes: SYSVAR_SLOT_HASHES_PUBKEY, sbInstructions: SYSVAR_INSTRUCTIONS_PUBKEY, optaPriceFeed: null,
      }).preInstructions([]).rpc(); // no ed25519
    } catch (ex: any) { err = String(ex); }
    console.log(`    (5b) ${err.slice(0, 120)}`);
    assert.match(err, /NoEd25519Instruction|6067/, "ed25519-index derivation must error with no ed25519 ix");
  });

  it("(5c) SB oracle + valid ed25519 ix → reaches QuoteVerifier (reverts past all guards)", async () => {
    const e = await setupEnv("SBVOL4", "sbvol4", 100);
    const data = await rawOracle(e); data[OFF_ORACLE_SOURCE] = 1; await writeOracle(e, data);
    const clk = await getClockUnix(e.h.context);
    await setClockUnix(e.h.context, clk);
    const edKp = Keypair.generate();
    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: edKp.secretKey, message: Buffer.from("opta-1a-iii-probe"),
    });
    let err = "";
    try {
      await e.opta.methods.pushVolSample().accountsStrict({
        signer: e.admin.publicKey, priceUpdate: null, volOracle: e.volOracle,
        systemProgram: SystemProgram.programId,
        sbQueue: Keypair.generate().publicKey, sbSlothashes: SYSVAR_SLOT_HASHES_PUBKEY, sbInstructions: SYSVAR_INSTRUCTIONS_PUBKEY, optaPriceFeed: null,
      }).preInstructions([edIx]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (5c) ${err.slice(0, 160)}`);
    assert.notEqual(err, "", "must revert — a non-SB quote cannot verify");
    assert.notMatch(err, /PriceUpdateMissing|SwitchboardAccountsMissing|InvalidSwitchboardSysvar|NoEd25519Instruction/,
      "must reach the QuoteVerifier (past every earlier guard)");
  });
});
