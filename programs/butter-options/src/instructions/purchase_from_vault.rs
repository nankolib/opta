// =============================================================================
// instructions/purchase_from_vault.rs — Buyer purchases option tokens from vault
// =============================================================================
//
// Functionally identical to purchase_option (v1) but routes premium to the
// shared vault instead of a single writer's escrow. The buyer pays based on
// the writer's premium_per_contract (stored in VaultMint) with slippage
// protection via max_premium.
//
// Premium flow: buyer → vault USDC account (minus fee) + treasury (fee)
// Token flow:   purchase_escrow → buyer (via Token-2022 transfer with hook)
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::ButterError;
use crate::events::VaultPurchased;
use crate::state::*;
use super::initialize_protocol::TREASURY_SEED;

pub fn handle_purchase_from_vault(
    ctx: Context<PurchaseFromVault>,
    quantity: u64,
    max_premium: u64,
) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;
    let vault_mint = &ctx.accounts.vault_mint_record;
    let clock = Clock::get()?;

    // =========================================================================
    // Validation
    // =========================================================================
    require!(quantity > 0, ButterError::InvalidContractSize);
    require!(vault.expiry > clock.unix_timestamp, ButterError::VaultExpired);
    require!(!vault.is_settled, ButterError::VaultAlreadySettled);

    // Self-buy prevention: buyer can't be the writer
    require!(
        ctx.accounts.buyer.key() != vault_mint.writer,
        ButterError::CannotBuyOwnOption
    );

    // Check enough tokens are available in the purchase escrow
    let escrow_data = ctx.accounts.purchase_escrow.try_borrow_data()?;
    let available = u64::from_le_bytes(
        escrow_data[64..72].try_into().map_err(|_| ButterError::MathOverflow)?
    );
    drop(escrow_data);
    require!(quantity <= available, ButterError::InsufficientOptionTokens);

    // =========================================================================
    // Premium calculation
    //
    // total_premium = quantity * premium_per_contract
    // fee = total_premium * fee_bps / 10000 (0.5% = 50 bps)
    // writer_share = total_premium - fee
    // =========================================================================
    let total_premium = quantity
        .checked_mul(vault_mint.premium_per_contract)
        .ok_or(ButterError::MathOverflow)?;

    // Slippage protection: buyer won't pay more than max_premium
    require!(total_premium <= max_premium, ButterError::SlippageExceeded);

    let fee_bps = ctx.accounts.protocol_state.fee_bps as u64;
    let fee = total_premium
        .checked_mul(fee_bps)
        .ok_or(ButterError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ButterError::MathOverflow)?;
    let writer_share = total_premium
        .checked_sub(fee)
        .ok_or(ButterError::MathOverflow)?;

    // =========================================================================
    // Transfer USDC: buyer → vault (writer_share) + buyer → treasury (fee)
    // =========================================================================
    if writer_share > 0 {
        let transfer_to_vault = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_usdc_account.to_account_info(),
                to: ctx.accounts.vault_usdc_account.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        );
        token::transfer(transfer_to_vault, writer_share)?;
    }

    if fee > 0 {
        let transfer_fee = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_usdc_account.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        );
        token::transfer(transfer_fee, fee)?;
    }

    // =========================================================================
    // Transfer option tokens: purchase_escrow → buyer via Token-2022
    //
    // Uses invoke_transfer_checked which handles the transfer hook accounts.
    // Protocol PDA signs because it owns the escrow (same as v1).
    // =========================================================================
    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    let source_info = ctx.accounts.purchase_escrow.to_account_info();
    let mint_info = ctx.accounts.option_mint.to_account_info();
    let dest_info = ctx.accounts.buyer_option_account.to_account_info();

    spl_token_2022::onchain::invoke_transfer_checked(
        &ctx.accounts.token_2022_program.key(),
        source_info.clone(),
        mint_info.clone(),
        dest_info.clone(),
        ctx.accounts.protocol_state.to_account_info(),
        &[
            ctx.accounts.extra_account_meta_list.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
            ctx.accounts.hook_state.to_account_info(),
        ],
        quantity,
        0, // decimals = 0 for option tokens
        signer_seeds,
    )?;

    // =========================================================================
    // Update state
    // =========================================================================

    // Capture keys before mutable borrows
    let vault_key = ctx.accounts.shared_vault.key();
    let buyer_key = ctx.accounts.buyer.key();
    let mint_key = *mint_info.key;

    let vault_mint = &mut ctx.accounts.vault_mint_record;
    vault_mint.quantity_sold = vault_mint.quantity_sold
        .checked_add(quantity)
        .ok_or(ButterError::MathOverflow)?;

    let writer_pos = &mut ctx.accounts.writer_position;
    writer_pos.options_sold = writer_pos.options_sold
        .checked_add(quantity)
        .ok_or(ButterError::MathOverflow)?;

    let vault = &mut ctx.accounts.shared_vault;
    vault.total_options_sold = vault.total_options_sold
        .checked_add(quantity)
        .ok_or(ButterError::MathOverflow)?;
    vault.net_premium_collected = vault.net_premium_collected
        .checked_add(writer_share)
        .ok_or(ButterError::MathOverflow)?;

    // FIX H-01: Update cumulative premium per share (reward-per-share accumulator)
    if vault.total_shares > 0 {
        let premium_increment = (writer_share as u128)
            .checked_mul(1_000_000_000_000) // 1e12 scale factor
            .ok_or(ButterError::MathOverflow)?
            .checked_div(vault.total_shares as u128)
            .ok_or(ButterError::MathOverflow)?;
        vault.premium_per_share_cumulative = vault.premium_per_share_cumulative
            .checked_add(premium_increment)
            .ok_or(ButterError::MathOverflow)?;
    }

    // Update protocol volume
    let protocol = &mut ctx.accounts.protocol_state;
    protocol.total_volume = protocol.total_volume
        .checked_add(total_premium)
        .ok_or(ButterError::MathOverflow)?;

    emit!(VaultPurchased {
        vault: vault_key,
        buyer: buyer_key,
        mint: mint_key,
        quantity,
        total_premium,
    });

    Ok(())
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
pub struct PurchaseFromVault<'info> {
    /// The buyer purchasing option tokens.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// The shared vault this purchase is from.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The writer's position — for tracking options_sold.
    #[account(
        mut,
        seeds = [
            WRITER_POSITION_SEED,
            shared_vault.key().as_ref(),
            vault_mint_record.writer.as_ref(),
        ],
        bump = writer_position.bump,
    )]
    pub writer_position: Box<Account<'info, WriterPosition>>,

    /// VaultMint record — holds premium_per_contract and quantity tracking.
    #[account(
        mut,
        constraint = vault_mint_record.vault == shared_vault.key(),
    )]
    pub vault_mint_record: Box<Account<'info, VaultMint>>,

    /// Protocol state — for fee_bps, volume tracking, and token transfer signing.
    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The OptionsMarket — for expiry validation.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// Option token mint (Token-2022).
    /// CHECK: Validated via vault_mint_record.option_mint.
    #[account(constraint = option_mint.key() == vault_mint_record.option_mint)]
    pub option_mint: UncheckedAccount<'info>,

    /// Purchase escrow holding unsold tokens (Token-2022 account).
    /// CHECK: Validated by PDA seeds; balance read from raw data.
    // FIX L-03: Added PDA seed validation for purchase_escrow
    #[account(
        mut,
        seeds = [
            VAULT_PURCHASE_ESCROW_SEED,
            shared_vault.key().as_ref(),
            vault_mint_record.writer.as_ref(),
            &vault_mint_record.created_at.to_le_bytes(),
        ],
        bump,
    )]
    pub purchase_escrow: UncheckedAccount<'info>,

    /// Buyer's option token account (Token-2022). Frontend creates ATA before calling.
    /// CHECK: Validated by the Token-2022 transfer instruction.
    #[account(mut)]
    pub buyer_option_account: UncheckedAccount<'info>,

    /// Buyer's USDC account — pays premium from here.
    #[account(
        mut,
        constraint = buyer_usdc_account.owner == buyer.key(),
        constraint = buyer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub buyer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Vault's USDC account — receives writer's share of premium.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Treasury — receives protocol fee.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Standard SPL Token program — for USDC transfers.
    pub token_program: Program<'info, Token>,

    /// Token-2022 program — for option token transfers.
    pub token_2022_program: Program<'info, Token2022>,

    /// Transfer hook program.
    /// CHECK: Validated against known program ID.
    #[account(constraint = transfer_hook_program.key() == butter_transfer_hook::ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList for the transfer hook.
    /// CHECK: Validated by the transfer hook program during execution.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState with expiry info for the transfer hook.
    /// CHECK: Validated by the transfer hook program during execution.
    pub hook_state: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
