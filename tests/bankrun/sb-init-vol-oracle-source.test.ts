// =============================================================================
// tests/bankrun/sb-init-vol-oracle-source.test.ts  (Stage 3 1c-i-A + seed-at-birth)
//
// Guard proofs for initialize_vol_oracle(feed_id, oracle_source, seed_vol). The
// seed-at-birth arc UN-DEFERS the Switchboard feed-existence proof to init time:
// a Switchboard oracle now REQUIRES the 3 SB verify accounts at birth (so it can
// read + cache spot), instead of deferring the proof to the first push. litesvm
// cannot fabricate a valid signed_slothash, so the SB happy-path (a real quote →
// born SB with cached spot) is the devnet smoke; here we prove the guard surface.
//
//   (P)  oracle_source = 0 (Pyth): present price_update + matching feed → born
//        Pyth. Spot + last_sample_ts + seed_vol are seeded at birth (the proof
//        PriceUpdateV2 supplies the spot via pyth_current_spot_scale).
//   (SB) oracle_source = 1 (Switchboard) with NO SB accounts → reverts
//        SwitchboardAccountsMissing (6065): the proof is no longer deferred, so
//        the SB verify accounts are mandatory at birth.
//   (X)  oracle_source = 2 (invalid): reverts InvalidOracleSource (6066).
//   (M)  oracle_source = 0 but NO price_update → PriceUpdateMissing (6064): the
//        Pyth arm requires the (optional) account to be present.
// =============================================================================

import { assert } from "chai";
import { SystemProgram } from "@solana/web3.js";
import { setupEnv, getClockUnix, pda, injectPythFixture, pythBody, spotScaled, BN } from "./helpers";
import { synthFeedIdHex } from "../_pyth_fixtures";

// A fresh feed distinct from the one setupEnv already initialized, so each init
// targets a brand-new vol_oracle PDA (plain `init` — would collide otherwise).
function freshFeed(label: string): { hex: string; bytes: number[] } {
  const hex = synthFeedIdHex(label);
  return { hex, bytes: Array.from(Buffer.from(hex, "hex")) };
}
const volOraclePda = (bytes: number[]) => pda([Buffer.from("vol_oracle"), Buffer.from(bytes)]);
const SEED = new BN("800000000000"); // 0.80 σ @ SCALE

describe("bankrun: Stage 3 1c-i-A — initialize_vol_oracle oracle_source + seed-at-birth", function () {
  this.timeout(180_000);

  it("(P) oracle_source=0 (Pyth) + present price_update → born Pyth, seeded at birth", async () => {
    const e = await setupEnv("SBINIT0", "sbinit0", 100);
    const feed = freshFeed("sbinit0-pyth");
    const oracle = volOraclePda(feed.bytes);
    const now = await getClockUnix(e.h.context);

    const { Keypair } = await import("@solana/web3.js");
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(feed.hex, 100, now)); // feed_id matches + fresh

    await e.opta.methods.initializeVolOracle(feed.bytes, 0, SEED).accountsStrict({
      initializer: e.admin.publicKey, priceUpdate: fix, volOracle: oracle,
      systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    }).rpc();

    const o: any = await e.opta.account.volOracle.fetch(oracle);
    assert.equal(o.oracleSource, 0, "born Pyth (oracle_source = 0)");
    assert.deepEqual(Array.from(o.feedId), feed.bytes, "feed_id stored");
    assert.equal(o.sampleCount, 0, "fresh oracle, sample_count 0");
    assert.equal(o.seedVol.toString(), SEED.toString(), "seed_vol seeded at birth");
    assert.equal(o.lastSpotPrice.toString(), spotScaled(100).toString(), "spot seeded from the proof update");
    assert.isAtMost(Math.abs(Number(o.lastSampleTs) - now), 5, "last_sample_ts ≈ now");
    console.log(`    (P) Pyth init OK: source=${o.oracleSource} seed_vol=${o.seedVol} spot=${o.lastSpotPrice}`);
  });

  it("(SB) oracle_source=1 (Switchboard) with NO sb accounts → SwitchboardAccountsMissing (6065)", async () => {
    const e = await setupEnv("SBINIT1", "sbinit1", 100);
    const feed = freshFeed("sbinit1-sb");
    const oracle = volOraclePda(feed.bytes);

    // The SB proof is no longer deferred — birth now REQUIRES the SB verify
    // accounts. Omitting them (null) reverts before any state is written.
    let err = "";
    try {
      await e.opta.methods.initializeVolOracle(feed.bytes, 1, SEED).accountsStrict({
        initializer: e.admin.publicKey, priceUpdate: null, volOracle: oracle,
        systemProgram: SystemProgram.programId,
        sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      }).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (SB) ${err.slice(0, 120)}`);
    assert.match(err, /SwitchboardAccountsMissing|6065/, "SB birth must require the SB verify accounts");
  });

  it("(X) oracle_source=7 (out of range) → InvalidOracleSource (6066)", async () => {
    // Plug wave 1 (2026-09-18): source 2 is VALID now (Opta). The garbage-byte
    // negative moves to 7; source 2 gets its own negative below.
    const e = await setupEnv("SBINIT2", "sbinit2", 100);
    const feed = freshFeed("sbinit2-bad");
    const oracle = volOraclePda(feed.bytes);
    let err = "";
    try {
      await e.opta.methods.initializeVolOracle(feed.bytes, 7, SEED).accountsStrict({
        initializer: e.admin.publicKey, priceUpdate: null, volOracle: oracle,
        systemProgram: SystemProgram.programId,
        sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      }).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (X) ${err.slice(0, 120)}`);
    assert.match(err, /InvalidOracleSource|6066/, "out-of-range oracle_source must revert");
  });

  it("(X2) oracle_source=2 (Opta) + NO opta_price_feed → OptaFeedMissing (6102)", async () => {
    const e = await setupEnv("SBINIT2B", "sbinit2b", 100);
    const feed = freshFeed("sbinit2b-nofeed");
    const oracle = volOraclePda(feed.bytes);
    let err = "";
    try {
      await e.opta.methods.initializeVolOracle(feed.bytes, 2, SEED).accountsStrict({
        initializer: e.admin.publicKey, priceUpdate: null, volOracle: oracle,
        systemProgram: SystemProgram.programId,
        sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      }).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (X2) ${err.slice(0, 120)}`);
    assert.match(err, /OptaFeedMissing|6102/, "an Opta init without the feed account must revert on the arm, not on validation");
  });

  it("(M) oracle_source=0 (Pyth) but NO price_update → PriceUpdateMissing (6064)", async () => {
    const e = await setupEnv("SBINIT3", "sbinit3", 100);
    const feed = freshFeed("sbinit3-missing");
    const oracle = volOraclePda(feed.bytes);
    let err = "";
    try {
      await e.opta.methods.initializeVolOracle(feed.bytes, 0, SEED).accountsStrict({
        initializer: e.admin.publicKey, priceUpdate: null, volOracle: oracle,
        systemProgram: SystemProgram.programId,
        sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      }).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (M) ${err.slice(0, 120)}`);
    assert.match(err, /PriceUpdateMissing|6064/, "Pyth init must require the price_update account");
  });
});
