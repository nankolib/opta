// =============================================================================
// instructions/expire_option.rs — Expire an unexercised option after expiry
// =============================================================================
//
// After expiry, if option tokens haven't been exercised, the writer (or anyone)
// can call this to return collateral from escrow to the writer.
// The option tokens become worthless (they represent a claim on nothing).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::errors::ButterError;
use crate::events::OptionExpired;
use crate::state::*;

pub fn handle_expire_option(ctx: Context<ExpireOption>) -> Result<()> {
    let market = &ctx.accounts.market;
    let position = &ctx.accounts.position;
    let clock = Clock::get()?;

    require!(clock.unix_timestamp >= market.expiry_timestamp, ButterError::MarketNotExpired);
    require!(!position.is_exercised && !position.is_expired && !position.is_cancelled, ButterError::PositionNotActive);

    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    // Transfer all collateral from escrow to writer
    let escrow_balance = ctx.accounts.escrow.amount;
    if escrow_balance > 0 {
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.writer_usdc_account.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, escrow_balance)?;
    }

    // Close escrow — rent to writer
    let close_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.writer.to_account_info(),
            authority: ctx.accounts.protocol_state.to_account_info(),
        },
        signer_seeds,
    );
    token::close_account(close_ctx)?;

    let position = &mut ctx.accounts.position;
    position.is_expired = true;

    emit!(OptionExpired { position: ctx.accounts.position.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct ExpireOption<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [PROTOCOL_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    pub market: Account<'info, OptionsMarket>,

    #[account(mut, constraint = position.market == market.key())]
    pub position: Box<Account<'info, OptionPosition>>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, position.market.as_ref(), position.writer.as_ref(), &position.created_at.to_le_bytes()],
        bump,
        token::authority = protocol_state,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = writer_usdc_account.owner == position.writer,
        constraint = writer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Writer's SOL account for rent.
    #[account(mut, constraint = writer.key() == position.writer @ ButterError::NotWriter)]
    pub writer: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}
