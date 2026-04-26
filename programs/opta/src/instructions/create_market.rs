// =============================================================================
// instructions/create_market.rs — Create a new options market
// =============================================================================
//
// Anyone can create a new market for ANY asset that has a Pyth oracle feed.
// A "market" defines a specific option contract:
//   - Asset name (flexible string, e.g. "SOL", "BTC", "AAPL", "EUR/USD")
//   - Strike price (e.g. $200)
//   - Expiry (Unix timestamp)
//   - Type (Call or Put)
//   - Pyth oracle feed pubkey
//
// The market PDA is derived from all four identifying parameters, which
// guarantees each unique combination can only exist once (no duplicates).
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, OptionType, ProtocolState, MARKET_SEED, MAX_ASSET_CLASS, MAX_ASSET_NAME_LEN, PROTOCOL_SEED};

/// Handler: create a new options market with the given parameters.
pub fn handle_create_market(
    ctx: Context<CreateMarket>,
    asset_name: String,
    strike_price: u64,
    expiry_timestamp: i64,
    option_type: OptionType,
    pyth_feed: Pubkey,
    asset_class: u8,
) -> Result<()> {
    // -------------------------------------------------------------------------
    // Validation: asset name must be non-empty and <= 16 chars
    // -------------------------------------------------------------------------
    require!(!asset_name.is_empty(), OptaError::InvalidAssetName);
    require!(
        asset_name.len() <= MAX_ASSET_NAME_LEN,
        OptaError::InvalidAssetName
    );

    // -------------------------------------------------------------------------
    // Validation: strike price must be positive
    // -------------------------------------------------------------------------
    require!(strike_price > 0, OptaError::InvalidStrikePrice);

    // -------------------------------------------------------------------------
    // Validation: expiry must be in the future
    //
    // We use Solana's Clock sysvar to get the current on-chain timestamp.
    // This is more reliable than client-side time since validators agree on it.
    // -------------------------------------------------------------------------
    let clock = Clock::get()?;
    require!(
        expiry_timestamp > clock.unix_timestamp,
        OptaError::ExpiryInPast
    );

    // -------------------------------------------------------------------------
    // Validation: Pyth feed must not be the default (zero) pubkey.
    // A zero pubkey would mean no oracle is configured.
    // -------------------------------------------------------------------------
    require!(
        pyth_feed != Pubkey::default(),
        OptaError::InvalidPythFeed
    );

    // -------------------------------------------------------------------------
    // Validation: asset class must be a known value (0-4)
    // -------------------------------------------------------------------------
    require!(asset_class <= MAX_ASSET_CLASS, OptaError::InvalidAssetClass);

    // -------------------------------------------------------------------------
    // Initialize the market account with the provided parameters.
    // -------------------------------------------------------------------------
    let market = &mut ctx.accounts.market;
    market.asset_name = asset_name.clone();
    market.strike_price = strike_price;
    market.expiry_timestamp = expiry_timestamp;
    market.option_type = option_type;
    market.is_settled = false;
    market.settlement_price = 0;
    market.pyth_feed = pyth_feed;
    market.asset_class = asset_class;
    market.bump = ctx.bumps.market;

    // -------------------------------------------------------------------------
    // Increment the protocol's total market counter.
    // -------------------------------------------------------------------------
    let protocol = &mut ctx.accounts.protocol_state;
    protocol.total_markets = protocol
        .total_markets
        .checked_add(1)
        .ok_or(OptaError::MathOverflow)?;

    msg!(
        "Market created: {} strike={} expiry={} type={:?}",
        asset_name,
        strike_price,
        expiry_timestamp,
        option_type,
    );

    Ok(())
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
#[instruction(
    asset_name: String,
    strike_price: u64,
    expiry_timestamp: i64,
    option_type: OptionType,
)]
pub struct CreateMarket<'info> {
    /// The user creating this market. Anyone can create a market — there's no
    /// permissioning. They pay the rent for the new account.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// The global ProtocolState — we need this to increment total_markets.
    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The new OptionsMarket PDA.
    ///
    /// Seeds use the asset name as bytes (not an enum discriminant), making
    /// the protocol open to ANY asset. For example:
    ///   - "SOL" + strike + expiry + Call  → one unique PDA
    ///   - "AAPL" + strike + expiry + Call → a different PDA
    ///   - "EUR/USD" + strike + expiry + Put → yet another
    ///
    /// Attempting to create a duplicate combination will fail.
    #[account(
        init,
        seeds = [
            MARKET_SEED,
            asset_name.as_bytes(),
            &strike_price.to_le_bytes(),
            &expiry_timestamp.to_le_bytes(),
            &[option_type as u8],
        ],
        bump,
        payer = creator,
        space = 8 + OptionsMarket::INIT_SPACE,
    )]
    pub market: Account<'info, OptionsMarket>,

    /// Required for creating new accounts.
    pub system_program: Program<'info, System>,
}
