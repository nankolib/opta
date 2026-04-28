// =============================================================================
// instructions/settle_vault.rs — Settle a SharedVault from a SettlementRecord
// =============================================================================
//
// Stage 3 final shape: permissionless. Reads the canonical settlement
// price from a SettlementRecord PDA (written earlier by the admin-only
// `settle_expiry` instruction) and applies it to this vault.
//
// If no SettlementRecord exists for this vault's (asset, expiry) tuple,
// anchor's seed validation + Account deserialization fails before the
// handler runs — caller gets a clear "uninitialized account" error.
//
// This does NOT distribute funds. It just marks the vault as settled and
// records the payout calculations. Individual exercises and writer
// withdrawals handle actual fund movement.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::events::VaultSettled;
use crate::state::*;

pub fn handle_settle_vault(ctx: Context<SettleVault>) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;
    let record = &ctx.accounts.settlement_record;

    require!(!vault.is_settled, OptaError::VaultAlreadySettled);

    let clock = Clock::get()?;
    require!(
        vault.expiry <= clock.unix_timestamp,
        OptaError::MarketNotExpired
    );

    // Read canonical settlement price from the per-(asset, expiry) record
    let settlement_price = record.settlement_price;

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
    /// Permissionless — anyone can settle a vault once the SettlementRecord
    /// for its (asset, expiry) exists.
    pub authority: Signer<'info>,

    /// The shared vault to settle.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The vault's market — needed to derive the SettlementRecord PDA from
    /// `market.asset_name`. Constraint pins it to the vault's recorded market.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// The canonical settlement record for this (asset, expiry). If none
    /// exists, anchor's seed validation + Account deserialization fails
    /// before the handler runs.
    #[account(
        seeds = [
            SETTLEMENT_SEED,
            market.asset_name.as_bytes(),
            &shared_vault.expiry.to_le_bytes(),
        ],
        bump = settlement_record.bump,
    )]
    pub settlement_record: Account<'info, SettlementRecord>,
}
