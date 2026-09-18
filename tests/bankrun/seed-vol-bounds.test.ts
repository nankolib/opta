// =============================================================================
// tests/bankrun/seed-vol-bounds.test.ts — Run-8 H-1 regression
// =============================================================================
// H-1 (High): initialize_vol_oracle is permissionless and took a caller-supplied
// seed_vol with NO validation. During the ~7-day warmup price_american uses it
// verbatim as annualized σ, so a front-runner could seed a tiny σ (underprice →
// mint cheap ITM options) or absurd σ (overprice → grief buyers). The fix bounds
// seed_vol to the zero "no seed" sentinel OR [MIN_SEED_VOL, MAX_SEED_VOL]
// (0.05..2.0 at SCALE 1e12), rejecting negatives and out-of-band values.
//
//   negative — seed_vol < 0, tiny (< MIN), absurd (> MAX)  → SeedVolOutOfBounds
//   sentinel — seed_vol == 0 inits (cold), then prices → VolOracleWarmup (legacy)
//   valid    — MIN, a mid value, MAX all init; a bounded cold seed prices > 0
// =============================================================================

import { assert } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupEnv, getClockUnix, pda, injectPythFixture, pythBody, createVault, deposit, mint,
  usdc, actor, BN, PublicKey, Keypair, OPTA_PROGRAM_ID, Env,
} from "./helpers";
import { synthFeedIdHex } from "../_pyth_fixtures";

const MIN_SEED_VOL = new BN("50000000000");    // 0.05 σ at SCALE
const MAX_SEED_VOL = new BN("2000000000000");  // 2.00 σ at SCALE

function feed(label: string): { hex: string; bytes: number[] } {
  const hex = synthFeedIdHex(label);
  return { hex, bytes: Array.from(Buffer.from(hex, "hex")) };
}
const volOraclePda = (bytes: number[]) =>
  PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), Buffer.from(bytes)], OPTA_PROGRAM_ID)[0];

/** Create a fresh market and ATTEMPT initialize_vol_oracle with the given seed.
 *  Resolves { ok, err } — never throws — so callers can assert either outcome.
 *  Returns an Env clone pointing at the (possibly created) oracle on success. */
async function tryInitSeed(
  e: Env, asset: string, label: string, seedVol: BN, spotUsd = 100,
): Promise<{ ok: boolean; err: string; e2: Env }> {
  const f = feed(label);
  const market = pda([Buffer.from("market"), Buffer.from(asset)]);
  const oracle = volOraclePda(f.bytes);
  const now = await getClockUnix(e.h.context);
  const fix = Keypair.generate().publicKey;
  injectPythFixture(e.h.context, fix, pythBody(f.hex, spotUsd, now));
  await e.opta.methods.createMarket(asset, f.bytes, 0, 0).accountsStrict({
    creator: e.admin.publicKey, protocolState: e.protocolState, market, priceUpdate: fix,
    systemProgram: SystemProgram.programId, sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
  }).rpc();
  const e2: Env = { ...e, market, volOracle: oracle, feedHex: f.hex, feedId: f.bytes, asset };
  try {
    await e.opta.methods.initializeVolOracle(f.bytes, 0, seedVol).accountsStrict({
      initializer: e.admin.publicKey, priceUpdate: fix, volOracle: oracle,
      systemProgram: SystemProgram.programId, sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    }).rpc();
    return { ok: true, err: "", e2 };
  } catch (ex: any) {
    return { ok: false, err: String(ex), e2 };
  }
}

/** American mint off a cold+seeded oracle → premium_per_contract. */
async function priceViaMint(e: Env, createdAt: number): Promise<bigint> {
  const now = await getClockUnix(e.h.context);
  const expiry = new BN(now + 30 * 86400);
  const writer = actor(e);
  const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
  const writerPos = await deposit(e, vault, vaultUsdc, writer, 5000);
  const m = await mint(e, vault, writerPos, writer, 1, createdAt, true);
  const rec: any = await (e.opta.account as any).vaultMint.fetch(m.vaultMintRecord);
  return BigInt(rec.premiumPerContract.toString());
}

describe("seed_vol bounds (Run-8 H-1)", function () {
  this.timeout(180_000);

  let e: Env;
  before(async () => { e = await setupEnv("SVBND", "svbnd-warm", 100); });

  it("negative — seed_vol < 0 is rejected with SeedVolOutOfBounds", async () => {
    const r = await tryInitSeed(e, "SVNEG", "svneg", new BN(-1));
    assert.isFalse(r.ok, "negative seed must fail");
    assert.match(r.err, /SeedVolOutOfBounds/, "error = SeedVolOutOfBounds (6078)");
  });

  it("negative — tiny seed (0.01, below MIN) is rejected (the underpricing attack)", async () => {
    const r = await tryInitSeed(e, "SVTINY", "svtiny", new BN("10000000000")); // 0.01
    assert.isFalse(r.ok, "sub-MIN seed must fail");
    assert.match(r.err, /SeedVolOutOfBounds/, "the ~1% underpricing seed is rejected");
  });

  it("negative — absurd seed (5.0, above MAX) is rejected (the overpricing grief)", async () => {
    const r = await tryInitSeed(e, "SVBIG", "svbig", new BN("5000000000000")); // 5.0
    assert.isFalse(r.ok, "super-MAX seed must fail");
    assert.match(r.err, /SeedVolOutOfBounds/, "absurd σ is rejected");
  });

  it("boundary — exactly MIN and exactly MAX both initialize", async () => {
    const rMin = await tryInitSeed(e, "SVMIN", "svmin", MIN_SEED_VOL);
    assert.isTrue(rMin.ok, `MIN (${MIN_SEED_VOL}) accepted: ${rMin.err}`);
    const rMax = await tryInitSeed(e, "SVMAX", "svmax", MAX_SEED_VOL);
    assert.isTrue(rMax.ok, `MAX (${MAX_SEED_VOL}) accepted: ${rMax.err}`);
  });

  it("sentinel — seed_vol == 0 initializes cold; a cold American quote then reverts VolOracleWarmup", async () => {
    const r = await tryInitSeed(e, "SVZERO", "svzero", new BN(0));
    assert.isTrue(r.ok, "zero sentinel accepted at init: " + r.err);
    const o: any = await (e.opta.account as any).volOracle.fetch(r.e2.volOracle);
    assert.equal(o.seedVol.toString(), "0", "born unseeded (sentinel)");
    let err = "";
    try { await priceViaMint(r.e2, 8001); } catch (ex: any) { err = String(ex); }
    assert.match(err, /VolOracleWarmup/, "cold + unseeded prices exactly as before (no σ=0 pricing)");
  });

  it("valid — a bounded cold seed (0.80) initializes and a cold American quote prices > 0", async () => {
    const r = await tryInitSeed(e, "SVGOOD", "svgood", new BN("800000000000")); // 0.80
    assert.isTrue(r.ok, "valid crypto-class seed accepted: " + r.err);
    const o: any = await (e.opta.account as any).volOracle.fetch(r.e2.volOracle);
    assert.equal(o.sampleCount, 0, "cold");
    assert.equal(o.seedVol.toString(), "800000000000", "seed stored");
    const prem = await priceViaMint(r.e2, 8101);
    assert.isTrue(prem > 0n, "price_american Ok off the bounded seed → premium > 0");
  });
});
