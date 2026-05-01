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
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;
use state::*;

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
    ) -> Result<()> {
        instructions::create_market::handle_create_market(ctx, asset_name, pyth_feed_id, asset_class)
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
    ) -> Result<()> {
        instructions::create_shared_vault::handle_create_shared_vault(
            ctx, strike_price, expiry, option_type, vault_type, collateral_mint,
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
        ctx: Context<'_, '_, '_, 'info, AutoCancelListings<'info>>,
    ) -> Result<()> {
        instructions::auto_cancel_listings::handle_auto_cancel_listings(ctx)
    }
}
