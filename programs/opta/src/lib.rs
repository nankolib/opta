// =============================================================================
// lib.rs — Opta: Tokenized P2P options protocol on Solana
// =============================================================================
//
// Options are represented as SPL tokens. Whoever holds the tokens can exercise.
// This makes options tradeable on the built-in P2P marketplace or any DEX.
//
// Surface (Stage 2):
//   1. initialize_protocol  — One-time setup
//   2. create_market        — Register a supported asset (admin-only, idempotent)
//   v2 vault instructions follow below.
//
// Note: Stage 2 transitional shape — settle_vault temporarily takes
// `settlement_price` as an admin-signed argument (mirroring the deleted
// settle_market). Stage 3 swaps that arg for a SettlementRecord PDA read.
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

    /// Register a supported asset (admin-only, idempotent).
    /// One Market PDA per asset; strike/expiry/type live on SharedVault.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        asset_name: String,
        pyth_feed: Pubkey,
        asset_class: u8,
    ) -> Result<()> {
        instructions::create_market::handle_create_market(ctx, asset_name, pyth_feed, asset_class)
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
    ) -> Result<()> {
        instructions::create_shared_vault::handle_create_shared_vault(
            ctx, strike_price, expiry, option_type, vault_type,
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

    /// Settle a shared vault after expiry. Stage 2 transitional: admin
    /// passes the settlement price inline. Stage 3 will replace this with
    /// a SettlementRecord PDA read.
    pub fn settle_vault(ctx: Context<SettleVault>, settlement_price: u64) -> Result<()> {
        instructions::settle_vault::handle_settle_vault(ctx, settlement_price)
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
}
