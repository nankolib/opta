// =============================================================================
// state/pricing.rs — On-chain pricing data for option positions
// =============================================================================
//
// Stores the latest fair value computed ON-CHAIN via solmath's Black-Scholes.
// The Living Option Token becomes fully self-describing: financial terms,
// current price, AND Greeks — all readable on-chain by wallets, AI agents,
// and DEXes.
//
// Anyone can call update_pricing (permissionless). The contract computes
// the price deterministically from the caller-provided spot and vol inputs.
//
// PDA seed: ["pricing", position_pubkey]
// =============================================================================

use anchor_lang::prelude::*;

/// On-chain pricing data for an option position.
/// Computed on-chain via solmath's bs_full_hp() Black-Scholes engine.
///
/// WHY THIS EXISTS:
/// Without this, anyone holding a Butter option token has to call our
/// SDK to know what it's worth. With this, the fair value is right there
/// on the blockchain — computed deterministically by the smart contract.
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
    pub implied_vol_bps: u64,

    /// Delta (basis points, e.g. 5000 = 0.50 delta).
    /// Positive for calls, negative for puts.
    pub delta_bps: i64,

    /// Gamma (basis points × 100 for precision).
    pub gamma_bps: i64,

    /// Vega in micro-USDC (1 unit = 0.000001 USDC) per unit vol move.
    /// Stored at higher precision to avoid truncation to zero for small options.
    pub vega_usdc: i64,

    /// Theta: daily time decay in micro-USDC (1 unit = 0.000001 USDC).
    /// Typically negative. Stored at higher precision to avoid truncation.
    pub theta_usdc: i64,

    /// Unix timestamp of when this pricing was last updated.
    pub last_updated: i64,

    /// The last account that called update_pricing on this PDA.
    /// update_pricing is intentionally permissionless — consumers should
    /// check last_updater to decide whether they trust the data source.
    pub last_updater: Pubkey,

    /// PDA bump seed.
    pub bump: u8,
}

/// PDA seed prefix for pricing accounts.
pub const PRICING_SEED: &[u8] = b"pricing";

/// Minimum implied volatility in basis points (5%).
pub const MIN_VOL_BPS: u64 = 500;

/// Maximum implied volatility in basis points (500%).
pub const MAX_VOL_BPS: u64 = 50_000;

/// Risk-free rate at solmath SCALE (5% = 0.05 × 1e12).
/// Hardcoded for hackathon — can be upgraded to read from Ondo OUSG yield later.
pub const RISK_FREE_RATE_SCALE: u128 = 50_000_000_000;
