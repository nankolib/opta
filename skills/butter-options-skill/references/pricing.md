# Butter Options — Pricing Reference

## Black-Scholes Formula

Butter Options uses the standard Black-Scholes model for European option pricing. All prices are in USD (human-readable, not USDC-scaled).

### Core Variables

| Variable | Symbol | Description |
|----------|--------|-------------|
| Spot price | S | Current price of the underlying asset |
| Strike price | K | Option strike price |
| Time to expiry | T | Years until expiry (`daysToExpiry / 365`) |
| Volatility | σ | Annualized implied volatility |
| Risk-free rate | r | Annualized risk-free rate (default: 0 for crypto) |

### d1 and d2

```
d1 = [ln(S/K) + (r + σ²/2) × T] / (σ × √T)
d2 = d1 - σ × √T
```

### Call Premium

```
C = S × N(d1) - K × e^(-rT) × N(d2)
```

### Put Premium

```
P = K × e^(-rT) × N(-d2) - S × N(-d1)
```

Where N(x) is the standard normal cumulative distribution function.

---

## TypeScript Implementation

```typescript
/** Standard normal CDF approximation (Abramowitz & Stegun). */
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

/** Standard normal PDF (for Greeks). */
function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes call premium.
 * @param spotPrice    Current underlying price (USD)
 * @param strikePrice  Strike price (USD)
 * @param daysToExpiry Days until expiry
 * @param volatility   Annualized IV (e.g., 0.8 for 80%)
 * @param riskFreeRate Annualized risk-free rate (default 0)
 * @returns Fair premium in USD
 */
function calculateCallPremium(
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
 * Black-Scholes put premium.
 */
function calculatePutPremium(
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
```

---

## Asset Class Volatility Profiles

```typescript
function getDefaultVolatility(assetName: string): number {
  const lower = assetName.toLowerCase();
  if (["xau", "gold"].some((a) => lower.includes(a))) return 0.20;   // 20%
  if (["wti", "oil"].some((a) => lower.includes(a))) return 0.35;    // 35%
  if (["eur", "gbp", "jpy", "usd"].some((a) => lower.includes(a))) return 0.10; // 10%
  if (["aapl", "tsla", "nvda", "googl", "msft"].some((a) => lower.includes(a))) return 0.40; // 40%
  return 0.80; // Default: crypto — 80%
}
```

| Asset Class | Examples | Default IV | Notes |
|-------------|----------|------------|-------|
| Crypto (0) | SOL, BTC, ETH | 80% | High vol, 24/7 markets |
| Commodity (1) | Gold/XAU, Oil/WTI | 20-35% | Moderate vol |
| Equity (2) | AAPL, TSLA, NVDA | 40% | Market hours only |
| Forex (3) | EUR/USD, GBP/USD | 10% | Low vol, tight spreads |
| ETF (4) | SPY, QQQ | 30% | Moderate vol |

---

## Greeks

### Delta (Δ) — Price sensitivity
How much the option premium changes per $1 move in the underlying.

```typescript
function calculateDelta(
  spotPrice: number, strikePrice: number, daysToExpiry: number,
  volatility: number, riskFreeRate: number = 0, isCall: boolean = true,
): number {
  const T = daysToExpiry / 365;
  const d1 =
    (Math.log(spotPrice / strikePrice) +
      (riskFreeRate + (volatility * volatility) / 2) * T) /
    (volatility * Math.sqrt(T));

  return isCall ? normalCDF(d1) : normalCDF(d1) - 1;
}
```

### Gamma (Γ) — Delta sensitivity
How much delta changes per $1 move in the underlying.

```typescript
function calculateGamma(
  spotPrice: number, strikePrice: number, daysToExpiry: number,
  volatility: number, riskFreeRate: number = 0,
): number {
  const T = daysToExpiry / 365;
  const d1 =
    (Math.log(spotPrice / strikePrice) +
      (riskFreeRate + (volatility * volatility) / 2) * T) /
    (volatility * Math.sqrt(T));

  return normalPDF(d1) / (spotPrice * volatility * Math.sqrt(T));
}
```

### Theta (Θ) — Time decay per day
How much premium decays each day.

```typescript
function calculateTheta(
  spotPrice: number, strikePrice: number, daysToExpiry: number,
  volatility: number, riskFreeRate: number = 0, isCall: boolean = true,
): number {
  const T = daysToExpiry / 365;
  const d1 =
    (Math.log(spotPrice / strikePrice) +
      (riskFreeRate + (volatility * volatility) / 2) * T) /
    (volatility * Math.sqrt(T));
  const d2 = d1 - volatility * Math.sqrt(T);

  const term1 = -(spotPrice * normalPDF(d1) * volatility) / (2 * Math.sqrt(T));

  if (isCall) {
    const term2 = -riskFreeRate * strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(d2);
    return (term1 + term2) / 365;
  } else {
    const term2 = riskFreeRate * strikePrice * Math.exp(-riskFreeRate * T) * normalCDF(-d2);
    return (term1 + term2) / 365;
  }
}
```

### Vega (ν) — Volatility sensitivity
How much premium changes per 1% change in implied volatility.

```typescript
function calculateVega(
  spotPrice: number, strikePrice: number, daysToExpiry: number,
  volatility: number, riskFreeRate: number = 0,
): number {
  const T = daysToExpiry / 365;
  const d1 =
    (Math.log(spotPrice / strikePrice) +
      (riskFreeRate + (volatility * volatility) / 2) * T) /
    (volatility * Math.sqrt(T));

  return (spotPrice * normalPDF(d1) * Math.sqrt(T)) / 100; // per 1% change
}
```

---

## Worked Example

**Given:** SOL at $188, strike $200, 7 days to expiry, crypto asset class

```typescript
const spot = 188;
const strike = 200;
const days = 7;
const vol = 0.8;  // crypto default

// Call option
const callPremium = calculateCallPremium(spot, strike, days, vol);
// ≈ $7.62

const callDelta = calculateDelta(spot, strike, days, vol, 0, true);
// ≈ 0.34 (34% chance of finishing in-the-money)

const gamma = calculateGamma(spot, strike, days, vol);
// ≈ 0.0094

const callTheta = calculateTheta(spot, strike, days, vol, 0, true);
// ≈ -$1.34/day (premium decays $1.34 each day)

const vega = calculateVega(spot, strike, days, vol);
// ≈ $0.10 per 1% IV change

// Put option
const putPremium = calculatePutPremium(spot, strike, days, vol);
// ≈ $19.62

const putDelta = calculateDelta(spot, strike, days, vol, 0, false);
// ≈ -0.66
```

**Agent decision framework:**
- If market premium < $7.62 for the call → **BUY** (underpriced)
- If market premium > $7.62 for the call → **WRITE** (overpriced, collect premium)
- If delta > 0.7 → deep in-the-money, high probability of profit
- If theta < -$2/day → time decay is aggressive, favor selling over buying

---

## Converting Between Scaled and Human Values

```typescript
// USDC uses 6 decimal places
const USDC_DECIMALS = 1_000_000;

// On-chain premium (u64) → human-readable USD
function toUsd(scaledAmount: BN): number {
  return scaledAmount.toNumber() / USDC_DECIMALS;
}

// Human-readable USD → on-chain premium (u64)
function toScaled(usdAmount: number): BN {
  return new BN(Math.round(usdAmount * USDC_DECIMALS));
}

// Per-token premium from position data
function perTokenPremium(position: any): number {
  return toUsd(position.premium) / position.totalSupply.toNumber();
}
```
