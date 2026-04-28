// =============================================================================
// instructions/claim_premium.rs — Writer claims earned premium from vault
// =============================================================================
//
// Premium collected from buyers is held in the vault's USDC account. Each
// writer can claim their proportional share based on their share ratio.
//
// Formula:
//   writer_premium_share = (writer.shares * vault.premium_collected) / vault.total_shares
//   claimable = writer_premium_share - writer.premium_claimed
//
// This prevents double-claiming by tracking how much has been claimed.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::OptaError;
use crate::events::PremiumClaimed;
use crate::state::*;

pub fn handle_claim_premium(ctx: Context<ClaimPremium>) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;
    let writer_pos = &ctx.accounts.writer_position;

    // Validation
    require!(writer_pos.owner == ctx.accounts.writer.key(), OptaError::NotWriter);

    // FIX H-01: Use reward-per-share accumulator instead of proportional share.
    // total_earned = shares * cumulative / SCALE
    let total_earned = (writer_pos.shares as u128)
        .checked_mul(vault.premium_per_share_cumulative)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(1_000_000_000_000) // SCALE = 1e12
        .ok_or(OptaError::MathOverflow)?;

    // Subtract the debt (premium earned before this writer deposited)
    let earned_since_deposit = total_earned
        .checked_sub(writer_pos.premium_debt)
        .unwrap_or(0);

    // Subtract what's already been claimed
    let claimable = earned_since_deposit
        .saturating_sub(writer_pos.premium_claimed as u128) as u64;

    require!(claimable > 0, OptaError::NothingToClaim);

    // Transfer USDC from vault to writer (signed by shared_vault PDA)
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
    token::transfer(transfer_ctx, claimable)?;

    // Update writer position
    let vault_key = ctx.accounts.shared_vault.key();
    let writer_key = ctx.accounts.writer.key();

    let writer_pos = &mut ctx.accounts.writer_position;
    writer_pos.premium_claimed = writer_pos.premium_claimed
        .checked_add(claimable)
        .ok_or(OptaError::MathOverflow)?;

    emit!(PremiumClaimed {
        vault: vault_key,
        writer: writer_key,
        amount: claimable,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ClaimPremium<'info> {
    /// The writer claiming premium.
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

    /// Vault's USDC token account — source of premium.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Writer's USDC token account — destination.
    #[account(
        mut,
        constraint = writer_usdc_account.owner == writer.key(),
        constraint = writer_usdc_account.mint == shared_vault.collateral_mint,
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
