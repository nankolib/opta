// =============================================================================
// instructions/create_market.rs — Register an asset (permissionless + proof-gated)
// =============================================================================
//
// Permissionless post-HIGH-5 fix (audit Run-7 PART 1). Anyone can register an
// asset by passing a fresh Pyth PriceUpdateV2 account whose `feed_id` matches
// the `pyth_feed_id` argument. The caller-supplied feed_id is therefore
// proof-bound to a real Pyth feed — random byte griefers are rejected at
// account-validation time, not just downstream at settle. The HIGH-2 admin
// gate that this fix replaces is strictly weaker: an admin fat-finger could
// still brick a namespace, and external integrators couldn't bootstrap their
// own asset listings.
//
// On-chain proof check (mirrors settle_expiry.rs:88-97):
//   1. price_update.verification_level == Full   → InsufficientVerificationLevel
//   2. price_update.price_message.feed_id == pyth_feed_id  → MismatchedFeedId
//
// Zero feed IDs are still rejected as defense-in-depth, though the proof check
// already implicitly rejects them (no real Pyth feed has feed_id [0u8; 32]).
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
use pyth_solana_receiver_sdk::error::GetPriceError;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use pyth_solana_receiver_sdk::price_update::VerificationLevel;

use crate::errors::OptaError;
use crate::state::{
    OptionsMarket, ProtocolState, MARKET_SEED, MAX_ASSET_CLASS, MAX_ASSET_NAME_LEN,
    ORACLE_SOURCE_PYTH, ORACLE_SOURCE_SWITCHBOARD, PROTOCOL_SEED,
};
use crate::state::opta_price_feed::{OptaPriceFeed, ORACLE_SOURCE_OPTA};
use crate::utils::opta_price_read::opta_prove_feed_exists;
use crate::utils::price_oracle::{
    find_ed25519_ix_index, sb_prove_feed_exists, secs_to_slots, SB_MIN_ORACLE_SAMPLES_FLOOR,
};

/// Freshness budget for the Switchboard create-time existence proof, in seconds
/// → slots via `secs_to_slots`. The quote's `signed_slothash` must resolve within
/// this many slots of `clock.slot`. The real ceiling is the ~512-slot SlotHashes
/// retention (~3.5 min); 300 s (= 750 slots) is a generous upper bound that the
/// SlotHashes wall clamps in practice — mirrors `SB_SETTLE_WINDOW_SECS`. Create
/// carries a FRESH quote (same tightly-sequenced fetch→land as the 1c-i-A smoke).
pub const CREATE_SB_PROOF_MAX_AGE_SECS: i64 = 300;

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
    oracle_source: u8,
) -> Result<()> {
    // HIGH-5 proof gate (audit Run-7), BRANCHED by oracle_source (Stage 3
    // 1c-i-B). Both arms prove the caller-supplied feed_id is bound to a REAL
    // feed before the asset is registered; the match also validates the source
    // (a value other than Pyth/Switchboard reverts InvalidOracleSource). The
    // proof is PURE EXISTENCE for both arms — no price is stored at create.
    match oracle_source {
        ORACLE_SOURCE_PYTH => {
            // Unchanged Pyth proof: Full verification + feed_id match. Mirrors
            // settle_expiry.rs:88-97. price_update is REQUIRED for a Pyth create
            // (a present account is wire-identical to the pre-1c-i-B form).
            let pu = ctx
                .accounts
                .price_update
                .as_ref()
                .ok_or(error!(OptaError::PriceUpdateMissing))?;
            require!(
                pu.verification_level.gte(VerificationLevel::Full),
                GetPriceError::InsufficientVerificationLevel
            );
            require!(
                pu.price_message.feed_id == pyth_feed_id,
                GetPriceError::MismatchedFeedId
            );
        }
        ORACLE_SOURCE_SWITCHBOARD => {
            // SB existence proof: one QuoteVerifier pass asserting a feed whose
            // feed_id() == pyth_feed_id (the 32-byte SB feedHash, double-duty
            // field) exists in a FRESH signed quote. The verify+extract is the
            // same path proven live in the 1c-i-A smoke; here we discard the
            // value (create stores no price). ed25519 index derived on-chain.
            let queue = ctx
                .accounts
                .sb_queue
                .as_ref()
                .ok_or(error!(OptaError::SwitchboardAccountsMissing))?;
            let slothashes = ctx
                .accounts
                .sb_slothashes
                .as_ref()
                .ok_or(error!(OptaError::SwitchboardAccountsMissing))?;
            let instructions = ctx
                .accounts
                .sb_instructions
                .as_ref()
                .ok_or(error!(OptaError::SwitchboardAccountsMissing))?;
            require_keys_eq!(
                slothashes.key(),
                anchor_lang::solana_program::sysvar::slot_hashes::ID,
                OptaError::InvalidSwitchboardSysvar
            );
            require_keys_eq!(
                instructions.key(),
                anchor_lang::solana_program::sysvar::instructions::ID,
                OptaError::InvalidSwitchboardSysvar
            );
            let instructions_ai = instructions.to_account_info();
            let ed25519_ix_index = find_ed25519_ix_index(&instructions_ai)?;
            let clock = Clock::get()?;
            sb_prove_feed_exists(
                &queue.to_account_info(),
                &slothashes.to_account_info(),
                &instructions_ai,
                ed25519_ix_index,
                clock.slot,
                secs_to_slots(CREATE_SB_PROOF_MAX_AGE_SECS),
                pyth_feed_id,
                SB_MIN_ORACLE_SAMPLES_FLOOR,
            )?;
        }
        ORACLE_SOURCE_OPTA => {
            // FP-ORACLE: HIGH-5 existence proof -- PDA resolves, carries this
            // feed_id, is not frozen, and has been pushed at least once.
            let feed = ctx
                .accounts
                .opta_price_feed
                .as_ref()
                .ok_or(error!(OptaError::OptaFeedMissing))?;
            opta_prove_feed_exists(feed, pyth_feed_id)?;
        }
        _ => return Err(error!(OptaError::InvalidOracleSource)),
    }

    // HIGH-3 same-arc zero-feed guard (BOTH arms). Defense-in-depth — the Pyth
    // proof already implicitly rejects [0u8; 32]; for Switchboard this is the
    // cheap reject of a zero feedHash.
    require!(pyth_feed_id != [0u8; 32], OptaError::InvalidPythFeedId);

    // 1. Asset name normalization contract
    assert_normalized(&asset_name)?;

    // 2. Asset class bound (0..=4)
    require!(asset_class <= MAX_ASSET_CLASS, OptaError::InvalidAssetClass);

    // 3. Idempotent init: if account already populated, verify match. Now
    //    SOURCE-AWARE (1c-i-B) — re-creating an existing market with a different
    //    oracle_source rejects AssetMismatch (the same error a feed/class
    //    mismatch raises). The proof gate above runs BEFORE this short-circuit,
    //    so an SB re-call must still carry a fresh quote to reach here — mild,
    //    consistent with the original Pyth re-call (which also re-runs its proof).
    let market = &mut ctx.accounts.market;
    if !market.asset_name.is_empty() {
        require!(
            market.asset_name == asset_name
                && market.pyth_feed_id == pyth_feed_id
                && market.asset_class == asset_class
                && market.oracle_source == oracle_source,
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
    // Stage 3 1c-i-B: born with the requested (validated) source.
    market.oracle_source = oracle_source;

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
#[instruction(asset_name: String, pyth_feed_id: [u8; 32], asset_class: u8, oracle_source: u8)]
pub struct CreateMarket<'info> {
    /// Permissionless post-HIGH-5 fix (audit Run-7). Any signer pays for
    /// account creation on first init; pays nothing on idempotent re-call
    /// because `init_if_needed` short-circuits. The proof-of-feed gate is
    /// enforced via the `price_update` account (Pyth) or the trailing SB
    /// accounts (Switchboard) below.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Global ProtocolState — mutated to bump total_markets on first init.
    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. The handler
    /// verifies `verification_level == Full` and
    /// `price_message.feed_id == pyth_feed_id` to prove the caller-supplied
    /// feed_id corresponds to a real Pyth feed. Read-only — never mutated.
    ///
    /// Stage 3 1c-i-B: now `Option`. REQUIRED (present) for a Pyth create
    /// (oracle_source=0) — a present account is wire-identical to the prior
    /// required form, so existing Pyth creates are unaffected. Passed None for
    /// a Switchboard create (oracle_source=1): the SB feed-existence proof runs
    /// against the trailing SB accounts instead. Pyth arm errors
    /// `PriceUpdateMissing` if absent on a Pyth create.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

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

    // --- Switchboard create-time proof accounts (Stage 3 1c-i-B). TRAILING
    // optionals: a Pyth create omits all three (allow-missing-optionals → None),
    // keeping its tx byte-identical. Required only when oracle_source ==
    // Switchboard; the handler unwraps + runtime-address-checks the two sysvars,
    // then runs one QuoteVerifier existence pass. Appended AFTER system_program;
    // no existing account moved. ---
    /// CHECK: Switchboard oracle queue; validated by QuoteVerifier (oracle-key
    /// set) in the SB arm. Not address-pinned (per-network queue).
    pub sb_queue: Option<UncheckedAccount<'info>>,

    /// CHECK: SlotHashes sysvar; address-checked == sysvar::slot_hashes::ID at
    /// runtime in the SB arm.
    pub sb_slothashes: Option<UncheckedAccount<'info>>,

    /// CHECK: Instructions sysvar; address-checked == sysvar::instructions::ID at
    /// runtime in the SB arm, then scanned for the ed25519 ix index.
    pub sb_instructions: Option<UncheckedAccount<'info>>,

    /// FP-ORACLE arm (plug, wave 1). Trailing optional, appended AFTER the SB
    /// optionals so every existing Pyth/SB transaction stays byte-identical.
    /// REQUIRED (present) when the routed oracle_source == ORACLE_SOURCE_OPTA;
    /// the arm errors OptaFeedMissing if absent. Identity is proven by the arm
    /// against the market's feed_id (assert_feed_identity) -- a PDA constraint is
    /// unnecessary: the account is ours (owner + discriminator via Account) and
    /// feed_id is unique by init seeds.
    pub opta_price_feed: Option<Account<'info, OptaPriceFeed>>,
}
