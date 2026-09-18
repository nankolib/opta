// =============================================================================
// tests/bankrun/reset-vol-oracle.test.ts
// Proves the admin-only reset_vol_oracle instruction (MED-2 clearing path).
//
// Synth-warm an oracle to a full ring (720), reset it, and assert the ring +
// both accumulators + sample_count + head + last_spot + last_ts are all zeroed.
// Then push once and assert it takes the SEED branch (sample_count stays 0,
// last_spot set, no return recorded) — i.e. the oracle is fresh again and the
// 7-day warmup re-engages from 0. A second on-cadence push records the first
// real sample (count 0 -> 1).
// =============================================================================

import { assert } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupEnv, getClockUnix, setClockUnix, BN, Keypair, PublicKey, TOKEN_PROGRAM_ID,
} from "./helpers";
import { injectPythFixture } from "./bootstrap";
import { serializePriceUpdateV2 } from "../_pyth_fixtures";

describe("bankrun: reset_vol_oracle (admin-only; MED-2 clearing path)", function () {
  this.timeout(180_000);

  it("zeroes a polluted oracle and the next push re-seeds fresh", async () => {
    const e = await setupEnv("RESETVOL", "resetvol", 100); // synth-warms to sample_count=720
    let oracle: any = await e.opta.account.volOracle.fetch(e.volOracle);
    assert.equal(oracle.sampleCount, 720, "synth-warm planted a full ring (720)");
    assert.notEqual(oracle.lastSpotPrice.toString(), "0", "warmed oracle has a non-zero last_spot");

    // --- RESET (admin-only) -------------------------------------------------
    // H-1 (Run-8): reset now REPAIRS seed_vol to an admin-passed bounded value.
    // Pass 0.60 (600e9, in [MIN,MAX]) and assert it lands in the oracle.
    const REPAIR_SEED = new BN("600000000000"); // 0.60 σ at SCALE
    await e.opta.methods.resetVolOracle([...e.feedId], REPAIR_SEED).accountsStrict({
      admin: e.admin.publicKey,
      protocolState: e.protocolState,
      volOracle: e.volOracle,
    }).rpc();

    oracle = await e.opta.account.volOracle.fetch(e.volOracle);
    assert.equal(oracle.sampleCount, 0, "reset zeroes sample_count");
    assert.equal(oracle.head, 0, "reset zeroes head");
    assert.equal(oracle.sumLogReturns.toString(), "0", "reset zeroes sum_log_returns");
    assert.equal(oracle.sumLogReturnsSq.toString(), "0", "reset zeroes sum_log_returns_sq");
    assert.equal(oracle.lastSpotPrice.toString(), "0", "reset zeroes last_spot_price (forces seed branch next)");
    assert.equal(oracle.lastSampleTs.toString(), "0", "reset zeroes last_sample_ts");
    assert.equal(oracle.seedVol.toString(), "600000000000", "reset REPAIRS seed_vol to the admin-passed bounded value (H-1)");

    const pushBody = (priceUsd: number, publishTime: number) =>
      serializePriceUpdateV2({
        feedIdHex: e.feedHex, price: BigInt(priceUsd) * 100_000_000n, conf: 1_000_000n, exponent: -8,
        publishTime: BigInt(publishTime), prevPublishTime: BigInt(publishTime - 1),
        emaPrice: BigInt(priceUsd) * 100_000_000n, emaConf: 1_000_000n,
      });
    const doPush = async (priceUsd: number, clk: number) => {
      await setClockUnix(e.h.context, clk);
      const fix = Keypair.generate().publicKey;
      injectPythFixture(e.h.context, fix, pushBody(priceUsd, clk - 1));
      await e.opta.methods.pushVolSample().accountsStrict({
        signer: e.admin.publicKey, priceUpdate: fix, volOracle: e.volOracle,
        systemProgram: SystemProgram.programId,
        sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      }).rpc();
      return e.opta.account.volOracle.fetch(e.volOracle);
    };

    // --- 1. First push after reset -> SEED branch (count stays 0; spot set) --
    let clk = await getClockUnix(e.h.context);
    oracle = await doPush(150, clk + 10);
    assert.equal(oracle.sampleCount, 0, "first push after reset is the SEED branch (no sample)");
    assert.notEqual(oracle.lastSpotPrice.toString(), "0", "seed push records the new baseline spot");
    assert.equal(oracle.sumLogReturns.toString(), "0", "seed push records NO return");

    // --- 2. Second on-cadence push -> first REAL sample (count 0 -> 1) -------
    oracle = await doPush(151, clk + 15);
    assert.equal(oracle.sampleCount, 1, "second push records the first real sample after reseed");

    console.log("    reset_vol_oracle: ring zeroed; next push re-seeded (count 0), then resumed sampling (count 1)");
  });
});
