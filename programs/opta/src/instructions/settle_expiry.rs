// =============================================================================
// instructions/settle_expiry.rs — Record settlement price from Pyth Pull
// =============================================================================
//
// Pricing semantic (post-fix arc, 2026-05-03):
//   settlement price = Pyth EMA at first published time at-or-after
//                      vault expiry, within a 60s window.
//
// The crank fetches a HISTORICAL Pyth update whose publish_time is at
// or just after vault expiry (Hermes /v2/updates/price/{ts} endpoint —
// /v1 was decommissioned in the 2026-05-20 Pyth cutover), posts it via
// the Pyth Receiver, and consumes it here. We read EMA
// (price_update.price_message.ema_price) rather than spot to dampen
// final-tick noise — the EMA is signed/verified via the same Wormhole
// VAA + Merkle path as spot, so verification guarantees are identical.
//
// Permissionless. Caller passes a PriceUpdateV2 account. We validate:
//   1. Asset's expiry has elapsed (clock >= expiry)
//   2. price_update.verification_level == Full
//   3. price_update.price_message.feed_id == market.pyth_feed_id
//   4. publish_time >= expiry  (else PriceUpdateBeforeExpiry)
//   5. publish_time - expiry <= EXPIRY_WINDOW_SECS (60)  (else PriceUpdateTooFarFromExpiry)
//   6. publish_time + PYTH_MAX_AGE_SECS >= clock        (else PriceTooOld; 1-day floor)
//
// Checks (2) and (3) replicate what the SDK's get_price_no_older_than
// performs internally — verified against pyth-solana-receiver-sdk v1.1.0
// source at src/price_update.rs (2026-05-03). We replicate manually
// because that helper returns a Price struct with no EMA field.
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
use crate::state::{
    OptionsMarket, SettlementRecord, ORACLE_SOURCE_PYTH, ORACLE_SOURCE_SWITCHBOARD, MARKET_SEED,
    SETTLEMENT_SEED,
};
use crate::state::opta_price_feed::{OptaPriceFeed, ORACLE_SOURCE_OPTA};
use crate::utils::opta_price_read::opta_settlement_price_usdc;
use crate::utils::price_oracle::{
    find_ed25519_ix_index, pyth_settlement_price_usdc, sb_settlement_price_usdc, secs_to_slots,
    SB_MIN_ORACLE_SAMPLES_FLOOR,
};

/// Maximum gap between the Pyth update's `publish_time` and the on-chain clock
/// at settlement time. Set to 30 days (2_592_000 s) as a wide backstop SLO,
/// up from the original 1-day value. The real security against stale-data
/// attacks is the [expiry, expiry+60] window check (EXPIRY_WINDOW_SECS)
/// applied at gates #5-6 of this instruction — this constant is only a
/// catch-all that prevents silently settling vaults whose historical Pyth
/// updates are months or years stale.
///
/// Why 30 days: previously 86_400 (1 day) which assumed settle delays would
/// be operator-noticed in <24h. The 2026-05-19 Hermes /v1 → /v2 cutover
/// proved that assumption wrong (5-day silent backlog before fix). The new
/// value tolerates multi-day outages while still preventing settles against
/// arbitrarily-old historical updates.
pub const PYTH_MAX_AGE_SECS: u64 = 2_592_000;

/// Maximum gap between Pyth `publish_time` and vault `expiry`. The crank
/// fetches a historical update at `publish_time = expiry`; Pyth posts
/// every ~400ms, so a window of 60s comfortably accommodates skipped
/// slots while pinning settlement to "first official print at-or-after
/// expiry." One-sided: publish_time must be in [expiry, expiry + 60].
pub const EXPIRY_WINDOW_SECS: i64 = 60;

/// Maximum Pyth EMA confidence width tolerated at settlement, in basis
/// points of the EMA price. Settlement reverts when
/// `ema_conf * 10_000 > abs(ema_price) * MAX_CONF_BPS`. 200 bps (2%) is
/// the audit-suggested default — broad enough to absorb routine Pyth
/// noise on blue-chip feeds, tight enough to reject the wide-conf prints
/// that surface during oracle-stress / aggregator-divergence events.
/// See audit Run-6 finding CRIT-2.
pub const MAX_CONF_BPS: u16 = 200;

/// Switchboard settlement window (Stage 3 1b). The Pyth/Switchboard ASYMMETRY:
///   - Pyth settles on a HISTORICAL at-expiry price (Hermes archive lets the
///     crank fetch the print at `publish_time ∈ [expiry, expiry+60]` and settle
///     any time within ~30 days). The price is always the as-of-expiry print.
///   - Switchboard has NO historical lookback: a signed quote is only verifiable
///     on-chain while its `signed_slothash` is still in the SlotHashes sysvar
///     (~512 slots ≈ 3.5 min). So an SB market settles on a FRESH quote captured
///     near expiry, and MUST be settled within this window of expiry. Past it,
///     no quote is verifiable → no SettlementRecord lands → the existing
///     `reclaim_unsettled` 7-day hatch winds the vault down (writers reclaim
///     pro-rata, holders forfeit). 300 s (5 min) gives the crank a comfortable
///     margin over the ~3.5-min SlotHashes wall.
pub const SB_SETTLE_WINDOW_SECS: i64 = 300;

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

    // 2-6. Read + validate + normalize the settlement price, ROUTED by
    //      market.oracle_source (Stage 3 1b — the last of the 4 read sites).
    //      Both arms produce a `settlement_price` (USDC 6-dec) and a value for
    //      the record's `pyth_publish_time` slot. They differ fundamentally in
    //      WHAT that second value is and how freshness is enforced (see
    //      SB_SETTLE_WINDOW_SECS docs): Pyth → a historical at-expiry print +
    //      publish_time; Switchboard → a fresh-at-settle quote + recent_slot.
    let oracle_source = ctx.accounts.market.oracle_source;
    let feed_id = ctx.accounts.market.pyth_feed_id;
    let (settlement_price, publish_time_or_slot) = match oracle_source {
        ORACLE_SOURCE_PYTH => {
            // Byte-for-byte the pre-Stage-3 read: Full verification + feed_id +
            // EMA-confidence + the [expiry, expiry+60] window + 30d backstop.
            let price_update = ctx
                .accounts
                .price_update
                .as_ref()
                .ok_or(error!(OptaError::PriceUpdateMissing))?;
            let read = pyth_settlement_price_usdc(
                price_update,
                feed_id,
                expiry,
                clock.unix_timestamp,
                EXPIRY_WINDOW_SECS,
                PYTH_MAX_AGE_SECS as i64,
                MAX_CONF_BPS,
            )?;
            (read.price_usdc, read.publish_time)
        }
        ORACLE_SOURCE_SWITCHBOARD => {
            // Persist-at-expiry: NO historical lookback. The Pyth
            // [expiry, expiry+60] publish_time gate has no SB analog and is NOT
            // faked — replaced by a SETTLE-TIME window: must settle within
            // SB_SETTLE_WINDOW_SECS of expiry, while a fresh quote is verifiable.
            // (Pre-expiry is already rejected by gate 1 above, MarketNotExpired.)
            require!(
                clock.unix_timestamp.saturating_sub(expiry) <= SB_SETTLE_WINDOW_SECS,
                OptaError::SwitchboardSettleWindowElapsed
            );
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
            // Freshness is the verifier's slot-based max_age (NOT a timestamp
            // gate): the quote's signed_slothash must resolve within
            // secs_to_slots(SB_SETTLE_WINDOW_SECS) of clock.slot.
            let read = sb_settlement_price_usdc(
                &queue.to_account_info(),
                &slothashes.to_account_info(),
                &instructions_ai,
                ed25519_ix_index,
                clock.slot,
                secs_to_slots(SB_SETTLE_WINDOW_SECS),
                feed_id,
                SB_MIN_ORACLE_SAMPLES_FLOOR,
            )?;
            // REPURPOSED FIELD: for a Switchboard market, the record's
            // `pyth_publish_time` holds the verifier-resolved `recent_slot` — a
            // SLOT, not a unix timestamp. Downstream (settle_vault → claims)
            // reads only `settlement_price`, so the field's meaning is free to
            // differ by source. Slots fit in i64.
            (read.price_usdc, read.recent_slot as i64)
        }
        ORACLE_SOURCE_OPTA => {
            // FP-ORACLE: PERSIST-AT-EXPIRY, structurally the Switchboard choice --
            // no history exists on an OptaPriceFeed, so settlement must land inside
            // the same SB_SETTLE_WINDOW_SECS after expiry and uses the CURRENT price,
            // which must itself be published at or after expiry (opta_price_read #3).
            require!(
                clock.unix_timestamp.saturating_sub(expiry) <= SB_SETTLE_WINDOW_SECS,
                OptaError::SwitchboardSettleWindowElapsed
            );
            let feed = ctx
                .accounts
                .opta_price_feed
                .as_ref()
                .ok_or(error!(OptaError::OptaFeedMissing))?;
            let read = opta_settlement_price_usdc(
                feed,
                feed_id,
                expiry,
                clock.unix_timestamp,
                SB_SETTLE_WINDOW_SECS,
            )?;
            (read.price_usdc, read.publish_time)
        }
        _ => return Err(error!(OptaError::InvalidOracleSource)),
    };

    // 7. Populate the record. `pyth_publish_time` = Pyth publish_time OR (SB) the
    //    quote's recent_slot — see the repurposed-field note above.
    let record = &mut ctx.accounts.settlement_record;
    record.asset_name = asset_name.clone();
    record.expiry = expiry;
    record.settlement_price = settlement_price;
    record.settled_at = clock.unix_timestamp;
    record.pyth_publish_time = publish_time_or_slot;
    record.bump = ctx.bumps.settlement_record;

    // Log the consensus-relevant outputs. The raw Pyth EMA/exponent are no
    // longer surfaced here — they live inside the source-routed price-oracle
    // helper (and would be source-specific once Switchboard is wired at Stage
    // 3); settlement_price + publish_time fully describe the recorded result.
    msg!(
        "Settlement recorded: {} expiry={} price={} (publish_time_or_slot={} source={})",
        asset_name,
        expiry,
        settlement_price,
        publish_time_or_slot,
        oracle_source,
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
    ///
    /// Stage 3 (1b): now `Option`, position unchanged. REQUIRED (present) for a
    /// Pyth market — a present price_update is wire-identical to before. A
    /// Switchboard market passes None (sentinel) and uses the trailing SB
    /// accounts. The Pyth arm errors `PriceUpdateMissing` if absent on a Pyth market.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

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

    // --- Switchboard read-arm accounts (Stage 3 1b). TRAILING optionals: a Pyth
    // market omits all three (allow-missing-optionals → None), keeping its tx
    // byte-identical. Required only when market.oracle_source == Switchboard; the
    // handler unwraps + runtime-address-checks the two sysvars. Appended AFTER
    // system_program; no existing account moved. ---
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
