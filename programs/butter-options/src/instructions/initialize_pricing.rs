// =============================================================================
// instructions/initialize_pricing.rs — Create on-chain pricing account
// =============================================================================
//
// Creates a PricingData PDA for an option position. Anyone can call this
// (permissionless) — creating the PDA costs SOL rent, which is a natural
// spam deterrent.
//
// After creation, anyone can call update_pricing to compute fair value.
//
// PDA seeds: ["pricing", position_pubkey]
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::ButterError;
use crate::state::*;

/// Handler: create a PricingData account for an option position.
pub fn handle_initialize_pricing(ctx: Context<InitializePricing>) -> Result<()> {
    let position = &ctx.accounts.position;

    // Position must still be active (not exercised, expired, or cancelled)
    require!(
        !position.is_exercised && !position.is_expired && !position.is_cancelled,
        ButterError::PositionNotActive
    );

    let pricing = &mut ctx.accounts.pricing_data;
    pricing.position = ctx.accounts.position.key();
    pricing.fair_value_per_token = 0;
    pricing.spot_price_used = 0;
    pricing.implied_vol_bps = 0;
    pricing.delta_bps = 0;
    pricing.gamma_bps = 0;
    pricing.vega_usdc = 0;
    pricing.theta_usdc = 0;
    pricing.last_updated = 0;
    pricing.update_authority = ctx.accounts.payer.key();
    pricing.bump = ctx.bumps.pricing_data;

    msg!(
        "Pricing initialized: position={}, payer={}",
        ctx.accounts.position.key(),
        ctx.accounts.payer.key(),
    );

    Ok(())
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
pub struct InitializePricing<'info> {
    /// Anyone can create a pricing PDA (pays rent).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The option position to create pricing for. Must exist and be active.
    pub position: Account<'info, OptionPosition>,

    /// The pricing PDA. Created here, owned by this program.
    #[account(
        init,
        seeds = [PRICING_SEED, position.key().as_ref()],
        bump,
        payer = payer,
        space = 8 + PricingData::INIT_SPACE,
    )]
    pub pricing_data: Account<'info, PricingData>,

    pub system_program: Program<'info, System>,
}
