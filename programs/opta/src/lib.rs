// =============================================================================
// lib.rs — Opta: Tokenized P2P options protocol on Solana
// =============================================================================
//
// Options are represented as SPL tokens. Whoever holds the tokens can exercise.
// This makes options tradeable on the built-in P2P marketplace or any DEX.
//
// Surface (Stage 3):
//   1. initialize_protocol      — One-time setup
//   2. create_market            — Register a supported asset (admin-only, idempotent)
//   3. settle_expiry            — Record canonical price for an (asset, expiry)
//   v2 vault instructions follow below.
// =============================================================================

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod feature_flags;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;
use state::*;

// =============================================================================
// LOW-5 — deployable-artifact guard (fail-closed on the `testing` marker)
// =============================================================================
// Test/dev-only cargo features must NEVER reach a deployed build. The bankrun
// .so is a RELEASE build carrying test-fast-vol/test-synth-vol, so
// `debug_assertions` can't distinguish it, and `test-fast-vol` is const-only
// (invisible in the IDL) — the check must be feature-level. Fail-CLOSED on a
// `testing` marker: any test/dev feature WITHOUT `testing` refuses to compile,
// so forgetting the marker on a test build fails loudly while the only way test
// code reaches a deploy is a deliberate `--features testing` on a production
// build. The Stage-I American flip is the feature_flags.rs default edit + a
// FEATURE-FREE deploy — never `--features american-enabled`.
#[cfg(all(
    any(feature = "test-fast-vol", feature = "test-synth-vol", feature = "cu-profile"),
    not(feature = "testing")
))]
compile_error!(
    "test-only cargo feature (test-fast-vol / test-synth-vol / cu-profile) enabled without the \
     `testing` marker — refusing to build a DEPLOYABLE artifact carrying test code. Pass \
     `--features testing` for test builds; production deploys must be FEATURE-FREE."
);

#[cfg(all(feature = "american-enabled", not(feature = "testing")))]
compile_error!(
    "`american-enabled` passed as --features on a non-`testing` build. The Stage-I flip is the \
     feature_flags.rs default edit + a FEATURE-FREE deploy, never `--features american-enabled`. \
     Pass `--features testing` only to run the American test suite."
);

// FP-ORACLE: the scratch-build identity block (isolation gate tier 3) was
// deleted at the plug ceremony, as designed. One program, one id.
declare_id!("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");

#[program]
pub mod opta {
    use super::*;

    pub fn initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
        instructions::initialize_protocol::handle_initialize_protocol(ctx)
    }

    /// Register a supported asset (permissionless, idempotent).
    /// One Market PDA per asset; strike/expiry/type live on SharedVault.
    /// `pyth_feed_id` is the 32-byte Pyth Pull feed ID for the asset.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        asset_name: String,
        pyth_feed_id: [u8; 32],
        asset_class: u8,
        oracle_source: u8,
    ) -> Result<()> {
        instructions::create_market::handle_create_market(
            ctx,
            asset_name,
            pyth_feed_id,
            asset_class,
            oracle_source,
        )
    }

    /// Record the canonical settlement price for an (asset, expiry) tuple
    /// from a Pyth Pull `PriceUpdateV2` account. Permissionless — anyone
    /// can call once the (asset, expiry) is past expiry and a fresh Pyth
    /// update is on-chain.
    pub fn settle_expiry(
        ctx: Context<SettleExpiry>,
        asset_name: String,
        expiry: i64,
    ) -> Result<()> {
        instructions::settle_expiry::handle_settle_expiry(ctx, asset_name, expiry)
    }

    /// Rotate the Pyth Pull feed_id stored on an existing OptionsMarket.
    /// Admin-only; idempotent on same feed_id; overwrites on different.
    /// No oracle call — only mutates registry metadata.
    pub fn migrate_pyth_feed(
        ctx: Context<MigratePythFeed>,
        asset_name: String,
        new_pyth_feed_id: [u8; 32],
    ) -> Result<()> {
        instructions::migrate_pyth_feed::handle_migrate_pyth_feed(
            ctx, asset_name, new_pyth_feed_id,
        )
    }

    // =========================================================================
    // v2 Shared Vault instructions
    // =========================================================================

    /// Initialize the epoch schedule (admin-only, one-time setup).
    pub fn initialize_epoch_config(
        ctx: Context<InitializeEpochConfig>,
        weekly_expiry_day: u8,
        weekly_expiry_hour: u8,
        monthly_enabled: bool,
    ) -> Result<()> {
        instructions::initialize_epoch_config::handle_initialize_epoch_config(
            ctx, weekly_expiry_day, weekly_expiry_hour, monthly_enabled,
        )
    }

    /// Create a new shared collateral vault for a specific option specification.
    pub fn create_shared_vault(
        ctx: Context<CreateSharedVault>,
        strike_price: u64,
        expiry: i64,
        option_type: OptionType,
        vault_type: VaultType,
        collateral_mint: Pubkey,
        carry_rate_bps: i32,
        exercise_style: ExerciseStyle,
    ) -> Result<()> {
        instructions::create_shared_vault::handle_create_shared_vault(
            ctx, strike_price, expiry, option_type, vault_type, collateral_mint, carry_rate_bps, exercise_style,
        )
    }

    /// Deposit USDC collateral into a shared vault and receive shares.
    pub fn deposit_to_vault(
        ctx: Context<DepositToVault>,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit_to_vault::handle_deposit_to_vault(ctx, amount)
    }

    /// Mint Living Option Tokens from a shared vault using writer's collateral share.
    pub fn mint_from_vault(
        ctx: Context<MintFromVault>,
        quantity: u64,
        premium_per_contract: u64,
        created_at: i64,
    ) -> Result<()> {
        instructions::mint_from_vault::handle_mint_from_vault(
            ctx, quantity, premium_per_contract, created_at,
        )
    }

    /// Purchase option tokens minted from a shared vault.
    pub fn purchase_from_vault(
        ctx: Context<PurchaseFromVault>,
        quantity: u64,
        max_premium: u64,
    ) -> Result<()> {
        instructions::purchase_from_vault::handle_purchase_from_vault(ctx, quantity, max_premium)
    }

    /// Burn unsold option tokens from a vault mint, freeing committed collateral.
    pub fn burn_unsold_from_vault(ctx: Context<BurnUnsoldFromVault>) -> Result<()> {
        instructions::burn_unsold_from_vault::handle_burn_unsold_from_vault(ctx)
    }

    /// Withdraw uncommitted collateral from a shared vault.
    pub fn withdraw_from_vault(
        ctx: Context<WithdrawFromVault>,
        shares_to_withdraw: u64,
    ) -> Result<()> {
        instructions::withdraw_from_vault::handle_withdraw_from_vault(ctx, shares_to_withdraw)
    }

    /// Claim earned premium from a shared vault.
    pub fn claim_premium(ctx: Context<ClaimPremium>) -> Result<()> {
        instructions::claim_premium::handle_claim_premium(ctx)
    }

    /// Settle a shared vault. Permissionless — reads the canonical price
    /// from a SettlementRecord PDA written earlier by `settle_expiry`.
    pub fn settle_vault(ctx: Context<SettleVault>) -> Result<()> {
        instructions::settle_vault::handle_settle_vault(ctx)
    }

    /// Exercise option tokens from a settled vault.
    pub fn exercise_from_vault(
        ctx: Context<ExerciseFromVault>,
        quantity: u64,
    ) -> Result<()> {
        instructions::exercise_from_vault::handle_exercise_from_vault(ctx, quantity)
    }

    /// Early (pre-expiry) American exercise. The holder burns `quantity`
    /// tokens and receives cash-settled capped intrinsic in USDC from the
    /// vault (CALL/PUT capped at 1× collateral per contract). American-only
    /// and gated off via AMERICAN_ENABLED until Stage I. Spot is read from a
    /// fresh PriceUpdateV2 the exerciser supplies. Increments the vault's
    /// early-exercise counters only; settlement nets them in Stage G.
    pub fn exercise_american(
        ctx: Context<ExerciseAmerican>,
        quantity: u64,
    ) -> Result<()> {
        instructions::exercise_american::handle_exercise_american(ctx, quantity)
    }

    /// Withdraw remaining collateral after vault settlement.
    pub fn withdraw_post_settlement(ctx: Context<WithdrawPostSettlement>) -> Result<()> {
        instructions::withdraw_post_settlement::handle_withdraw_post_settlement(ctx)
    }

    /// Auto-burn holder option tokens + auto-pay ITM USDC for a settled vault.
    /// Permissionless. Caller passes `remaining_accounts` as pairs of
    /// (holder_option_ata, holder_usdc_ata). Idempotent: zero-amount accounts
    /// and mismatched USDC ATAs are skipped silently.
    /// See docs/AUTO_FINALIZE_PLAN.md.
    pub fn auto_finalize_holders<'info>(
        ctx: Context<'_, '_, '_, 'info, AutoFinalizeHolders<'info>>,
    ) -> Result<()> {
        instructions::auto_finalize_holders::handle_auto_finalize_holders(ctx)
    }

    /// Auto-distribute USDC to writers + close their writer_position accounts
    /// for a settled vault. Permissionless. Caller passes `remaining_accounts`
    /// as triples of (writer_position, writer_usdc_ata, writer_wallet).
    /// Idempotent: closed writer_positions and mismatched USDC ATAs are
    /// skipped silently. When the last writer is processed, sweeps any USDC
    /// dust + the vault_usdc_account rent SOL to the protocol treasury.
    /// See docs/AUTO_FINALIZE_PLAN.md.
    pub fn auto_finalize_writers<'info>(
        ctx: Context<'_, '_, 'info, 'info, AutoFinalizeWriters<'info>>,
    ) -> Result<()> {
        instructions::auto_finalize_writers::handle_auto_finalize_writers(ctx)
    }

    // =========================================================================
    // V2 secondary listing instructions
    // =========================================================================

    /// V2 secondary listing — list option tokens for resale.
    /// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §2.1.
    pub fn list_v2_for_resale(
        ctx: Context<ListV2ForResale>,
        price_per_contract: u64,
        quantity: u64,
    ) -> Result<()> {
        instructions::list_v2_for_resale::handle_list_v2_for_resale(
            ctx, price_per_contract, quantity,
        )
    }

    /// V2 secondary listing — fill (partially or fully) an existing listing.
    /// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §2.2.
    pub fn buy_v2_resale(
        ctx: Context<BuyV2Resale>,
        quantity: u64,
        max_total_price: u64,
    ) -> Result<()> {
        instructions::buy_v2_resale::handle_buy_v2_resale(ctx, quantity, max_total_price)
    }

    /// V2 secondary listing — seller cancels their own listing.
    /// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §2.3.
    pub fn cancel_v2_resale(ctx: Context<CancelV2Resale>) -> Result<()> {
        instructions::cancel_v2_resale::handle_cancel_v2_resale(ctx)
    }

    /// V2 secondary listing — permissionless cleanup of stale listings at expiry.
    /// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §4.2 (Design A).
    pub fn auto_cancel_listings<'info>(
        ctx: Context<'_, '_, 'info, 'info, AutoCancelListings<'info>>,
    ) -> Result<()> {
        instructions::auto_cancel_listings::handle_auto_cancel_listings(ctx)
    }

    /// Exchange book — post a resting bid or ask (collateral escrowed per-order).
    /// Spec: exchange-spec §6.3 (Step 2).
    pub fn post_order(
        ctx: Context<PostOrder>,
        kind: OrderKind,
        price_per_contract: u64,
        quantity: u64,
        nonce: u64,
    ) -> Result<()> {
        instructions::post_order::handle_post_order(ctx, kind, price_per_contract, quantity, nonce)
    }

    /// Exchange book — taker fills a named resting order (partial fills first-class).
    /// Spec: exchange-spec §6.3 (Step 3).
    pub fn fill_order(ctx: Context<FillOrder>, fill_quantity: u64) -> Result<()> {
        instructions::fill_order::handle_fill_order(ctx, fill_quantity)
    }

    /// Exchange book — owner cancels their own resting order; escrow + rent returned.
    /// Spec: exchange-spec §6.3 (Step 4).
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        instructions::cancel_order::handle_cancel_order(ctx)
    }

    /// Exchange book — permissionless post-expiry sweep of resting orders.
    /// Returns each order's escrow to its owner and closes the PDAs. Crank
    /// runs this BEFORE auto_finalize_holders. Spec: exchange-spec §6.3 (Step 5).
    /// remaining_accounts: 4-tuples (order, escrow, owner_asset_account, owner_wallet).
    pub fn sweep_expired_orders<'info>(
        ctx: Context<'_, '_, 'info, 'info, SweepExpiredOrders<'info>>,
    ) -> Result<()> {
        instructions::sweep_expired_orders::handle_sweep_expired_orders(ctx)
    }

    /// Exchange Phase 2 Pass A — create the canonical per-spec series mint.
    /// Permissionless, once-per-spec (series-record `init` enforces it). American
    /// only (D12). Inert until Pass B mints against it. Spec: §7.3.1.
    pub fn create_series(
        ctx: Context<CreateSeries>,
        strike: u64,
        expiry: i64,
        option_type: OptionType,
        exercise_style: ExerciseStyle,
    ) -> Result<()> {
        instructions::create_series::handle_create_series(ctx, strike, expiry, option_type, exercise_style)
    }

    /// Exchange Phase 2 Pass B — fill the standing vault peg: price an American
    /// series at fill time (BS-2002 + spread_bps via the shared price_american
    /// helper), take USDC (pool premium + fee), and mint `quantity` contracts
    /// to the taker from pooled vault collateral. `max_premium` is the taker's
    /// fee-inclusive slippage ceiling. Dark behind AMERICAN_ENABLED until the
    /// Stage-I flip. Spec: §7.3.2 (D3/D5/D6/D7).
    pub fn fill_vault_peg(
        ctx: Context<FillVaultPeg>,
        quantity: u64,
        max_premium: u64,
    ) -> Result<()> {
        instructions::fill_vault_peg::handle_fill_vault_peg(ctx, quantity, max_premium)
    }

    /// Exchange Phase 3 Slice B — fill a writer's limit ask. Mint-on-fill from
    /// the writer's PERSONAL collateral (Slice A's per-order escrow): premium
    /// (maker-set price) taker→writer, fee→treasury, mint `fill_quantity` series
    /// contracts to the taker, move cpt×fill_quantity escrow→WriterAskPot. Bumps
    /// only the pot + position — never the vault counters. Dark behind
    /// WRITER_ASKS_ENABLED + AMERICAN_ENABLED. Settlement of these contracts is
    /// Slice D. Spec: §8 (P3/D7).
    pub fn fill_writer_ask(ctx: Context<FillWriterAsk>, fill_quantity: u64) -> Result<()> {
        instructions::fill_writer_ask::handle_fill_writer_ask(ctx, fill_quantity)
    }

    /// Exchange Phase 3 Slice D2a — a writer-ask backer claims their
    /// post-settlement residual: equiv_shares = committed × writer_ask_equiv_shares
    /// / swept, payout = equiv_shares × collateral_remaining / total_shares, both
    /// drawn from the SAME unified (collateral_remaining, total_shares) the pool
    /// writers use. PURE (pay → decrement → zero the position; no close logic).
    /// Permissionless with the payout pinned to position.backer; enforces the
    /// holders-first EXERCISE_WINDOW. UNGATED (an exit/refund path) — inert in a
    /// feature-free build (reverts NothingToClaim, swept always 0). Spec §8.
    pub fn withdraw_writer_ask_residual(ctx: Context<WithdrawWriterAskResidual>) -> Result<()> {
        instructions::withdraw_writer_ask_residual::handle_withdraw_writer_ask_residual(ctx)
    }

    /// Exchange Phase 3 Slice D2a — reclaim a fully-drained writer-ask vault's
    /// USDC account. EXACT precondition: is_settled && !voided && swept > 0 &&
    /// total_shares == 0 (the unspoofable all-drained signal — impossible to
    /// close while a claimant is owed). Sweeps residual dust + the account rent
    /// SOL to the treasury. Permissionless. UNGATED — inert in a feature-free
    /// build (reverts NotAWriterAskVault, swept always 0). A mixed vault that
    /// lands at total_shares == D > 0 floor-dust is a SAFE under-close (never
    /// fires; no claimant harmed). Spec §8.
    pub fn close_settled_writer_ask_vault(
        ctx: Context<CloseSettledWriterAskVault>,
    ) -> Result<()> {
        instructions::close_settled_writer_ask_vault::handle_close_settled_writer_ask_vault(ctx)
    }

    /// Exchange Phase 2 Pass C — atomic write merge (D9). Fuses create_shared_vault
    /// + deposit_to_vault into ONE tx via init_if_needed: the first caller for a
    /// spec creates + deposits, a subsequent caller just deposits. The heavy mint
    /// left the write path (D8/D9), so this carries no Token-2022 mint + no
    /// BS-2002. Kills the partial-flow stranded-collateral hazard structurally.
    /// Additive — create_shared_vault + deposit_to_vault stay live. EUR
    /// byte-identical; American keeps create_shared_vault's AMERICAN_ENABLED gate.
    /// Spec: §7.3.3 / §7.6.
    #[allow(clippy::too_many_arguments)]
    pub fn create_and_deposit(
        ctx: Context<CreateAndDeposit>,
        strike_price: u64,
        expiry: i64,
        option_type: OptionType,
        vault_type: VaultType,
        collateral_mint: Pubkey,
        carry_rate_bps: i32,
        exercise_style: ExerciseStyle,
        amount: u64,
    ) -> Result<()> {
        instructions::create_and_deposit::handle_create_and_deposit(
            ctx, strike_price, expiry, option_type, vault_type, collateral_mint,
            carry_rate_bps, exercise_style, amount,
        )
    }

    /// Phase 2 Pass D — dead-feed safety hatch (pool-writer side). Permissionless,
    /// per-writer pro-rata reclaim from a voided vault. Phase 3 D3: now REQUIRES
    /// `voided == true` (set atomically by `initialize_void`, the sole voider) —
    /// it no longer self-voids and no longer takes the market/settlement_record
    /// accounts (CRANK: drop those two before redeploy). The pro-rata payout is
    /// byte-identical (auto-scales on the bumped total_shares + merged
    /// collateral_remaining). NOT gated by AMERICAN_ENABLED.
    pub fn reclaim_unsettled(ctx: Context<ReclaimUnsettled>) -> Result<()> {
        instructions::reclaim_unsettled::handle_reclaim_unsettled(ctx)
    }

    /// Phase 3 Slice D3 — atomic dead-feed void transition. The SOLE setter of
    /// `voided`. After the 7-day grace with no SettlementRecord, derives the
    /// canonical writer-ask pot from vault identity (un-omittable; sound via D2.5's
    /// canonical-mint pin), sweeps it into vault_usdc (donation→treasury, closes
    /// pot_usdc), applies the D2a shares-unification merge (total_shares +=
    /// equiv_total, collateral_remaining = TC + swept − E), and flips voided — all
    /// atomically. No-pot/EUR → byte-identical to the old self-void seed (swept 0).
    /// Both reclaim paths require voided, so none can run before the merge.
    /// Permissionless, UNGATED, once-only. Spec: §8 void path.
    pub fn initialize_void(ctx: Context<InitializeVoid>) -> Result<()> {
        instructions::initialize_void::handle_initialize_void(ctx)
    }

    /// Phase 3 Slice D3 — writer-ask backer's VOID-path residual claim (the void
    /// twin of withdraw_writer_ask_residual; shares the same pure core). Gates on
    /// `voided` (not is_settled), no holders-first window (voided holders get
    /// nothing). Pays the backer their pro-rata of the merged residual from
    /// vault_usdc. Permissionless, backer-pinned, double-claim guarded. Spec: §8.
    pub fn reclaim_writer_ask_residual(ctx: Context<ReclaimWriterAskResidual>) -> Result<()> {
        instructions::reclaim_writer_ask_residual::handle_reclaim_writer_ask_residual(ctx)
    }

    // =========================================================================
    // Phase 4 — Trigger orders (Pass 0: placement + cancel; execute is Pass 1)
    // =========================================================================

    /// Stage a durable trigger order. NOT flag-gated (a user can stage/cancel
    /// anytime; only the Pass-1 execute path checks AMERICAN_ENABLED).
    /// StopEntryBuy escrows `max_premium × quantity` USDC + pre-creates the
    /// owner's destination option ATA; TakeProfitSell escrows nothing and
    /// sanity-checks the declared source ATA holds ≥ quantity. Spec v1 §placement.
    /// B3: mutually pair two of the caller's triggers so a fire on one
    /// decrements the other in the SAME transaction. Without this, `oco_link`
    /// could never be set and the OCO enforcement in execute_trigger was
    /// unreachable.
    pub fn link_oco(ctx: Context<LinkOco>) -> Result<()> {
        instructions::link_oco::handle_link_oco(ctx)
    }

    pub fn place_trigger(
        ctx: Context<PlaceTrigger>,
        kind: TriggerKind,
        comparator: Comparator,
        threshold_usdc: u64,
        quantity: u64,
        max_premium: u64,
        nonce: u64,
        tape: TapeSource,
    ) -> Result<()> {
        instructions::place_trigger::handle_place_trigger(
            ctx, kind, comparator, threshold_usdc, quantity, max_premium, nonce, tape,
        )
    }

    /// Owner cancels their own trigger; refunds the full escrow (BUY) and closes
    /// both PDAs, rent → owner. NOT flag-gated. Spec v1 §cancel.
    pub fn cancel_trigger(ctx: Context<CancelTrigger>) -> Result<()> {
        instructions::cancel_trigger::handle_cancel_trigger(ctx)
    }

    /// Keeper fires a trigger. Flag-gated (6052 while AMERICAN_ENABLED=false).
    /// Re-reads a FRESH Pyth EMA in-tx (60s/200bps, mirrors exercise_american),
    /// re-checks the stored comparator (6059), then routes to the shared cores:
    /// StopEntryBuy → vault_peg_fill_core (escrow pays, mints to owner);
    /// TakeProfitSell → american_exercise_core (delegate burns, vault pays owner)
    /// with a fire-time owner/mint re-verification (6060) + partial-fire support.
    /// CALLERS MUST prepend ComputeBudgetProgram.setComputeUnitLimit(~400_000)
    /// (the BUY path runs BS-2002). Spec v1 §execute.
    pub fn execute_trigger(ctx: Context<ExecuteTrigger>) -> Result<()> {
        instructions::execute_trigger::handle_execute_trigger(ctx)
    }

    /// One-time SharedVault schema migration that adds the trailing
    /// carry_rate_bps field to pre-Stage-A vaults. Admin-only. Caller passes
    /// vault accounts to migrate via remaining_accounts (recommended batch:
    /// 20-30 per call to stay under 1.4M CU). Idempotent: vaults already at
    /// the new size are skipped. Admin pays the rent delta.
    pub fn migrate_shared_vault_carry_rate<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultCarryRate<'info>>,
    ) -> Result<()> {
        instructions::migrate_shared_vault_carry_rate::handle_migrate_shared_vault_carry_rate(ctx)
    }

    /// One-time OptionsMarket schema migration that adds the trailing
    /// oracle_source byte (Switchboard Stage 2) to pre-Stage-2 markets.
    /// Admin-only. Caller passes market accounts via remaining_accounts
    /// (BATCH_SIZE 20; the full current set of 16 fits one call). Idempotent:
    /// markets already at the new size (incl. the larger pre-reshape orphans)
    /// are skipped. Admin pays the rent delta. Sets oracle_source = 0 (Pyth).
    pub fn migrate_market_oracle_source<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateMarketOracleSource<'info>>,
    ) -> Result<()> {
        instructions::migrate_market_oracle_source::handle_migrate_market_oracle_source(ctx)
    }

    /// Admin-only. Closes an OptionsMarket PDA and returns its rent to the admin.
    /// Used at the Pyth→Switchboard cutover to free a crypto asset's name PDA so
    /// an SB-sourced market can be re-created under the SAME real name.
    ///
    /// NO on-chain child-check is possible: SharedVaults are independent PDAs
    /// keyed by market.key() and the market holds no child counter, so proving
    /// "no open vaults" would need unbounded remaining_accounts. Safety is
    /// enforced OFF-CHAIN by scripts/preflight_close_market.ts (refuses to build
    /// the tx if any live vault references the market). VolOracles (keyed by
    /// feed_id) are NOT children and survive by design. Admin-trusted (devnet);
    /// ships in the cutover deploy, INERT until then.
    pub fn close_market(ctx: Context<CloseMarket>, asset_name: String) -> Result<()> {
        instructions::close_market::handle_close_market(ctx, asset_name)
    }

    /// One-time SharedVault schema migration that adds the trailing
    /// exercise_style field to pre-Pass-1 vaults. Admin-only.
    /// Caller passes vault accounts via remaining_accounts (recommended
    /// batch: 20-30 per call). Idempotent: vaults already at the new
    /// size are skipped. Zero-fill on the new byte deserializes as
    /// ExerciseStyle::European (variant 0). Admin pays the rent delta.
    pub fn migrate_shared_vault_exercise_style<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultExerciseStyle<'info>>,
    ) -> Result<()> {
        instructions::migrate_shared_vault_exercise_style::handle_migrate_shared_vault_exercise_style(ctx)
    }

    /// One-time SharedVault schema migration that adds the trailing
    /// exercised_options + early_exercise_payout fields (Stage F) to
    /// pre-Stage-F vaults. Admin-only. Caller passes vault accounts via
    /// remaining_accounts (recommended batch: 20 per call). Idempotent:
    /// vaults already at the new size are skipped. Zero-fill on the new 16
    /// bytes deserializes as 0/0 (no early exercises). Admin pays the rent delta.
    pub fn migrate_shared_vault_exercise_tracking<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultExerciseTracking<'info>>,
    ) -> Result<()> {
        instructions::migrate_shared_vault_exercise_tracking::handle_migrate_shared_vault_exercise_tracking(ctx)
    }

    /// Phase 2 Pass A — one-time SharedVault schema migration adding the trailing
    /// `spread_bps` (u16) + `voided` (bool) fields. Admin-only, batched via
    /// remaining_accounts (recommended batch: 20). Idempotent: vaults already at
    /// the new 260-byte size are skipped. Zero-fill on the new 3 bytes
    /// deserializes as spread_bps=0 / voided=false. Admin pays the rent delta.
    pub fn migrate_shared_vault_exchange_fields<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultExchangeFields<'info>>,
    ) -> Result<()> {
        instructions::migrate_shared_vault_exchange_fields::handle_migrate_shared_vault_exchange_fields(ctx)
    }

    /// Phase 3 Slice D1 — one-time SharedVault migration: append the trailing
    /// `writer_ask_collateral_swept` field (252→260 INIT_SPACE; on-disk 260→268).
    /// Admin-only, batched via remaining_accounts (recommended batch: 20).
    /// Idempotent: vaults already at 268 bytes are skipped. Zero-fill on the new
    /// 8 bytes deserializes as writer_ask_collateral_swept=0. The 6th such append.
    pub fn migrate_shared_vault_writer_ask_swept<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultWriterAskSwept<'info>>,
    ) -> Result<()> {
        instructions::migrate_shared_vault_writer_ask_swept::handle_migrate_shared_vault_writer_ask_swept(ctx)
    }

    /// Phase 3 Slice D2a — one-time SharedVault migration: append the trailing
    /// `writer_ask_equiv_shares` field (260→268 INIT_SPACE; on-disk 268→276).
    /// Admin-only, batched via remaining_accounts (recommended batch: 20).
    /// CONSOLIDATED: grows a vault at ANY prior size (260 pre-D1 or 268 post-D1)
    /// straight to 276, zero-filling all trailing bytes — so it SUPERSEDES the D1
    /// 268-migration at deploy (run ONLY this one). Idempotent: vaults already at
    /// 276 bytes are skipped. The 7th such append.
    pub fn migrate_shared_vault_residual_shares<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultResidualShares<'info>>,
    ) -> Result<()> {
        instructions::migrate_shared_vault_residual_shares::handle_migrate_shared_vault_residual_shares(ctx)
    }

    // =========================================================================
    // Phase 2 Stage B -- realized-vol oracle
    // =========================================================================

    /// Bootstrap a per-feed VolOracle PDA. Permissionless; caller supplies
    /// a fresh PriceUpdateV2 whose feed_id matches the arg as proof-of-
    /// feed-existence. Plain `init` -- second call for the same feed_id
    /// reverts.
    pub fn initialize_vol_oracle(
        ctx: Context<InitializeVolOracle>,
        feed_id: [u8; 32],
        oracle_source: u8,
        seed_vol: i64,
    ) -> Result<()> {
        instructions::initialize_vol_oracle::handle_initialize_vol_oracle(
            ctx,
            feed_id,
            oracle_source,
            seed_vol,
        )
    }

    /// Push a fresh Pyth spot sample to a VolOracle. Permissionless. The
    /// handler validates the Pyth update, computes a log return against
    /// the prior spot, and updates the ring buffer + O(1) accumulators.
    /// First push to a fresh oracle takes the seed-only branch (no
    /// ring/accumulator write; rate limit skipped). Subsequent pushes
    /// enforce the rate limit (55 min production / 1 sec test-fast-vol).
    pub fn push_vol_sample(ctx: Context<PushVolSample>) -> Result<()> {
        instructions::push_vol_sample::handle_push_vol_sample(ctx)
    }

    /// Admin-only reset of a polluted/broken VolOracle. Zeroes the ring,
    /// both accumulators, sample_count, head, and last_spot/last_ts so the
    /// next push takes the seed branch (records spot, no return) and the
    /// 7-day warmup re-engages from 0. feed_id (the PDA seed + Pyth identity)
    /// is preserved. `seed_vol` REPAIRS the seed (H-1, Run-8): bounded to
    /// [MIN,MAX] or 0 (no seed); the warmup after reset consults this value.
    /// One oracle per call.
    pub fn reset_vol_oracle(
        ctx: Context<ResetVolOracle>,
        feed_id: [u8; 32],
        seed_vol: i64,
    ) -> Result<()> {
        instructions::reset_vol_oracle::handle_reset_vol_oracle(ctx, feed_id, seed_vol)
    }

    // =========================================================================
    // FP-ORACLE module — first-party price feed (spec FP_ORACLE_MODULE_SPEC_V2)
    // =========================================================================
    // Plug wave 1: the six oracle_source match arms are ARMED (create_market,
    // initialize_vol_oracle, push_vol_sample, settle_expiry, exercise_american,
    // execute_trigger) and set_oracle_source carries the D1 guard. A market on
    // ORACLE_SOURCE_OPTA is served from its OptaPriceFeed on every read path.

    /// Create an OptaPriceFeed PDA and install its initial oracle authority.
    /// Admin-only. Stores NO price: the feed is unreadable (OptaFeedInvalidPrice)
    /// until the authority pushes to it, so creating a feed can never make a
    /// market quotable by accident. Refuses admin-as-authority.
    pub fn init_opta_price_feed(
        ctx: Context<InitOptaPriceFeed>,
        feed_id: [u8; 32],
        authority: Pubkey,
    ) -> Result<()> {
        instructions::init_opta_price_feed::handle_init_opta_price_feed(ctx, feed_id, authority)
    }

    /// Write a price to an OptaPriceFeed. Signed by feed.authority — NOT admin,
    /// and admin has no override. Guards, in order: frozen, authority, price>0,
    /// clock skew (both directions), rate limit, deviation circuit-breaker.
    /// The breaker ships at 500 bps and shadow-logs `would_have_tripped` in
    /// [OBSERVE, MAX) so the final threshold comes from soak data (R4).
    pub fn push_opta_price(
        ctx: Context<PushOptaPrice>,
        feed_id: [u8; 32],
        price_6dec: u64,
        conf_6dec: u64,
        publish_time: i64,
    ) -> Result<()> {
        instructions::push_opta_price::handle_push_opta_price(
            ctx,
            feed_id,
            price_6dec,
            conf_6dec,
            publish_time,
        )
    }

    /// Rotate an OptaPriceFeed's authority (revocation tier 2). Admin-only. The
    /// old key is inert as of this tx — no redeploy, no migration. Refuses
    /// admin-as-authority.
    pub fn set_feed_authority(
        ctx: Context<SetFeedAuthority>,
        feed_id: [u8; 32],
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::set_feed_authority::handle_set_feed_authority(ctx, feed_id, new_authority)
    }

    /// Freeze/unfreeze an OptaPriceFeed (revocation tier 1 — the break-glass).
    /// Admin-only, one transaction, no key movement. A frozen feed blocks every
    /// read at every arm regardless of freshness, and accepts no pushes even
    /// from the real authority.
    pub fn set_feed_frozen(
        ctx: Context<SetFeedFrozen>,
        feed_id: [u8; 32],
        frozen: bool,
    ) -> Result<()> {
        instructions::set_feed_authority::handle_set_feed_frozen(ctx, feed_id, frozen)
    }

    /// Close an OptaPriceFeed and return its rent to the admin. REFUSES unless
    /// the feed is already frozen (6101), so a live feed can never be deleted in
    /// one step. Required by the wedge path — a genesis error above the
    /// breaker's 50% cap is otherwise uncorrectable — and by unplug (spec 9.2).
    pub fn close_opta_price_feed(
        ctx: Context<CloseOptaPriceFeed>,
        feed_id: [u8; 32],
    ) -> Result<()> {
        instructions::close_opta_price_feed::handle_close_opta_price_feed(ctx, feed_id)
    }

    /// Flip a market's oracle lane. Admin-only. Writes BOTH
    /// OptionsMarket.oracle_source AND VolOracle.oracle_source, or neither —
    /// the two bytes are independent at rest and a market that settles from one
    /// source while its vol oracle is warmed from another keeps quoting, which
    /// is what makes the desync dangerous (6096).
    ///
    /// R1: refuses if any SharedVault passed in remaining_accounts holds live
    /// collateral (6100). That is a FAT-FINGER guard, not a trustless
    /// invariant — completeness of the vault list is enforced off-chain by the
    /// ceremony. See instructions/set_oracle_source.rs for the full limit.
    pub fn set_oracle_source<'info>(
        ctx: Context<'_, '_, '_, 'info, SetOracleSource<'info>>,
        asset_name: String,
        feed_id: [u8; 32],
        new_source: u8,
    ) -> Result<()> {
        instructions::set_oracle_source::handle_set_oracle_source(
            ctx,
            asset_name,
            feed_id,
            new_source,
        )
    }

    /// AMER-only BS-2002 pricing view. Read-only; CPI-callable.
    /// Returns OptionPriceQuote (premium + vol/spot snapshot + ts) for the
    /// supplied hypothetical option against a live VolOracle. European
    /// reverts with ViewNotSupportedForEuropean — use the off-chain BS
    /// pricer (app/src/utils/blackScholes.ts) for EUR quotes. Shares the
    /// `price_american` helper with mint_from_vault, so same-block quotes
    /// match what a mint would charge.
    pub fn get_option_price(
        ctx: Context<GetOptionPrice>,
        strike: u64,
        expiry_ts: i64,
        option_type: OptionType,
        exercise_style: ExerciseStyle,
        carry_rate_bps: i32,
    ) -> Result<OptionPriceQuote> {
        instructions::get_option_price::handle_get_option_price(
            ctx, strike, expiry_ts, option_type, exercise_style, carry_rate_bps,
        )
    }

    /// Hot-path CU profile for push_vol_sample. Calls the ring +
    /// accumulator update directly with a synthetic log return,
    /// bracketed by sol_log_compute_units. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_push_vol_sample(
        ctx: Context<CuProfilePushVolSample>,
    ) -> Result<()> {
        instructions::cu_profile_push_vol_sample::handle_cu_profile_push_vol_sample(ctx)
    }

    /// CU profile for realized_vol_annualized. Synthesizes 720-sample
    /// accumulators in the oracle account, then measures the read
    /// function. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_realized_vol(
        ctx: Context<CuProfileRealizedVol>,
    ) -> Result<()> {
        instructions::cu_profile_realized_vol::handle_cu_profile_realized_vol(ctx)
    }

    // =========================================================================
    // Test-only CU profiling (gated by `cu-profile` Cargo feature).
    // NEVER deploy a cu-profile build to devnet/mainnet.
    // =========================================================================

    /// Profile compute-unit consumption of the BS-2002 American pricing kernel
    /// across three scenarios (CALL fast-path, CALL BS-2002 main, PUT via
    /// McD-S transform). Per-phi breakdown via gated markers inside
    /// `bs2002_call_price`. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_american(ctx: Context<CuProfileAmerican>) -> Result<()> {
        instructions::cu_profile_american::handle_cu_profile_american(ctx)
    }

    /// CU profile for the FULL American branch pipeline of mint_from_vault:
    /// VolOracle load + realized_vol_annualized + american_call_price /
    /// american_put_price. Synthesizes oracle accumulator state in-line so
    /// no warmup wait is needed. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_mint_from_vault_american(
        ctx: Context<CuProfileMintFromVaultAmerican>,
    ) -> Result<()> {
        instructions::cu_profile_mint_from_vault_american::handle_cu_profile_mint_from_vault_american(ctx)
    }

    /// CU profile for the Pass 3 `price_american` helper (the path
    /// `get_option_price` executes per call). Plants synthetic vol oracle
    /// state then measures Call q=5% + Put q=5% (both BS-2002 main path).
    /// Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_get_option_price(
        ctx: Context<CuProfileGetOptionPrice>,
    ) -> Result<()> {
        instructions::cu_profile_get_option_price::handle_cu_profile_get_option_price(ctx)
    }

    /// Shrink a SharedVault account back to its pre-Stage-A size (without the
    /// trailing carry_rate_bps field). Used by tests/realloc-shared-vault.ts
    /// to simulate a legacy on-chain vault before exercising the lazy-realloc
    /// migration in claim_premium. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn shrink_shared_vault_for_test(ctx: Context<ShrinkSharedVaultForTest>) -> Result<()> {
        instructions::shrink_shared_vault_for_test::handle_shrink_shared_vault_for_test(ctx)
    }

    /// Shrink a SharedVault account back to its pre-Pass-1 size (without
    /// the trailing exercise_style field). Used by
    /// tests/realloc-shared-vault-exercise-style.ts to simulate a legacy
    /// on-chain vault before exercising the
    /// migrate_shared_vault_exercise_style instruction. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn shrink_shared_vault_to_pre_exercise_style_for_test(
        ctx: Context<ShrinkSharedVaultToPreExerciseStyleForTest>,
    ) -> Result<()> {
        instructions::shrink_shared_vault_to_pre_exercise_style_for_test::handle_shrink_shared_vault_to_pre_exercise_style_for_test(ctx)
    }

    /// Initialize a bare SharedVault account with default values, bypassing
    /// the full create_shared_vault validation chain (no market/USDC/epoch/
    /// Pyth proof dependencies). Used by tests/realloc-shared-vault.ts to
    /// stand up vaults for the realloc tests. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn create_test_shared_vault(
        ctx: Context<CreateTestSharedVault>,
    ) -> Result<()> {
        instructions::create_test_shared_vault::handle_create_test_shared_vault(ctx)
    }

    /// Plant warmed VolOracle state (sample_count=720, fresh last_sample_ts,
    /// V2-reference accumulators, caller-supplied spot) so American pricing
    /// reads Ok past warmup/stale/math gates without 168 rate-limited pushes.
    /// Gated by `test-synth-vol`. NEVER deploy a test-synth-vol build — it
    /// lets anyone overwrite an oracle's vol state. Test-only.
    #[cfg(feature = "test-synth-vol")]
    pub fn synth_warm_vol_oracle(
        ctx: Context<SynthWarmVolOracle>,
        spot_price_scaled: i64,
        last_sample_ts: i64,
    ) -> Result<()> {
        instructions::synth_warm_vol_oracle::handle_synth_warm_vol_oracle(
            ctx, spot_price_scaled, last_sample_ts,
        )
    }
}
