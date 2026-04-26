// =============================================================================
// state/protocol.rs — Global protocol configuration (singleton)
// =============================================================================
//
// ProtocolState is a single account that stores global settings for the entire
// Butter Options protocol. It is created once during `initialize_protocol` and
// never recreated.
//
// PDA seed: ["protocol"]
// =============================================================================

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ProtocolState {
    /// The admin wallet that can update protocol settings.
    /// Set to the signer of the `initialize_protocol` transaction.
    pub admin: Pubkey,

    /// Fee charged on option purchases, in basis points (1 bps = 0.01%).
    /// Default: 50 bps = 0.50%.
    /// Example: on a 100 USDC premium, the fee is 0.50 USDC.
    pub fee_bps: u16,

    /// The treasury token account (PDA) that collects protocol fees in USDC.
    pub treasury: Pubkey,

    /// The USDC mint address. Stored so all instructions can validate that
    /// token accounts are denominated in USDC.
    pub usdc_mint: Pubkey,

    /// Running count of all markets created. Used for stats/tracking.
    pub total_markets: u64,

    /// Running total of all USDC volume (premiums + settlements) flowing
    /// through the protocol. Scaled by 10^6 (USDC decimals).
    pub total_volume: u64,

    /// PDA bump seed, stored so we don't have to recalculate it.
    pub bump: u8,
}

/// Seeds used to derive the ProtocolState PDA.
/// There is exactly one ProtocolState per program deployment.
/// Version 2 seed — changed from "protocol" to "protocol_v2" to avoid
/// collision with the old ProtocolState account that has a different layout.
pub const PROTOCOL_SEED: &[u8] = b"protocol_v2";
