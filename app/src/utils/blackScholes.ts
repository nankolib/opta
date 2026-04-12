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

/** Standard normal probability density function. */
function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Calculate d1 and d2 parameters used across Black-Scholes formulas. */
function calcD1D2(
  spot: number,
  strike: number,
  T: number,
  vol: number,
  r: number,
): { d1: number; d2: number } {
  const d1 =
    (Math.log(spot / strike) + (r + (vol * vol) / 2) * T) /
    (vol * Math.sqrt(T));
  const d2 = d1 - vol * Math.sqrt(T);
  return { d1, d2 };
}

// =============================================================================
// Volatility calculations
// =============================================================================

const MIN_VOL = 0.05;
const MAX_VOL = 5.0;

/**
 * Calculate realized volatility from a series of prices.
 * Uses log returns and annualizes assuming 365-day year.
 */
export function calculateRealizedVol(prices: number[]): number {
  if (prices.length < 2) return MIN_VOL;

  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] <= 0 || prices[i - 1] <= 0) continue;
    logReturns.push(Math.log(prices[i] / prices[i - 1]));
  }

  if (logReturns.length < 1) return MIN_VOL;

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance =
    logReturns.length > 1
      ? logReturns.reduce((a, r) => a + (r - mean) ** 2, 0) /
        (logReturns.length - 1)
      : 0;
  const dailyVol = Math.sqrt(variance);
  const annualizedVol = dailyVol * Math.sqrt(365);

  return Math.max(MIN_VOL, Math.min(MAX_VOL, annualizedVol));
}

/**
 * Calculate EWMA (Exponentially Weighted Moving Average) volatility.
 * RiskMetrics model with configurable lambda (default 0.94).
 */
export function calculateEWMAVol(
  prices: number[],
  lambda: number = 0.94,
): number {
  if (prices.length < 2) return MIN_VOL;

  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] <= 0 || prices[i - 1] <= 0) continue;
    logReturns.push(Math.log(prices[i] / prices[i - 1]));
  }

  if (logReturns.length < 1) return MIN_VOL;

  let variance = logReturns[0] ** 2;
  for (let i = 1; i < logReturns.length; i++) {
    variance = lambda * variance + (1 - lambda) * logReturns[i] ** 2;
  }

  const annualizedVol = Math.sqrt(variance) * Math.sqrt(365);
  return Math.max(MIN_VOL, Math.min(MAX_VOL, annualizedVol));
}

/**
 * Apply volatility smile adjustment based on moneyness and asset name.
 * Returns adjusted volatility.
 */
export function applyVolSmile(
  baseVol: number,
  spotPrice: number,
  strikePrice: number,
  assetName: string,
): number {
  if (spotPrice <= 0 || strikePrice <= 0) return baseVol;

  // Log-moneyness: negative when OTM put (strike < spot), positive when OTM call (strike > spot)
  const logMoneyness = Math.log(strikePrice / spotPrice);

  // Per-asset smile parameters: [curvature, tilt]
  // Curvature: how much vol increases for OTM options (both sides)
  // Tilt: negative = OTM puts (negative logMoneyness) get more vol boost
  const lower = assetName.toLowerCase();
  let curvature: number;
  let tilt: number;

  if (
    ["eur", "gbp", "jpy", "usd", "eur/usd", "gbp/usd"].some((a) =>
      lower.includes(a),
    )
  ) {
    // Forex — mild smile
    curvature = 0.3;
    tilt = -0.05;
  } else if (
    ["aapl", "tsla", "nvda", "googl", "msft", "amzn", "meta"].some((a) =>
      lower.includes(a),
    )
  ) {
    // Equity — negative skew (crash protection)
    curvature = 0.5;
    tilt = -0.25;
  } else if (
    ["xau", "gold", "xag", "silver", "wti", "oil", "crude"].some((a) =>
      lower.includes(a),
    )
  ) {
    // Commodity
    curvature = 0.6;
    tilt = -0.1;
  } else {
    // Crypto (default) — strong smile, slight negative tilt
    curvature = 0.8;
    tilt = -0.15;
  }

  // Smile formula: vol_adj = baseVol * (1 + curvature * logMoneyness^2 + tilt * logMoneyness)
  // OTM puts have logMoneyness < 0, so tilt < 0 means: tilt * negative = positive → vol UP
  // OTM calls have logMoneyness > 0, so tilt < 0 means: tilt * positive = negative → vol DOWN (or less up)
  const smileFactor = 1 + curvature * logMoneyness ** 2 + tilt * logMoneyness;
  // Floor at 0.5x base vol, cap at MAX_VOL
  const adjustedVol = baseVol * Math.max(0.5, smileFactor);
  return Math.min(MAX_VOL, adjustedVol);
}

// Minimum number of historical prices for EWMA to override static vol
const MIN_HISTORICAL_PRICES = 20;

/**
 * Calculate the fair premium for a CALL option using Black-Scholes.
 *
 * @param spotPrice        - Current price of the underlying asset (USD)
 * @param strikePrice      - Strike price of the option (USD)
 * @param daysToExpiry     - Time until expiry in days
 * @param volatility       - Annualized implied volatility (e.g., 0.8 for 80%)
 * @param riskFreeRate     - Annualized risk-free rate (default 5%)
 * @param historicalPrices - Optional array of historical prices for EWMA vol
 * @param assetName        - Optional asset name for smile adjustment
 * @returns Fair premium in USD
 */
export function calculateCallPremium(
  spotPrice: number,
  strikePrice: number,
  daysToExpiry: number,
  volatility: number = 0.8,
  riskFreeRate: number = 0.05,
  historicalPrices?: number[],
  assetName?: string,
): number {
  if (daysToExpiry <= 0 || spotPrice <= 0 || strikePrice <= 0) return 0;

  let vol = volatility;

  // Use EWMA vol if enough historical data provided
  if (historicalPrices && historicalPrices.length >= MIN_HISTORICAL_PRICES) {
    const ewmaVol = calculateEWMAVol(historicalPrices);
    vol = Math.max(vol, ewmaVol); // Floor at asset-class default
  }

  // Apply smile if asset name provided
  if (assetName) {
    vol = applyVolSmile(vol, spotPrice, strikePrice, assetName);
  }

  const T = daysToExpiry / 365;
  const { d1, d2 } = calcD1D2(spotPrice, strikePrice, T, vol, riskFreeRate);

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
  riskFreeRate: number = 0.05,
  historicalPrices?: number[],
  assetName?: string,
): number {
  if (daysToExpiry <= 0 || spotPrice <= 0 || strikePrice <= 0) return 0;

  let vol = volatility;

  // Use EWMA vol if enough historical data provided
  if (historicalPrices && historicalPrices.length >= MIN_HISTORICAL_PRICES) {
    const ewmaVol = calculateEWMAVol(historicalPrices);
    vol = Math.max(vol, ewmaVol);
  }

  // Apply smile if asset name provided
  if (assetName) {
    vol = applyVolSmile(vol, spotPrice, strikePrice, assetName);
  }

  const T = daysToExpiry / 365;
  const { d1, d2 } = calcD1D2(spotPrice, strikePrice, T, vol, riskFreeRate);

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

  // Commodities — each has unique vol profile
  if (["xau", "gold"].some((a) => lower.includes(a))) return 0.25;       // Gold: elevated but not extreme
  if (["xag", "silver"].some((a) => lower.includes(a))) return 0.35;     // Silver: more volatile than gold
  if (["wti", "oil", "crude"].some((a) => lower.includes(a))) return 0.55; // Oil: Iran/Hormuz crisis = extreme vol

  // Forex
  if (["eur", "gbp", "jpy", "usd"].some((a) => lower.includes(a))) return 0.10;

  // Equities — per-stock vol
  if (lower === "aapl") return 0.35;
  if (lower === "tsla") return 0.60;
  if (lower === "nvda") return 0.55;
  if (["googl", "msft", "amzn", "meta"].some((a) => lower.includes(a))) return 0.40;

  // Crypto — differentiate by asset
  if (lower === "btc" || lower === "bitcoin") return 0.65;
  if (lower === "eth" || lower === "ethereum") return 0.75;
  if (lower === "sol" || lower === "solana") return 0.85;

  // Default: generic crypto
  return 0.80;
}

// =============================================================================
// Greeks
// =============================================================================

/** Option Greeks — sensitivity measures for an option's price. */
export interface Greeks {
  /** How much the option price changes per $1 move in the underlying. */
  delta: number;
  /** How fast delta changes per $1 move in the underlying. */
  gamma: number;
  /** How much the option loses per day from time decay (in USD). */
  theta: number;
  /** How much the option price changes per 1% move in implied volatility. */
  vega: number;
  /** The theoretical fair price of the option (Black-Scholes). */
  premium: number;
}

/**
 * Calculate all Greeks for a CALL option.
 *
 * @param spotPrice    - Current price of the underlying asset (USD)
 * @param strikePrice  - Strike price of the option (USD)
 * @param daysToExpiry - Time until expiry in days
 * @param volatility   - Annualized implied volatility (default: asset-class-based)
 * @param riskFreeRate - Annualized risk-free rate (default: 5%)
 */
export function calculateCallGreeks(
  spotPrice: number,
  strikePrice: number,
  daysToExpiry: number,
  volatility: number = 0.8,
  riskFreeRate: number = 0.05,
): Greeks {
  if (daysToExpiry <= 0 || spotPrice <= 0 || strikePrice <= 0) {
    return { delta: 0, gamma: 0, theta: 0, vega: 0, premium: 0 };
  }

  const T = daysToExpiry / 365;
  const sqrtT = Math.sqrt(T);
  const { d1, d2 } = calcD1D2(spotPrice, strikePrice, T, volatility, riskFreeRate);

  const premium = spotPrice * normalCDF(d1) - strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(d2);
  const delta = normalCDF(d1);
  const gamma = normalPDF(d1) / (spotPrice * volatility * sqrtT);
  const theta = (-(spotPrice * normalPDF(d1) * volatility) / (2 * sqrtT) - riskFreeRate * strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(d2)) / 365;
  const vega = spotPrice * normalPDF(d1) * sqrtT / 100;

  return { delta, gamma, theta, vega, premium };
}

/**
 * Calculate all Greeks for a PUT option.
 *
 * @param spotPrice    - Current price of the underlying asset (USD)
 * @param strikePrice  - Strike price of the option (USD)
 * @param daysToExpiry - Time until expiry in days
 * @param volatility   - Annualized implied volatility (default: asset-class-based)
 * @param riskFreeRate - Annualized risk-free rate (default: 5%)
 */
export function calculatePutGreeks(
  spotPrice: number,
  strikePrice: number,
  daysToExpiry: number,
  volatility: number = 0.8,
  riskFreeRate: number = 0.05,
): Greeks {
  if (daysToExpiry <= 0 || spotPrice <= 0 || strikePrice <= 0) {
    return { delta: 0, gamma: 0, theta: 0, vega: 0, premium: 0 };
  }

  const T = daysToExpiry / 365;
  const sqrtT = Math.sqrt(T);
  const { d1, d2 } = calcD1D2(spotPrice, strikePrice, T, volatility, riskFreeRate);

  const premium = strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(-d2) - spotPrice * normalCDF(-d1);
  const delta = normalCDF(d1) - 1;
  const gamma = normalPDF(d1) / (spotPrice * volatility * sqrtT);
  const theta = (-(spotPrice * normalPDF(d1) * volatility) / (2 * sqrtT) + riskFreeRate * strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(-d2)) / 365;
  const vega = spotPrice * normalPDF(d1) * sqrtT / 100;

  return { delta, gamma, theta, vega, premium };
}
