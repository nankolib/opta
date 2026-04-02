// =============================================================================
// state/position.rs — Tokenized option position with partial fills + resale
// =============================================================================
//
// Supports partial purchases: a position with 100 tokens can be bought in
// chunks (30 by buyer A, 40 by buyer B, etc.). Same for resale.
//
// PDAs:
//   Position:         ["position", market, writer, created_at(8 bytes)]
//   USDC Escrow:      ["escrow", market, writer, created_at(8 bytes)]
//   Option Mint:      ["option_mint", position]
//   Purchase Escrow:  ["purchase_escrow", position]
//   Resale Escrow:    ["resale_escrow", position]
// =============================================================================

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct OptionPosition {
    /// The OptionsMarket this position belongs to.
    pub market: Pubkey,

    /// The writer (seller) who locked collateral to create this position.
    pub writer: Pubkey,

    /// The SPL token mint representing ownership of this option.
    pub option_mint: Pubkey,

    /// Total supply of option tokens minted.
    pub total_supply: u64,

    /// Number of tokens that have been purchased from the primary sale.
    /// Position stays active for more purchases until tokens_sold == total_supply.
    pub tokens_sold: u64,

    /// Amount of USDC collateral locked by the writer, scaled by 10^6.
    pub collateral_amount: u64,

    /// Total premium price for ALL tokens (scaled by 10^6 USDC).
    /// Per-token premium = premium / total_supply.
    pub premium: u64,

    /// Number of option contracts, scaled by 10^6.
    pub contract_size: u64,

    /// Unix timestamp when this position was created (also PDA seed).
    pub created_at: i64,

    /// Whether ALL tokens have been exercised (escrow fully drained).
    pub is_exercised: bool,

    /// Whether the option has expired without being exercised.
    pub is_expired: bool,

    /// Whether the writer cancelled this position.
    pub is_cancelled: bool,

    // -------------------------------------------------------------------------
    // Resale marketplace fields
    // -------------------------------------------------------------------------

    /// Whether this option has tokens listed for resale.
    pub is_listed_for_resale: bool,

    /// The resale asking price for ALL listed tokens (scaled by 10^6 USDC).
    /// Per-token resale price = resale_premium / resale_token_amount.
    pub resale_premium: u64,

    /// How many tokens are currently listed for resale.
    pub resale_token_amount: u64,

    /// The seller who listed this for resale.
    pub resale_seller: Pubkey,

    /// PDA bump seed.
    pub bump: u8,
}

pub const POSITION_SEED: &[u8] = b"position";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const OPTION_MINT_SEED: &[u8] = b"option_mint";
pub const PURCHASE_ESCROW_SEED: &[u8] = b"purchase_escrow";
pub const RESALE_ESCROW_SEED: &[u8] = b"resale_escrow";
