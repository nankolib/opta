// =============================================================================
// tests/pricing.ts — Unit tests for the Black-Scholes pricing engine
// =============================================================================
//
// Tests the volatility calculators (realized vol, EWMA vol) and verifies
// that pricing functions integrate real vol correctly.
//
// These are pure math tests — no Solana validator needed.
// =============================================================================

import { assert } from "chai";
import {
  calculateRealizedVol,
  calculateEWMAVol,
  calculateCallPremium,
  calculatePutPremium,
} from "../app/src/utils/blackScholes";

describe("pricing-engine", () => {
  // =========================================================================
  // calculateRealizedVol
  // =========================================================================
  describe("calculateRealizedVol", () => {
    it("returns correct vol for bouncy prices (higher than flat)", () => {
      const bouncy = [100, 101, 99, 102, 98, 103, 97, 104];
      const flat = [100, 100.1, 100.2, 100.3];

      const bouncyVol = calculateRealizedVol(bouncy);
      const flatVol = calculateRealizedVol(flat);

      // Both should be valid positive numbers within bounds
      assert.isAbove(bouncyVol, 0.05, "Bouncy vol should be above floor");
      assert.isBelow(bouncyVol, 5.0, "Bouncy vol should be below cap");
      assert.isAbove(flatVol, 0.05 - 0.001, "Flat vol should be at or above floor");
      assert.isBelow(flatVol, 5.0, "Flat vol should be below cap");

      // Bouncy prices should produce higher vol than flat prices
      assert.isAbove(bouncyVol, flatVol, "Bouncy prices should have higher vol than flat prices");
    });

    it("handles zero-movement prices — returns floor vol", () => {
      const noMovement = [100, 100, 100];
      const vol = calculateRealizedVol(noMovement);
      assert.equal(vol, 0.05, "Zero movement should return floor vol (0.05)");
    });

    it("returns floor vol for fewer than 2 prices", () => {
      assert.equal(calculateRealizedVol([100]), 0.05, "Single price returns floor");
      assert.equal(calculateRealizedVol([]), 0.05, "Empty array returns floor");
    });

    it("caps at MAX_VOL for extremely volatile data", () => {
      // Prices that double/halve every period — insane volatility
      const extreme = [100, 200, 100, 200, 100, 200, 100, 200];
      const vol = calculateRealizedVol(extreme);
      assert.equal(vol, 5.0, "Extreme volatility should be capped at 5.0");
    });
  });

  // =========================================================================
  // calculateEWMAVol
  // =========================================================================
  describe("calculateEWMAVol", () => {
    it("reacts more to recent prices than early prices", () => {
      // 80 calm periods then a spike — EWMA variance is low when the spike hits
      const calm = Array.from({ length: 80 }, () => 100);
      const calmThenSpike = [...calm, 103];
      // Spike at the start then 80 calm periods — EWMA has time to fully decay
      const spikeThenCalm = [100, 103, ...calm];

      const volCalmThenSpike = calculateEWMAVol(calmThenSpike);
      const volSpikeThenCalm = calculateEWMAVol(spikeThenCalm);

      assert.isAbove(
        volCalmThenSpike,
        volSpikeThenCalm,
        "EWMA should weight recent spike higher than old spike",
      );
    });

    it("returns floor vol for fewer than 2 prices", () => {
      assert.equal(calculateEWMAVol([100]), 0.05, "Single price returns floor");
      assert.equal(calculateEWMAVol([]), 0.05, "Empty array returns floor");
    });

    it("returns a valid number in range for normal data", () => {
      // Moderate moves (~1-2%) that won't cap at 5.0 when annualized hourly
      const prices = [100, 101, 99.5, 100.5, 99, 101.5, 98.5, 102, 99, 101];
      const vol = calculateEWMAVol(prices);
      assert.isAbove(vol, 0.05, "EWMA vol should be above floor");
      assert.isBelow(vol, 5.0, "EWMA vol should be below cap");
      assert.isFalse(isNaN(vol), "EWMA vol should not be NaN");
    });

    it("lower lambda reacts faster to recent changes", () => {
      const data = [100, 100, 100, 100, 100, 100, 100, 130];
      const fastReact = calculateEWMAVol(data, 0.80); // low lambda = fast
      const slowReact = calculateEWMAVol(data, 0.99); // high lambda = slow

      assert.isAbove(
        fastReact,
        slowReact,
        "Lower lambda should react more to the recent spike",
      );
    });
  });

  // =========================================================================
  // Pricing with real vol integration
  // =========================================================================
  describe("pricing with real vol", () => {
    it("gives different premium than static vol when historical prices provided", () => {
      const spot = 180;
      const strike = 200;
      const days = 7;
      const historicalPrices = [100, 105, 98, 110, 95, 108, 92, 115, 88, 110,
        105, 100, 108, 95, 112, 90, 118, 85, 120, 82, 125];

      // Static vol (default crypto = 0.8)
      const staticPremium = calculateCallPremium(spot, strike, days, 0.8);

      // Real vol from historical prices
      const realVolPremium = calculateCallPremium(
        spot, strike, days, 0.8, 0, historicalPrices, "SOL",
      );

      assert.isAbove(staticPremium, 0, "Static premium should be positive");
      assert.isAbove(realVolPremium, 0, "Real vol premium should be positive");
      assert.notEqual(
        staticPremium,
        realVolPremium,
        "Real vol premium should differ from static vol premium",
      );
    });

    it("falls back to static vol when too few historical prices", () => {
      const spot = 180;
      const strike = 200;
      const days = 7;
      const fewPrices = [100, 105, 98]; // only 3 — below the 20 threshold

      const staticPremium = calculateCallPremium(spot, strike, days, 0.8);
      const withFewPrices = calculateCallPremium(
        spot, strike, days, 0.8, 0, fewPrices, "SOL",
      );

      assert.equal(
        staticPremium,
        withFewPrices,
        "Should fall back to static vol when fewer than 20 prices",
      );
    });

    it("real vol floor is the asset-class default — never lower", () => {
      const spot = 180;
      const strike = 200;
      const days = 7;

      // Very flat prices → low realized vol, but crypto floor is 0.8
      const flatPrices = Array.from({ length: 30 }, (_, i) => 100 + i * 0.01);
      const premiumWithFlat = calculateCallPremium(
        spot, strike, days, 0.8, 0, flatPrices, "SOL",
      );
      const premiumWithDefault = calculateCallPremium(spot, strike, days, 0.8);

      // The floor (0.8 for crypto) should kick in, so both premiums match
      assert.approximately(
        premiumWithFlat,
        premiumWithDefault,
        0.001,
        "Flat historical prices should hit the asset-class floor vol",
      );
    });

    it("put premium also works with historical prices", () => {
      const spot = 200;
      const strike = 180;
      const days = 14;
      const historicalPrices = [100, 105, 98, 110, 95, 108, 92, 115, 88, 110,
        105, 100, 108, 95, 112, 90, 118, 85, 120, 82, 125];

      const staticPut = calculatePutPremium(spot, strike, days, 0.8);
      const realVolPut = calculatePutPremium(
        spot, strike, days, 0.8, 0, historicalPrices, "SOL",
      );

      assert.isAbove(staticPut, 0, "Static put premium should be positive");
      assert.isAbove(realVolPut, 0, "Real vol put premium should be positive");
    });
  });
});
