// =============================================================================
// instructions/settle_expiry.rs — Record the canonical settlement price
// for a single (asset, expiry) tuple
// =============================================================================
//
// Introduced in Stage 3. Replaces the old `settle_market` instruction
// (deleted in Stage 2) that wrote settlement state directly onto the
// OptionsMarket account.
//
// Admin-only. Hackathon-mocked Pyth: the admin passes the price inline.
// In production this instruction would either read from a Pyth pull-oracle
// account or be replaced by a permissionless variant that reads from one.
//
// Idempotency: the SettlementRecord PDA is created with plain `init`
// (not `init_if_needed`). A second call for the same (asset, expiry)
// reverts naturally with anchor's "account already in use" error — exactly
// the desired behavior, because settlement prices must be one-shot per
// (asset, expiry).
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{
    OptionsMarket, ProtocolState, SettlementRecord, MARKET_SEED, PROTOCOL_SEED, SETTLEMENT_SEED,
};

pub fn handle_settle_expiry(
    ctx: Context<SettleExpiry>,
    asset_name: String,
    expiry: i64,
    price: u64,
) -> Result<()> {
    // 1. Admin-only
    require!(
        ctx.accounts.admin.key() == ctx.accounts.protocol_state.admin,
        OptaError::Unauthorized
    );

    // 2. Cannot settle pre-expiry
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= expiry,
        OptaError::MarketNotExpired
    );

    // 3. Settlement price must be positive
    require!(price > 0, OptaError::InvalidSettlementPrice);

    // 4. Populate the record
    let record = &mut ctx.accounts.settlement_record;
    record.asset_name = asset_name.clone();
    record.expiry = expiry;
    record.settlement_price = price;
    record.settled_at = clock.unix_timestamp;
    record.bump = ctx.bumps.settlement_record;

    msg!(
        "Settlement recorded: {} expiry={} price={}",
        asset_name,
        expiry,
        price,
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String, expiry: i64)]
pub struct SettleExpiry<'info> {
    /// Protocol admin (verified inside handler against `protocol_state.admin`).
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Global ProtocolState — read for admin check.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// OptionsMarket — proves the asset_name is registered (and normalized,
    /// because the market PDA derivation requires the canonical bytes).
    #[account(
        seeds = [MARKET_SEED, asset_name.as_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, OptionsMarket>,

    /// The SettlementRecord PDA. Plain `init` — second call for the same
    /// (asset, expiry) reverts.
    #[account(
        init,
        seeds = [
            SETTLEMENT_SEED,
            asset_name.as_bytes(),
            &expiry.to_le_bytes(),
        ],
        bump,
        payer = admin,
        space = 8 + SettlementRecord::INIT_SPACE,
    )]
    pub settlement_record: Account<'info, SettlementRecord>,

    pub system_program: Program<'info, System>,
}
