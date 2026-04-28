// =============================================================================
// instructions/create_market.rs — Register an asset (permissionless)
// =============================================================================
//
// Stage P1 shape: create_market is permissionless. Anyone can register an
// asset by storing a 32-byte Pyth Pull feed ID alongside its ticker and
// asset class. The feed_id is stored verbatim with no on-chain validation
// at create time — Stage P2's settle_expiry validates it by passing the
// stored feed_id to PriceUpdateV2::get_price_no_older_than, which fails
// with MismatchedFeedId if the feed_id doesn't match the price update.
//
// Strike, expiry, option type, and settlement state moved to SharedVault
// and SettlementRecord. The Market PDA is a per-asset registry record.
//
// Asset names must be pre-normalized by the caller: ASCII-uppercase,
// alphanumeric only, 1..=16 chars. The handler verifies the normalization
// (it does NOT silently uppercase) so the (asset_name, market_pda)
// mapping is unambiguous.
//
// PDA seed: ["market", asset_name.as_bytes()]
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, ProtocolState, MARKET_SEED, MAX_ASSET_CLASS, MAX_ASSET_NAME_LEN, PROTOCOL_SEED};

/// Verify the asset name conforms to the normalization contract:
/// 1..=16 ASCII uppercase letters or digits. Caller must pre-normalize.
fn assert_normalized(name: &str) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= MAX_ASSET_NAME_LEN,
        OptaError::InvalidAssetName
    );
    require!(
        name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
        OptaError::InvalidAssetName
    );
    Ok(())
}

pub fn handle_create_market(
    ctx: Context<CreateMarket>,
    asset_name: String,
    pyth_feed_id: [u8; 32],
    asset_class: u8,
) -> Result<()> {
    // 1. Asset name normalization contract
    assert_normalized(&asset_name)?;

    // 2. Asset class bound (0..=4)
    require!(asset_class <= MAX_ASSET_CLASS, OptaError::InvalidAssetClass);

    // 3. Idempotent init: if account already populated, verify match
    let market = &mut ctx.accounts.market;
    if !market.asset_name.is_empty() {
        require!(
            market.asset_name == asset_name
                && market.pyth_feed_id == pyth_feed_id
                && market.asset_class == asset_class,
            OptaError::AssetMismatch
        );
        msg!("Market already exists for {} — idempotent Ok", asset_name);
        return Ok(());
    }

    // 4. First init — populate fields and bump market counter
    market.asset_name = asset_name.clone();
    market.pyth_feed_id = pyth_feed_id;
    market.asset_class = asset_class;
    market.bump = ctx.bumps.market;

    let protocol = &mut ctx.accounts.protocol_state;
    protocol.total_markets = protocol
        .total_markets
        .checked_add(1)
        .ok_or(OptaError::MathOverflow)?;

    msg!(
        "Market registered: {} feed_id={:?} class={}",
        asset_name,
        pyth_feed_id,
        asset_class
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String, pyth_feed_id: [u8; 32], asset_class: u8)]
pub struct CreateMarket<'info> {
    /// Permissionless — anyone can call. Pays for account creation on
    /// first init; pays nothing on idempotent re-call because
    /// `init_if_needed` short-circuits when the account already exists.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Global ProtocolState — mutated to bump total_markets on first init.
    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Asset registry PDA. One per supported asset.
    #[account(
        init_if_needed,
        seeds = [MARKET_SEED, asset_name.as_bytes()],
        bump,
        payer = creator,
        space = 8 + OptionsMarket::INIT_SPACE,
    )]
    pub market: Account<'info, OptionsMarket>,

    pub system_program: Program<'info, System>,
}
