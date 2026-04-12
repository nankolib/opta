// =============================================================================
// state/shared_vault.rs — Shared collateral vault for pooled liquidity
// =============================================================================
//
// A SharedVault pools USDC collateral from multiple writers for a specific
// option specification (asset + strike + expiry + type). Instead of each
// writer having their own isolated escrow, writers deposit into a shared
// pool and receive proportional shares.
//
// Two vault types:
//   - Epoch: Protocol-defined expiry (Fridays at 08:00 UTC), open to all writers
//   - Custom: Writer-defined expiry, restricted to a single writer
//
// PDA seed: ["shared_vault", market, strike_price(8), expiry(8), option_type(1)]
//
// This ensures exactly one vault per unique option specification within a market.
// =============================================================================

use anchor_lang::prelude::*;
use super::market::OptionType;

/// Whether this vault is an epoch (shared) or custom (single-writer) vault.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum VaultType {
    /// Protocol-defined expiry (fixed Fridays at 08:00 UTC).
    /// Multiple writers can deposit — this is the shared liquidity pool.
    Epoch,
    /// Writer-defined expiry, single writer only.
    /// Functions like the v1 isolated escrow but using the vault infrastructure.
    Custom,
}

#[account]
#[derive(InitSpace)]
pub struct SharedVault {
    // === Identity (what kind of option is this vault for?) ===

    /// Which OptionsMarket this vault belongs to.
    pub market: Pubkey,

    /// Call or Put — reuses the existing OptionType enum from market.rs.
    pub option_type: OptionType,

    /// Strike price in USDC (6 decimals). Example: $200.00 = 200_000_000.
    pub strike_price: u64,

    /// Unix timestamp when all options in this vault expire.
    pub expiry: i64,

    // === Vault type ===

    /// Epoch (shared, Friday expiries) or Custom (single writer, any expiry).
    pub vault_type: VaultType,

    // === Collateral tracking ===

    /// Total USDC locked across all writers in this vault (6 decimals).
    pub total_collateral: u64,

    /// Total shares issued to all writers. First depositor gets 1:1 ratio,
    /// subsequent depositors get proportional shares.
    pub total_shares: u64,

    /// The USDC token account holding this vault's collateral.
    /// Authority = this SharedVault PDA.
    pub vault_usdc_account: Pubkey,

    // === Options tracking ===

    /// Total option tokens minted from this vault across all writers.
    pub total_options_minted: u64,

    /// Total option tokens that have been purchased by buyers.
    pub total_options_sold: u64,

    /// Total premium collected in this vault (USDC, 6 decimals).
    /// Used for proportional premium distribution to writers.
    pub premium_collected: u64,

    // === Settlement ===

    /// Whether this vault has been settled after expiry.
    pub is_settled: bool,

    /// Final settlement price (0 until settled). Copied from market.
    pub settlement_price: u64,

    /// Collateral remaining after settlement payouts. Writers withdraw from this.
    pub collateral_remaining: u64,

    // === Metadata ===

    /// Who created this vault (the first depositor).
    /// For Custom vaults, this is the only allowed depositor.
    pub creator: Pubkey,

    /// When this vault was created.
    pub created_at: i64,

    /// PDA bump seed.
    pub bump: u8,
}

/// PDA seed prefix for SharedVault accounts.
pub const SHARED_VAULT_SEED: &[u8] = b"shared_vault";

/// PDA seed prefix for the vault's USDC token account.
pub const VAULT_USDC_SEED: &[u8] = b"vault_usdc";
