// =============================================================================
// Black-Scholes Pricing Engine
// =============================================================================
//
// Implements the Black-Scholes formula for European option pricing.
// Used to show "Suggested Fair Price" on the Trade page.
//
// All prices are in USDC (human-readable, not scaled).
// =============================================================================

// =============================================================================
// Volatility Calculators — compute vol from real Pyth price history
// =============================================================================

/** Minimum volatility floor — zero vol breaks Black-Scholes math. */
const MIN_VOL = 0.05;
/** Maximum volatility cap — prevents absurdly expensive premiums. */
const MAX_VOL = 5.0;

/**
 * Calculate realized (historical) volatility from an array of prices.
 *
 * HOW IT WORKS:
 * 1. Takes a list of prices in chronological order (oldest first)
 * 2. Computes the log-return between each consecutive pair: ln(price[i] / price[i-1])
 * 3. Computes the standard deviation of those log-returns
 * 4. Annualizes by multiplying by sqrt(periodsPerYear)
 *
 * For crypto with ~hourly Pyth updates, periodsPerYear = 8760 (hours in a year).
 *
 * @param prices - Array of historical prices, oldest first. Needs at least 2.
 * @param periodsPerYear - Observation frequency. 8760 for hourly crypto, ~98280 for minute-level equities.
 * @returns Annualized volatility as a decimal (e.g. 0.85 = 85%). Clamped to [0.05, 5.0].
 */
export function calculateRealizedVol(
  prices: number[],
  periodsPerYear: number = 8760,
): number {
  if (prices.length < 2) return MIN_VOL;

  // Step 1: log returns
  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] <= 0 || prices[i - 1] <= 0) continue;
    logReturns.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (logReturns.length === 0) return MIN_VOL;

  // Step 2: mean of log returns
  const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;

  // Step 3: standard deviation (sample, N-1)
  const sumSqDiff = logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0);
  const variance =
    logReturns.length > 1 ? sumSqDiff / (logReturns.length - 1) : sumSqDiff;
  const stddev = Math.sqrt(variance);

  // Step 4: annualize
  const annualizedVol = stddev * Math.sqrt(periodsPerYear);

  // Clamp to [MIN_VOL, MAX_VOL]
  return Math.max(MIN_VOL, Math.min(MAX_VOL, annualizedVol));
}

/**
 * EWMA Volatility — Exponentially Weighted Moving Average.
 *
 * HOW IT WORKS:
 * Like a standard deviation, but recent price moves get HEAVIER weight.
 * A flash crash 2 hours ago spikes EWMA immediately, whereas regular stddev
 * would dilute it across days of calm data.
 *
 * The decay factor lambda controls how fast old data fades:
 *   - lambda = 0.94 (RiskMetrics industry standard, used by banks worldwide)
 *   - Higher lambda → smoother, slower to react
 *   - Lower lambda  → noisier, faster to react
 *
 * @param prices - Array of historical prices, oldest first. Needs at least 2.
 * @param lambda - Decay factor, 0 < lambda < 1. Default 0.94.
 * @param periodsPerYear - For annualization. 8760 for hourly crypto.
 * @returns Annualized EWMA volatility as a decimal. Clamped to [0.05, 5.0].
 */
export function calculateEWMAVol(
  prices: number[],
  lambda: number = 0.94,
  periodsPerYear: number = 8760,
): number {
  if (prices.length < 2) return MIN_VOL;

  // Step 1: log returns
  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] <= 0 || prices[i - 1] <= 0) continue;
    logReturns.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (logReturns.length === 0) return MIN_VOL;

  // Step 2: EWMA variance — seed with the first return squared
  let variance = logReturns[0] ** 2;
  for (let i = 1; i < logReturns.length; i++) {
    variance = lambda * variance + (1 - lambda) * logReturns[i] ** 2;
  }

  // Step 3: annualize
  const annualizedVol = Math.sqrt(variance) * Math.sqrt(periodsPerYear);

  return Math.max(MIN_VOL, Math.min(MAX_VOL, annualizedVol));
}

// =============================================================================
// Black-Scholes Pricing
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
 * Resolve which volatility to use for pricing.
 *
 * If historicalPrices has >= 20 data points, compute EWMA vol and use the
 * higher of (EWMA vol, asset-class default vol). The asset-class default
 * acts as a FLOOR so writers are always protected in calm markets.
 *
 * Otherwise, fall back to the explicit volatility parameter (no breaking change).
 */
function resolveVolatility(
  explicitVol: number,
  historicalPrices?: number[],
  assetName?: string,
): number {
  if (historicalPrices && historicalPrices.length >= 20) {
    const ewmaVol = calculateEWMAVol(historicalPrices);
    const floorVol = assetName ? getDefaultVolatility(assetName) : explicitVol;
    return Math.max(ewmaVol, floorVol);
  }
  return explicitVol;
}

/**
 * Calculate the fair premium for a CALL option using Black-Scholes.
 *
 * @param spotPrice       - Current price of the underlying asset (USD)
 * @param strikePrice     - Strike price of the option (USD)
 * @param daysToExpiry    - Time until expiry in days
 * @param volatility      - Annualized implied volatility (e.g., 0.8 for 80%)
 * @param riskFreeRate    - Annualized risk-free rate (default 0 for crypto)
 * @param historicalPrices - Optional array of recent prices. If >= 20, EWMA vol is used instead of static vol.
 * @param assetName       - Optional asset name for floor vol lookup (e.g. "SOL"). Required when using historicalPrices.
 * @returns Fair premium in USD
 */
export function calculateCallPremium(
  spotPrice: number,
  strikePrice: number,
  daysToExpiry: number,
  volatility: number = 0.8,
  riskFreeRate: number = 0,
  historicalPrices?: number[],
  assetName?: string,
): number {
  if (daysToExpiry <= 0 || spotPrice <= 0 || strikePrice <= 0) return 0;

  // If enough historical prices are provided, use EWMA vol with asset-class floor
  const vol = resolveVolatility(volatility, historicalPrices, assetName);

  const T = daysToExpiry / 365;
  const d1 =
    (Math.log(spotPrice / strikePrice) +
      (riskFreeRate + (vol * vol) / 2) * T) /
    (vol * Math.sqrt(T));
  const d2 = d1 - vol * Math.sqrt(T);

  return (
    spotPrice * normalCDF(d1) -
    strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(d2)
  );
}

/**
 * Calculate the fair premium for a PUT option using Black-Scholes.
 *
 * @param historicalPrices - Optional array of recent prices. If >= 20, EWMA vol is used instead of static vol.
 * @param assetName       - Optional asset name for floor vol lookup. Required when using historicalPrices.
 */
export function calculatePutPremium(
  spotPrice: number,
  strikePrice: number,
  daysToExpiry: number,
  volatility: number = 0.8,
  riskFreeRate: number = 0,
  historicalPrices?: number[],
  assetName?: string,
): number {
  if (daysToExpiry <= 0 || spotPrice <= 0 || strikePrice <= 0) return 0;

  const vol = resolveVolatility(volatility, historicalPrices, assetName);

  const T = daysToExpiry / 365;
  const d1 =
    (Math.log(spotPrice / strikePrice) +
      (riskFreeRate + (vol * vol) / 2) * T) /
    (vol * Math.sqrt(T));
  const d2 = d1 - vol * Math.sqrt(T);

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
