// =============================================================================
// tests/bankrun/vol-oracle-gap-reseed.test.ts
// Proves the AM-MED-2 gap-reseed guard in push_vol_sample.
//
// When the gap since last_sample_ts exceeds VOL_ORACLE_MAX_SAMPLE_GAP_SECS
// (7200s), the next push must RESEED — refresh last_spot_price + last_sample_ts
// only, recording NO sample — so a multi-period price move is never mis-recorded
// as one hourly log return (which would inflate realized vol). This test drives
// the real handler with setClock: it asserts a gap push leaves sample_count AND
// the O(1) accumulators UNCHANGED while spot/ts advance, then that an on-cadence
// push afterward resumes normal sampling (accumulators move again).
// =============================================================================

import { assert } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupEnv, getClockUnix, setClockUnix, BN, Keypair, PublicKey, TOKEN_PROGRAM_ID,
} from "./helpers";
import { injectPythFixture } from "./bootstrap";
import { serializePriceUpdateV2 } from "../_pyth_fixtures";

const MAX_GAP_SECS = 7200; // VOL_ORACLE_MAX_SAMPLE_GAP_SECS (production + test — not shrunk)

describe("bankrun: vol_oracle gap-reseed (AM-MED-2)", function () {
  this.timeout(180_000);

  it("a push after a >7200s gap reseeds (spot/ts advance; ring + accumulators + count unchanged)", async () => {
    const e = await setupEnv("GAPRESEED", "gapreseed", 100); // synth-warms to sample_count=720, fresh ts
    let oracle: any = await e.opta.account.volOracle.fetch(e.volOracle);
    assert.equal(oracle.sampleCount, 720, "synth-warm planted a full ring (720)");

    // Baseline accumulators + spot/ts before the gap push.
    const baseSum = oracle.sumLogReturns.toString();
    const baseSumSq = oracle.sumLogReturnsSq.toString();
    const baseSpot = oracle.lastSpotPrice.toString();
    const baseTs = Number(oracle.lastSampleTs);

    const pushBody = (priceUsd: number, publishTime: number) =>
      serializePriceUpdateV2({
        feedIdHex: e.feedHex, price: BigInt(priceUsd) * 100_000_000n, conf: 1_000_000n, exponent: -8,
        publishTime: BigInt(publishTime), prevPublishTime: BigInt(publishTime - 1),
        emaPrice: BigInt(priceUsd) * 100_000_000n, emaConf: 1_000_000n,
      });

    const doPush = async (priceUsd: number, clk: number) => {
      await setClockUnix(e.h.context, clk);
      const fix = Keypair.generate().publicKey;
      injectPythFixture(e.h.context, fix, pushBody(priceUsd, clk - 1)); // fresh within 60s
      await e.opta.methods.pushVolSample().accountsStrict({
        signer: e.admin.publicKey, priceUpdate: fix, volOracle: e.volOracle,
        systemProgram: SystemProgram.programId,
        sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      }).rpc();
      return e.opta.account.volOracle.fetch(e.volOracle);
    };

    // --- 1. GAP push: now - last_sample_ts = 7201 > 7200 -> RESEED ----------
    const gapTs = baseTs + MAX_GAP_SECS + 1;
    oracle = await doPush(250, gapTs);

    assert.equal(oracle.sampleCount, 720, "gap push must NOT change sample_count");
    assert.equal(oracle.sumLogReturns.toString(), baseSum,
      "gap push must NOT change sum_log_returns (no sample recorded)");
    assert.equal(oracle.sumLogReturnsSq.toString(), baseSumSq,
      "gap push must NOT change sum_log_returns_sq (the σ-inflation guard)");
    assert.notEqual(oracle.lastSpotPrice.toString(), baseSpot,
      "gap push MUST refresh last_spot_price to the new baseline");
    assert.equal(Number(oracle.lastSampleTs), gapTs,
      "gap push MUST advance last_sample_ts to now");

    const reseedSum = oracle.sumLogReturns.toString();
    const reseedSumSq = oracle.sumLogReturnsSq.toString();

    // --- 2. ON-CADENCE push after the reseed: Δt = 5s (>1s test rate-limit,
    //        < 7200 gap) -> normal sample; accumulators MUST move again -------
    oracle = await doPush(251, gapTs + 5);

    assert.equal(oracle.sampleCount, 720, "ring stays saturated at 720");
    const moved =
      oracle.sumLogReturns.toString() !== reseedSum ||
      oracle.sumLogReturnsSq.toString() !== reseedSumSq;
    assert.isTrue(moved,
      "the next on-cadence push after a reseed must record a real sample (accumulators move)");

    console.log(`    gap-reseed: gap push left accumulators frozen (sum=${reseedSum}); next push resumed sampling`);
  });
});
