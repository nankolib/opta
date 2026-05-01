// =============================================================================
// instructions/cancel_v2_resale.rs — Seller cancels their own listing
// =============================================================================
//
// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §2.3.
//
// Flow:
//   1. Read escrow balance (raw bytes 64..72 — Token-2022 ATA layout).
//   2. If balance > 0, transfer escrow tokens → seller's regular ATA via
//      Token-2022 invoke_transfer_checked, signed by protocol_state PDA.
//      Hook permits this even post-expiry because source is protocol-owned
//      (opta-transfer-hook/src/lib.rs:286-291). This is the load-bearing
//      structural fact — no `is_settled` check needed (plan §4.4).
//   3. Close the resale escrow Token-2022 account; rent → seller.
//      Mirrors burn_unsold_from_vault.rs:74-88.
//   4. Emit VaultListingCancelled with returned_quantity.
//   5. Listing PDA closes via Anchor `close = seller` constraint.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::VaultListingCancelled;
use crate::state::*;

pub fn handle_cancel_v2_resale(ctx: Context<CancelV2Resale>) -> Result<()> {
    let token_2022_key = ctx.accounts.token_2022_program.key();
    let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

    // ---- 1. Read escrow balance --------------------------------------------
    let escrow_balance: u64 = {
        let data = ctx.accounts.resale_escrow.try_borrow_data()?;
        require!(data.len() >= 72, OptaError::MathOverflow);
        let amount_bytes: [u8; 8] = data[64..72]
            .try_into()
            .map_err(|_| OptaError::MathOverflow)?;
        u64::from_le_bytes(amount_bytes)
    };

    // ---- 2. Return tokens to seller (protocol PDA signs) -------------------
    // Hook permits this post-expiry because source is protocol_state-owned
    // (opta-transfer-hook/src/lib.rs:286-291). No is_settled check needed —
    // see plan §4.4.
    if escrow_balance > 0 {
        spl_token_2022::onchain::invoke_transfer_checked(
            &token_2022_key,
            ctx.accounts.resale_escrow.to_account_info(),
            ctx.accounts.option_mint.to_account_info(),
            ctx.accounts.seller_option_account.to_account_info(),
            ctx.accounts.protocol_state.to_account_info(),
            &[
                ctx.accounts.extra_account_meta_list.to_account_info(),
                ctx.accounts.transfer_hook_program.to_account_info(),
                ctx.accounts.hook_state.to_account_info(),
            ],
            escrow_balance,
            0, // decimals = 0 for option tokens
            protocol_signer,
        )?;
    }

    // ---- 3. Close the resale escrow (rent → seller) ------------------------
    // Mirrors burn_unsold_from_vault.rs:74-88. Protocol PDA signs as owner.
    invoke_signed(
        &spl_token_2022::instruction::close_account(
            &token_2022_key,
            ctx.accounts.resale_escrow.key,
            ctx.accounts.seller.key,
            &ctx.accounts.protocol_state.key(),
            &[],
        )?,
        &[
            ctx.accounts.resale_escrow.to_account_info(),
            ctx.accounts.seller.to_account_info(),
            ctx.accounts.protocol_state.to_account_info(),
        ],
        protocol_signer,
    )?;

    // ---- 4. Emit event ----------------------------------------------------
    emit!(VaultListingCancelled {
        listing: ctx.accounts.listing.key(),
        mint: ctx.accounts.option_mint.key(),
        seller: ctx.accounts.seller.key(),
        returned_quantity: escrow_balance,
    });

    // ---- 5. Listing PDA closes via Anchor `close = seller` constraint -----
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

    /// Listing being cancelled. Closed at instruction end; rent → seller.
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
        close = seller,
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
