// =============================================================================
// instructions/create_market.rs — Register a supported asset (admin-only)
// =============================================================================
//
// Stage 2 reshape: create_market registers an *asset* (one PDA per asset),
// not an option specification. Strike, expiry, option type, and settlement
// state moved to SharedVault and (Stage 3) SettlementRecord.
//
// The instruction is admin-only and idempotent: calling it twice with the
// same (asset_name, pyth_feed, asset_class) is a silent Ok; calling it with
// different metadata for an existing asset reverts with AssetMismatch.
//
// Asset names must be pre-normalized by the caller: ASCII-uppercase,
// alphanumeric only, 1..=16 chars. The handler verifies the normalization
// (it does NOT silently uppercase) so the (asset_name, market_pda) mapping
// is unambiguous.
//
// PDA seed: ["market", asset_name.as_bytes()]
// =============================================================================

use anchor_lang::prelude::*;
use std::str::FromStr;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, ProtocolState, MARKET_SEED, MAX_ASSET_NAME_LEN, PROTOCOL_SEED};

/// Hardcoded supported-asset registry. Adding a new asset requires a
/// program upgrade. Each tuple is
/// `(normalized_asset_name, pyth_feed_pubkey_str, asset_class)`. The
/// pyth_feed values are the Solana pull-oracle account pubkeys (shard 0)
/// derived from the canonical Pyth hex feed IDs.
const REGISTRY: &[(&str, &str, u8)] = &[
    ("BTC",  "HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J", 0),
    ("SOL",  "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix", 0),
    ("ETH",  "EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9GvYRk4HY7y44", 0),
    ("XAU",  "8y3WWjvmSmVGWVKH1rCA7VTRmuU7QbJ9axMK6JUUuCyi", 1),
    ("AAPL", "5yKHAuiDWKUGRgs3s6mYGdfZjFmTfgHVDBwFBDfMuZJH", 2),
];

/// Validate the (asset_name, pyth_feed, asset_class) triple against the
/// hardcoded registry. Asset name is checked post-normalization.
fn registry_matches(name: &str, pyth_feed: &Pubkey, asset_class: u8) -> bool {
    REGISTRY.iter().any(|(n, pk, c)| {
        if *n != name || *c != asset_class {
            return false;
        }
        match Pubkey::from_str(pk) {
            Ok(expected) => expected == *pyth_feed,
            Err(_) => false,
        }
    })
}

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
    pyth_feed: Pubkey,
    asset_class: u8,
) -> Result<()> {
    // 1. Admin-only
    require!(
        ctx.accounts.creator.key() == ctx.accounts.protocol_state.admin,
        OptaError::Unauthorized
    );

    // 2. Asset name normalization contract
    assert_normalized(&asset_name)?;

    // 3. Registry validation: (name, feed, class) must match a known entry
    require!(
        registry_matches(&asset_name, &pyth_feed, asset_class),
        OptaError::UnknownAsset
    );

    // 4. Idempotent init: if account already populated, verify match
    let market = &mut ctx.accounts.market;
    if !market.asset_name.is_empty() {
        require!(
            market.asset_name == asset_name
                && market.pyth_feed == pyth_feed
                && market.asset_class == asset_class,
            OptaError::AssetMismatch
        );
        msg!("Market already exists for {} — idempotent Ok", asset_name);
        return Ok(());
    }

    // 5. First init — populate fields and bump market counter
    market.asset_name = asset_name.clone();
    market.pyth_feed = pyth_feed;
    market.asset_class = asset_class;
    market.bump = ctx.bumps.market;

    let protocol = &mut ctx.accounts.protocol_state;
    protocol.total_markets = protocol
        .total_markets
        .checked_add(1)
        .ok_or(OptaError::MathOverflow)?;

    msg!(
        "Market registered: {} pyth={} class={}",
        asset_name,
        pyth_feed,
        asset_class
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String, pyth_feed: Pubkey, asset_class: u8)]
pub struct CreateMarket<'info> {
    /// Protocol admin (verified inside handler against `protocol_state.admin`).
    /// Pays for account creation on first init; pays nothing on idempotent re-call
    /// because `init_if_needed` short-circuits when the account already exists.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Global ProtocolState — read for admin check, mutated to bump
    /// total_markets on first init.
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
