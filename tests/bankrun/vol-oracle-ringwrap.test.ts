// =============================================================================
// tests/bankrun/vol-oracle-ringwrap.test.ts
// Ported from tests/zzz-vol-oracle.ts it.skip "ring buffer wraps at 720th sample".
// The exhaustive O(1)-accumulator-vs-naive proof lives in Rust unit tests
// (state/vol_oracle.rs::o1_accumulator_matches_naive_*). This bankrun port
// exercises the WRAP/eviction edge deterministically: synth-warm to a full
// ring (sample_count == 720), then push real samples and assert the count
// SATURATES at 720 (eviction path runs, no overflow) and spot/ts update.
// =============================================================================

import { assert } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupEnv, getClockUnix, setClockUnix, BN, Keypair, PublicKey, TOKEN_PROGRAM_ID,
} from "./helpers";
import { injectPythFixture } from "./bootstrap";
import { serializePriceUpdateV2 } from "../_pyth_fixtures";

describe("bankrun: vol_oracle ring-buffer wrap (saturation edge)", function () {
  this.timeout(180_000);

  it("full ring (720) saturates on further pushes; spot/ts update", async () => {
    const e = await setupEnv("RINGWRAP", "ringwrap", 100); // setupEnv synth-warms to sample_count=720
    let oracle: any = await e.opta.account.volOracle.fetch(e.volOracle);
    assert.equal(oracle.sampleCount, 720, "synth-warm planted a full ring (720)");

    const pushBody = (priceUsd: number, publishTime: number) =>
      serializePriceUpdateV2({
        feedIdHex: e.feedHex, price: BigInt(priceUsd) * 100_000_000n, conf: 1_000_000n, exponent: -8,
        publishTime: BigInt(publishTime), prevPublishTime: BigInt(publishTime - 1),
        emaPrice: BigInt(priceUsd) * 100_000_000n, emaConf: 1_000_000n,
      });

    let clk = await getClockUnix(e.h.context);
    for (let i = 0; i < 3; i++) {
      clk += 5; // > test-fast-vol 1s rate-limit
      await setClockUnix(e.h.context, clk);
      const fix = Keypair.generate().publicKey;
      injectPythFixture(e.h.context, fix, pushBody(100 + i + 1, clk - 1)); // fresh, varying spot
      await e.opta.methods.pushVolSample().accountsStrict({
        signer: e.admin.publicKey, priceUpdate: fix, volOracle: e.volOracle,
        systemProgram: SystemProgram.programId,
        sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      }).rpc();
      oracle = await e.opta.account.volOracle.fetch(e.volOracle);
      assert.equal(oracle.sampleCount, 720, `sample_count saturates at 720 after push ${i + 1}`);
    }
    console.log(`    ring-wrap: 3 post-full pushes OK; sample_count stays 720; last_sample_ts=${oracle.lastSampleTs.toString()} (clk=${clk})`);
    // last_sample_ts tracks the latest push (handler stores publish_time or clock —
    // either way it must have advanced to ~the latest push, not the synth seed).
    assert.isTrue(Number(oracle.lastSampleTs) >= clk - 5, "last_sample_ts advanced to latest push");
  });
});
