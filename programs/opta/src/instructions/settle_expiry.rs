// =============================================================================
// instructions/settle_expiry.rs — Record settlement price from Pyth Pull
// =============================================================================
//
// Stage P2 shape: permissionless. Caller passes a fresh PriceUpdateV2
// account (posted via the Pyth Receiver program off-chain — typically by
// the crank). settle_expiry validates:
//   1. Asset's expiry has elapsed
//   2. PriceUpdateV2's feed_id matches the OptionsMarket's stored feed_id
//   3. PriceUpdateV2's publish_time is within PYTH_MAX_AGE_SECS of now
//   4. Verification level is Full (all Wormhole guardian signatures verified)
//
// On success, writes the canonical settlement price for this (asset, expiry)
// to a SettlementRecord PDA. SharedVaults for this (asset, expiry) read
// from there.
//
// Idempotency: SettlementRecord is created with `init` (not init_if_needed).
// A second call for the same (asset, expiry) reverts with "account already
// in use".
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, SettlementRecord, MARKET_SEED, SETTLEMENT_SEED};
use crate::utils::solmath_bridge::pyth_price_to_usdc;

/// Maximum age (in seconds) of a Pyth price update accepted by settle_expiry.
/// Pyth Pull on Solana typically posts every ~400ms; 300s = 5 minutes is a
/// generous bound that tolerates network hiccups while preventing obvious
/// stale data.
pub const PYTH_MAX_AGE_SECS: u64 = 300;

pub fn handle_settle_expiry(
    ctx: Context<SettleExpiry>,
    asset_name: String,
    expiry: i64,
) -> Result<()> {
    // 1. Cannot settle pre-expiry
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= expiry,
        OptaError::MarketNotExpired
    );

    // 2. Read price from PriceUpdateV2 — this enforces:
    //    - feed_id match (else MismatchedFeedId)
    //    - publish_time freshness (else PriceTooOld)
    //    - verification_level == Full (else InsufficientVerificationLevel)
    let market = &ctx.accounts.market;
    let pyth_price = ctx.accounts.price_update.get_price_no_older_than(
        &clock,
        PYTH_MAX_AGE_SECS,
        &market.pyth_feed_id,
    )?;

    // 3. Normalize Pyth's (i64 price, i32 exponent) to u64 USDC 6-decimal.
    //    Rejects price <= 0 (InvalidSettlementPrice) and overflow (MathOverflow).
    let settlement_price = pyth_price_to_usdc(pyth_price.price, pyth_price.exponent)?;

    // 4. Populate the record
    let record = &mut ctx.accounts.settlement_record;
    record.asset_name = asset_name.clone();
    record.expiry = expiry;
    record.settlement_price = settlement_price;
    record.settled_at = clock.unix_timestamp;
    record.bump = ctx.bumps.settlement_record;

    msg!(
        "Settlement recorded: {} expiry={} price={} (pyth={}, expo={})",
        asset_name,
        expiry,
        settlement_price,
        pyth_price.price,
        pyth_price.exponent,
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String, expiry: i64)]
pub struct SettleExpiry<'info> {
    /// Permissionless. Caller pays for SettlementRecord rent.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// OptionsMarket — provides the canonical feed_id for this asset.
    #[account(
        seeds = [MARKET_SEED, asset_name.as_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, OptionsMarket>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. Validated by
    /// `get_price_no_older_than(.., &market.pyth_feed_id)` for both feed_id
    /// match and staleness.
    pub price_update: Account<'info, PriceUpdateV2>,

    /// The SettlementRecord PDA. Plain `init` — second call for the same
    /// (asset, expiry) reverts.
    #[account(
        init,
        seeds = [
            SETTLEMENT_SEED,
            asset_name.as_bytes(),
            &expiry.to_le_bytes(),
        ],
        bump,
        payer = caller,
        space = 8 + SettlementRecord::INIT_SPACE,
    )]
    pub settlement_record: Account<'info, SettlementRecord>,

    pub system_program: Program<'info, System>,
}
