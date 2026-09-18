// =============================================================================
// errors.rs — Custom error codes for the Opta protocol
// =============================================================================
//
// Stage 2 prune: v1-only variants removed. New variants added for asset
// registry validation and (Stage 3) collateral mint validation.
// =============================================================================

use anchor_lang::prelude::*;

#[error_code]
pub enum OptaError {
    // Protocol errors
    #[msg("Unauthorized: signer is not the protocol admin")]
    Unauthorized,

    // Market / asset registry errors
    #[msg("Expiry timestamp must be in the future")]
    ExpiryInPast,
    #[msg("Strike price must be greater than zero")]
    InvalidStrikePrice,
    #[msg("Asset name must be 1-16 ASCII uppercase letters or digits")]
    InvalidAssetName,
    #[msg("Asset class must be 0-4 (crypto, commodity, equity, forex, etf)")]
    InvalidAssetClass,
    #[msg("Market already exists for this asset with different metadata")]
    AssetMismatch,
    #[msg("Market has not expired yet")]
    MarketNotExpired,
    #[msg("Market has not been settled yet")]
    MarketNotSettled,
    #[msg("Settlement price must be greater than zero")]
    InvalidSettlementPrice,

    // Collateral / vault validation
    #[msg("Collateral mint must be the protocol's USDC mint")]
    UnsupportedCollateral,

    // Position / contract errors (still used by v2 vault flow)
    #[msg("Insufficient collateral for this option")]
    InsufficientCollateral,
    #[msg("Contract size must be greater than zero")]
    InvalidContractSize,
    #[msg("Premium must be greater than zero")]
    InvalidPremium,

    // Authorization errors
    #[msg("Only the writer can perform this action")]
    NotWriter,
    #[msg("Cannot buy your own option")]
    CannotBuyOwnOption,

    // Token errors
    #[msg("Insufficient option tokens to exercise")]
    InsufficientOptionTokens,

    // Pricing / oracle errors (used by surviving solmath_bridge)
    #[msg("Option has already expired — cannot price")]
    OptionExpired,

    // Math errors
    #[msg("Arithmetic overflow")]
    MathOverflow,

    // =========================================================================
    // Shared Vault errors (v2 liquidity system)
    // =========================================================================
    #[msg("Custom vaults only allow the original creator to deposit")]
    CustomVaultSingleWriter,

    #[msg("Vault has been settled, no more deposits allowed")]
    VaultAlreadySettled,

    #[msg("Vault expiry has passed")]
    VaultExpired,

    #[msg("Invalid epoch expiry - must fall on configured day and hour")]
    InvalidEpochExpiry,

    #[msg("Insufficient free collateral in writer's vault position")]
    InsufficientVaultCollateral,

    #[msg("Collateral is committed to active options and cannot be withdrawn")]
    CollateralCommitted,

    #[msg("No unsold tokens to burn")]
    NoTokensToBurn,

    #[msg("Nothing to claim - all premium already withdrawn")]
    NothingToClaim,

    #[msg("Premium exceeds buyer's maximum (slippage protection)")]
    SlippageExceeded,

    #[msg("Vault not yet settled")]
    VaultNotSettled,

    #[msg("Option is not in the money - cannot exercise")]
    OptionNotInTheMoney,

    #[msg("Option mint does not belong to this vault")]
    InvalidVaultMint,

    #[msg("Claim all premium before withdrawing shares")]
    ClaimPremiumFirst,

    #[msg("remaining_accounts length must be a multiple of 2 (holder_option_ata, holder_usdc_ata pairs)")]
    InvalidBatchAccounts,

    #[msg("writer_position.vault does not match the shared_vault passed to this instruction")]
    WriterPositionVaultMismatch,

    #[msg("writer_wallet pubkey does not match writer_position.owner — refusing to drain rent to a stranger")]
    WriterWalletMismatch,

    // =========================================================================
    // V2 secondary listing errors
    // =========================================================================
    #[msg("listing has fewer tokens available than requested")]
    ListingExhausted,

    #[msg("only the listing's seller can cancel it")]
    NotResaleSeller,

    #[msg("listing escrow does not belong to this vault")]
    InvalidListingEscrow,

    #[msg("listing PDA derivation failed or its mint/vault doesn't match the batch")]
    ListingMismatch,

    // =========================================================================
    // Pyth settlement window (settle_expiry, D2 of pricing-fix arc)
    // =========================================================================
    #[msg("Pyth price update publish_time is before vault expiry")]
    PriceUpdateBeforeExpiry,

    #[msg("Pyth price update publish_time is more than 60s after vault expiry")]
    PriceUpdateTooFarFromExpiry,

    #[msg("Pyth EMA confidence interval exceeds MAX_CONF_BPS at settlement")]
    PriceConfidenceTooWide,

    // =========================================================================
    // Holder exercise window (CRIT-1 audit-fix arc, Run-6)
    // =========================================================================
    // Writers must wait EXERCISE_WINDOW seconds after vault.expiry before
    // calling withdraw_post_settlement / auto_finalize_writers, unless the
    // vault never sold any options (total_options_sold == 0). This prevents
    // the writer-drains-before-holders-exercise race where holders' payouts
    // get capped to a vault that's already been emptied.
    #[msg(
        "Holder exercise window still open — writers must wait until \
         vault.expiry + EXERCISE_WINDOW before withdrawing"
    )]
    HolderExerciseWindowOpen,

    // =========================================================================
    // Zero-feed grief guard (HIGH-2 + HIGH-3 audit-fix arc, Run-7)
    // =========================================================================
    // Rejected at create_market, create_shared_vault, and migrate_pyth_feed.
    // The all-zeros feed_id is the default sentinel value of [u8; 32] — a
    // common admin fat-finger and the registration-name griefer's lowest-
    // friction lock. Real Pyth feed IDs are random 32-byte values and
    // never collide with this.
    #[msg("Pyth feed ID cannot be all zeros — register a real feed")]
    InvalidPythFeedId,

    // =========================================================================
    // VolOracle errors (Phase 2 Stage B)
    // =========================================================================
    // VolOracleNotInitialized is returned by realized_vol_annualized when
    // its caller passes an uninitialized account; Stage C's
    // create_shared_vault will surface this on the American branch.
    // VolOracleWarmup / VolOracleStale gate the read path.
    // VolOraclePushTooSoon / VolOraclePriceStale gate the push path.
    #[msg("VolOracle account not initialized for this asset")]
    VolOracleNotInitialized,

    #[msg("VolOracle in warmup — needs 168 samples (7 days) before reads are valid")]
    VolOracleWarmup,

    #[msg("VolOracle stale — most recent sample is older than 6 hours")]
    VolOracleStale,

    #[msg("VolOracle push too soon — must wait at least 55 minutes since last push")]
    VolOraclePushTooSoon,

    #[msg("Pyth price update for vol push is older than 60 seconds")]
    VolOraclePriceStale,

    #[msg("Pyth spot price for vol push is zero or negative")]
    VolOracleInvalidSpot,

    #[msg("VolOracle math error (sqrt domain, division-by-zero, or overflow)")]
    VolOracleMathError,

    // Phase 2 Stage C Pass 2 — American on-chain pricing.
    // Single wrapper for any BS-2002 internal error (InvalidSpot,
    // InvalidStrike, InvalidCarry, BoundaryOverflow, SolMath). The raw
    // variant is logged via msg! at the call site for diagnostics; the
    // 5 underlying variants are defensive on validated inputs and do not
    // warrant individual IDL surface area.
    #[msg("American BS-2002 pricing failed — see tx log for raw variant")]
    AmericanPricingFailed,

    // Phase 2 Stage C Pass 3 — get_option_price view.
    // The view instruction does not price European options on-chain; the
    // off-chain pricer (app/src/utils/blackScholes.ts) is the canonical
    // EUR source and avoids burning CU on a value the client already has.
    #[msg("get_option_price view does not support European style; use frontend pricer")]
    ViewNotSupportedForEuropean,

    // Phase 2 Stage D — American vaults feature gate.
    // Returned by the American arm of create_shared_vault and mint_from_vault
    // when feature_flags::AMERICAN_ENABLED is false (the default until Stage I).
    // European arms NEVER reference the flag, so this can only surface on
    // American vaults. Error code 6052.
    #[msg("American vaults are disabled — AMERICAN_ENABLED is false (flip at Stage I)")]
    AmericanVaultsDisabled,

    // Phase 2 Stage F — early American exercise.
    // Returned by exercise_american when the vault's exercise_style is
    // European (early exercise is an American-only feature). Error code 6053.
    #[msg("Option is not American-style — early exercise is not available")]
    NotAmericanOption,

    // =========================================================================
    // Exchange book errors (Phase 1 — RestingOrder limit book)
    // =========================================================================
    // Phase 3 Slice A: WriterAsk posting (lock-at-post personal collateral) is
    // gated by feature_flags::WRITER_ASKS_ENABLED — true only under the `testing`
    // feature, false on a feature-free production build (the dark gate). The
    // post_order WriterAsk arm guards on it with this error; fill_order /
    // cancel_order / sweep_expired_orders still reject WriterAsk with it until
    // Slices B/C land. Repurposed as the dark gate, not retired. Error code 6054.
    #[msg("Writer asks are not enabled in this build (dark gate) — see WRITER_ASKS_ENABLED")]
    WriterAsksDisabled,

    // =========================================================================
    // Exchange series errors (Phase 2 Pass A — canonical series mint)
    // =========================================================================
    // D12 — Phase 2 series mints are American-only; create_series rejects
    // European. European series ride the European arc. Error code 6055.
    #[msg("Series mints are American-only in Phase 2 (D12)")]
    SeriesMustBeAmerican,

    // Phase 2 Pass B — vault peg fill (fill_vault_peg).
    // A vault reclaimed via the dead-feed hatch (reclaim_unsettled, Pass D)
    // sets `voided = true`; it pays holders nothing and writers pro-rata. No
    // fill path may treat `voided` as tradeable (spec v1.1 invariant #6).
    // fill_vault_peg gates on it forward-safely (nothing sets voided until
    // Pass D, but the block ships now). Error code 6056.
    #[msg("Vault has been voided via the dead-feed hatch — no peg fills")]
    VaultVoided,

    // =========================================================================
    // Dead-feed hatch errors (Phase 2 Pass D — reclaim_unsettled)
    // =========================================================================
    // The hatch is callable ONLY when settlement provably never happened: the
    // per-(asset, expiry) SettlementRecord PDA must NOT exist. If it does, the
    // feed produced a price and the normal settle/withdraw path applies — the
    // hatch reverts forever. Error code 6057.
    #[msg("Settlement record exists — vault is settleable, the dead-feed hatch is forbidden")]
    SettlementRecordExists,

    // The hatch only opens once the 7-day GRACE_WINDOW has elapsed past expiry,
    // giving the settle crank time to recover from transient feed-archive gaps
    // before collateral can be reclaimed. Error code 6058.
    #[msg("Dead-feed grace window has not elapsed yet")]
    GracePeriodNotElapsed,

    // =========================================================================
    // Trigger orders (Phase 4 — TP/SL + stop-entry)
    // =========================================================================
    // DECLARED in Pass 0; first USED by execute_trigger (Pass 1). The keeper's
    // off-chain price assertion is never trusted: execute_trigger re-reads a
    // fresh Pyth EMA in-tx and reverts this when the live EMA does not satisfy
    // the trigger's stored comparator against threshold_usdc. Error code 6059.
    #[msg("Trigger condition not met — live price does not satisfy the stored comparator")]
    TriggerConditionNotMet,

    // execute_trigger fire-time re-verification (Pass 1). The SELL burn source is
    // a STORED address; before the delegate-burn, execute_trigger re-asserts the
    // declared holder_option_ata's owner == trigger.owner and mint ==
    // trigger.option_mint. A mismatch (re-init'd account, hostile/stale address)
    // reverts this. The theft-vector guard. Error code 6060.
    #[msg("Trigger source ATA failed fire-time re-verification (owner or mint mismatch)")]
    TriggerSourceAtaInvalid,

    // =========================================================================
    // Switchboard On-Demand read arm (Stage 3 — oracle_source routing)
    // =========================================================================
    // The QuoteVerifier (queue + SlotHashes + Instructions sysvar + clock_slot +
    // max_age) failed to verify the ed25519-signed oracle quote: signature/
    // slothash mismatch, quote older than max_age slots, or no ED25519 ix at the
    // given index. Maps the crate's anyhow error to a stable Opta code (the crate
    // error carries no discriminant we can surface on-chain). Error code 6061.
    #[msg("Switchboard quote verification failed (signature, slothash, freshness, or missing ED25519 ix)")]
    SwitchboardVerifyFailed,

    // The verified quote contained no feed whose feed_id matches the market's
    // expected oracle id. INERT until Stage 3 routes a market to Switchboard.
    // Error code 6062.
    #[msg("Switchboard quote does not contain the expected feed_id")]
    SwitchboardFeedNotFound,

    // The matched feed reported fewer aggregating oracle samples than the
    // SB_MIN_ORACLE_SAMPLES_FLOOR floor — the Switchboard analog of Pyth's
    // confidence-width gate (a thin multi-oracle quote is rejected). Error code
    // 6063.
    #[msg("Switchboard feed has fewer oracle samples than the required floor")]
    SwitchboardInsufficientSamples,

    // =========================================================================
    // Oracle-source routing (Stage 3 wiring) — the match arm guards
    // =========================================================================
    // A Pyth-sourced market routed to the Pyth arm but the optional price_update
    // account was absent (None). The price update is required for Pyth markets;
    // only Switchboard markets omit it. Error code 6064.
    #[msg("Pyth market requires the price_update account, but it was not provided")]
    PriceUpdateMissing,

    // A Switchboard-sourced market routed to the SB arm but one or more of the
    // trailing SB accounts (queue / SlotHashes sysvar / Instructions sysvar) was
    // absent. All three are required when oracle_source == Switchboard. Error
    // code 6065.
    #[msg("Switchboard market requires the queue + SlotHashes + Instructions accounts")]
    SwitchboardAccountsMissing,

    // market.oracle_source held a value that is neither Pyth (0) nor Switchboard
    // (1). Unreachable for well-formed markets (create_market pins Pyth; the only
    // other writer is the migration zero-fill) — fail-closed guard. Error code 6066.
    #[msg("Unknown oracle_source value on the market")]
    InvalidOracleSource,

    // The SB arm scanned the Instructions sysvar and found no ED25519 precompile
    // instruction in the current transaction. The caller must prepend the
    // Switchboard ed25519 verify instruction. Error code 6067.
    #[msg("No ED25519 instruction found in the transaction for Switchboard verification")]
    NoEd25519Instruction,

    // A SB account whose address is fixed (the SlotHashes or Instructions sysvar)
    // did not match its canonical pubkey. Runtime-checked in the SB arm because a
    // struct-level address constraint would fire on the absent-optional Pyth path.
    // Error code 6068.
    #[msg("Switchboard sysvar account address mismatch (SlotHashes or Instructions)")]
    InvalidSwitchboardSysvar,

    // settle_expiry SB arm: the settlement window elapsed. Unlike Pyth (which
    // settles on a HISTORICAL at-expiry price and has a 30-day window to run),
    // Switchboard has no historical lookback (the ~512-slot SlotHashes wall), so
    // an SB market must be settled within SB_SETTLE_WINDOW_SECS (5 min) of expiry
    // while a fresh quote is still verifiable. Missing the window leaves no
    // SettlementRecord → the reclaim_unsettled 7-day hatch winds the vault down.
    // Error code 6069.
    #[msg("Switchboard settlement window elapsed — settle within 5 min of expiry or reclaim after grace")]
    SwitchboardSettleWindowElapsed,

    // =========================================================================
    // Exchange writer-ask fill (Phase 3 Slice B — fill_writer_ask)
    // =========================================================================
    // The RestingOrder PDA seed is shared across kinds, so a Bid/ResaleAsk order
    // could be passed to fill_writer_ask. Its collateral_per_contract is 0, which
    // would mint uncollateralized contracts — fail closed. Error code 6070.
    #[msg("Order is not a writer ask — fill it through fill_order")]
    NotAWriterAsk,

    // Money-conservation guard on the full-fill close path: every micro-USDC of
    // the per-order escrow must have moved into the WriterAskPot before the
    // escrow is closed. A non-zero balance (accounting bug or dust-grief) blocks
    // the close explicitly rather than relying on close_account's implicit
    // non-empty revert. Error code 6071.
    #[msg("Per-order escrow is not empty — collateral did not fully move to the pot")]
    EscrowNotEmpty,

    // =========================================================================
    // Exchange writer-ask settlement sweep (Phase 3 Slice D1 — settle_vault)
    // =========================================================================
    // The pot sweep is all-or-nothing: if the writer_ask_pot is present, the
    // other sweep accounts (pot USDC, vault USDC, protocol_state, token program)
    // MUST also be present. ALSO raised if the pot USDC balance is below
    // pot.total_collateral (the counter that becomes the frozen residual
    // denominator) — fail closed rather than freeze an over-credited denominator.
    // Error code 6072.
    #[msg("Writer-ask pot sweep accounts missing or pot USDC balance below the recorded counter")]
    WriterAskSweepAccountsMissing,

    // =========================================================================
    // Exchange writer-ask residual + vault close (Phase 3 Slice D2a)
    // =========================================================================
    // close_settled_writer_ask_vault scope guard: the vault carries no writer-ask
    // collateral (writer_ask_collateral_swept == 0), so this is a pool-only / EUR
    // vault — its USDC is closed by the pooled withdraw_post_settlement /
    // auto_finalize_writers last-writer path, not here. Error code 6073.
    #[msg("Not a writer-ask vault — pool-only/EUR vaults close via the pooled last-writer path")]
    NotAWriterAskVault,

    // close_settled_writer_ask_vault EXACT all-drained precondition: total_shares
    // must be 0. While ANY claimant is owed (a pool WriterPosition with shares > 0
    // or an unclaimed WriterAskPosition with collateral_committed > 0) its weight
    // is still in total_shares ⇒ total_shares > 0 ⇒ close is refused. It is
    // therefore impossible to close a vault that still owes a claimant. A mixed
    // pool+writer-ask vault whose pool ratio drifted (truncated partial withdrawal)
    // can land at total_shares == D > 0 floor-dust → close never fires: a SAFE
    // under-close (rent stranded, no claimant harmed), reclaimable later by a
    // future admin force-close. Error code 6074.
    #[msg("Vault not fully drained — total_shares must be 0 before the writer-ask vault USDC can be closed")]
    VaultNotFullyDrained,

    // =========================================================================
    // Exchange writer-ask canonical-mint pin (Phase 3 Slice D2.5)
    // =========================================================================
    // A WriterAsk may only rest on the CANONICAL create_series mint (its VaultMint
    // record sentinels writer == Pubkey::default). A per-writer mint_from_vault
    // record (writer == the minter) is rejected: its pot would be keyed by a mint
    // NOT derivable from vault identity, so the void-path reconciliation (D3's
    // initialize_void, which derives the canonical pot) could never reach it →
    // stranded collateral. post_order pins it; fill_writer_ask mirrors it. Error
    // code 6075.
    #[msg("Writer asks may only be posted on a canonical create_series mint")]
    CanonicalMintRequired,

    // =========================================================================
    // Exchange void-path reconciliation (Phase 3 Slice D3)
    // =========================================================================
    // The void path is two-phase: `initialize_void` is the SOLE setter of
    // `voided` (it atomically sweeps the canonical pot, applies the
    // shares-unification merge, seeds collateral_remaining, and flips voided),
    // and BOTH reclaim paths (reclaim_unsettled for pool writers,
    // reclaim_writer_ask_residual for backers) require voided == true. This error
    // fires when a reclaim is attempted on a vault that has not been
    // initialize_void'd yet — guaranteeing no claim runs against a
    // voided-but-unmerged vault. Error code 6076.
    #[msg("Vault not voided — call initialize_void first")]
    VaultNotVoided,

    // =========================================================================
    // Exchange fill_order theft guard (Run-8 C-1)
    // =========================================================================
    // fill_order's Bid arm delivers the taker's option tokens to
    // maker_option_account and pays the taker the bidder's escrowed USDC.
    // Token-2022 transfer_checked validates only the destination's mint/
    // decimals, NOT its ownership — so an unpinned destination let the taker
    // pass their OWN account (a self-transfer that keeps the tokens) while still
    // draining the bid escrow. fill_order now reads owner(32..64)+mint(0..32)
    // from the raw account layout and reverts this if either does not match
    // (order.owner, order.option_mint). Error code 6077.
    #[msg("maker_option_account failed owner/mint pin (owner != order.owner or mint != order.option_mint)")]
    MakerOptionAccountInvalid,

    // =========================================================================
    // VolOracle seed bound (Run-8 H-1)
    // =========================================================================
    // initialize_vol_oracle / reset_vol_oracle reject a caller-supplied seed_vol
    // that is neither the zero "no seed" sentinel nor within [MIN_SEED_VOL,
    // MAX_SEED_VOL] (0.05..2.0 annualized σ at SCALE). An unbounded seed poisons
    // American premiums for the ~7-day warmup. Error code 6078.
    #[msg("seed_vol out of bounds — must be 0 (no seed) or within [MIN_SEED_VOL, MAX_SEED_VOL]")]
    SeedVolOutOfBounds,

    // B0: StopLossSell is appended to TriggerKind but its book fire path is DARK
    // until B2. execute_trigger rejects it defensively (no vault path exists for
    // an OTM sell). Append-only — error code 6079.
    #[msg("StopLossSell trigger is not yet enabled (dark until the book sell path lands in B2)")]
    StopLossSellDark,

    // B1: a book StopEntryBuy fire was handed an ask whose per-contract price
    // exceeds the trigger's max_premium ceiling. The keeper must only lift asks
    // within the bound; this is the on-chain backstop. Append-only — code 6080.
    #[msg("Ask price exceeds the trigger's per-contract max_premium ceiling")]
    AskPriceExceedsMax,

    // B2: a sell-leg book fire was handed a resting order that is not a Bid. The
    // sell path can ONLY lift the bid side (a sell into an ask is not a fill), so
    // this is fail-closed rather than a silent skip — a non-Bid in the book slot
    // is a keeper bug, not a market condition. Append-only — error code 6081.
    #[msg("Sell-leg book fire requires a Bid resting order")]
    NotABid,

    // B2: a sell trigger reached the book path carrying max_premium == 0 — i.e.
    // no stored per-contract minimum-proceeds floor. execute_trigger is
    // PERMISSIONLESS, so without a floor any caller could post a dust bid and
    // fire the owner's stop-loss into it. Floor 0 therefore means "book
    // ineligible": the trigger keeps its vault fallback (TakeProfitSell) or stays
    // unfireable (StopLossSell) rather than becoming free money for a keeper.
    // Every pre-B2 sell trigger stored 0, so this is also the migration guard.
    // Append-only — error code 6082.
    #[msg("Sell trigger has no minimum-proceeds floor (max_premium == 0) — book fire refused")]
    SellFloorRequired,

    // B2: the bid handed to a sell-leg fire prices below the owner's stored
    // per-contract floor. REVERT, not skip: the keeper CHOSE this bid, so a
    // below-floor bid is keeper error or an attack, never a benign market state
    // (mirrors AskPriceExceedsMax / 6080 on the buy side). Append-only — 6083.
    #[msg("Bid price is below the sell trigger's per-contract minimum-proceeds floor")]
    BidPriceBelowMin,

    // Early exercise needed more than the vault's own USDC account holds and the
    // writer-ask pot accounts were not supplied. On a series funded entirely by
    // writer asks the vault account is empty by construction, so this is the
    // normal "client did not pass the optionals" case, not a shortfall.
    // Append-only — error code 6084.
    #[msg("Early exercise needs the writer-ask pot accounts for this series")]
    EarlyExercisePotRequired,

    // The pot cannot cover the shortfall. Unreachable by construction — intrinsic
    // is capped at collateral_per_contract and the pot holds cpt x contracts — so
    // this firing means an invariant broke, and reverting is the only safe answer.
    // Append-only — error code 6085.
    #[msg("Writer-ask pot cannot fund this early exercise")]
    EarlyExercisePotUnderfunded,

    // ---- 2A: contract tape + OCO (append-only) ----------------------------
    // Contract tape is re-checked with `price_american`, the only on-chain
    // pricer, which is American-only. Rejected at PLACEMENT, not at fire: an
    // order that can never legally fire looks armed to its owner.
    // Append-only — error code 6086.
    #[msg("Contract-tape triggers require an American series")]
    ContractTapeRequiresAmerican,

    // The trigger carries an oco_link but the paired TriggerOrder account was
    // not supplied. Firing without it would leave the sibling leg armed, which
    // is the double-exit this design exists to prevent, so it reverts.
    // Append-only — error code 6087.
    #[msg("Trigger has an OCO link but the paired trigger account was not supplied")]
    OcoPeerRequired,

    // The supplied peer is not the linked one, or does not link back, or belongs
    // to another owner. A mismatched peer would let a caller decrement an
    // unrelated stranger's trigger, so the link must be mutual and owner-equal.
    // Append-only — error code 6088.
    #[msg("OCO peer does not match this trigger's link, or the link is not mutual")]
    OcoPeerMismatch,

    // Re-pointing a live pair would orphan the old peer: it would still link
    // back to a trigger that no longer links to it, which execute_trigger reads
    // as a mismatch (6088) and refuses — leaving the orphan permanently
    // unfireable. Unlink by cancelling a leg instead.
    // Append-only — error code 6089.
    #[msg("Trigger is already part of an OCO pair")]
    OcoAlreadyLinked,

    // A TP/SL couple is two exits on ONE position. Linking across series would
    // let a fire on one contract cancel an exit on an unrelated one.
    // Append-only — error code 6090.
    #[msg("OCO legs must be on the same option series")]
    OcoSeriesMismatch,

    // =========================================================================
    // FP-ORACLE module (first-party price feed) — codes 6091-6100
    // =========================================================================
    // Reserved as a contiguous block. The spec reserved 6091-6096; the build
    // needed four more (push-side rate limit, deviation breaker, push skew, and
    // the open-collateral flip guard) which the spec's prose implied but had not
    // been given codes. Block widened to 6091-6100 — recorded here because the
    // next feature must start at 6101, not 6097.

    // Read-side freshness gate. now - publish_time exceeded the call site's
    // max_age. Also raised for a FUTURE-dated feed: a read gate that trusts the
    // writer's clock is not a gate.
    // Append-only — error code 6091.
    #[msg("Opta price feed is stale for this read")]
    OptaFeedStale,

    // Admin kill-switch (revocation tier 1). Blocks EVERY read at EVERY arm,
    // regardless of freshness, in one admin transaction with no key movement.
    // Append-only — error code 6092.
    #[msg("Opta price feed is frozen by the protocol admin")]
    OptaFeedFrozen,

    // Zero price. A feed that has never been pushed, or one pushed with a
    // garbage value, must not price an option.
    // Append-only — error code 6093.
    #[msg("Opta price feed price is zero or invalid")]
    OptaFeedInvalidPrice,

    // Confidence band wider than OPTA_FEED_MAX_CONF_BPS of price — the sources
    // disagreed, and a price nobody agrees on must not settle an option.
    // Append-only — error code 6094.
    #[msg("Opta price feed confidence band is too wide to price against")]
    OptaFeedConfTooWide,

    // Push signer is not feed.authority. The single most important check in the
    // module: it is what makes the oracle key's blast radius one instruction.
    // Append-only — error code 6095.
    #[msg("Signer is not the authority for this Opta price feed")]
    OptaFeedUnauthorized,

    // oracle_source disagrees between OptionsMarket and its VolOracle. The two
    // bytes are independent in storage but must never diverge: a market settling
    // from one source while its vol oracle is warmed from another mixes
    // provenance across the pricing inputs AND KEEPS QUOTING, which is what
    // makes it dangerous. set_oracle_source writes both or neither.
    // Append-only — error code 6096.
    #[msg("Market and vol-oracle oracle_source disagree — they must be set together")]
    OracleSourceMismatch,

    // Push-side rate limit (OPTA_FEED_MIN_PUSH_INTERVAL_SECS).
    // Append-only — error code 6097.
    #[msg("Opta price feed push too soon since the last accepted push")]
    OptaFeedPushTooSoon,

    // Deviation circuit-breaker. Converts "compromised key writes $1 BTC" from
    // an instant drain into a slow, loud, visible walk.
    // Append-only — error code 6098.
    #[msg("Opta price feed push deviates too far from the previous price")]
    OptaFeedDeviationTooLarge,

    // Pushed publish_time is too far from the on-chain clock in either
    // direction. Blocks future-dating (a feed that looks fresh after the pusher
    // dies) and backfill (a stale price replayed as current).
    // Append-only — error code 6099.
    #[msg("Opta price feed push timestamp skew exceeds the allowed window")]
    OptaFeedSkewTooLarge,

    // R1 flip guard: refuse to change oracle_source while the market has an
    // unsettled vault holding collateral. Changing the settlement basis under a
    // live contract is a material change to an instrument someone already holds.
    // Append-only — error code 6100.
    #[msg("Market has open collateral — settle or reclaim before changing oracle_source")]
    MarketHasOpenCollateral,

    // ---- FP-ORACLE close (6101) --------------------------------------------
    // Closing a LIVE feed would remove pricing capability silently: the account
    // vanishes and every read arm fails on a missing account instead of the
    // explicit OptaFeedFrozen operators are trained to recognise. Freeze first,
    // then close -- reversible step before irreversible one.
    #[msg("OptaPriceFeed must be frozen before it can be closed")]
    OptaFeedNotFrozen,

    // ---- FP-ORACLE arms (6102) ---------------------------------------------
    // The Opta read arm of the six oracle_source sites and the set_oracle_source
    // flip guard take the OptaPriceFeed as a trailing optional account. Absent on
    // a source-2 market is a caller error, named exactly like PriceUpdateMissing
    // and SwitchboardAccountsMissing are for their arms. Append-only.
    #[msg("OptaPriceFeed account required for an Opta-sourced market")]
    OptaFeedMissing,
}
