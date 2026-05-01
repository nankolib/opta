// =============================================================================
// state/vault_resale_listing.rs — Per-(mint, seller) secondary-market listing
// =============================================================================
//
// V2 secondary listing record. One PDA per (option_mint, seller) pair —
// single-listing-per-pair design (locked per V2_SECONDARY_LISTING_PLAN.md
// Open Question #2).
//
// PDA seed: ["vault_resale_listing", option_mint, seller]
//
// The accompanying Token-2022 escrow PDA (owned by protocol_state) is keyed
// by the listing PDA itself: ["vault_resale_escrow", listing].
//
// Created by `list_v2_for_resale`. Decremented by `buy_v2_resale`. Closed
// by `cancel_v2_resale`, by `buy_v2_resale` on full fill, or by
// `auto_cancel_listings` at expiry (Design A, plan §4.2).
// =============================================================================

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct VaultResaleListing {
    /// Wallet that created the listing. Receives sale proceeds + rent on close.
    pub seller: Pubkey,
    /// Which SharedVault this option mint was minted from. Stored for
    /// reverse lookup + crank enumeration efficiency.
    pub vault: Pubkey,
    /// The Token-2022 mint being resold.
    pub option_mint: Pubkey,
    /// Tokens currently sitting in the resale_escrow PDA. Decremented on
    /// each partial fill; listing auto-closes when this hits zero.
    pub listed_quantity: u64,
    /// USDC per contract (6 decimals), set at listing time, immutable.
    pub price_per_contract: u64,
    /// Unix timestamp when listing was created.
    pub created_at: i64,
    /// PDA bump seed.
    pub bump: u8,
}

/// Seed prefix for VaultResaleListing PDAs: ["vault_resale_listing", mint, seller].
pub const VAULT_RESALE_LISTING_SEED: &[u8] = b"vault_resale_listing";

/// Seed prefix for the per-listing Token-2022 escrow PDA, owned by protocol_state:
/// ["vault_resale_escrow", listing].
pub const VAULT_RESALE_ESCROW_SEED: &[u8] = b"vault_resale_escrow";
