// =============================================================================
// tests/bankrun/initialize-vol-oracle-seed.test.ts
//
// Seed-at-birth → instant-tradeable markets. Proves the on-chain changes:
//   - Change 1: VolOracle gains seed_vol: i64 (claimed from _pad_align), 5856B.
//   - Change 2: initialize_vol_oracle writes seed_vol + last_spot_price +
//     last_sample_ts at birth (Pyth reads spot from the proof PriceUpdateV2).
//   - Change 3: price_american handoff — warm (>=168) uses realized vol; else
//     seed_vol!=0 uses the seed; else reverts VolOracleWarmup (legacy behavior).
//
// price_american is exercised via an American mint (mint_from_vault American
// branch): a successful mint with premium_per_contract > 0 proves Ok; a revert
// proves Err. We compare premiums across seed_vol values to prove the price is
// a FUNCTION of seed_vol (not a constant) and is IGNORED once the oracle warms.
//
// SWITCHBOARD COVERAGE BOUNDARY (deliberate, not a gap): litesvm cannot
// fabricate a valid signed_slothash, so a REAL Switchboard-quote birth (the
// QuoteVerifier path) is NOT executable in bankrun — that is a post-deploy live
// devnet smoke (same limitation that deferred the live SB proof elsewhere).
// What bankrun CAN prove is that the price_american handoff is source-agnostic:
// we fabricate an oracle_source=1 oracle with a cached spot + seed_vol via
// setAccount and show it prices off seed_vol identically to the Pyth path. The
// guard/routing surface of the SB init arm is covered in
// sb-init-vol-oracle-source.test.ts.
// =============================================================================

import { assert } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupEnv, getClockUnix, pda, injectPythFixture, pythBody, createVault, deposit, mint,
  usdc, actor, BN, PublicKey, Keypair, OPTA_PROGRAM_ID, spotScaled, Env,
} from "./helpers";
import { synthFeedIdHex } from "../_pyth_fixtures";

// 0.80 annualized σ at solmath SCALE 1e12 (crypto class default).
const SEED_VOL_HI = new BN("800000000000");
// 0.20 annualized σ — a lower seed to prove premium tracks seed_vol.
const SEED_VOL_LO = new BN("200000000000");

// --- VolOracle byte layout (incl. 8-byte account discriminator) ---
// Offsets used for direct fabrication / patching (mirrors state/vol_oracle.rs):
//   disc[0..8] sum_log_returns[8..24] sum_log_returns_sq[24..40] feed_id[40..72]
//   samples[72..5832] last_sample_ts[5832] last_spot_price[5840] head[5848]
//   sample_count[5850] bump[5852] oracle_source[5853] _pad_align[5854..5856]
//   seed_vol[5856..5864]                                    total = 5864 bytes
const OFF_LAST_SAMPLE_TS = 5832;
const OFF_LAST_SPOT_PRICE = 5840;
const OFF_HEAD = 5848;
const OFF_SAMPLE_COUNT = 5850;
const OFF_BUMP = 5852;
const OFF_ORACLE_SOURCE = 5853;
const OFF_SEED_VOL = 5856;
const VOL_ORACLE_DATA_LEN = 5864; // 8 disc + 5856 struct

function feed(label: string): { hex: string; bytes: number[] } {
  const hex = synthFeedIdHex(label);
  return { hex, bytes: Array.from(Buffer.from(hex, "hex")) };
}
const volOraclePda = (bytes: number[]) =>
  PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), Buffer.from(bytes)], OPTA_PROGRAM_ID);

/** Born a fresh COLD (sample_count=0) market + Pyth oracle, seed_vol seeded at
 *  birth. Returns an Env clone pointing at it so the rich vault/mint helpers work. */
async function bornColdPyth(e: Env, asset: string, label: string, seedVol: BN, spotUsd: number): Promise<Env> {
  const f = feed(label);
  const market = pda([Buffer.from("market"), Buffer.from(asset)]);
  const [oracle] = volOraclePda(f.bytes);
  const now = await getClockUnix(e.h.context);
  const fix = Keypair.generate().publicKey;
  injectPythFixture(e.h.context, fix, pythBody(f.hex, spotUsd, now));
  await e.opta.methods.createMarket(asset, f.bytes, 0, 0).accountsStrict({
    creator: e.admin.publicKey, protocolState: e.protocolState, market, priceUpdate: fix,
    systemProgram: SystemProgram.programId, sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
  }).rpc();
  await e.opta.methods.initializeVolOracle(f.bytes, 0, seedVol).accountsStrict({
    initializer: e.admin.publicKey, priceUpdate: fix, volOracle: oracle,
    systemProgram: SystemProgram.programId, sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
  }).rpc();
  return { ...e, market, volOracle: oracle, feedHex: f.hex, feedId: f.bytes, asset };
}

/** Read the canonical VolOracle account discriminator from an existing oracle. */
async function readDisc(e: Env): Promise<Buffer> {
  const acc = await e.h.context.banksClient.getAccount(e.volOracle);
  return Buffer.from(acc!.data.slice(0, 8));
}

/** Fabricate a VolOracle account directly (setAccount) — the only way to obtain
 *  an oracle_source=1 oracle with a cached spot in bankrun. */
function buildOracleData(
  disc: Buffer, feedId: number[],
  o: { sampleCount: number; lastSampleTs: number; lastSpotPrice: bigint; bump: number; oracleSource: number; seedVol: bigint },
): Buffer {
  const d = Buffer.alloc(VOL_ORACLE_DATA_LEN);
  disc.copy(d, 0);
  Buffer.from(feedId).copy(d, 40);
  d.writeBigInt64LE(BigInt(o.lastSampleTs), OFF_LAST_SAMPLE_TS);
  d.writeBigInt64LE(o.lastSpotPrice, OFF_LAST_SPOT_PRICE);
  d.writeUInt16LE(0, OFF_HEAD);
  d.writeUInt16LE(o.sampleCount, OFF_SAMPLE_COUNT);
  d.writeUInt8(o.bump, OFF_BUMP);
  d.writeUInt8(o.oracleSource, OFF_ORACLE_SOURCE);
  // _pad_align (5854..5856) left zero
  d.writeBigInt64LE(o.seedVol, OFF_SEED_VOL);
  return d;
}

/** Patch only the seed_vol field of a live oracle account (offset 5856). */
async function patchSeedVol(e: Env, oracle: PublicKey, seedVol: bigint): Promise<void> {
  const acc = await e.h.context.banksClient.getAccount(oracle);
  const data = Buffer.from(acc!.data);
  data.writeBigInt64LE(seedVol, OFF_SEED_VOL);
  e.h.context.setAccount(oracle, {
    lamports: acc!.lamports, data, owner: acc!.owner, executable: acc!.executable, rentEpoch: Number(acc!.rentEpoch),
  });
}

async function fetchOracle(e: Env, oracle: PublicKey): Promise<any> {
  return (e.opta.account as any).volOracle.fetch(oracle);
}

/** American mint → exercises price_american. Returns premium_per_contract; throws
 *  (revert) if price_american returns Err. Uses a fresh writer + vault. */
async function priceViaMint(e: Env, createdAt: number, strikeUsd = 100): Promise<bigint> {
  const now = await getClockUnix(e.h.context);
  const expiry = new BN(now + 30 * 86400);
  const strike = usdc(strikeUsd);
  const writer = actor(e);
  const { vault, vaultUsdc } = await createVault(e, "american", strike, expiry, { call: {} }, writer);
  const writerPos = await deposit(e, vault, vaultUsdc, writer, 5000);
  const m = await mint(e, vault, writerPos, writer, 1, createdAt, true);
  const rec: any = await (e.opta.account as any).vaultMint.fetch(m.vaultMintRecord);
  return BigInt(rec.premiumPerContract.toString());
}

describe("bankrun: initialize_vol_oracle seed-at-birth", function () {
  this.timeout(180_000);

  it("1. Cold + seeded (Pyth) → price_american Ok, premium tracks seed_vol", async () => {
    const e = await setupEnv("SEEDPY", "seedpy-warm", 100);
    const e2 = await bornColdPyth(e, "COLDPY", "coldpy", SEED_VOL_HI, 100);

    const o = await fetchOracle(e2, e2.volOracle);
    assert.equal(o.sampleCount, 0, "cold: sample_count = 0");
    assert.equal(o.seedVol.toString(), SEED_VOL_HI.toString(), "seed_vol stored at birth");
    assert.isTrue(o.lastSpotPrice.gt(new BN(0)), "spot seeded > 0");

    // One vault, two mints, seed_vol patched between → same S/K/T, only σ changes.
    const now = await getClockUnix(e2.h.context);
    const expiry = new BN(now + 30 * 86400);
    const strike = usdc(100);
    const writer = actor(e2);
    const { vault, vaultUsdc } = await createVault(e2, "american", strike, expiry, { call: {} }, writer);
    const writerPos = await deposit(e2, vault, vaultUsdc, writer, 5000);

    const mHi = await mint(e2, vault, writerPos, writer, 1, 1001, true);
    const premHi = BigInt((await (e2.opta.account as any).vaultMint.fetch(mHi.vaultMintRecord)).premiumPerContract.toString());
    assert.isTrue(premHi > 0n, "price_american Ok off seed_vol → premium > 0");

    await patchSeedVol(e2, e2.volOracle, BigInt(SEED_VOL_LO.toString()));
    const mLo = await mint(e2, vault, writerPos, writer, 1, 1002, true);
    const premLo = BigInt((await (e2.opta.account as any).vaultMint.fetch(mLo.vaultMintRecord)).premiumPerContract.toString());

    assert.isTrue(premLo < premHi, `premium tracks seed_vol (σ0.80 ${premHi} > σ0.20 ${premLo})`);
    // Still cold → it priced off the seed, never realized vol.
    assert.equal((await fetchOracle(e2, e2.volOracle)).sampleCount, 0, "still cold after pricing");
  });

  it("1b. Cold + seeded (Switchboard-sourced oracle) → price_american Ok off seed_vol", async () => {
    // Real SB-quote birth is a post-deploy live smoke (litesvm can't sign a
    // slothash). Here we fabricate the oracle_source=1 oracle to prove the
    // price_american handoff is source-agnostic (reads seed_vol either way).
    const e = await setupEnv("SBSEED", "sbseed-warm", 100);
    const disc = await readDisc(e);
    const f = feed("sbseed-sb");
    const asset = "SBSEEDM";
    const market = pda([Buffer.from("market"), Buffer.from(asset)]);
    const [oracle, bump] = volOraclePda(f.bytes);
    const now = await getClockUnix(e.h.context);

    // Market created Pyth (cosmetic — mint pricing reads the cached oracle, not
    // the market's oracle_source).
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(f.hex, 100, now));
    await e.opta.methods.createMarket(asset, f.bytes, 0, 0).accountsStrict({
      creator: e.admin.publicKey, protocolState: e.protocolState, market, priceUpdate: fix,
      systemProgram: SystemProgram.programId, sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    }).rpc();

    // Fabricate: cold, oracle_source=1, $100 spot @ SCALE, seed_vol 0.80, ts=now.
    const data = buildOracleData(disc, f.bytes, {
      sampleCount: 0, lastSampleTs: now, lastSpotPrice: 100_000_000_000_000n,
      bump, oracleSource: 1, seedVol: 800_000_000_000n,
    });
    e.h.context.setAccount(oracle, {
      lamports: 50_000_000, data, owner: OPTA_PROGRAM_ID, executable: false, rentEpoch: 0,
    });
    const e2: Env = { ...e, market, volOracle: oracle, feedHex: f.hex, feedId: f.bytes, asset };

    const o = await fetchOracle(e2, oracle);
    assert.equal(o.oracleSource, 1, "oracle_source = 1 (Switchboard-sourced)");
    assert.equal(o.seedVol.toString(), "800000000000", "seed_vol cached");
    assert.equal(o.sampleCount, 0, "cold");

    const prem = await priceViaMint(e2, 1501);
    assert.isTrue(prem > 0n, "price_american Ok off seed_vol for a source=1 oracle");
  });

  it("2. Warm (sample_count>=168) → prices off realized vol, seed_vol IGNORED", async () => {
    // setupEnv births + warms its oracle (sample_count=720, seed_vol=0).
    const e = await setupEnv("WARM", "warm-f", 100);
    assert.isAtLeast((await fetchOracle(e, e.volOracle)).sampleCount, 168, "oracle is warm");

    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 30 * 86400);
    const strike = usdc(100);
    const writer = actor(e);
    const { vault, vaultUsdc } = await createVault(e, "american", strike, expiry, { call: {} }, writer);
    const writerPos = await deposit(e, vault, vaultUsdc, writer, 5000);

    // seed_vol = 0 → realized-vol premium.
    const m0 = await mint(e, vault, writerPos, writer, 1, 2001, true);
    const prem0 = BigInt((await (e.opta.account as any).vaultMint.fetch(m0.vaultMintRecord)).premiumPerContract.toString());

    // Patch seed_vol to an ABSURD 5.0 (500%): if the warm path consulted it the
    // premium would balloon. It must NOT — warm uses realized vol exclusively.
    await patchSeedVol(e, e.volOracle, 5_000_000_000_000n);
    const m1 = await mint(e, vault, writerPos, writer, 1, 2002, true);
    const prem1 = BigInt((await (e.opta.account as any).vaultMint.fetch(m1.vaultMintRecord)).premiumPerContract.toString());

    assert.equal(prem1.toString(), prem0.toString(), "warm premium invariant to seed_vol (seed ignored)");
  });

  it("3. Cold + unseeded (seed_vol=0) → reverts VolOracleWarmup (legacy behavior)", async () => {
    const e = await setupEnv("UNSEED", "unseed-warm", 100);
    const e2 = await bornColdPyth(e, "COLDNO", "coldno", new BN(0), 100);
    assert.equal((await fetchOracle(e2, e2.volOracle)).seedVol.toString(), "0", "born unseeded");

    let err = "";
    try {
      await priceViaMint(e2, 3001);
    } catch (ex: any) { err = String(ex); }
    assert.match(err, /VolOracleWarmup/, "cold + unseeded must revert exactly as before");
  });

  it("4. Birth populates last_spot_price>0 and last_sample_ts≈now (Pyth + SB)", async () => {
    const e = await setupEnv("BIRTH", "birth-warm", 100);

    // Pyth: real init reads spot from the proof PriceUpdateV2.
    const nowP = await getClockUnix(e.h.context);
    const ep = await bornColdPyth(e, "BIRTHPY", "birthpy", SEED_VOL_HI, 100);
    const op = await fetchOracle(ep, ep.volOracle);
    assert.equal(op.lastSpotPrice.toString(), spotScaled(100).toString(), "Pyth: spot = $100 @ SCALE");
    assert.isAtMost(Math.abs(Number(op.lastSampleTs) - nowP), 5, "Pyth: last_sample_ts ≈ now");
    assert.equal(op.sampleCount, 0, "Pyth: cold at birth");

    // SB: fabricated (real SB birth is devnet smoke) — confirm the same seeded
    // birth-state shape that price_american's spot + staleness gates require.
    const disc = await readDisc(e);
    const f = feed("birth-sb");
    const [oracle, bump] = volOraclePda(f.bytes);
    const nowS = await getClockUnix(e.h.context);
    e.h.context.setAccount(oracle, {
      lamports: 50_000_000,
      data: buildOracleData(disc, f.bytes, {
        sampleCount: 0, lastSampleTs: nowS, lastSpotPrice: 250_000_000_000_000n, // $250
        bump, oracleSource: 1, seedVol: 800_000_000_000n,
      }),
      owner: OPTA_PROGRAM_ID, executable: false, rentEpoch: 0,
    });
    const os = await fetchOracle(e, oracle);
    assert.isTrue(os.lastSpotPrice.gt(new BN(0)), "SB: spot > 0 (gate passes at minute zero)");
    assert.equal(Number(os.lastSampleTs), nowS, "SB: last_sample_ts = now (fresh, not stale)");
  });

  it("5. Layout: account is 5864 bytes; legacy (seed_vol byte=0) loads cleanly", async () => {
    const e = await setupEnv("SIZE", "size-warm", 100);
    // seed_vol=0 init = byte-identical to a legacy account (old _padding[10] = 0).
    const e2 = await bornColdPyth(e, "SIZEPY", "sizepy", new BN(0), 100);

    const acc = await e2.h.context.banksClient.getAccount(e2.volOracle);
    assert.equal(acc!.data.length, VOL_ORACLE_DATA_LEN, "8 disc + 5856 struct = 5864 (no realloc)");

    // A successful anchor fetch == AccountLoader/bytemuck cast succeeded (no
    // length mismatch) — the migration-free property holds for a zero seed_vol.
    const o = await fetchOracle(e2, e2.volOracle);
    assert.equal(o.seedVol.toString(), "0", "legacy-equivalent seed_vol reads 0");
    // 'behaves as today' is covered by test 2 (warm→realized) and test 3 (cold→revert).
  });
});
