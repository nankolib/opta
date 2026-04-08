// =============================================================================
// instructions/initialize_pricing.rs — Create on-chain pricing account
// =============================================================================
//
// Creates a PricingData PDA for an option position. The crank bot calls this
// once per position, then calls update_pricing every ~60 seconds.
//
// The crank bot wallet becomes the update_authority — only that wallet
// can write fair values later. This prevents fake price injection.
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
    pricing.last_updated = 0;
    pricing.update_authority = ctx.accounts.authority.key();
    pricing.bump = ctx.bumps.pricing_data;

    msg!(
        "Pricing initialized: position={}, authority={}",
        ctx.accounts.position.key(),
        ctx.accounts.authority.key(),
    );

    Ok(())
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
pub struct InitializePricing<'info> {
    /// The crank bot wallet that will own this pricing feed.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The option position to create pricing for. Must exist and be active.
    pub position: Account<'info, OptionPosition>,

    /// The pricing PDA. Created here, owned by this program.
    #[account(
        init,
        seeds = [PRICING_SEED, position.key().as_ref()],
        bump,
        payer = authority,
        space = 8 + PricingData::INIT_SPACE,
    )]
    pub pricing_data: Account<'info, PricingData>,

    pub system_program: Program<'info, System>,
}
