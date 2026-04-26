// =============================================================================
// state/vault_mint.rs — Per-mint tracking for vault-minted option tokens
// =============================================================================
//
// Each time a writer calls mint_from_vault, a VaultMint record is created
// to track that specific batch of option tokens. This stores the writer's
// asking price (premium_per_contract), how many were minted, and how many
// have been sold.
//
// The purchase_from_vault instruction reads this to validate premium.
// The burn_unsold_from_vault instruction reads this to track inventory.
//
// PDA seed: ["vault_mint_record", option_mint]
// One record per Token-2022 mint — clean 1:1 relationship.
// =============================================================================

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct VaultMint {
    /// Which SharedVault this mint belongs to.
    pub vault: Pubkey,

    /// The writer who created this mint.
    pub writer: Pubkey,

    /// The Token-2022 mint pubkey.
    pub option_mint: Pubkey,

    /// Writer's asking price per contract (USDC, 6 decimals).
    /// This is what buyers pay when purchasing from this mint.
    pub premium_per_contract: u64,

    /// How many option tokens were originally minted.
    pub quantity_minted: u64,

    /// How many option tokens have been sold to buyers.
    pub quantity_sold: u64,

    /// Timestamp when this mint was created (also used as PDA seed nonce).
    pub created_at: i64,

    /// PDA bump seed.
    pub bump: u8,
}

/// PDA seed prefix for VaultMint tracking accounts.
pub const VAULT_MINT_RECORD_SEED: &[u8] = b"vault_mint_record";

/// PDA seed prefix for vault-minted Token-2022 option mints.
pub const VAULT_OPTION_MINT_SEED: &[u8] = b"vault_option_mint";

/// PDA seed prefix for vault-minted purchase escrows.
pub const VAULT_PURCHASE_ESCROW_SEED: &[u8] = b"vault_purchase_escrow";
