// =============================================================================
// instructions/cancel_v2_resale.rs — Seller cancels their own listing
// =============================================================================
//
// STEP 1 SCAFFOLDING: handler is empty. Logic lands in Step 2.
//
// Spec: V2_SECONDARY_LISTING_PLAN.md §2.3.
//
// Note: plan calls for `close = seller` on the listing PDA. Step 1 leaves
// listing as plain `mut` and defers the close attribute to Step 2 per the
// "no Anchor close=" Step-1 constraint.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;

use crate::state::*;

pub fn handle_cancel_v2_resale(_ctx: Context<CancelV2Resale>) -> Result<()> {
    // TODO: Step 2 — return escrow tokens to seller, close escrow, close listing
    Ok(())
}

#[derive(Accounts)]
pub struct CancelV2Resale<'info> {
    /// Seller — only the listing's seller can cancel.
    #[account(mut)]
    pub seller: Signer<'info>,

    /// Vault — read for context (no mutation here).
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Token-2022 mint.
    /// CHECK: pinned by listing PDA seeds.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    // TODO: Step 2 — add `close = seller` constraint so Anchor refunds the
    // listing PDA's rent to the seller and zeros the account at the end of
    // the instruction.
    /// Listing being cancelled. Mut; close attribute deferred to Step 2.
    #[account(
        mut,
        seeds = [
            VAULT_RESALE_LISTING_SEED,
            option_mint.key().as_ref(),
            seller.key().as_ref(),
        ],
        bump = listing.bump,
        constraint = listing.seller == seller.key()
            @ crate::errors::OptaError::NotResaleSeller,
    )]
    pub listing: Box<Account<'info, VaultResaleListing>>,

    /// Resale escrow — source of the token-return transfer.
    /// CHECK: PDA seeds validate the address.
    #[account(
        mut,
        seeds = [VAULT_RESALE_ESCROW_SEED, listing.key().as_ref()],
        bump,
    )]
    pub resale_escrow: UncheckedAccount<'info>,

    /// Seller's option ATA — destination of the returned tokens.
    /// CHECK: validated by Token-2022 transfer.
    #[account(mut)]
    pub seller_option_account: UncheckedAccount<'info>,

    /// Protocol state — signs the escrow-source transfer.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Transfer hook program.
    /// CHECK: ID-constrained.
    #[account(constraint = transfer_hook_program.key() == opta_transfer_hook::ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList for the transfer hook.
    /// CHECK: validated by Token-2022 hook dispatch.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState for the transfer hook.
    /// CHECK: validated by Token-2022 hook dispatch.
    pub hook_state: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
