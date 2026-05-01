// =============================================================================
// instructions/auto_cancel_listings.rs — Permissionless listing cleanup
// =============================================================================
//
// STEP 1 SCAFFOLDING: handler is empty. Logic lands in Step 2.
//
// Spec: V2_SECONDARY_LISTING_PLAN.md §4.2 (Design A) + §5.1.
//
// Per-(vault, mint) — same shape as auto_finalize_holders. Crank groups
// listings by mint and processes one mint per call.
//
// remaining_accounts: 4-tuples of
//   (listing, resale_escrow, seller_option_account, seller_wallet)
// per listing in the batch.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;

use crate::state::*;

pub fn handle_auto_cancel_listings<'info>(
    _ctx: Context<'_, '_, '_, 'info, AutoCancelListings<'info>>,
) -> Result<()> {
    // TODO: Step 2 — walk remaining_accounts in 4-tuples; for each:
    //   - return escrow tokens → seller_option_account
    //   - close escrow (rent → seller_wallet)
    //   - close listing (manual lamport drain → seller_wallet)
    Ok(())
}

#[derive(Accounts)]
pub struct AutoCancelListings<'info> {
    /// Permissionless caller — pays the tx fee.
    pub caller: Signer<'info>,

    /// Vault these listings belong to. Read-only.
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Market — pinned to the vault.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// VaultMint record — pins option_mint to this vault.
    #[account(
        constraint = vault_mint_record.vault == shared_vault.key()
            @ crate::errors::OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == option_mint.key()
            @ crate::errors::OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Account<'info, VaultMint>,

    /// The single Token-2022 mint shared by every listing in this batch.
    /// CHECK: validated via vault_mint_record + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Protocol state — signs the escrow-source token-return transfers.
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
    // remaining_accounts: 4-tuples per listing —
    //   (listing, resale_escrow, seller_option_account, seller_wallet)
}
