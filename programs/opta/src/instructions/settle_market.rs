// =============================================================================
// instructions/settle_market.rs — Set the settlement price for an expired market
// =============================================================================
//
// HACKATHON NOTE: This is a simplified settlement instruction where the admin
// provides the settlement price directly. In production, this would:
//   1. Read from a Pyth PriceUpdateV2 account
//   2. Validate the price is fresh (not stale)
//   3. Allow anyone to trigger settlement (not just admin)
//
// The Pyth integration point is clearly defined — swap the `settlement_price`
// parameter with a Pyth oracle read in the handler function.
//
// Who can call: Protocol admin only.
// When: After the market's expiry_timestamp has passed.
// What it does: Sets market.settlement_price and market.is_settled = true.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::ButterError;
use crate::events::MarketSettled;
use crate::state::{OptionsMarket, ProtocolState, PROTOCOL_SEED};

/// Handler: settle an expired market with a price.
///
/// In production, `settlement_price` would come from a Pyth oracle read
/// instead of being passed as a parameter.
pub fn handle_settle_market(
    ctx: Context<SettleMarket>,
    settlement_price: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    // -------------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------------

    // Market must have expired.
    require!(
        clock.unix_timestamp >= market.expiry_timestamp,
        ButterError::MarketNotExpired
    );

    // Market must not already be settled.
    require!(!market.is_settled, ButterError::MarketAlreadySettled);

    // Settlement price must be positive.
    require!(settlement_price > 0, ButterError::InvalidSettlementPrice);

    // -------------------------------------------------------------------------
    // Set settlement price
    //
    // PRODUCTION TODO: Replace `settlement_price` parameter with:
    //   let price_update = Account::<PriceUpdateV2>::try_from(
    //       &ctx.accounts.oracle_price_update
    //   )?;
    //   let price = price_update.get_price_no_older_than(
    //       &clock, MAX_PRICE_AGE_SECS, &market.pyth_feed_id
    //   )?;
    //   let settlement_price = convert_pyth_price(price);
    // -------------------------------------------------------------------------
    market.settlement_price = settlement_price;
    market.is_settled = true;

    // -------------------------------------------------------------------------
    // Emit event
    // -------------------------------------------------------------------------
    emit!(MarketSettled {
        market: market.key(),
        settlement_price,
    });

    msg!(
        "Market settled: market={}, price={}",
        market.key(),
        settlement_price,
    );

    Ok(())
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Only the protocol admin can settle markets (hackathon constraint).
    /// In production, this would be permissionless with Pyth validation.
    #[account(
        constraint = admin.key() == protocol_state.admin @ ButterError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    /// Protocol state — used to verify admin identity.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The market to settle. Must be a valid OptionsMarket account.
    #[account(mut)]
    pub market: Account<'info, OptionsMarket>,
}
