// =============================================================================
// instructions/withdraw_from_vault.rs — Writer withdraws uncommitted collateral
// =============================================================================
//
// Writers can withdraw their free collateral (not committed to active options)
// from the shared vault. Shares are redeemed proportionally.
//
// The key constraint: can't withdraw collateral backing active (minted but
// unsold or sold) options. Only "free" collateral can be withdrawn.
//
// USDC flow: vault_usdc_account → writer_usdc_account (signed by vault PDA)
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ButterError;
use crate::events::VaultWithdrawn;
use crate::state::*;

pub fn handle_withdraw_from_vault(
    ctx: Context<WithdrawFromVault>,
    shares_to_withdraw: u64,
) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;
    let writer_pos = &ctx.accounts.writer_position;

    // Validation
    require!(writer_pos.owner == ctx.accounts.writer.key(), ButterError::NotWriter);
    require!(shares_to_withdraw > 0, ButterError::InvalidContractSize);
    require!(shares_to_withdraw <= writer_pos.shares, ButterError::InsufficientCollateral);
    require!(!vault.is_settled, ButterError::VaultAlreadySettled);

    // FIX MEDIUM-01: Require all premium claimed before share withdrawal
    // This prevents premium loss from debt/share mismatch
    let total_earned = (writer_pos.shares as u128)
        .checked_mul(vault.premium_per_share_cumulative)
        .ok_or(ButterError::MathOverflow)?
        .checked_div(1_000_000_000_000u128) // SCALE = 1e12
        .ok_or(ButterError::MathOverflow)?;

    let earned_since_deposit = total_earned
        .checked_sub(writer_pos.premium_debt)
        .unwrap_or(0);

    let unclaimed = earned_since_deposit
        .saturating_sub(writer_pos.premium_claimed as u128) as u64;

    require!(unclaimed == 0, ButterError::ClaimPremiumFirst);

    // Calculate withdrawal amount from shares
    let withdrawal_amount = (shares_to_withdraw as u128)
        .checked_mul(vault.total_collateral as u128)
        .ok_or(ButterError::MathOverflow)?
        .checked_div(vault.total_shares as u128)
        .ok_or(ButterError::MathOverflow)? as u64;

    // Check that withdrawal doesn't breach committed collateral
    // FIX M-04: Match v1 collateral formula — calls require 2x strike
    let collateral_per_contract = match vault.option_type {
        OptionType::Call => vault.strike_price
            .checked_mul(2)
            .ok_or(ButterError::MathOverflow)?,
        OptionType::Put => vault.strike_price,
    };
    let writer_total_collateral = (writer_pos.shares as u128)
        .checked_mul(vault.total_collateral as u128)
        .ok_or(ButterError::MathOverflow)?
        .checked_div(vault.total_shares as u128)
        .ok_or(ButterError::MathOverflow)? as u64;
    let writer_committed = writer_pos.options_minted
        .checked_mul(collateral_per_contract)
        .ok_or(ButterError::MathOverflow)?;
    let writer_free = writer_total_collateral
        .checked_sub(writer_committed)
        .ok_or(ButterError::MathOverflow)?;

    require!(withdrawal_amount <= writer_free, ButterError::CollateralCommitted);

    // Transfer USDC from vault to writer (signed by shared_vault PDA)
    let vault_key = ctx.accounts.shared_vault.key();
    let market_key = vault.market;
    let strike_bytes = vault.strike_price.to_le_bytes();
    let expiry_bytes = vault.expiry.to_le_bytes();
    let option_type_byte = [vault.option_type as u8];
    let vault_bump = [vault.bump];

    let vault_seeds: &[&[u8]] = &[
        SHARED_VAULT_SEED,
        market_key.as_ref(),
        &strike_bytes,
        &expiry_bytes,
        &option_type_byte,
        &vault_bump,
    ];
    let signer_seeds = &[vault_seeds];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_usdc_account.to_account_info(),
            to: ctx.accounts.writer_usdc_account.to_account_info(),
            authority: ctx.accounts.shared_vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, withdrawal_amount)?;

    // Update state
    let writer_key = ctx.accounts.writer.key();

    let writer_pos = &mut ctx.accounts.writer_position;
    writer_pos.shares = writer_pos.shares
        .checked_sub(shares_to_withdraw)
        .ok_or(ButterError::MathOverflow)?;
    writer_pos.deposited_collateral = writer_pos.deposited_collateral
        .saturating_sub(withdrawal_amount);

    let vault = &mut ctx.accounts.shared_vault;
    vault.total_collateral = vault.total_collateral
        .checked_sub(withdrawal_amount)
        .ok_or(ButterError::MathOverflow)?;
    vault.total_shares = vault.total_shares
        .checked_sub(shares_to_withdraw)
        .ok_or(ButterError::MathOverflow)?;

    emit!(VaultWithdrawn {
        vault: vault_key,
        writer: writer_key,
        amount: withdrawal_amount,
        shares: shares_to_withdraw,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawFromVault<'info> {
    /// The writer withdrawing collateral.
    #[account(mut)]
    pub writer: Signer<'info>,

    /// The shared vault.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Writer's position in the vault.
    #[account(
        mut,
        seeds = [WRITER_POSITION_SEED, shared_vault.key().as_ref(), writer.key().as_ref()],
        bump = writer_position.bump,
    )]
    pub writer_position: Box<Account<'info, WriterPosition>>,

    /// Vault's USDC token account — source of withdrawal.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Writer's USDC token account — destination.
    #[account(
        mut,
        constraint = writer_usdc_account.owner == writer.key(),
        constraint = writer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Protocol state — for USDC mint validation.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Standard SPL Token program.
    pub token_program: Program<'info, Token>,
}
