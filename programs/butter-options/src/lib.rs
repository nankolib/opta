// =============================================================================
// lib.rs — Butter Options: Tokenized P2P options protocol on Solana
// =============================================================================
//
// Options are represented as SPL tokens. Whoever holds the tokens can exercise.
// This makes options tradeable on the built-in P2P marketplace or any DEX.
//
// Instructions:
//   1. initialize_protocol  — One-time setup
//   2. create_market        — Create options market for any asset
//   3. write_option         — Lock collateral, mint option tokens to writer
//   4. purchase_option      — Buy tokens from writer (pay premium)
//   5. settle_market        — Set settlement price after expiry
//   6. exercise_option      — Token holder burns tokens, receives PnL
//   7. expire_option        — Return collateral for unexercised options
//   8. cancel_option        — Writer burns all tokens, reclaims collateral
//   9. list_for_resale      — List tokens on P2P resale market
//  10. buy_resale           — Buy tokens from resale listing
//  11. cancel_resale        — Cancel resale listing
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
pub mod butter_options {
    use super::*;

    pub fn initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
        instructions::initialize_protocol::handle_initialize_protocol(ctx)
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        asset_name: String,
        strike_price: u64,
        expiry_timestamp: i64,
        option_type: OptionType,
        pyth_feed: Pubkey,
        asset_class: u8,
    ) -> Result<()> {
        instructions::create_market::handle_create_market(ctx, asset_name, strike_price, expiry_timestamp, option_type, pyth_feed, asset_class)
    }

    /// Write an option: lock collateral, mint option tokens to writer.
    pub fn write_option(
        ctx: Context<WriteOption>,
        collateral_amount: u64,
        premium: u64,
        contract_size: u64,
        created_at: i64,
    ) -> Result<()> {
        instructions::write_option::handle_write_option(ctx, collateral_amount, premium, contract_size, created_at)
    }

    /// Purchase option tokens. Amount is how many tokens to buy (partial fills supported).
    pub fn purchase_option(ctx: Context<PurchaseOption>, amount: u64) -> Result<()> {
        instructions::purchase_option::handle_purchase_option(ctx, amount)
    }

    /// Settle an expired market with a price (admin-only for hackathon).
    pub fn settle_market(ctx: Context<SettleMarket>, settlement_price: u64) -> Result<()> {
        instructions::settle_market::handle_settle_market(ctx, settlement_price)
    }

    /// Exercise option tokens after settlement. Burns tokens, distributes PnL.
    pub fn exercise_option(ctx: Context<ExerciseOption>, tokens_to_exercise: u64) -> Result<()> {
        instructions::exercise_option::handle_exercise_option(ctx, tokens_to_exercise)
    }

    /// Expire an unexercised option. Returns collateral to writer.
    pub fn expire_option(ctx: Context<ExpireOption>) -> Result<()> {
        instructions::expire_option::handle_expire_option(ctx)
    }

    /// Cancel an unsold option. Burns all tokens, returns collateral.
    pub fn cancel_option(ctx: Context<CancelOption>) -> Result<()> {
        instructions::cancel_option::handle_cancel_option(ctx)
    }

    /// List option tokens for resale. token_amount is how many to list.
    pub fn list_for_resale(ctx: Context<ListForResale>, resale_premium: u64, token_amount: u64) -> Result<()> {
        instructions::list_for_resale::handle_list_for_resale(ctx, resale_premium, token_amount)
    }

    /// Buy tokens from a resale listing. amount is how many to buy (partial fills).
    pub fn buy_resale(ctx: Context<BuyResale>, amount: u64) -> Result<()> {
        instructions::buy_resale::handle_buy_resale(ctx, amount)
    }

    /// Cancel a resale listing. Returns tokens to seller.
    pub fn cancel_resale(ctx: Context<CancelResale>) -> Result<()> {
        instructions::cancel_resale::handle_cancel_resale(ctx)
    }

    /// Create on-chain pricing account for an option position.
    /// Called once per position by the crank bot.
    pub fn initialize_pricing(ctx: Context<InitializePricing>) -> Result<()> {
        instructions::initialize_pricing::handle_initialize_pricing(ctx)
    }

    /// Compute Black-Scholes on-chain and store fair value + Greeks.
    /// Permissionless — anyone can call with a spot price and implied vol.
    pub fn update_pricing(
        ctx: Context<UpdatePricing>,
        spot_price_used: u64,
        implied_vol_bps: u64,
    ) -> Result<()> {
        instructions::update_pricing::handle_update_pricing(ctx, spot_price_used, implied_vol_bps)
    }
}
