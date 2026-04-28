// =============================================================================
// instructions/migrate_pyth_feed.rs — Admin-only Pyth feed_id rotation
// =============================================================================
//
// Stage P3 shape: a one-shot admin instruction that overwrites an existing
// OptionsMarket's `pyth_feed_id`. Intended for the rare case where Pyth
// rotates a feed_id (e.g. asset re-listing on a new feed). 99% of the time
// this instruction is never called; markets are immutable in practice.
//
// Re-call semantics:
//   - Same feed_id as currently stored → silent Ok (idempotent).
//   - Different feed_id → overwrite and continue.
//
// Authorization: signer must match `protocol_state.admin`. Reuses the
// existing `Unauthorized` error.
//
// No PriceUpdateV2 in context — this instruction does not consult the
// oracle. It only mutates registry metadata. The next `settle_expiry` call
// will pick up the new feed_id naturally.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, ProtocolState, MARKET_SEED, PROTOCOL_SEED};

pub fn handle_migrate_pyth_feed(
    ctx: Context<MigratePythFeed>,
    asset_name: String,
    new_pyth_feed_id: [u8; 32],
) -> Result<()> {
    // Admin-only gate
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.protocol_state.admin,
        OptaError::Unauthorized
    );

    let market = &mut ctx.accounts.market;

    // Idempotent re-call with same feed_id — silent Ok.
    if market.pyth_feed_id == new_pyth_feed_id {
        msg!(
            "migrate_pyth_feed: feed_id unchanged for {} — idempotent Ok",
            asset_name
        );
        return Ok(());
    }

    let old_feed_id = market.pyth_feed_id;
    market.pyth_feed_id = new_pyth_feed_id;

    msg!(
        "Pyth feed_id rotated for {}: {:?} -> {:?}",
        asset_name,
        old_feed_id,
        new_pyth_feed_id,
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String, new_pyth_feed_id: [u8; 32])]
pub struct MigratePythFeed<'info> {
    /// Must match `protocol_state.admin`. Verified in the handler.
    pub admin: Signer<'info>,

    /// Global ProtocolState — read-only here, used to verify the admin key.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The market whose Pyth feed_id is being rotated. PDA seeds enforce
    /// existence — passing an unknown asset_name fails seed validation
    /// (AccountNotInitialized).
    #[account(
        mut,
        seeds = [MARKET_SEED, asset_name.as_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, OptionsMarket>,
}
