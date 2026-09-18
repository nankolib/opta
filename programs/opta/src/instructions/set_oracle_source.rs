// =============================================================================
// instructions/set_oracle_source.rs -- flip a market's oracle lane (admin-only)
// =============================================================================
//
// WHY THIS IS NOT `set_market_oracle`. `oracle_source` is stored in TWO places
// that are independent at rest:
//
//   OptionsMarket.oracle_source  -> drives settle_expiry, exercise_american,
//                                   execute_trigger, and the create_market
//                                   HIGH-5 proof.
//   VolOracle.oracle_source      -> drives push_vol_sample. The push_vol_sample
//                                   comment calls it "the keystone".
//
// Writing only the market produces a market that SETTLES from one source while
// its vol oracle is still WARMED from another — mixed provenance across the
// pricing inputs. The failure is silent: quotes keep working, the board looks
// healthy, and the two halves of the price disagree in a way nothing surfaces.
// That is why this instruction takes both accounts and writes both bytes, or
// neither, and why it is named for the pair rather than for the market.
//
// BREAKS A DOCUMENTED INVARIANT (spec 1c). Until now oracle_source was
// write-once: only create_market set it, and close-and-recreate was the only
// migration path (that is why SBXAU and XAUSMOKE exist as separate markets).
// This instruction makes it mutable, deliberately. Anything elsewhere that
// assumed immutability is now wrong and is an explicit audit item.
//
// -----------------------------------------------------------------------------
// R1 OPEN-COLLATERAL GUARD -- AND ITS HONEST LIMIT. READ BEFORE RELYING ON IT.
// -----------------------------------------------------------------------------
// The ruling is "refuse the flip on open collateral": changing the settlement
// basis under a live contract is a material change to an instrument someone
// already holds.
//
// What this instruction CAN enforce: every SharedVault passed in
// `remaining_accounts` belongs to this market and is clean (settled, voided, or
// holding zero collateral).
//
// What it CANNOT enforce: that the caller passed them ALL. Vault PDAs are
// derived per (market, type, strike, expiry, style) and cannot be enumerated
// on-chain; OptionsMarket carries no open-vault counter, and adding one would
// mean a realloc migration plus edits to the mint and settle hot paths — a much
// larger and riskier change than the guard is worth.
//
// So this is a FAT-FINGER GUARD, not a trustless invariant. Completeness comes
// from the ceremony: the flip script enumerates the market's vaults by
// getProgramAccounts and passes every one, exactly as the reclaim sweep already
// does. On-chain we get "nothing you showed me is live"; off-chain we get "I
// showed you everything". The admin is already trusted with program upgrade, so
// the residual trust added here is nil — but the guard must not be described in
// the audit as something stronger than it is.
//
// `vault_count` is echoed in the log so the ceremony's off-chain enumeration and
// the on-chain check can be reconciled after the fact from the tx alone.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{
    OptionsMarket, ProtocolState, SharedVault, VolOracle, MARKET_SEED, PROTOCOL_SEED,
    VOL_ORACLE_SEED,
};
use crate::state::opta_price_feed::{OptaPriceFeed, ORACLE_SOURCE_OPTA, OPTA_FEED_READ_MAX_AGE_SECS};
use crate::utils::opta_price_read::opta_prove_feed_exists;
use crate::state::market::{ORACLE_SOURCE_PYTH, ORACLE_SOURCE_SWITCHBOARD};

pub fn handle_set_oracle_source<'info>(
    ctx: Context<'_, '_, '_, 'info, SetOracleSource<'info>>,
    _asset_name: String,
    _feed_id: [u8; 32],
    new_source: u8,
) -> Result<()> {
    // Only the three known sources. The wildcard that keeps legacy
    // garbage-byte markets fail-closed must never be reachable through here.
    require!(
        new_source == ORACLE_SOURCE_PYTH
            || new_source == ORACLE_SOURCE_SWITCHBOARD
            || new_source == ORACLE_SOURCE_OPTA,
        OptaError::InvalidOracleSource
    );

    let market_key = ctx.accounts.market.key();

    // ---- D1 GUARD: a flip to Opta is refused unless the feed is serviceable ----
    // BEGIN D1-GUARD (mutation target: scripts/fp-oracle-guard-mutation.sh)
    // "Structural beats procedural" (plug proposal D1). The value 2 is accepted
    // above only because the six read arms now exist; this guard makes the
    // ordering hazard in proposal 1.2 impossible at RUNTIME too: you cannot point
    // a market at an OptaPriceFeed that is absent, wrong-id, frozen, never
    // pushed, or not fresh. A flip that passed here lands on a feed the read
    // arms can serve THIS MINUTE, so the flip itself cannot brick the market.
    if new_source == ORACLE_SOURCE_OPTA {
        let feed = ctx
            .accounts
            .opta_price_feed
            .as_ref()
            .ok_or(error!(OptaError::OptaFeedMissing))?;
        opta_prove_feed_exists(feed, _feed_id)?;
        feed.assert_readable(Clock::get()?.unix_timestamp, OPTA_FEED_READ_MAX_AGE_SECS)?;
    }
    // END D1-GUARD

    // ---- R1 guard: no supplied vault may hold live collateral ---------------
    // Every remaining account must deserialize as a SharedVault of THIS market.
    // A foreign or undecodable account is a caller error, not something to skip:
    // silently ignoring it would let the ceremony "prove" cleanliness with junk.
    let mut vault_count: u64 = 0;
    for acct in ctx.remaining_accounts.iter() {
        require_keys_eq!(*acct.owner, crate::ID, OptaError::Unauthorized);
        let data = acct.try_borrow_data()?;
        let vault = SharedVault::try_deserialize(&mut &data[..])
            .map_err(|_| error!(OptaError::Unauthorized))?;
        require_keys_eq!(vault.market, market_key, OptaError::Unauthorized);

        // Clean means: already settled, voided, or never collateralised. A
        // settled vault's basis is fixed in its SettlementRecord and cannot be
        // changed by a later flip, so it is safe.
        let clean = vault.is_settled || vault.voided || vault.total_collateral == 0;
        require!(clean, OptaError::MarketHasOpenCollateral);
        vault_count += 1;
    }

    // ---- Write BOTH bytes, or neither ---------------------------------------
    let previous_market = ctx.accounts.market.oracle_source;
    let previous_oracle = ctx.accounts.vol_oracle.load()?.oracle_source;

    ctx.accounts.market.oracle_source = new_source;
    {
        let mut oracle = ctx.accounts.vol_oracle.load_mut()?;
        oracle.oracle_source = new_source;
    }

    // Post-condition, asserted rather than assumed. If these ever disagree the
    // whole point of the instruction has been defeated, so prove it before
    // returning rather than trusting the two writes above.
    require!(
        ctx.accounts.market.oracle_source == ctx.accounts.vol_oracle.load()?.oracle_source,
        OptaError::OracleSourceMismatch
    );

    msg!(
        "oracle_source flipped: market={} vol_oracle={} {}->{} (vol_oracle was {}) vaults_checked={}",
        market_key,
        ctx.accounts.vol_oracle.key(),
        previous_market,
        new_source,
        previous_oracle,
        vault_count,
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String, feed_id: [u8; 32])]
pub struct SetOracleSource<'info> {
    #[account(address = protocol_state.admin @ OptaError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [MARKET_SEED, asset_name.as_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, OptionsMarket>,

    /// The vol oracle for this market's feed. Required, not optional: the whole
    /// contract of this instruction is that the pair moves together.
    #[account(
        mut,
        seeds = [VOL_ORACLE_SEED, feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,

    /// FP-ORACLE D1 guard input. Trailing optional: REQUIRED when new_source ==
    /// ORACLE_SOURCE_OPTA (OptaFeedMissing otherwise); ignored for 0/1. Must be
    /// the feed for `feed_id` (identity asserted), unfrozen, pushed, and fresh.
    pub opta_price_feed: Option<Account<'info, OptaPriceFeed>>,
    // remaining_accounts: every SharedVault of `market`. See the R1 note above
    // for what this does and does not prove.
}
