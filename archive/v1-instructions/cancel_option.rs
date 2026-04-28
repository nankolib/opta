// =============================================================================
// instructions/cancel_option.rs — Writer cancels option (burns tokens from escrow)
// =============================================================================
//
// Writer can cancel ONLY if ALL tokens are still in the purchase escrow
// (nobody bought them). Burns the tokens via Token-2022, returns collateral,
// closes the USDC escrow.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::OptionCancelled;
use crate::state::*;

pub fn handle_cancel_option(ctx: Context<CancelOption>) -> Result<()> {
    let position = &ctx.accounts.position;

    require!(!position.is_cancelled && !position.is_exercised && !position.is_expired, OptaError::PositionNotActive);
    require!(position.tokens_sold == 0, OptaError::TokensAlreadySold);

    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    // Read purchase escrow balance from Token-2022 account data.
    // Token account layout: bytes 64..72 = amount (u64 LE)
    let escrow_data = ctx.accounts.purchase_escrow.try_borrow_data()?;
    let purchase_escrow_balance = u64::from_le_bytes(
        escrow_data[64..72].try_into().map_err(|_| OptaError::MathOverflow)?
    );
    drop(escrow_data);

    // Burn all option tokens from purchase escrow via Token-2022.
    // Protocol PDA signs as the escrow authority.
    invoke_signed(
        &spl_token_2022::instruction::burn(
            &ctx.accounts.token_2022_program.key(),
            ctx.accounts.purchase_escrow.key,
            ctx.accounts.option_mint.key,
            &ctx.accounts.protocol_state.key(),
            &[],
            purchase_escrow_balance,
        )?,
        &[
            ctx.accounts.purchase_escrow.to_account_info(),
            ctx.accounts.option_mint.to_account_info(),
            ctx.accounts.protocol_state.to_account_info(),
        ],
        signer_seeds,
    )?;

    // Return USDC collateral to writer (standard Token program)
    let collateral_balance = ctx.accounts.escrow.amount;
    if collateral_balance > 0 {
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.writer_usdc_account.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, collateral_balance)?;
    }

    // Close USDC escrow (standard Token)
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
    position.is_cancelled = true;

    emit!(OptionCancelled { position: ctx.accounts.position.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelOption<'info> {
    #[account(mut, constraint = writer.key() == position.writer @ OptaError::NotWriter)]
    pub writer: Signer<'info>,

    #[account(seeds = [PROTOCOL_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut)]
    pub position: Box<Account<'info, OptionPosition>>,

    /// USDC collateral escrow (standard Token).
    #[account(
        mut,
        seeds = [ESCROW_SEED, position.market.as_ref(), position.writer.as_ref(), &position.created_at.to_le_bytes()],
        bump,
        token::authority = protocol_state,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,

    /// Purchase escrow holding option tokens (Token-2022).
    /// CHECK: Token-2022 burn validates mint and authority internally.
    #[account(
        mut,
        seeds = [PURCHASE_ESCROW_SEED, position.key().as_ref()],
        bump,
    )]
    pub purchase_escrow: UncheckedAccount<'info>,

    /// Option token mint (Token-2022).
    /// CHECK: Validated against position.option_mint.
    #[account(mut, constraint = option_mint.key() == position.option_mint)]
    pub option_mint: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = writer_usdc_account.owner == writer.key(),
        constraint = writer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Standard SPL Token — for USDC operations.
    pub token_program: Program<'info, Token>,

    /// Token-2022 — for burning option tokens.
    pub token_2022_program: Program<'info, Token2022>,
}
