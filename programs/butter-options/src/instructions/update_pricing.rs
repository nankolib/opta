// =============================================================================
// instructions/update_pricing.rs — Compute Black-Scholes on-chain via solmath
// =============================================================================
//
// PERMISSIONLESS: Anyone can call this. The contract computes the fair value
// deterministically from the caller-provided spot price and implied volatility.
//
// The contract:
//   1. Reads strike, expiry, option_type from the market account
//   2. Converts inputs to solmath's SCALE format
//   3. Calls bs_full_hp() — full Black-Scholes + all 5 Greeks in ~50K CU
//   4. Stores fair value + Greeks in the PricingData PDA
//
// The caller provides spot_price and implied_vol because Pyth is not read
// on-chain yet (hackathon). In production, these would come from oracle reads.
// =============================================================================

use anchor_lang::prelude::*;
use solmath::SCALE;

use crate::errors::ButterError;
use crate::state::*;
use crate::utils::solmath_bridge::*;

/// Handler: compute Black-Scholes on-chain and store results.
pub fn handle_update_pricing(
    ctx: Context<UpdatePricing>,
    spot_price_used: u64,    // Spot in USDC smallest units (e.g. 180_000_000 = $180)
    implied_vol_bps: u64,    // Vol in bps (e.g. 8500 = 85%)
) -> Result<()> {
    // 1. Validate vol bounds
    require!(implied_vol_bps >= MIN_VOL_BPS, ButterError::VolTooLow);
    require!(implied_vol_bps <= MAX_VOL_BPS, ButterError::VolTooHigh);
    require!(spot_price_used > 0, ButterError::InvalidSettlementPrice);

    // 2. Read market data
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;

    // 3. Check option hasn't expired
    let time_to_expiry = market.expiry_timestamp - clock.unix_timestamp;
    require!(time_to_expiry > 0, ButterError::OptionExpired);

    // 4. Convert to solmath SCALE format
    let spot_scale = usdc_to_scale(spot_price_used)?;
    let strike_scale = usdc_to_scale(market.strike_price)?;
    let vol_scale = vol_bps_to_scale(implied_vol_bps)?;
    let time_scale = seconds_to_time_scale(time_to_expiry)?;

    // 5. Call solmath Black-Scholes on-chain
    let greeks = solmath::bs_full_hp(
        spot_scale,
        strike_scale,
        RISK_FREE_RATE_SCALE,
        vol_scale,
        time_scale,
    ).map_err(|_| ButterError::PricingCalculationFailed)?;

    // 6. Extract fair value based on option type (call vs put)
    let fair_value_scale = match market.option_type {
        OptionType::Call => greeks.call,
        OptionType::Put => greeks.put,
    };
    let fair_value_usdc = scale_to_usdc(fair_value_scale);

    // 7. Convert Greeks to human-readable on-chain formats
    let delta_raw = match market.option_type {
        OptionType::Call => greeks.call_delta,
        OptionType::Put => greeks.put_delta,
    };
    // Delta is at SCALE (0 to 1.0 or -1.0 to 0). Convert to bps: × 10000 / SCALE
    let delta_bps = (delta_raw * 10_000 / SCALE as i128) as i64;

    // Gamma at SCALE. Convert to bps×100 for precision.
    let gamma_bps = (greeks.gamma * 1_000_000 / SCALE as i128) as i64;

    // Vega: price change per unit vol change, at SCALE. Convert to USDC per 1% move.
    // vega_at_scale is dV/dσ. For per-1%-point: vega * 0.01. Then to USDC: / 1e6.
    let vega_usdc = (greeks.vega / 100 / 1_000_000) as i64;

    // Theta: per-year at SCALE. Convert to daily USDC.
    let theta_raw = match market.option_type {
        OptionType::Call => greeks.call_theta,
        OptionType::Put => greeks.put_theta,
    };
    let theta_usdc = (theta_raw / 365 / 1_000_000) as i64;

    // 8. Store in PricingData PDA
    let pricing = &mut ctx.accounts.pricing_data;
    pricing.fair_value_per_token = fair_value_usdc;
    pricing.spot_price_used = spot_price_used;
    pricing.implied_vol_bps = implied_vol_bps;
    pricing.delta_bps = delta_bps;
    pricing.gamma_bps = gamma_bps;
    pricing.vega_usdc = vega_usdc;
    pricing.theta_usdc = theta_usdc;
    pricing.last_updated = clock.unix_timestamp;

    Ok(())
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
pub struct UpdatePricing<'info> {
    /// Anyone can call update_pricing (permissionless).
    pub caller: Signer<'info>,

    /// The pricing PDA to update. Validated via seeds against the position.
    #[account(
        mut,
        seeds = [PRICING_SEED, option_position.key().as_ref()],
        bump = pricing_data.bump,
    )]
    pub pricing_data: Account<'info, PricingData>,

    /// The option position being priced.
    #[account(
        constraint = pricing_data.position == option_position.key(),
    )]
    pub option_position: Account<'info, OptionPosition>,

    /// The market — provides strike, expiry, option_type for BS calculation.
    #[account(
        constraint = option_position.market == market.key(),
    )]
    pub market: Account<'info, OptionsMarket>,
}
