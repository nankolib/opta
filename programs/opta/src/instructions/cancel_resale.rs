// =============================================================================
// instructions/cancel_resale.rs — Cancel a resale listing
// =============================================================================
//
// Only the seller who listed can cancel. Returns option tokens from
// resale escrow back to the seller's token account.
//
// Option token transfer uses Token-2022 with transfer hook.
// =============================================================================

use anchor_lang::prelude::*;

use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::ResaleCancelled;
use crate::state::*;

pub fn handle_cancel_resale(ctx: Context<CancelResale>) -> Result<()> {
    let position = &ctx.accounts.position;

    require!(position.is_listed_for_resale, OptaError::NotListedForResale);
    require!(ctx.accounts.seller.key() == position.resale_seller, OptaError::NotResaleSeller);

    // Read escrow balance from raw account data (Token-2022 layout: amount at bytes 64..72)
    let escrow_data = ctx.accounts.resale_escrow.try_borrow_data()?;
    let escrow_balance = u64::from_le_bytes(
        escrow_data[64..72].try_into().map_err(|_| OptaError::MathOverflow)?
    );
    drop(escrow_data);

    // Transfer tokens from resale escrow back to seller via Token-2022 with transfer hook.
    // Protocol PDA signs because it owns the escrow.
    if escrow_balance > 0 {
        let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
        let signer_seeds = &[&protocol_seeds[..]];

        let source_info = ctx.accounts.resale_escrow.to_account_info();
        let mint_info = ctx.accounts.option_mint.to_account_info();
        let dest_info = ctx.accounts.seller_option_account.to_account_info();

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
            escrow_balance,
            0, // decimals = 0 for option tokens
            signer_seeds,
        )?;
    }

    // Reset listing state
    let position = &mut ctx.accounts.position;
    position.is_listed_for_resale = false;
    position.resale_premium = 0;
    position.resale_token_amount = 0;
    position.resale_seller = Pubkey::default();

    emit!(ResaleCancelled {
        position: ctx.accounts.position.key(),
        seller: ctx.accounts.seller.key(),
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelResale<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut)]
    pub position: Account<'info, OptionPosition>,

    /// Resale escrow holding option tokens (Token-2022 PDA).
    /// CHECK: Validated by PDA seeds; balance read from raw account data.
    #[account(
        mut,
        seeds = [RESALE_ESCROW_SEED, position.key().as_ref()],
        bump,
    )]
    pub resale_escrow: UncheckedAccount<'info>,

    /// Seller's option token account (Token-2022, receives tokens back).
    /// CHECK: Validated by the Token-2022 transfer instruction.
    #[account(mut)]
    pub seller_option_account: UncheckedAccount<'info>,

    /// Option token mint (Token-2022 mint).
    /// CHECK: Validated via position.option_mint constraint.
    #[account(constraint = option_mint.key() == position.option_mint)]
    pub option_mint: UncheckedAccount<'info>,

    /// Token-2022 program — for option token transfers.
    pub token_2022_program: Program<'info, Token2022>,

    /// Transfer hook program.
    /// CHECK: Validated against known program ID.
    #[account(constraint = transfer_hook_program.key() == opta_transfer_hook::ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList for the transfer hook.
    /// CHECK: Validated by the transfer hook program during execution.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState with expiry info for the transfer hook.
    /// CHECK: Validated by the transfer hook program during execution.
    pub hook_state: UncheckedAccount<'info>,
}
