// =============================================================================
// instructions/update_pricing.rs — Update on-chain fair value
// =============================================================================
//
// The crank bot calls this every ~60 seconds to write the latest fair value.
//
// WHY NOT COMPUTE ON-CHAIN?
// Black-Scholes requires exp(), log(), sqrt() — these are expensive in Solana
// compute units. It's much cheaper to compute off-chain and just store the
// result. The crank is the trusted price writer.
//
// TRUST MODEL:
// Only the original update_authority can update prices. If the crank goes
// down, prices go stale but the protocol still works — options can still be
// exercised, settled, traded. The pricing PDA is informational, not enforced.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::ButterError;
use crate::state::*;

/// Handler: update the fair value in a PricingData account.
pub fn handle_update_pricing(
    ctx: Context<UpdatePricing>,
    fair_value_per_token: u64,
    spot_price_used: u64,
    implied_vol_bps: u64,
) -> Result<()> {
    let pricing = &mut ctx.accounts.pricing_data;
    let clock = Clock::get()?;

    pricing.fair_value_per_token = fair_value_per_token;
    pricing.spot_price_used = spot_price_used;
    pricing.implied_vol_bps = implied_vol_bps;
    pricing.last_updated = clock.unix_timestamp;

    Ok(())
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
pub struct UpdatePricing<'info> {
    /// Must be the same wallet that initialized this pricing account.
    #[account(
        constraint = authority.key() == pricing_data.update_authority
            @ ButterError::UnauthorizedPricingUpdate,
    )]
    pub authority: Signer<'info>,

    /// The pricing account to update.
    #[account(mut)]
    pub pricing_data: Account<'info, PricingData>,
}
