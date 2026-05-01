// =============================================================================
// instructions/buy_v2_resale.rs — Buyer fills (partially or fully) a listing
// =============================================================================
//
// STEP 1 SCAFFOLDING: handler is empty. Logic lands in Step 2.
//
// Spec: V2_SECONDARY_LISTING_PLAN.md §2.2.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use anchor_spl::token_2022::Token2022;

use crate::state::*;
use super::initialize_protocol::TREASURY_SEED;

pub fn handle_buy_v2_resale(
    _ctx: Context<BuyV2Resale>,
    _quantity: u64,
    _max_total_price: u64,
) -> Result<()> {
    // TODO: Step 2 — USDC + option-token transfers, listing decrement,
    //                conditional auto-close on full fill
    Ok(())
}

#[derive(Accounts)]
pub struct BuyV2Resale<'info> {
    /// Buyer — pays USDC, receives option tokens.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// Vault — read for collateral_mint constraints + is_settled / expiry guards.
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

    // TODO: Step 2 — add `close = seller` constraint (manual lamport drain
    // gated on listed_quantity hitting zero in the handler body).
    /// Listing being filled. Mut for listed_quantity decrement; close path
    /// (when listed_quantity hits zero) is manual in handler — see Step 2.
    #[account(
        mut,
        seeds = [
            VAULT_RESALE_LISTING_SEED,
            option_mint.key().as_ref(),
            listing.seller.as_ref(),
        ],
        bump = listing.bump,
    )]
    pub listing: Box<Account<'info, VaultResaleListing>>,

    /// Seller wallet — rent destination on full-fill close. Constraint pins
    /// it to listing.seller so a third-party caller can't redirect rent.
    /// CHECK: pubkey-pinned to listing.seller.
    #[account(mut, constraint = seller.key() == listing.seller)]
    pub seller: UncheckedAccount<'info>,

    /// Token-2022 mint.
    /// CHECK: validated via vault_mint_record + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Resale escrow — source of the option-token transfer.
    /// CHECK: PDA seeds validate the address.
    #[account(
        mut,
        seeds = [VAULT_RESALE_ESCROW_SEED, listing.key().as_ref()],
        bump,
    )]
    pub resale_escrow: UncheckedAccount<'info>,

    /// Buyer's option ATA — destination. Frontend pre-creates idempotently.
    /// CHECK: validated by Token-2022 transfer.
    #[account(mut)]
    pub buyer_option_account: UncheckedAccount<'info>,

    /// Buyer's USDC ATA.
    #[account(
        mut,
        constraint = buyer_usdc_account.owner == buyer.key(),
        constraint = buyer_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub buyer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Seller's USDC ATA — receives seller-share. Must exist (Open Q #6 locked).
    #[account(
        mut,
        constraint = seller_usdc_account.owner == listing.seller,
        constraint = seller_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub seller_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Treasury — receives protocol fee.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Protocol state — fee_bps + total_volume + escrow signer authority.
    #[account(
        mut,
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

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
