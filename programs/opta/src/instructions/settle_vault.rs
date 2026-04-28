// =============================================================================
// instructions/settle_vault.rs — Settle a SharedVault after expiry
// =============================================================================
//
// Stage 2 transitional shape: admin passes `settlement_price` inline as an
// instruction argument. This mirrors the deleted `settle_market` so the
// build stays green between Stages 2 and 3.
//
// Stage 3 will replace the inline arg with a per-(asset, expiry)
// `SettlementRecord` PDA read.
//
// This does NOT distribute funds. It just marks the vault as settled and
// records the payout calculations. Individual exercises and writer
// withdrawals handle actual fund movement.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::events::VaultSettled;
use crate::state::*;

pub fn handle_settle_vault(
    ctx: Context<SettleVault>,
    settlement_price: u64,
) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;

    // Admin-only (Stage 2 transitional — Stage 3 makes this permissionless
    // by reading from a SettlementRecord written by an admin-only
    // settle_expiry instruction).
    require!(
        ctx.accounts.authority.key() == ctx.accounts.protocol_state.admin,
        OptaError::Unauthorized
    );

    require!(settlement_price > 0, OptaError::InvalidSettlementPrice);
    require!(!vault.is_settled, OptaError::VaultAlreadySettled);

    let clock = Clock::get()?;
    require!(
        vault.expiry <= clock.unix_timestamp,
        OptaError::MarketNotExpired
    );

    // Calculate total payout owed to option holders
    let strike_price = vault.strike_price;

    let payout_per_contract = match vault.option_type {
        OptionType::Call => {
            if settlement_price > strike_price {
                settlement_price
                    .checked_sub(strike_price)
                    .ok_or(OptaError::MathOverflow)?
            } else {
                0
            }
        }
        OptionType::Put => {
            if strike_price > settlement_price {
                strike_price
                    .checked_sub(settlement_price)
                    .ok_or(OptaError::MathOverflow)?
            } else {
                0
            }
        }
    };

    let total_payout = payout_per_contract
        .checked_mul(vault.total_options_sold)
        .ok_or(OptaError::MathOverflow)?;

    // Cap payout at total collateral (can't pay out more than exists)
    let total_payout = std::cmp::min(total_payout, vault.total_collateral);

    // FIX CRITICAL-01: Do NOT pre-deduct exercise payouts from collateral_remaining.
    // collateral_remaining starts at total_collateral.
    // exercise_from_vault will deduct each exercise payout individually.
    // Writers get whatever remains after all exercises via withdraw_post_settlement.
    let collateral_remaining = vault.total_collateral;

    // Update vault state
    let vault_key = ctx.accounts.shared_vault.key();

    let vault = &mut ctx.accounts.shared_vault;
    vault.is_settled = true;
    vault.settlement_price = settlement_price;
    vault.collateral_remaining = collateral_remaining;

    emit!(VaultSettled {
        vault: vault_key,
        settlement_price,
        total_payout,
        collateral_remaining,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleVault<'info> {
    /// Admin signer (verified inside handler against `protocol_state.admin`).
    pub authority: Signer<'info>,

    /// The shared vault to settle.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Protocol state — for admin check.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,
}
