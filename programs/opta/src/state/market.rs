// =============================================================================
// state/market.rs — Options market definition
// =============================================================================
//
// An OptionsMarket represents a unique option contract specification, e.g.
// "SOL $200 Call expiring May 1, 2026". Multiple writers can write positions
// against the same market (see OptionPosition).
//
// The protocol supports ANY asset that has a Pyth oracle feed — not just a
// hardcoded list. The asset is identified by a human-readable string name
// (e.g. "SOL", "BTC", "AAPL", "EUR/USD") and a Pyth feed pubkey.
//
// PDA seed: ["market", asset_name(bytes), strike_price(8), expiry(8), option_type(1)]
//
// This ensures each unique combination of (asset, strike, expiry, type) has
// exactly one market account — no duplicates.
// =============================================================================

use anchor_lang::prelude::*;

/// Maximum length of an asset name (e.g. "SOL", "EUR/USD", "AAPL").
/// 16 bytes is enough for any ticker symbol or currency pair.
pub const MAX_ASSET_NAME_LEN: usize = 16;

/// Whether this option is a call (right to buy) or put (right to sell).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum OptionType {
    /// Call option — buyer profits when the asset price is ABOVE the strike.
    Call,
    /// Put option — buyer profits when the asset price is BELOW the strike.
    Put,
}

#[account]
#[derive(InitSpace)]
pub struct OptionsMarket {
    /// Human-readable asset identifier (e.g. "SOL", "BTC", "AAPL", "EUR/USD").
    /// This is a flexible string — the protocol supports ANY asset that has
    /// a Pyth oracle feed. Max 16 characters.
    #[max_len(16)]
    pub asset_name: String,

    /// The strike price in USDC, scaled by 10^6.
    /// Example: $200.00 is stored as 200_000_000.
    pub strike_price: u64,

    /// Unix timestamp when this option expires. After this time, the option
    /// can be settled using the Pyth oracle price.
    pub expiry_timestamp: i64,

    /// Call or Put.
    pub option_type: OptionType,

    /// Whether this market has been settled (the Pyth price at expiry has
    /// been recorded). Once settled, no new positions can be written.
    pub is_settled: bool,

    /// The Pyth oracle price recorded at settlement time, scaled by 10^6.
    /// Zero until the market is settled.
    pub settlement_price: u64,

    /// The Pyth Network price feed account for this asset.
    /// Used during settlement to read the current price.
    pub pyth_feed: Pubkey,

    /// Asset class for categorizing the underlying asset.
    /// 0 = crypto, 1 = commodity, 2 = equity, 3 = forex, 4 = ETF.
    pub asset_class: u8,

    /// PDA bump seed.
    pub bump: u8,
}

/// Prefix for the OptionsMarket PDA seed.
pub const MARKET_SEED: &[u8] = b"market";

/// Asset class constants.
pub const ASSET_CLASS_CRYPTO: u8 = 0;
pub const ASSET_CLASS_COMMODITY: u8 = 1;
pub const ASSET_CLASS_EQUITY: u8 = 2;
pub const ASSET_CLASS_FOREX: u8 = 3;
pub const ASSET_CLASS_ETF: u8 = 4;
/// Maximum valid asset class value.
pub const MAX_ASSET_CLASS: u8 = 4;
