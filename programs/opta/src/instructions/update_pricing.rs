// =============================================================================
// instructions/update_pricing.rs — Compute Black-Scholes on-chain via solmath
// =============================================================================
//
// PERMISSIONLESS: Anyone can call this.
//
// Two modes:
//   1. PYTH MODE (production): Pass a PriceUpdateV2 account — contract reads
//      spot price directly from the oracle with a 30-second staleness check.
//      spot_price_used parameter is ignored.
//
//   2. PARAMETER MODE (testing/fallback): No Pyth account — caller passes
//      spot_price_used directly. Used on localnet where Pyth doesn't exist.
//
// In both modes, the contract computes Black-Scholes + Greeks on-chain via
// solmath's bs_full_hp() in ~50K compute units.
// =============================================================================

use anchor_lang::prelude::*;
use solmath::SCALE;

use crate::errors::ButterError;
use crate::state::*;
use crate::utils::solmath_bridge::*;

/// Maximum age of a Pyth price update in seconds.
/// Prices older than this are rejected to prevent stale data attacks.
pub const MAXIMUM_PRICE_AGE: u64 = 30;

/// Handler: compute Black-Scholes on-chain and store results.
pub fn handle_update_pricing(
    ctx: Context<UpdatePricing>,
    spot_price_used: u64,    // Spot in USDC units — used ONLY if no Pyth account provided
    implied_vol_bps: u64,    // Vol in bps (e.g. 8500 = 85%)
) -> Result<()> {
    // 1. Validate vol bounds
    require!(implied_vol_bps >= MIN_VOL_BPS, ButterError::VolTooLow);
    require!(implied_vol_bps <= MAX_VOL_BPS, ButterError::VolTooHigh);

    // 2. Read market data
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;

    // 3. Check option hasn't expired (checked_sub guards against corrupted timestamps)
    let time_to_expiry = market.expiry_timestamp
        .checked_sub(clock.unix_timestamp)
        .ok_or(ButterError::OptionExpired)?;
    require!(time_to_expiry > 0, ButterError::OptionExpired);

    // 4. Determine spot price — from Pyth oracle or parameter
    let (spot_usdc, spot_scale) = if let Some(price_update) = &ctx.accounts.price_update {
        // PYTH MODE: read price from oracle with staleness check
        let feed_id = price_update.price_message.feed_id;

        // Validate that the Pyth feed matches the market's expected feed.
        // market.pyth_feed stores the feed ID as a Pubkey (same 32 bytes).
        require!(
            feed_id == market.pyth_feed.to_bytes(),
            ButterError::InvalidPythFeed
        );

        let price = price_update.get_price_no_older_than(
            &clock,
            MAXIMUM_PRICE_AGE,
            &feed_id,
        ).map_err(|_| ButterError::OracleStaleOrInvalid)?;

        let spot_scale_val = pyth_price_to_scale(price.price, price.exponent)?;
        let spot_usdc_val = pyth_price_to_usdc(price.price, price.exponent)?;
        (spot_usdc_val, spot_scale_val)
    } else {
        // PARAMETER MODE: trust caller-provided spot price (testing/fallback)
        require!(spot_price_used > 0, ButterError::InvalidSettlementPrice);
        let spot_scale_val = usdc_to_scale(spot_price_used)?;
        (spot_price_used, spot_scale_val)
    };

    // 5. Convert remaining inputs to solmath SCALE format
    let strike_scale = usdc_to_scale(market.strike_price)?;
    let vol_scale = vol_bps_to_scale(implied_vol_bps)?;
    let time_scale = seconds_to_time_scale(time_to_expiry)?;

    // 6. Call solmath Black-Scholes on-chain
    let greeks = solmath::bs_full_hp(
        spot_scale,
        strike_scale,
        RISK_FREE_RATE_SCALE,
        vol_scale,
        time_scale,
    ).map_err(|_| ButterError::PricingCalculationFailed)?;

    // 7. Extract fair value based on option type
    let fair_value_scale = match market.option_type {
        OptionType::Call => greeks.call,
        OptionType::Put => greeks.put,
    };
    let fair_value_usdc = scale_to_usdc(fair_value_scale)?;

    // 8. Convert Greeks to human-readable formats
    let delta_raw = match market.option_type {
        OptionType::Call => greeks.call_delta,
        OptionType::Put => greeks.put_delta,
    };
    let delta_bps = (delta_raw * 10_000 / SCALE as i128) as i64;
    let gamma_bps = (greeks.gamma * 1_000_000 / SCALE as i128) as i64;
    // Vega: stored in micro-USDC (1 unit = 0.000001 USDC) per unit vol move.
    // greeks.vega is at SCALE (1e12). Divide by 1e6 to get micro-USDC.
    // Previous code divided by 1e8 which truncated small values to zero.
    let vega_usdc = (greeks.vega / 1_000_000) as i64;
    let theta_raw = match market.option_type {
        OptionType::Call => greeks.call_theta,
        OptionType::Put => greeks.put_theta,
    };
    // Theta: daily time decay in micro-USDC (1 unit = 0.000001 USDC).
    // theta_raw is at SCALE (1e12) per year. Divide by 365 for daily,
    // then by 1e6 to get micro-USDC.
    let theta_usdc = (theta_raw / 365 / 1_000_000) as i64;

    // 9. Store in PricingData PDA
    let pricing = &mut ctx.accounts.pricing_data;
    pricing.fair_value_per_token = fair_value_usdc;
    pricing.spot_price_used = spot_usdc;
    pricing.implied_vol_bps = implied_vol_bps;
    pricing.delta_bps = delta_bps;
    pricing.gamma_bps = gamma_bps;
    pricing.vega_usdc = vega_usdc;
    pricing.theta_usdc = theta_usdc;
    pricing.last_updated = clock.unix_timestamp;
    pricing.last_updater = ctx.accounts.caller.key();

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

    /// Optional Pyth PriceUpdateV2 account. If provided, spot price is read
    /// from the oracle with a 30-second staleness check. If not provided,
    /// the spot_price_used parameter is used instead (testing/fallback).
    ///
    /// Anchor's Account<PriceUpdateV2> validates ownership by the Pyth program,
    /// preventing spoofed price accounts.
    pub price_update: Option<Account<'info, pyth_solana_receiver_sdk::price_update::PriceUpdateV2>>,
}
