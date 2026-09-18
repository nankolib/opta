// =============================================================================
// instructions/push_vol_sample.rs -- Permissionless realized-vol sample push
// =============================================================================
//
// Crank (or anyone) calls this once per hour per feed. The handler:
//   1. Validates the Pyth PriceUpdateV2 (proof-of-feed, verification level,
//      EMA confidence interval, freshness vs Clock).
//   2. Extracts the spot price (NOT the EMA -- realized vol is computed
//      from spot returns, not smoothed returns).
//   3. Rejects zero or negative spot (ln undefined).
//   4. Branches on whether the oracle has ever been pushed to:
//      - Seed branch (last_spot_price == 0): set last_spot + last_ts only,
//        skip rate limit, skip ring write, skip accumulator update.
//      - Normal branch: enforce rate limit, compute log return, ring + acc
//        update, advance last_spot + last_ts.
//
// Permissionless. Caller pays only the tx fee; no rent (the oracle was
// pre-allocated by initialize_vol_oracle).
//
// Storage note: VolOracle is `#[account(zero_copy)]`; we use
// `AccountLoader::load_mut()` to obtain a `RefMut<VolOracle>`. The mutable
// borrow is scoped tightly so the validator doesn't hold a write lock
// longer than necessary.
//
// Algorithm cross-reference: the ring + accumulator update step is mirrored
// verbatim by the `apply` helper in `state/vol_oracle.rs`'s `#[cfg(test)]`
// module, which audits this code path against a naive O(n) recompute.
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use solmath::transcendental::ln_fixed_i;
use solmath::arithmetic::fp_div;

use crate::errors::OptaError;
use crate::state::{
    VolOracle, ORACLE_SOURCE_PYTH, ORACLE_SOURCE_SWITCHBOARD, VOL_ORACLE_MAX_SAMPLE_GAP_SECS,
    VOL_ORACLE_MIN_PUSH_INTERVAL_SECS, VOL_ORACLE_PYTH_MAX_AGE_SECS, VOL_ORACLE_RING_SIZE,
    VOL_ORACLE_SEED,
};
use crate::state::opta_price_feed::{OptaPriceFeed, ORACLE_SOURCE_OPTA, OPTA_FEED_READ_MAX_AGE_SECS};
use crate::utils::opta_price_read::opta_current_spot_scale;
use crate::utils::price_oracle::{
    find_ed25519_ix_index, pyth_current_spot_scale, sb_current_spot_scale, secs_to_slots,
    SB_MIN_ORACLE_SAMPLES_FLOOR,
};

/// EMA confidence-interval gate, in basis points of the EMA price. Same
/// 200bps threshold settle_expiry uses (audit Run-6 CRIT-2). Pyth wide-
/// confidence prints during stress events would otherwise let an attacker
/// stuff garbage returns into the buffer.
pub const VOL_ORACLE_MAX_CONF_BPS: u16 = 200;

pub fn handle_push_vol_sample(ctx: Context<PushVolSample>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // --- 1. Pyth validate (verification + feed_id + spot>0 + confidence +
    //        freshness) + spot→SCALE normalization. The full read+validate
    //        logic lives in the source-routed price-oracle abstraction
    //        (Stage 1); Pyth is the sole implementer until the Switchboard arm
    //        slots in at Stage 3. Behavior, error codes (incl. the spot>0
    //        BEFORE conf/freshness ordering), and the SPOT read match the prior
    //        inline block.
    //
    //        The oracle's feed_id is read first into a Copy local so the
    //        read-only borrow drops immediately — the load_mut below stays the
    //        only write lock, preserving the original "defer write-lock" intent.
    //        ROUTED by oracle_source (Stage 3 wiring 1a-iii) — the keystone:
    //        once an oracle is SB-sourced, last_spot_price (and the whole
    //        American pricing tree that reads it) becomes Switchboard-sourced.
    //        oracle_source rides on the VolOracle itself, read from the SAME
    //        read-only borrow that reads feed_id (no extra load, no market
    //        account). Both are Copy, so the borrow drops before load_mut below.
    let (expected_feed_id, oracle_source) = {
        let oracle = ctx.accounts.vol_oracle.load()?;
        (oracle.feed_id, oracle.oracle_source)
    };
    let new_spot_u128 = match oracle_source {
        ORACLE_SOURCE_PYTH => {
            let price_update = ctx
                .accounts
                .price_update
                .as_ref()
                .ok_or(error!(OptaError::PriceUpdateMissing))?;
            pyth_current_spot_scale(
                price_update,
                expected_feed_id,
                now,
                VOL_ORACLE_PYTH_MAX_AGE_SECS,
                VOL_ORACLE_MAX_CONF_BPS,
            )?
        }
        ORACLE_SOURCE_SWITCHBOARD => {
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
            sb_current_spot_scale(
                &queue.to_account_info(),
                &slothashes.to_account_info(),
                &instructions_ai,
                ed25519_ix_index,
                clock.slot,
                secs_to_slots(VOL_ORACLE_PYTH_MAX_AGE_SECS),
                expected_feed_id,
                SB_MIN_ORACLE_SAMPLES_FLOOR,
            )?
        }
        ORACLE_SOURCE_OPTA => {
            // FP-ORACLE: read the lane's feed. Freshness 180s (three ticks).
            let feed = ctx
                .accounts
                .opta_price_feed
                .as_ref()
                .ok_or(error!(OptaError::OptaFeedMissing))?;
            opta_current_spot_scale(feed, expected_feed_id, now, OPTA_FEED_READ_MAX_AGE_SECS)?
        }
        _ => return Err(error!(OptaError::InvalidOracleSource)),
    };

    // Cap conversion to i64 storage. Max i64 (9.2e18) accommodates spot
    // up to ~$9.2M at SCALE; BTC at $90k = 9e16 well under.
    let new_spot_i64 = i64::try_from(new_spot_u128)
        .map_err(|_| error!(OptaError::MathOverflow))?;

    // --- 3. Mutate the oracle ------------------------------------------------
    let mut oracle = ctx.accounts.vol_oracle.load_mut()?;

    // ---- 3a. Seed-push branch (CRITICAL — DO NOT collapse into normal) ----
    // Triggered when the oracle has never been pushed to (last_spot_price
    // is the default zero value from init). Rationale:
    //   - The first push has no prior spot to compute a return against;
    //     computing ln(new_spot / 0) is mathematical garbage.
    //   - The rate-limit check compares against last_sample_ts, which
    //     also reads as default zero on a fresh oracle -- making the
    //     rate-limit branch always evaluate "now - 0 >= 3300" = true,
    //     which is correct but only by accident. Skipping it explicitly
    //     documents intent.
    //   - sample_count stays at 0; the buffer is untouched. The seed
    //     push contributes to ts/spot tracking only, not to the vol
    //     estimate. The next push (after the rate-limit interval) is
    //     the first one that produces a real sample.
    //
    // A future optimization pass MUST NOT remove this branch without
    // first proving the "ln of new/0" path returns a defined value AND
    // that the resulting sample is meaningful. Both are false. Keep it.
    if oracle.last_spot_price == 0 {
        oracle.last_spot_price = new_spot_i64;
        oracle.last_sample_ts = now;
        msg!(
            "VolOracle seeded: pda={} spot={} ts={}",
            ctx.accounts.vol_oracle.key(),
            new_spot_i64,
            now,
        );
        return Ok(());
    }

    // ---- 3a-bis. Gap-reseed branch (audit AM-MED-2) -----------------------
    // If the oracle went unpushed for longer than VOL_ORACLE_MAX_SAMPLE_GAP_SECS
    // (e.g. a crank outage), the price move accumulated over that gap must NOT
    // be recorded as a single hourly log return: ln(new_spot / last_spot) over
    // a multi-period gap, annualized by sqrt(8760), injects an outlier that
    // inflates realized vol for as long as it lives in the ring (up to 30 days).
    // Instead RESEED — adopt the new spot as the baseline and record NO sample.
    // The next on-cadence push then computes a correct ~1h return off this
    // refreshed spot. Mirrors the last_spot_price == 0 seed branch above
    // (spot + ts only; ring, accumulators, and sample_count untouched).
    //
    // Placed BEFORE the rate-limit check because a gap this large trivially
    // satisfies it; the reseed is the intended action, not a normal push.
    // Note: this prevents FUTURE gap pollution; it does not clear an outlier
    // already resident in the ring from a pre-existing gap.
    if now.saturating_sub(oracle.last_sample_ts) > VOL_ORACLE_MAX_SAMPLE_GAP_SECS {
        oracle.last_spot_price = new_spot_i64;
        oracle.last_sample_ts = now;
        msg!(
            "VolOracle reseeded after gap: pda={} spot={} ts={} (no sample recorded)",
            ctx.accounts.vol_oracle.key(),
            new_spot_i64,
            now,
        );
        return Ok(());
    }

    // ---- 3b. Normal-push branch -------------------------------------------
    // 3b.i. Rate limit. With test-fast-vol the constant is 1s.
    require!(
        now.saturating_sub(oracle.last_sample_ts) >= VOL_ORACLE_MIN_PUSH_INTERVAL_SECS,
        OptaError::VolOraclePushTooSoon
    );

    // 3b.ii. Compute log return = ln(new_spot / last_spot) at SCALE.
    //        last_spot is stored as i64 but is provably positive (set in
    //        the seed branch from a `price > 0` validated value), so
    //        casting to u128 for fp_div is safe.
    let last_spot_u128 = oracle.last_spot_price as u128;
    let quotient = fp_div(new_spot_u128, last_spot_u128)
        .map_err(|_| error!(OptaError::MathOverflow))?;
    let log_return_i128 = ln_fixed_i(quotient)
        .map_err(|_| error!(OptaError::MathOverflow))?;
    let log_return_i64 = i64::try_from(log_return_i128)
        .map_err(|_| error!(OptaError::MathOverflow))?;

    // 3b.iii. Ring buffer + O(1) accumulator update.
    //         Cross-reference: replicated by `apply()` in state/vol_oracle.rs
    //         #[cfg(test)] module, which audits this against naive recompute.
    apply_normal_push(&mut oracle, log_return_i64);

    // 3b.iv. Advance the rolling state.
    oracle.last_spot_price = new_spot_i64;
    oracle.last_sample_ts = now;

    msg!(
        "VolOracle pushed: pda={} spot={} log_return={} sample_count={}",
        ctx.accounts.vol_oracle.key(),
        new_spot_i64,
        log_return_i64,
        oracle.sample_count,
    );
    Ok(())
}

/// Apply a log_return to the ring + accumulators. Pure mutation; no
/// validation. Extracted so the cu-profile instruction can measure the
/// hot path without the rate-limit + Pyth-validation overhead.
///
/// Mirrors the `apply()` test helper in state/vol_oracle.rs verbatim.
/// Any divergence here from that helper invalidates the unit-test audit.
pub fn apply_normal_push(oracle: &mut VolOracle, log_return: i64) {
    let lr_i128 = log_return as i128;
    if oracle.sample_count < VOL_ORACLE_RING_SIZE {
        oracle.samples[oracle.head as usize] = log_return;
        oracle.sum_log_returns += lr_i128;
        oracle.sum_log_returns_sq += lr_i128 * lr_i128;
        oracle.head = (oracle.head + 1) % VOL_ORACLE_RING_SIZE;
        oracle.sample_count += 1;
    } else {
        let evicted = oracle.samples[oracle.head as usize] as i128;
        oracle.sum_log_returns -= evicted;
        oracle.sum_log_returns_sq -= evicted * evicted;
        oracle.samples[oracle.head as usize] = log_return;
        oracle.sum_log_returns += lr_i128;
        oracle.sum_log_returns_sq += lr_i128 * lr_i128;
        oracle.head = (oracle.head + 1) % VOL_ORACLE_RING_SIZE;
    }
}

#[derive(Accounts)]
pub struct PushVolSample<'info> {
    /// Permissionless. Pays the tx fee only.
    pub signer: Signer<'info>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. Validated
    /// against the oracle's feed_id and the 60s freshness window.
    ///
    /// Stage 3 (1a-iii): now `Option`, position unchanged. REQUIRED (present)
    /// for a Pyth-sourced oracle. A Switchboard-sourced oracle passes None
    /// (sentinel) and uses the trailing SB accounts. The Pyth arm errors
    /// `PriceUpdateMissing` if absent on a Pyth oracle.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

    /// The VolOracle PDA. Mutated. PDA-validated against the price
    /// update's feed_id via the `seeds` constraint here; the handler
    /// re-checks the proof against price_update.price_message.feed_id
    /// for defense-in-depth against passing a stale PriceUpdateV2 from
    /// a different feed.
    #[account(
        mut,
        seeds = [VOL_ORACLE_SEED, vol_oracle.load()?.feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,

    pub system_program: Program<'info, System>,

    // --- Switchboard read-arm accounts (Stage 3 1a-iii). TRAILING optionals: a
    // Pyth oracle omits all three (allow-missing-optionals → None), keeping its
    // tx byte-identical. Required only when vol_oracle.oracle_source ==
    // Switchboard; the handler unwraps + runtime-address-checks the two sysvars.
    // Appended AFTER system_program; no existing account moved. ---
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
