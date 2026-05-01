// =============================================================================
// instructions/list_v2_for_resale.rs — Seller lists V2 vault tokens for resale
// =============================================================================
//
// STEP 1 SCAFFOLDING: handler is empty. Logic lands in Step 2.
//
// Spec: V2_SECONDARY_LISTING_PLAN.md §2.1.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;

use crate::state::*;

pub fn handle_list_v2_for_resale(
    _ctx: Context<ListV2ForResale>,
    _price_per_contract: u64,
    _quantity: u64,
) -> Result<()> {
    // TODO: Step 2 — token transfer seller → resale_escrow, listing init
    Ok(())
}

#[derive(Accounts)]
pub struct ListV2ForResale<'info> {
    /// Seller — listing creator. Pays for listing PDA + escrow rent.
    #[account(mut)]
    pub seller: Signer<'info>,

    /// The vault this option mint was minted from.
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Market — pinned to the vault for sanity.
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

    /// Token-2022 mint being resold.
    /// CHECK: validated via vault_mint_record + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Seller's option ATA — source of the listing transfer.
    /// CHECK: balance + ownership validated by Token-2022 transfer.
    #[account(mut)]
    pub seller_option_account: UncheckedAccount<'info>,

    /// Listing PDA — initialized in this instruction. One per (mint, seller).
    #[account(
        init,
        seeds = [
            VAULT_RESALE_LISTING_SEED,
            option_mint.key().as_ref(),
            seller.key().as_ref(),
        ],
        bump,
        payer = seller,
        space = 8 + VaultResaleListing::INIT_SPACE,
    )]
    pub listing: Box<Account<'info, VaultResaleListing>>,

    /// Resale escrow Token-2022 account. Owned by protocol_state PDA.
    /// Created in handler via system_instruction + initialize_account3 (Step 2).
    /// CHECK: PDA seeds validate the address.
    #[account(
        mut,
        seeds = [VAULT_RESALE_ESCROW_SEED, listing.key().as_ref()],
        bump,
    )]
    pub resale_escrow: UncheckedAccount<'info>,

    /// Protocol state — escrow's owner authority.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Transfer hook program — pinned to the known opta-transfer-hook ID.
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
    pub rent: Sysvar<'info, Rent>,
}
