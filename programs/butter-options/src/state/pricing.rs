// =============================================================================
// state/pricing.rs — On-chain pricing data for option positions
// =============================================================================
//
// Stores the latest fair value computed by a crank bot. This makes the
// Living Option Token fully self-describing: financial terms AND current
// price, all readable on-chain by wallets, AI agents, and DEXes.
//
// The crank bot runs off-chain, computes fair value using Black-Scholes
// with EWMA vol and smile, then writes the result here every ~60 seconds.
//
// PDA seed: ["pricing", position_pubkey]
// =============================================================================

use anchor_lang::prelude::*;

/// On-chain pricing data for an option position.
/// Updated periodically by a crank bot with the latest fair value.
///
/// WHY THIS EXISTS:
/// Without this, anyone holding a Butter option token has to call our
/// SDK to know what it's worth. With this, the fair value is right there
/// on the blockchain. Wallets can display it. AI agents can read it.
/// DEXes can use it for order matching. The token becomes self-pricing.
#[account]
#[derive(InitSpace)]
pub struct PricingData {
    /// The option position this pricing data belongs to.
    pub position: Pubkey,

    /// Last computed fair value per token, in USDC smallest units (6 decimals).
    /// Example: 11_160_000 = $11.16 per token.
    pub fair_value_per_token: u64,

    /// The spot price used in the calculation, in USDC smallest units.
    /// Example: 180_000_000 = $180.00.
    pub spot_price_used: u64,

    /// The implied volatility used (basis points, e.g. 8500 = 85.00%).
    /// Stored for transparency — anyone can verify the crank's math.
    pub implied_vol_bps: u64,

    /// Unix timestamp of when this pricing was last updated.
    pub last_updated: i64,

    /// The authority (crank bot wallet) that can update this data.
    /// Set once during initialization and never changed.
    pub update_authority: Pubkey,

    /// PDA bump seed.
    pub bump: u8,
}

/// PDA seed prefix for pricing accounts.
pub const PRICING_SEED: &[u8] = b"pricing";
