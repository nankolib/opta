// =============================================================================
// Black-Scholes Pricing Engine
// =============================================================================
//
// Implements the Black-Scholes formula for European option pricing.
// Used to show "Suggested Fair Price" on the Trade page.
//
// All prices are in USDC (human-readable, not scaled).
// =============================================================================

/** Standard normal cumulative distribution function (approximation). */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y =
    1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Calculate the fair premium for a CALL option using Black-Scholes.
 *
 * @param spotPrice    - Current price of the underlying asset (USD)
 * @param strikePrice  - Strike price of the option (USD)
 * @param daysToExpiry - Time until expiry in days
 * @param volatility   - Annualized implied volatility (e.g., 0.8 for 80%)
 * @param riskFreeRate - Annualized risk-free rate (default 0 for crypto)
 * @returns Fair premium in USD
 */
export function calculateCallPremium(
  spotPrice: number,
  strikePrice: number,
  daysToExpiry: number,
  volatility: number = 0.8,
  riskFreeRate: number = 0,
): number {
  if (daysToExpiry <= 0 || spotPrice <= 0 || strikePrice <= 0) return 0;

  const T = daysToExpiry / 365;
  const d1 =
    (Math.log(spotPrice / strikePrice) +
      (riskFreeRate + (volatility * volatility) / 2) * T) /
    (volatility * Math.sqrt(T));
  const d2 = d1 - volatility * Math.sqrt(T);

  return (
    spotPrice * normalCDF(d1) -
    strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(d2)
  );
}

/**
 * Calculate the fair premium for a PUT option using Black-Scholes.
 */
export function calculatePutPremium(
  spotPrice: number,
  strikePrice: number,
  daysToExpiry: number,
  volatility: number = 0.8,
  riskFreeRate: number = 0,
): number {
  if (daysToExpiry <= 0 || spotPrice <= 0 || strikePrice <= 0) return 0;

  const T = daysToExpiry / 365;
  const d1 =
    (Math.log(spotPrice / strikePrice) +
      (riskFreeRate + (volatility * volatility) / 2) * T) /
    (volatility * Math.sqrt(T));
  const d2 = d1 - volatility * Math.sqrt(T);

  return (
    strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(-d2) -
    spotPrice * normalCDF(-d1)
  );
}

/**
 * Get default volatility for a given asset class.
 * Crypto is much more volatile than traditional assets.
 */
export function getDefaultVolatility(assetName: string): number {
  const lower = assetName.toLowerCase();
  if (["xau", "gold"].some((a) => lower.includes(a))) return 0.2;
  if (["wti", "oil"].some((a) => lower.includes(a))) return 0.35;
  if (["eur", "gbp", "jpy", "usd"].some((a) => lower.includes(a))) return 0.1;
  if (["aapl", "tsla", "nvda", "googl", "msft"].some((a) => lower.includes(a))) return 0.4;
  // Default: crypto volatility
  return 0.8;
}
