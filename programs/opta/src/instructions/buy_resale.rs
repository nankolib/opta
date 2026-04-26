// =============================================================================
// instructions/buy_resale.rs — Buy tokens from resale listing (partial fills)
// =============================================================================
//
// Buyer specifies how many tokens to buy from the resale listing.
// Price is proportional: buyer_pays = resale_premium * amount / resale_token_amount.
// Listing stays active until all listed tokens are sold.
//
// Option token transfer uses Token-2022 with transfer hook.
// USDC transfers remain on standard SPL Token.
// =============================================================================

use anchor_lang::prelude::*;

use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::ButterError;
use crate::events::OptionResold;
use crate::state::*;
use super::initialize_protocol::TREASURY_SEED;

pub fn handle_buy_resale(ctx: Context<BuyResale>, amount: u64, max_premium: u64) -> Result<()> {
    let position = &ctx.accounts.position;

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < ctx.accounts.market.expiry_timestamp, ButterError::MarketExpired);
    require!(position.is_listed_for_resale, ButterError::NotListedForResale);
    require!(!position.is_exercised && !position.is_expired && !position.is_cancelled, ButterError::PositionNotActive);
    require!(ctx.accounts.buyer.key() != position.resale_seller, ButterError::CannotBuyOwnResale);
    require!(amount > 0, ButterError::InvalidContractSize);

    // Read resale escrow balance from raw account data (Token-2022 layout: amount at bytes 64..72)
    let escrow_data = ctx.accounts.resale_escrow.try_borrow_data()?;
    let escrow_balance = u64::from_le_bytes(
        escrow_data[64..72].try_into().map_err(|_| ButterError::MathOverflow)?
    );
    drop(escrow_data);
    require!(amount <= escrow_balance, ButterError::InsufficientOptionTokens);

    // Proportional price: resale_premium * amount / resale_token_amount
    let resale_premium = position.resale_premium;
    let resale_total = position.resale_token_amount;
    let proportional_price = resale_premium
        .checked_mul(amount).ok_or(ButterError::MathOverflow)?
        .checked_div(resale_total).ok_or(ButterError::MathOverflow)?;

    // FIX M-02: prevent dust purchases where premium rounds to zero
    require!(proportional_price > 0, ButterError::PremiumTooLow);

    // FIX M-03: slippage protection — buyer won't pay more than max_premium
    require!(proportional_price <= max_premium, ButterError::SlippageExceeded);

    let fee_bps = ctx.accounts.protocol_state.fee_bps as u64;
    let fee = proportional_price
        .checked_mul(fee_bps).ok_or(ButterError::MathOverflow)?
        .checked_div(10_000).ok_or(ButterError::MathOverflow)?;
    let seller_amount = proportional_price.checked_sub(fee).ok_or(ButterError::MathOverflow)?;

    // Transfer USDC: buyer -> seller (standard SPL Token)
    if seller_amount > 0 {
        let transfer_to_seller = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_usdc_account.to_account_info(),
                to: ctx.accounts.seller_usdc_account.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        );
        token::transfer(transfer_to_seller, seller_amount)?;
    }

    // Transfer fee: buyer -> treasury (standard SPL Token)
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

    // Transfer option tokens: resale escrow -> buyer via Token-2022 with transfer hook.
    // Protocol PDA signs because it owns the escrow.
    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    let source_info = ctx.accounts.resale_escrow.to_account_info();
    let mint_info = ctx.accounts.option_mint.to_account_info();
    let dest_info = ctx.accounts.buyer_option_account.to_account_info();

    // Use invoke_transfer_checked which properly handles transfer hook accounts.
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

    // Check if all listed tokens are now sold by re-reading escrow balance from raw data
    let escrow_data = ctx.accounts.resale_escrow.try_borrow_data()?;
    let remaining = u64::from_le_bytes(
        escrow_data[64..72].try_into().map_err(|_| ButterError::MathOverflow)?
    );
    drop(escrow_data);

    // Update position: decrement resale tracking
    let position = &mut ctx.accounts.position;

    if remaining == 0 {
        // All resale tokens sold — clear listing state
        position.is_listed_for_resale = false;
        position.resale_premium = 0;
        position.resale_token_amount = 0;
        position.resale_seller = Pubkey::default();
    } else {
        // Reduce the listed amount and proportionally reduce the remaining premium
        let sold_fraction_premium = resale_premium
            .checked_mul(amount).ok_or(ButterError::MathOverflow)?
            .checked_div(resale_total).ok_or(ButterError::MathOverflow)?;
        position.resale_premium = position.resale_premium
            .checked_sub(sold_fraction_premium).ok_or(ButterError::MathOverflow)?;
        position.resale_token_amount = position.resale_token_amount
            .checked_sub(amount).ok_or(ButterError::MathOverflow)?;
    }

    // Update protocol volume
    let protocol = &mut ctx.accounts.protocol_state;
    protocol.total_volume = protocol.total_volume
        .checked_add(proportional_price).ok_or(ButterError::MathOverflow)?;

    emit!(OptionResold {
        position: ctx.accounts.position.key(),
        seller: ctx.accounts.seller_usdc_account.owner,
        buyer: ctx.accounts.buyer.key(),
        resale_premium: proportional_price,
        fee,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct BuyResale<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The market this position belongs to — used to check expiry.
    #[account(constraint = market.key() == position.market)]
    pub market: Account<'info, OptionsMarket>,

    #[account(mut)]
    pub position: Box<Account<'info, OptionPosition>>,

    /// Resale escrow holding option tokens (Token-2022 PDA).
    /// CHECK: Validated by PDA seeds; balance read from raw account data.
    #[account(
        mut,
        seeds = [RESALE_ESCROW_SEED, position.key().as_ref()],
        bump,
    )]
    pub resale_escrow: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = buyer_usdc_account.owner == buyer.key(),
        constraint = buyer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub buyer_usdc_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = seller_usdc_account.owner == position.resale_seller,
        constraint = seller_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub seller_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Buyer's option token account (Token-2022). Frontend creates ATA before calling.
    /// CHECK: Validated by the Token-2022 transfer instruction.
    #[account(mut)]
    pub buyer_option_account: UncheckedAccount<'info>,

    /// Option token mint (Token-2022 mint).
    /// CHECK: Validated via position.option_mint constraint.
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
