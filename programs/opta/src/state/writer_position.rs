// =============================================================================
// state/writer_position.rs — Writer's receipt for a SharedVault deposit
// =============================================================================
//
// Each writer who deposits into a SharedVault gets a WriterPosition that
// tracks their share of the pool. This is their "receipt" — it records
// how much they deposited, how many shares they hold, and how much
// premium they've already claimed.
//
// A writer can have at most one WriterPosition per vault (enforced by PDA).
// Multiple deposits into the same vault accumulate on the same position.
//
// PDA seed: ["writer_position", vault, owner]
// =============================================================================

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct WriterPosition {
    /// The writer's wallet address.
    pub owner: Pubkey,

    /// Which SharedVault this position belongs to.
    pub vault: Pubkey,

    /// Writer's proportional share of the vault.
    /// Used to calculate their cut of premium and remaining collateral.
    pub shares: u64,

    /// Total USDC this writer has deposited into the vault.
    /// Tracked for reference — the authoritative value is shares.
    pub deposited_collateral: u64,

    /// How much premium this writer has already claimed.
    /// Prevents double-claiming.
    pub premium_claimed: u64,

    /// FIX H-01: Snapshot of premium_per_share_cumulative at deposit time.
    /// Used in reward-per-share accumulator to prevent late-depositor dilution.
    pub premium_debt: u128,

    /// Total option tokens this writer has minted from their vault share.
    /// Used to calculate committed collateral (can't withdraw what's backing active options).
    pub options_minted: u64,

    /// How many of this writer's minted tokens have been sold to buyers.
    pub options_sold: u64,

    /// When this position was first created.
    pub deposited_at: i64,

    /// PDA bump seed.
    pub bump: u8,
}

/// PDA seed prefix for WriterPosition accounts.
pub const WRITER_POSITION_SEED: &[u8] = b"writer_position";
