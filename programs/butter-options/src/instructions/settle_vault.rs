// =============================================================================
// instructions/settle_vault.rs — Settle a SharedVault after market settlement
// =============================================================================
//
// After the market is settled (admin sets final price), this instruction
// settles the vault by calculating how much collateral is owed to option
// holders vs how much remains for writers.
//
// This does NOT distribute funds. It just marks the vault as settled and
// records the payout calculations. Individual exercises and writer withdrawals
// handle actual fund movement (mirrors how settle_market works in v1).
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::ButterError;
use crate::events::VaultSettled;
use crate::state::*;

pub fn handle_settle_vault(ctx: Context<SettleVault>) -> Result<()> {
    let market = &ctx.accounts.market;
    let vault = &ctx.accounts.shared_vault;

    // Validation
    require!(market.is_settled, ButterError::MarketNotSettled);
    require!(!vault.is_settled, ButterError::VaultAlreadySettled);

    let clock = Clock::get()?;
    require!(vault.expiry <= clock.unix_timestamp, ButterError::MarketNotExpired);

    // Calculate total payout owed to option holders
    let settlement_price = market.settlement_price;
    let strike_price = vault.strike_price;

    let payout_per_contract = match vault.option_type {
        OptionType::Call => {
            if settlement_price > strike_price {
                settlement_price.checked_sub(strike_price)
                    .ok_or(ButterError::MathOverflow)?
            } else {
                0
            }
        }
        OptionType::Put => {
            if strike_price > settlement_price {
                strike_price.checked_sub(settlement_price)
                    .ok_or(ButterError::MathOverflow)?
            } else {
                0
            }
        }
    };

    let total_payout = payout_per_contract
        .checked_mul(vault.total_options_sold)
        .ok_or(ButterError::MathOverflow)?;

    // Cap payout at total collateral (can't pay out more than exists)
    let total_payout = std::cmp::min(total_payout, vault.total_collateral);

    let collateral_remaining = vault.total_collateral
        .checked_sub(total_payout)
        .ok_or(ButterError::MathOverflow)?;

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
    /// Anyone can settle a vault (permissionless crank).
    pub authority: Signer<'info>,

    /// The shared vault to settle.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The market — must be settled (settlement_price set).
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,
}
