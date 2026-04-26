// =============================================================================
// instructions/withdraw_post_settlement.rs — Writer withdraws after settlement
// =============================================================================
//
// After a vault is settled and option holders have exercised, writers can
// withdraw their remaining share of collateral. The amount each writer gets
// is proportional to their share of the vault.
//
// This also handles cleanup: closes the writer_position account, and if the
// last writer withdraws, closes the vault and its USDC account.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::errors::OptaError;
use crate::events::VaultPostSettlementWithdraw;
use crate::state::*;

pub fn handle_withdraw_post_settlement(ctx: Context<WithdrawPostSettlement>) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;
    let writer_pos = &ctx.accounts.writer_position;

    // Validation
    require!(vault.is_settled, OptaError::VaultNotSettled);
    require!(writer_pos.owner == ctx.accounts.writer.key(), OptaError::NotWriter);
    require!(writer_pos.shares > 0, OptaError::InsufficientCollateral);

    // FIX HIGH-01: Auto-claim any unclaimed premium before closing position
    let total_earned = (writer_pos.shares as u128)
        .checked_mul(vault.premium_per_share_cumulative)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(1_000_000_000_000u128) // SCALE = 1e12
        .ok_or(OptaError::MathOverflow)?;

    let earned_since_deposit = total_earned
        .checked_sub(writer_pos.premium_debt)
        .unwrap_or(0);

    let unclaimed_premium = earned_since_deposit
        .saturating_sub(writer_pos.premium_claimed as u128) as u64;

    // Calculate writer's share of remaining collateral
    let writer_remaining = (writer_pos.shares as u128)
        .checked_mul(vault.collateral_remaining as u128)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(vault.total_shares as u128)
        .ok_or(OptaError::MathOverflow)? as u64;

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

    // FIX HIGH-01: Transfer unclaimed premium first
    if unclaimed_premium > 0 {
        let premium_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_usdc_account.to_account_info(),
                to: ctx.accounts.writer_usdc_account.to_account_info(),
                authority: ctx.accounts.shared_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(premium_ctx, unclaimed_premium)?;
    }

    if writer_remaining > 0 {
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_usdc_account.to_account_info(),
                to: ctx.accounts.writer_usdc_account.to_account_info(),
                authority: ctx.accounts.shared_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, writer_remaining)?;
    }

    // Capture values before mutable borrows
    let vault_key = ctx.accounts.shared_vault.key();
    let writer_key = ctx.accounts.writer.key();
    let writer_shares = writer_pos.shares;

    // Update vault state
    let vault = &mut ctx.accounts.shared_vault;
    vault.collateral_remaining = vault.collateral_remaining
        .checked_sub(writer_remaining)
        .ok_or(OptaError::MathOverflow)?;
    vault.total_shares = vault.total_shares
        .checked_sub(writer_shares)
        .ok_or(OptaError::MathOverflow)?;
    vault.total_collateral = vault.total_collateral
        .checked_sub(writer_remaining)
        .ok_or(OptaError::MathOverflow)?;

    // Check if this is the last writer — if so, close the vault USDC account
    let is_last_writer = vault.total_shares == 0;

    if is_last_writer {
        // FIX: Sweep premium rounding dust before closing vault USDC account.
        // Multi-writer accumulator truncation can leave < 1 cent of dust.
        ctx.accounts.vault_usdc_account.reload()?;
        let dust = ctx.accounts.vault_usdc_account.amount;
        if dust > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_usdc_account.to_account_info(),
                        to: ctx.accounts.writer_usdc_account.to_account_info(),
                        authority: ctx.accounts.shared_vault.to_account_info(),
                    },
                    signer_seeds,
                ),
                dust,
            )?;
        }

        let close_usdc_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_usdc_account.to_account_info(),
                destination: ctx.accounts.writer.to_account_info(),
                authority: ctx.accounts.shared_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::close_account(close_usdc_ctx)?;
    }

    emit!(VaultPostSettlementWithdraw {
        vault: vault_key,
        writer: writer_key,
        amount: writer_remaining,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawPostSettlement<'info> {
    /// The writer withdrawing remaining collateral.
    #[account(mut)]
    pub writer: Signer<'info>,

    /// The settled shared vault.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Writer's position — will be closed after withdrawal.
    #[account(
        mut,
        seeds = [WRITER_POSITION_SEED, shared_vault.key().as_ref(), writer.key().as_ref()],
        bump = writer_position.bump,
        close = writer,
    )]
    pub writer_position: Box<Account<'info, WriterPosition>>,

    /// Vault's USDC token account.
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

    pub system_program: Program<'info, System>,
}
