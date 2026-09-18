// =============================================================================
// instructions/initialize_vol_oracle.rs -- Bootstrap a per-asset VolOracle PDA
// =============================================================================
//
// Permissionless, proof-of-feed-existence-gated. Mirrors the create_market
// post-HIGH-5 pattern (audit Run-7 PART 1): anyone can register an oracle
// for any feed_id, provided they supply a fresh PriceUpdateV2 whose
//   - verification_level == Full
//   - price_message.feed_id == arg feed_id
//
// This proves the caller-supplied feed_id corresponds to a real Pyth feed
// rather than 32 random bytes a griefer typed. Same defense-in-depth
// zero-feed reject as create_market is included.
//
// SWITCHBOARD (Stage 3 1c-i-A): the trailing `oracle_source: u8` arg picks the
// spot source the born oracle reads from (push_vol_sample routes on
// VolOracle.oracle_source — the keystone). Only ORACLE_SOURCE_PYTH (0) or
// ORACLE_SOURCE_SWITCHBOARD (1) are accepted; anything else reverts
// InvalidOracleSource. For a Switchboard oracle the feed_id holds the 32-byte
// SB feedHash (the pyth_feed_id/feedHash double-duty — no schema change).
//
// SEED-AT-BIRTH (instant-tradeable arc): init now SEEDS three fields so a
// brand-new market is priceable from minute one (price_american gates on spot +
// freshness BEFORE it reads vol, so vol alone unblocks nothing):
//   - seed_vol (NEW arg): per-asset-class default annualized σ at SCALE (1e12),
//     computed off-chain and passed in. Consumed by price_american ONLY while
//     the oracle is under-warmed (sample_count < 168); 0 = no seed (legacy).
//   - last_spot_price: read from the SAME quote that proves feed existence
//     (Pyth PriceUpdateV2 / SB signed quote), normalized to SCALE.
//   - last_sample_ts: Clock::get() at init — the freshness anchor.
//
// PROOF + SPOT, source-routed (the old Pyth-only proof now also reads spot):
//   - Pyth (0): pyth_current_spot_scale SUBSUMES the prior inline proof
//     (verification_level == Full + feed_id match) AND adds spot>0 / confidence
//     (<=200bps) / freshness (<=60s), returning the spot. price_update is
//     REQUIRED for a Pyth oracle (PriceUpdateMissing otherwise).
//   - Switchboard (1): the SB feed-existence proof is NO LONGER DEFERRED to the
//     first push — to seed spot, init verifies a fresh signed quote here via
//     sb_current_spot_scale (the same path proven live in the read arms), using
//     the 3 trailing SB accounts. A junk feedHash now fails at init
//     (SwitchboardFeedNotFound) instead of sitting inert. The Pyth call path is
//     unchanged (no SB accounts → all None).
//
// INSTRUCTION-DATA BACKWARD COMPAT: adding the trailing `oracle_source` arg
// leaves the 8-byte discriminator unchanged (derived from the name) but grows
// the Borsh arg region by 1 byte. An existing tx carrying only the 32-byte
// feed_id no longer deserializes (InstructionDidNotDeserialize). This is
// acceptable: `init` is one-time per feed (a second call reverts), every
// existing VolOracle is ALREADY initialized, and no path re-inits — so the
// break only affects NEW oracle creation going forward, never existing on-chain
// state. All off-chain callers pass ORACLE_SOURCE_PYTH (0) to preserve today's
// behavior; the change is a mechanical +1 arg at each call site.
//
// One oracle per feed_id (PDA collision otherwise). Plain `init` -- a
// second call for the same feed_id reverts with "account already in use".
//
// FIRST-PUSH INTERACTION: because init now seeds last_spot_price (non-zero) and
// last_sample_ts, the first crank push does NOT hit push_vol_sample's seed
// branch (which keys on last_spot_price == 0). Within ~55min of birth it hits
// the normal branch and reverts VolOraclePushTooSoon; past ~2h it harmlessly
// reseeds. Expected: the first realized sample is delayed up to ~55min while
// seed_vol covers pricing. This is intended — do not "fix" it.
//
// Caller pays rent (~5.7 KB account, ~0.041 SOL).
//
// Storage note: VolOracle is `#[account(zero_copy)]` because its 5760-byte
// `samples` array would overflow the BPF stack via Anchor's Borsh-backed
// `Account<T>` flow. We use `AccountLoader<T>` here and `load_init()` on
// the fresh account so bytemuck can cast the data region without a
// stack-resident copy. See state/vol_oracle.rs for the layout decision.
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::OptaError;
use crate::instructions::push_vol_sample::VOL_ORACLE_MAX_CONF_BPS;
use crate::state::{
    seed_vol_in_bounds, VolOracle, ORACLE_SOURCE_PYTH, ORACLE_SOURCE_SWITCHBOARD,
    VOL_ORACLE_PYTH_MAX_AGE_SECS, VOL_ORACLE_SEED,
};
use crate::state::opta_price_feed::{OptaPriceFeed, ORACLE_SOURCE_OPTA, OPTA_FEED_READ_MAX_AGE_SECS};
use crate::utils::opta_price_read::opta_current_spot_scale;
use crate::utils::price_oracle::{
    find_ed25519_ix_index, pyth_current_spot_scale, sb_current_spot_scale, secs_to_slots,
    SB_MIN_ORACLE_SAMPLES_FLOOR,
};

pub fn handle_initialize_vol_oracle(
    ctx: Context<InitializeVolOracle>,
    feed_id: [u8; 32],
    oracle_source: u8,
    seed_vol: i64,
) -> Result<()> {
    // 0. Validate the requested oracle source: Pyth (0), Switchboard (1) or,
    //    since the plug (wave 1), Opta (2). The arm below is what proves a
    //    source-2 feed is live; this check only keeps garbage bytes out.
    require!(
        oracle_source == ORACLE_SOURCE_PYTH
            || oracle_source == ORACLE_SOURCE_SWITCHBOARD
            || oracle_source == ORACLE_SOURCE_OPTA,
        OptaError::InvalidOracleSource
    );

    // 1. Zero-feed defense-in-depth (BOTH sources) — cheap reject before any
    //    Pyth/SB verification work below.
    require!(feed_id != [0u8; 32], OptaError::InvalidPythFeedId);

    // 1b. H-1 (Run-8) — bound the caller-supplied seed_vol. Permissionless init
    //     means an attacker could otherwise front-run a new feed and seed a tiny
    //     σ (underprice) or absurd σ (overprice) that price_american uses verbatim
    //     for the ~7-day warmup. Permit only the zero "no seed" sentinel (cold +
    //     unseeded ⇒ VolOracleWarmup, never σ=0 pricing) or [MIN_SEED_VOL,
    //     MAX_SEED_VOL]; this also rejects negatives (L-7). See state/vol_oracle.rs.
    require!(seed_vol_in_bounds(seed_vol), OptaError::SeedVolOutOfBounds);

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // 2. Existence proof + SPOT read, source-routed. Seed-at-birth: we no longer
    //    only prove the feed exists — we read its CURRENT spot and seed
    //    last_spot_price + last_sample_ts so the oracle is priceable from minute
    //    one (price_american gates on spot + freshness BEFORE it reads vol). Both
    //    arms reuse the exact proven read paths push_vol_sample uses — no new
    //    verify logic is written here.
    let new_spot_u128: u128 = match oracle_source {
        ORACLE_SOURCE_PYTH => {
            // pyth_current_spot_scale SUBSUMES the prior inline proof (checks
            // verification_level == Full + feed_id == feed_id) AND adds spot>0,
            // confidence (<=200bps), and freshness (<=60s), returning SPOT at
            // SCALE. price_update is REQUIRED for a Pyth oracle.
            let pu = ctx
                .accounts
                .price_update
                .as_ref()
                .ok_or(error!(OptaError::PriceUpdateMissing))?;
            pyth_current_spot_scale(
                pu,
                feed_id,
                now,
                VOL_ORACLE_PYTH_MAX_AGE_SECS,
                VOL_ORACLE_MAX_CONF_BPS,
            )?
        }
        ORACLE_SOURCE_SWITCHBOARD => {
            // SB existence proof UN-DEFERRED to init (was deferred to first push):
            // verify a fresh signed quote and extract the matched feed's spot at
            // SCALE via the same sb_current_spot_scale proven live in the read
            // arms. A junk feedHash now fails here (SwitchboardFeedNotFound).
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
                feed_id,
                SB_MIN_ORACLE_SAMPLES_FLOOR,
            )?
        }
        ORACLE_SOURCE_OPTA => {
            // FP-ORACLE: same proven read path push_vol_sample uses (spot at SCALE).
            let feed = ctx
                .accounts
                .opta_price_feed
                .as_ref()
                .ok_or(error!(OptaError::OptaFeedMissing))?;
            opta_current_spot_scale(feed, feed_id, now, OPTA_FEED_READ_MAX_AGE_SECS)?
        }
        _ => return Err(error!(OptaError::InvalidOracleSource)),
    };

    // Cap to i64 storage (mirrors push_vol_sample new_spot_i64). Max i64
    // ~9.2e18 covers spot up to ~$9.2M at SCALE.
    let new_spot_i64 = i64::try_from(new_spot_u128)
        .map_err(|_| error!(OptaError::MathOverflow))?;

    // 3. Populate via the zero_copy loader. `load_init` casts the zeroed data
    //    region as &mut VolOracle without deserializing (the discriminator isn't
    //    written yet). Anchor zeroes the buffer, so samples/head/sample_count/
    //    sum_* stay 0. We explicitly seed the three birth fields that make the
    //    oracle instant-tradeable:
    //      - seed_vol       : under-warmed pricing input (0 = no seed, as before)
    //      - last_spot_price: BS-2002 spot input (price_american requires > 0)
    //      - last_sample_ts : freshness anchor (price_american 6h staleness gate)
    let mut oracle = ctx.accounts.vol_oracle.load_init()?;
    oracle.feed_id = feed_id;
    oracle.bump = ctx.bumps.vol_oracle;
    oracle.oracle_source = oracle_source;
    oracle.seed_vol = seed_vol;
    oracle.last_spot_price = new_spot_i64;
    oracle.last_sample_ts = now;

    msg!(
        "VolOracle initialized: feed_id={:?} source={} seed_vol={} spot={} ts={} pda={}",
        feed_id,
        oracle_source,
        seed_vol,
        new_spot_i64,
        now,
        ctx.accounts.vol_oracle.key(),
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32], oracle_source: u8, seed_vol: i64)]
pub struct InitializeVolOracle<'info> {
    /// Permissionless. Any signer pays for account creation.
    #[account(mut)]
    pub initializer: Signer<'info>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. REQUIRED (present)
    /// for a Pyth oracle (oracle_source=0): the handler reads its CURRENT spot
    /// via `pyth_current_spot_scale` to seed `last_spot_price` AND proves feed
    /// existence (verification_level == Full + feed_id match) in the same call.
    /// Read-only -- never mutated. Passed None for a Switchboard oracle
    /// (oracle_source=1): spot is seeded from the SB quote instead. The Pyth arm
    /// errors `PriceUpdateMissing` if absent on a Pyth init.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

    /// The VolOracle PDA. One per Pyth feed_id. Plain `init` -- a second
    /// call for the same feed_id reverts ("account already in use").
    /// `AccountLoader` (not `Account`) because zero_copy: see state file.
    #[account(
        init,
        seeds = [VOL_ORACLE_SEED, feed_id.as_ref()],
        bump,
        payer = initializer,
        space = 8 + std::mem::size_of::<VolOracle>(),
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,

    pub system_program: Program<'info, System>,

    // --- Switchboard seed-at-birth accounts. TRAILING optionals: a Pyth init
    // omits all three (allow-missing-optionals → None), keeping its tx
    // byte-identical to today. Required only when oracle_source == Switchboard;
    // the handler unwraps + runtime-address-checks the two sysvars, then runs one
    // QuoteVerifier pass to prove existence AND read spot. Appended AFTER
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
