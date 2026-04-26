// =============================================================================
// instructions/exercise_option.rs — Token holder exercises the option
// =============================================================================
//
// Anyone who holds option tokens can call this after settlement.
// Burns the caller's option tokens and distributes PnL proportionally.
//
// PnL calculation:
//   CALL: pnl = max(0, (settlement - strike)) * tokens_burned
//   PUT:  pnl = max(0, (strike - settlement)) * tokens_burned
//
// Token-2022 note: Burns use the Token-2022 program. Burns do NOT trigger
// the transfer hook. The exerciser signs to burn their own tokens.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::ButterError;
use crate::events::OptionExercised;
use crate::state::*;

pub fn handle_exercise_option(ctx: Context<ExerciseOption>, tokens_to_exercise: u64) -> Result<()> {
    let market = &ctx.accounts.market;
    let position = &ctx.accounts.position;
    let clock = Clock::get()?;

    // Validation
    require!(clock.unix_timestamp >= market.expiry_timestamp, ButterError::MarketNotExpired);
    require!(market.is_settled, ButterError::MarketNotSettled);
    require!(!position.is_exercised && !position.is_expired && !position.is_cancelled, ButterError::PositionNotActive);

    // Exerciser must hold enough tokens — read balance from Token-2022 account data.
    // Token account layout: bytes 64..72 = amount (u64 LE)
    let exerciser_acct_data = ctx.accounts.exerciser_option_account.try_borrow_data()?;
    let exerciser_balance = u64::from_le_bytes(
        exerciser_acct_data[64..72].try_into().map_err(|_| ButterError::MathOverflow)?
    );
    drop(exerciser_acct_data);
    require!(tokens_to_exercise > 0 && tokens_to_exercise <= exerciser_balance, ButterError::InsufficientOptionTokens);

    // Calculate proportional PnL
    let settlement_price = market.settlement_price;
    let strike_price = market.strike_price;
    let total_supply = position.total_supply;
    let collateral = position.collateral_amount;

    let raw_pnl = match market.option_type {
        OptionType::Call => {
            if settlement_price > strike_price {
                settlement_price.checked_sub(strike_price).ok_or(ButterError::MathOverflow)?
                    .checked_mul(tokens_to_exercise).ok_or(ButterError::MathOverflow)?
            } else { 0 }
        }
        OptionType::Put => {
            if strike_price > settlement_price {
                strike_price.checked_sub(settlement_price).ok_or(ButterError::MathOverflow)?
                    .checked_mul(tokens_to_exercise).ok_or(ButterError::MathOverflow)?
            } else { 0 }
        }
    };

    let proportional_collateral = collateral
        .checked_mul(tokens_to_exercise).ok_or(ButterError::MathOverflow)?
        .checked_div(total_supply).ok_or(ButterError::MathOverflow)?;

    let pnl = std::cmp::min(raw_pnl, proportional_collateral);
    let profitable = pnl > 0;
    let writer_receives = proportional_collateral.checked_sub(pnl).ok_or(ButterError::MathOverflow)?;

    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    // Burn option tokens via Token-2022. Exerciser signs for their own tokens.
    invoke(
        &spl_token_2022::instruction::burn(
            &ctx.accounts.token_2022_program.key(),
            ctx.accounts.exerciser_option_account.key,
            ctx.accounts.option_mint.key,
            ctx.accounts.exerciser.key,
            &[],
            tokens_to_exercise,
        )?,
        &[
            ctx.accounts.exerciser_option_account.to_account_info(),
            ctx.accounts.option_mint.to_account_info(),
            ctx.accounts.exerciser.to_account_info(),
        ],
    )?;

    // Transfer PnL to exerciser (USDC, standard Token)
    if pnl > 0 {
        let transfer_pnl = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.exerciser_usdc_account.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_pnl, pnl)?;
    }

    // Transfer remaining collateral to writer (USDC, standard Token)
    if writer_receives > 0 {
        let transfer_writer = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.writer_usdc_account.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_writer, writer_receives)?;
    }

    // If escrow is empty, close it and return rent to writer
    ctx.accounts.escrow.reload()?;
    if ctx.accounts.escrow.amount == 0 {
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
        position.is_exercised = true;
    }

    let protocol = &mut ctx.accounts.protocol_state;
    protocol.total_volume = protocol.total_volume
        .checked_add(pnl).ok_or(ButterError::MathOverflow)?;

    emit!(OptionExercised {
        position: ctx.accounts.position.key(),
        exerciser: ctx.accounts.exerciser.key(),
        settlement_price,
        pnl,
        tokens_burned: tokens_to_exercise,
        profitable,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExerciseOption<'info> {
    #[account(mut)]
    pub exerciser: Signer<'info>,

    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
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

    /// Option token mint (Token-2022).
    /// CHECK: Validated against position.option_mint.
    #[account(mut, constraint = option_mint.key() == position.option_mint)]
    pub option_mint: UncheckedAccount<'info>,

    /// Exerciser's option token account (Token-2022).
    /// CHECK: Token-2022 burn instruction validates mint and owner internally.
    #[account(mut)]
    pub exerciser_option_account: UncheckedAccount<'info>,

    /// Exerciser's USDC account (receives PnL).
    #[account(
        mut,
        constraint = exerciser_usdc_account.owner == exerciser.key(),
        constraint = exerciser_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub exerciser_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Writer's USDC account (receives remaining collateral).
    #[account(
        mut,
        constraint = writer_usdc_account.owner == position.writer,
        constraint = writer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Writer's SOL account (receives escrow rent if closed).
    #[account(mut, constraint = writer.key() == position.writer @ ButterError::NotWriter)]
    pub writer: UncheckedAccount<'info>,

    /// Standard SPL Token — for USDC operations.
    pub token_program: Program<'info, Token>,

    /// Token-2022 — for burning option tokens.
    pub token_2022_program: Program<'info, Token2022>,
}
