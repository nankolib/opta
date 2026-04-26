// =============================================================================
// instructions/purchase_option.rs — Buy option tokens with partial fills
// =============================================================================
//
// Buyer specifies how many tokens to buy. Premium is proportional:
//   buyer_pays = position.premium * amount / position.total_supply
//
// Position stays active for more purchases until all tokens are sold.
//
// Option token transfer uses Token-2022 with transfer hook.
// USDC transfers remain on standard SPL Token.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::ButterError;
use crate::events::OptionPurchased;
use crate::state::*;
use super::initialize_protocol::TREASURY_SEED;

pub fn handle_purchase_option(ctx: Context<PurchaseOption>, amount: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    let position = &ctx.accounts.position;
    let clock = Clock::get()?;

    // Validation
    require!(clock.unix_timestamp < market.expiry_timestamp, ButterError::MarketExpired);
    require!(!position.is_exercised && !position.is_expired && !position.is_cancelled, ButterError::PositionNotActive);
    require!(ctx.accounts.buyer.key() != position.writer, ButterError::CannotBuyOwnOption);
    require!(amount > 0, ButterError::InvalidContractSize);

    // Read purchase_escrow balance from raw account data (Token-2022 account layout: amount at bytes 64..72)
    let escrow_data = ctx.accounts.purchase_escrow.try_borrow_data()?;
    let available = u64::from_le_bytes(
        escrow_data[64..72].try_into().map_err(|_| ButterError::MathOverflow)?
    );
    drop(escrow_data);
    require!(amount <= available, ButterError::InsufficientOptionTokens);

    // Proportional premium: buyer pays (premium * amount / total_supply)
    let total_premium = position.premium;
    let total_supply = position.total_supply;
    let proportional_premium = total_premium
        .checked_mul(amount).ok_or(ButterError::MathOverflow)?
        .checked_div(total_supply).ok_or(ButterError::MathOverflow)?;

    // Reject if rounding truncated the premium to zero (dust purchase exploit)
    require!(proportional_premium > 0, ButterError::PremiumTooLow);

    // Fee calculation
    let fee_bps = ctx.accounts.protocol_state.fee_bps as u64;
    let fee = proportional_premium
        .checked_mul(fee_bps).ok_or(ButterError::MathOverflow)?
        .checked_div(10_000).ok_or(ButterError::MathOverflow)?;
    let writer_amount = proportional_premium.checked_sub(fee).ok_or(ButterError::MathOverflow)?;

    // Transfer premium minus fee: buyer -> writer (standard SPL Token / USDC)
    if writer_amount > 0 {
        let transfer_to_writer = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_usdc_account.to_account_info(),
                to: ctx.accounts.writer_usdc_account.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        );
        token::transfer(transfer_to_writer, writer_amount)?;
    }

    // Transfer fee: buyer -> treasury (standard SPL Token / USDC)
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

    // Transfer option tokens: purchase escrow -> buyer via Token-2022 with transfer hook.
    // Protocol PDA signs because it owns the escrow.
    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    let source_info = ctx.accounts.purchase_escrow.to_account_info();
    let mint_info = ctx.accounts.option_mint.to_account_info();
    let dest_info = ctx.accounts.buyer_option_account.to_account_info();

    // Use invoke_transfer_checked which properly handles transfer hook accounts.
    // It reads the ExtraAccountMetaList to add the right accounts to the CPI.
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
        amount,
        0, // decimals = 0 for option tokens
        signer_seeds,
    )?;

    // Update position: track how many tokens have been sold
    let position = &mut ctx.accounts.position;
    position.tokens_sold = position.tokens_sold
        .checked_add(amount).ok_or(ButterError::MathOverflow)?;

    // Update protocol volume
    let protocol = &mut ctx.accounts.protocol_state;
    protocol.total_volume = protocol.total_volume
        .checked_add(proportional_premium).ok_or(ButterError::MathOverflow)?;

    emit!(OptionPurchased {
        market: market.key(),
        position: ctx.accounts.position.key(),
        buyer: ctx.accounts.buyer.key(),
        premium: proportional_premium,
        fee,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct PurchaseOption<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    pub market: Account<'info, OptionsMarket>,

    #[account(mut, constraint = position.market == market.key())]
    pub position: Box<Account<'info, OptionPosition>>,

    /// Purchase escrow holding option tokens (Token-2022 account).
    /// CHECK: Validated by PDA seeds; balance read from raw account data.
    #[account(
        mut,
        seeds = [PURCHASE_ESCROW_SEED, position.key().as_ref()],
        bump,
    )]
    pub purchase_escrow: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = buyer_usdc_account.owner == buyer.key(),
        constraint = buyer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub buyer_usdc_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = writer_usdc_account.owner == position.writer,
        constraint = writer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Buyer's option token account (Token-2022). Frontend creates ATA before calling.
    /// CHECK: Validated by the Token-2022 transfer instruction.
    #[account(mut)]
    pub buyer_option_account: UncheckedAccount<'info>,

    /// Option token mint (Token-2022 mint).
    /// CHECK: Validated via position.option_mint constraint in handler.
    #[account(constraint = option_mint.key() == position.option_mint)]
    pub option_mint: UncheckedAccount<'info>,

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
    pub rent: Sysvar<'info, Rent>,
}
