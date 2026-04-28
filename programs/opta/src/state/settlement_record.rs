// =============================================================================
// state/settlement_record.rs — Per-(asset, expiry) settlement price record
// =============================================================================
//
// Introduced in Stage 3. Replaces the old per-market settlement state
// (settle_market wrote `is_settled` + `settlement_price` directly onto the
// OptionsMarket account, which in Stage 2 became asset-only).
//
// One SettlementRecord PDA is created by the admin-only `settle_expiry`
// instruction once an asset's expiry boundary has passed. It records the
// canonical settlement price for that (asset, expiry) tuple. Every
// SharedVault for that (asset, expiry) reads from this single record
// during `settle_vault`, so all vaults agree on the same price.
//
// PDA seed: ["settlement", asset_name(bytes), expiry(8 LE)]
// =============================================================================

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct SettlementRecord {
    /// Asset this settlement is for. Matches OptionsMarket.asset_name
    /// (already normalized to ASCII uppercase + alphanumeric by the
    /// market PDA derivation).
    #[max_len(16)]
    pub asset_name: String,

    /// Unix timestamp of the expiry boundary this settlement records.
    pub expiry: i64,

    /// Canonical settlement price for this (asset, expiry), scaled by 1e6
    /// (USDC decimals). Today this is admin-supplied (Pyth-mocked); in
    /// production it would be read from a Pyth pull-oracle account.
    pub settlement_price: u64,

    /// On-chain timestamp at which `settle_expiry` was called. Useful for
    /// audit trails and "settle was X seconds late" diagnostics.
    pub settled_at: i64,

    /// PDA bump seed.
    pub bump: u8,
}

/// PDA seed prefix for SettlementRecord accounts.
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
