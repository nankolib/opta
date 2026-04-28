// =============================================================================
// state/market.rs — Asset registry record (one PDA per supported asset)
// =============================================================================
//
// Stage 2 reshape: an OptionsMarket is now an *asset registration*, not an
// option specification. A single PDA per asset records the human-readable
// name, the Pyth oracle feed, and the asset class. Strike, expiry, option
// type, and settlement state moved off the market entirely:
//   - Strike, expiry, option type live on `SharedVault` (one vault per
//     unique option spec).
//   - Settlement price lives on a per-(asset, expiry) `SettlementRecord`
//     PDA (introduced in Stage 3).
//
// The `OptionType` enum still lives here because `SharedVault` reuses it.
//
// PDA seed: ["market", normalized_asset_name(bytes)]
//
// Asset names are normalized at create time (uppercase, alphanumeric only,
// 1..=16 chars). Once registered, the (asset_name, pyth_feed_id, asset_class)
// triple is immutable — re-creating with matching values is a silent Ok
// (idempotent registry); re-creating with different values reverts with
// `AssetMismatch`.
// =============================================================================

use anchor_lang::prelude::*;

/// Maximum length of an asset name (e.g. "SOL", "BTC", "AAPL").
pub const MAX_ASSET_NAME_LEN: usize = 16;

/// Whether this option is a call (right to buy) or put (right to sell).
/// Lives on `SharedVault` post-Stage-2; kept here because vaults import it.
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
    /// Human-readable, normalized asset identifier ("SOL", "BTC", "AAPL", ...).
    /// Max 16 chars, ASCII-uppercase, alphanumeric only.
    #[max_len(16)]
    pub asset_name: String,

    /// The 32-byte Pyth Pull oracle feed ID for this asset.
    /// Stage P1: stored without on-chain validation. Stage P2 settle_expiry
    /// will validate this matches the `feed_id` on a passed-in PriceUpdateV2
    /// account via `get_price_no_older_than(.., &feed_id)`.
    pub pyth_feed_id: [u8; 32],

    /// Asset class for categorizing the underlying asset.
    /// 0 = crypto, 1 = commodity, 2 = equity, 3 = forex, 4 = ETF.
    /// Metadata-only today — no surviving on-chain or frontend pricing
    /// logic branches on this value.
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
