// =============================================================================
// utils/solmath_bridge.rs — Converts between on-chain formats and solmath SCALE
// =============================================================================
//
// solmath uses u128 scaled by SCALE (1e12) for all values.
// Our on-chain data uses USDC smallest units (6 decimals) for prices.
// Pyth uses its own format (i64 value + i32 exponent).
// This module bridges between these formats.
// =============================================================================

use anchor_lang::prelude::*;
use solmath::SCALE;

use crate::errors::ButterError;

/// Converts a USDC smallest-units price (6 decimals) to solmath SCALE (12 decimals).
///
/// HOW IT WORKS:
/// USDC stores $180.50 as 180_500_000 (6 decimal places).
/// solmath wants 180_500_000_000_000 (12 decimal places).
/// So we multiply by 10^6 = 1_000_000.
pub fn usdc_to_scale(usdc_amount: u64) -> Result<u128> {
    let amount = usdc_amount as u128;
    amount.checked_mul(1_000_000)
        .ok_or_else(|| error!(ButterError::MathOverflow))
}

/// Converts a basis-points volatility (e.g. 8500 = 85%) to solmath SCALE.
///
/// HOW IT WORKS:
/// 8500 bps = 85% = 0.85 as a decimal.
/// solmath wants: 0.85 × SCALE = 850_000_000_000.
/// Math: bps × (SCALE / 10_000)
pub fn vol_bps_to_scale(vol_bps: u64) -> Result<u128> {
    let bps = vol_bps as u128;
    bps.checked_mul(SCALE / 10_000)
        .ok_or_else(|| error!(ButterError::MathOverflow))
}

/// Converts a solmath SCALE price back to USDC smallest units (6 decimals).
///
/// HOW IT WORKS:
/// solmath gives: 11_160_000_000_000 ($11.16 at SCALE).
/// USDC wants: 11_160_000.
/// Divide by 10^6 (because SCALE is 10^12 and USDC is 10^6).
pub fn scale_to_usdc(scale_value: u128) -> Result<u64> {
    let result = scale_value / 1_000_000;
    require!(result <= u64::MAX as u128, ButterError::MathOverflow);
    Ok(result as u64)
}

/// Converts a Pyth price (i64 value + i32 exponent) to solmath SCALE (1e12).
///
/// HOW IT WORKS:
/// Pyth says: price = 18050000000, exponent = -8. That means $180.50.
/// solmath wants: 180_500_000_000_000 (180.50 × 1e12).
/// The real price is: value × 10^exponent = 18050000000 × 10^(-8) = 180.50
/// At SCALE: 180.50 × 10^12
/// So: result = value × 10^(12 + exponent)
pub fn pyth_price_to_scale(price: i64, exponent: i32) -> Result<u128> {
    require!(price > 0, ButterError::InvalidSettlementPrice);
    let price_u128 = price as u128;
    let target_decimals: i32 = 12; // SCALE = 1e12
    let shift = target_decimals + exponent;

    if shift >= 0 {
        let multiplier = 10u128.pow(shift as u32);
        price_u128.checked_mul(multiplier)
            .ok_or_else(|| error!(ButterError::MathOverflow))
    } else {
        let divisor = 10u128.pow((-shift) as u32);
        Ok(price_u128 / divisor)
    }
}

/// Converts a Pyth price to USDC smallest units (6 decimals).
///
/// HOW IT WORKS:
/// Pyth: price = 18050000000, exponent = -8 → $180.50
/// USDC: 180_500_000 (6 decimal places)
/// Math: value × 10^(6 + exponent)
pub fn pyth_price_to_usdc(price: i64, exponent: i32) -> Result<u64> {
    require!(price > 0, ButterError::InvalidSettlementPrice);
    let price_u128 = price as u128;
    let target_decimals: i32 = 6;
    let shift = target_decimals + exponent;

    let result = if shift >= 0 {
        price_u128.checked_mul(10u128.pow(shift as u32))
            .ok_or_else(|| error!(ButterError::MathOverflow))?
    } else {
        price_u128 / 10u128.pow((-shift) as u32)
    };
    require!(result <= u64::MAX as u128, ButterError::MathOverflow);
    Ok(result as u64)
}

/// Converts time-to-expiry in seconds to solmath SCALE (fraction of a year).
///
/// HOW IT WORKS:
/// 7 days = 604800 seconds. As fraction of year: 604800 / 31_557_600 = 0.01918...
/// At SCALE: 0.01918 × 1e12 = 19_164_955_...
/// Uses 365.25 days/year to account for leap years.
pub fn seconds_to_time_scale(seconds: i64) -> Result<u128> {
    require!(seconds > 0, ButterError::OptionExpired);
    let seconds_u128 = seconds as u128;
    let seconds_per_year: u128 = 31_557_600; // 365.25 days
    seconds_u128.checked_mul(SCALE)
        .ok_or_else(|| error!(ButterError::MathOverflow))?
        .checked_div(seconds_per_year)
        .ok_or_else(|| error!(ButterError::MathOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_usdc_to_scale() {
        // $180.50 = 180_500_000 USDC units → 180_500_000_000_000 at SCALE
        let result = usdc_to_scale(180_500_000).unwrap();
        assert_eq!(result, 180_500_000_000_000u128);
    }

    #[test]
    fn test_vol_bps_to_scale() {
        // 8500 bps = 85% → 850_000_000_000 at SCALE
        let result = vol_bps_to_scale(8500).unwrap();
        assert_eq!(result, 850_000_000_000u128);

        // 500 bps = 5% → 50_000_000_000 at SCALE
        let result2 = vol_bps_to_scale(500).unwrap();
        assert_eq!(result2, 50_000_000_000u128);
    }

    #[test]
    fn test_scale_to_usdc() {
        // $11.16 at SCALE → 11_160_000 USDC units
        let result = scale_to_usdc(11_160_000_000_000u128).unwrap();
        assert_eq!(result, 11_160_000u64);
    }

    #[test]
    fn test_seconds_to_time_scale() {
        // 7 days = 604800 seconds → 7/365.25 × SCALE ≈ 19_164_955_509
        let result = seconds_to_time_scale(604_800).unwrap();
        assert!(result > 19_000_000_000u128, "7 days should be > 19e9");
        assert!(result < 20_000_000_000u128, "7 days should be < 20e9");
    }

    #[test]
    fn test_pyth_price_to_scale_8_decimals() {
        // SOL at $180.50: price=18050000000, exponent=-8
        let result = pyth_price_to_scale(18050000000, -8).unwrap();
        assert_eq!(result, 180_500_000_000_000u128);
    }

    #[test]
    fn test_pyth_price_to_scale_5_decimals() {
        // SOL at $180.50: price=18050000, exponent=-5
        let result = pyth_price_to_scale(18050000, -5).unwrap();
        assert_eq!(result, 180_500_000_000_000u128);
    }

    #[test]
    fn test_pyth_price_to_usdc() {
        // SOL at $180.50: price=18050000000, exponent=-8
        let result = pyth_price_to_usdc(18050000000, -8).unwrap();
        assert_eq!(result, 180_500_000u64); // $180.50 in USDC 6-dec
    }

    #[test]
    fn test_solmath_smoke() {
        use solmath::bs_full_hp;

        let s = 180 * SCALE;               // spot = $180
        let k = 200 * SCALE;               // strike = $200
        let r = 50_000_000_000u128;         // rate = 5%
        let sigma = 800_000_000_000u128;    // vol = 80%
        let t = SCALE / 52;                 // ~1 week (1/52 year)

        let result = bs_full_hp(s, k, r, sigma, t);
        assert!(result.is_ok(), "bs_full_hp should succeed");

        let greeks = result.unwrap();
        assert!(greeks.call > 0, "call price should be positive");
        assert!(greeks.call < s, "call price should be less than spot");
        assert!(greeks.put > 0, "put price should be positive");
        assert!(greeks.call_delta >= 0, "call delta should be non-negative");
        assert!(greeks.call_delta <= SCALE as i128, "call delta should be <= 1");
        assert!(greeks.put_delta <= 0, "put delta should be non-positive");
        assert!(greeks.gamma >= 0, "gamma should be non-negative");
        assert!(greeks.vega >= 0, "vega should be non-negative");
    }
}
