// =============================================================================
// instructions/deposit_to_vault.rs — Writer deposits USDC into a SharedVault
// =============================================================================
//
// Writers deposit USDC collateral and receive proportional shares.
//
// Share calculation:
//   - First deposit (total_shares == 0): shares = amount (1:1 baseline)
//   - Subsequent deposits: shares = (amount * total_shares) / total_collateral
//
// Gating rules:
//   - Epoch vaults: anyone can deposit (shared pool)
//   - Custom vaults: only the creator can deposit (single-writer)
//   - No deposits into settled or expired vaults
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ButterError;
use crate::events::VaultDeposited;
use crate::state::*;

pub fn handle_deposit_to_vault(
    ctx: Context<DepositToVault>,
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.shared_vault;

    // Basic validation
    require!(amount > 0, ButterError::InvalidPremium);
    require!(!vault.is_settled, ButterError::VaultAlreadySettled);
    require!(vault.expiry > clock.unix_timestamp, ButterError::VaultExpired);

    // Custom vault gate: only the original creator can deposit
    if vault.vault_type == VaultType::Custom && vault.total_shares > 0 {
        require!(
            ctx.accounts.writer.key() == vault.creator,
            ButterError::CustomVaultSingleWriter
        );
    }

    // Calculate shares for this deposit
    let shares = if vault.total_shares == 0 {
        // First depositor sets the baseline: 1 USDC = 1 share
        amount
    } else {
        // Proportional to existing pool
        (amount as u128)
            .checked_mul(vault.total_shares as u128)
            .ok_or(ButterError::MathOverflow)?
            .checked_div(vault.total_collateral as u128)
            .ok_or(ButterError::MathOverflow)? as u64
    };

    require!(shares > 0, ButterError::MathOverflow);

    // Transfer USDC from writer to vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.writer_usdc_account.to_account_info(),
            to: ctx.accounts.vault_usdc_account.to_account_info(),
            authority: ctx.accounts.writer.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    // Capture keys before mutable borrows
    let vault_key = ctx.accounts.shared_vault.key();
    let writer_key = ctx.accounts.writer.key();

    // Update the writer's position first (needs shared_vault.key() via vault_key)
    let position = &mut ctx.accounts.writer_position;
    let is_new = position.shares == 0 && position.deposited_collateral == 0;
    if is_new {
        position.owner = writer_key;
        position.vault = vault_key;
        position.premium_claimed = 0;
        position.premium_debt = 0;
        position.options_minted = 0;
        position.options_sold = 0;
        position.deposited_at = clock.unix_timestamp;
        position.bump = ctx.bumps.writer_position;
    }

    // FIX H-01: Set premium_debt for new shares so depositor isn't entitled
    // to premium accumulated before this deposit.
    // For existing positions: add debt for the new shares only.
    let additional_debt = (shares as u128)
        .checked_mul(vault.premium_per_share_cumulative)
        .ok_or(ButterError::MathOverflow)?
        .checked_div(1_000_000_000_000)
        .ok_or(ButterError::MathOverflow)?;
    position.premium_debt = position.premium_debt
        .checked_add(additional_debt)
        .ok_or(ButterError::MathOverflow)?;

    position.shares = position.shares
        .checked_add(shares)
        .ok_or(ButterError::MathOverflow)?;
    position.deposited_collateral = position.deposited_collateral
        .checked_add(amount)
        .ok_or(ButterError::MathOverflow)?;

    // Update the vault totals
    let vault = &mut ctx.accounts.shared_vault;
    vault.total_collateral = vault.total_collateral
        .checked_add(amount)
        .ok_or(ButterError::MathOverflow)?;
    vault.total_shares = vault.total_shares
        .checked_add(shares)
        .ok_or(ButterError::MathOverflow)?;

    let total_collateral = vault.total_collateral;

    emit!(VaultDeposited {
        vault: vault_key,
        writer: writer_key,
        amount,
        shares,
        total_collateral,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct DepositToVault<'info> {
    /// The writer depositing collateral.
    #[account(mut)]
    pub writer: Signer<'info>,

    /// The vault to deposit into. Must not be settled or expired.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Writer's position in this vault. Created on first deposit (init_if_needed).
    #[account(
        init_if_needed,
        seeds = [WRITER_POSITION_SEED, shared_vault.key().as_ref(), writer.key().as_ref()],
        bump,
        payer = writer,
        space = 8 + WriterPosition::INIT_SPACE,
    )]
    pub writer_position: Box<Account<'info, WriterPosition>>,

    /// Writer's USDC token account — source of collateral.
    #[account(
        mut,
        constraint = writer_usdc_account.owner == writer.key(),
        constraint = writer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Vault's USDC token account — destination for collateral.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Protocol state — for USDC mint validation.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Standard SPL Token program — for USDC transfers.
    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}
