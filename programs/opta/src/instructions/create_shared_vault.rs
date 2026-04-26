// =============================================================================
// instructions/create_shared_vault.rs — Create a new shared collateral vault
// =============================================================================
//
// Creates a SharedVault for a specific option specification (market + strike
// + expiry + type). The vault starts empty — depositing collateral is a
// separate instruction (deposit_to_vault).
//
// Two paths:
//   - Epoch vault: expiry must fall on configured epoch boundary (Friday 08:00 UTC)
//   - Custom vault: any future expiry at least 1 hour out
//
// The vault's USDC token account is created with the vault PDA as authority,
// so only the vault itself can sign for USDC transfers.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Mint as SplMint};

use crate::errors::OptaError;
use crate::events::VaultCreated;
use crate::state::*;
use crate::utils::epoch::is_valid_epoch_expiry;

/// Minimum time before expiry for custom vaults (5 seconds — short for testing).
const MIN_CUSTOM_EXPIRY_BUFFER: i64 = 5;

pub fn handle_create_shared_vault(
    ctx: Context<CreateSharedVault>,
    strike_price: u64,
    expiry: i64,
    option_type: OptionType,
    vault_type: VaultType,
) -> Result<()> {
    let clock = Clock::get()?;

    // Strike price must be positive
    require!(strike_price > 0, OptaError::InvalidStrikePrice);

    // Expiry must be in the future
    require!(expiry > clock.unix_timestamp, OptaError::ExpiryInPast);

    // Validate expiry based on vault type
    match vault_type {
        VaultType::Epoch => {
            // Epoch vaults must align to the configured epoch boundary
            let epoch_config = ctx.accounts.epoch_config
                .as_ref()
                .ok_or(OptaError::InvalidEpochExpiry)?;
            require!(
                is_valid_epoch_expiry(expiry, epoch_config),
                OptaError::InvalidEpochExpiry
            );

            // Must be at least min_epoch_duration_days from now
            let min_expiry = clock.unix_timestamp
                + (epoch_config.min_epoch_duration_days as i64) * 86400;
            require!(expiry >= min_expiry, OptaError::InvalidEpochExpiry);
        }
        VaultType::Custom => {
            // Custom vaults just need at least 1 hour buffer
            require!(
                expiry >= clock.unix_timestamp + MIN_CUSTOM_EXPIRY_BUFFER,
                OptaError::ExpiryInPast
            );
        }
    }

    // FIX M-01: Validate vault parameters match the market's parameters
    let market = &ctx.accounts.market;
    require!(strike_price == market.strike_price, OptaError::InvalidStrikePrice);
    require!(option_type as u8 == market.option_type as u8, OptaError::InvalidOptionType);
    require!(expiry == market.expiry_timestamp, OptaError::ExpiryMismatch);

    let vault = &mut ctx.accounts.shared_vault;
    vault.market = ctx.accounts.market.key();
    vault.option_type = option_type;
    vault.strike_price = strike_price;
    vault.expiry = expiry;
    vault.vault_type = vault_type;
    vault.total_collateral = 0;
    vault.total_shares = 0;
    vault.vault_usdc_account = ctx.accounts.vault_usdc_account.key();
    vault.total_options_minted = 0;
    vault.total_options_sold = 0;
    vault.net_premium_collected = 0;
    vault.premium_per_share_cumulative = 0; // FIX H-01
    vault.is_settled = false;
    vault.settlement_price = 0;
    vault.collateral_remaining = 0;
    vault.creator = ctx.accounts.creator.key();
    vault.created_at = clock.unix_timestamp;
    vault.bump = ctx.bumps.shared_vault;

    emit!(VaultCreated {
        vault: ctx.accounts.shared_vault.key(),
        market: ctx.accounts.market.key(),
        vault_type: vault_type as u8,
        strike_price,
        expiry,
        option_type: option_type as u8,
        creator: ctx.accounts.creator.key(),
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(strike_price: u64, expiry: i64, option_type: OptionType, vault_type: VaultType)]
pub struct CreateSharedVault<'info> {
    /// The vault creator (first writer). Pays for account creation.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// The OptionsMarket this vault is for. Must exist and be active.
    pub market: Account<'info, OptionsMarket>,

    /// The SharedVault PDA — unique per (market, strike, expiry, option_type).
    #[account(
        init,
        seeds = [
            SHARED_VAULT_SEED,
            market.key().as_ref(),
            &strike_price.to_le_bytes(),
            &expiry.to_le_bytes(),
            &[option_type as u8],
        ],
        bump,
        payer = creator,
        space = 8 + SharedVault::INIT_SPACE,
    )]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The vault's USDC token account. Authority = shared_vault PDA.
    /// This holds all the collateral deposited by writers.
    #[account(
        init,
        seeds = [
            VAULT_USDC_SEED,
            shared_vault.key().as_ref(),
        ],
        bump,
        payer = creator,
        token::mint = usdc_mint,
        token::authority = shared_vault,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// USDC mint — validated against the protocol's stored USDC mint.
    #[account(constraint = usdc_mint.key() == protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, SplMint>,

    /// Protocol state — for USDC mint validation.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Epoch config — required for Epoch vaults, optional for Custom.
    /// When present, used to validate the expiry aligns with the epoch schedule.
    pub epoch_config: Option<Account<'info, EpochConfig>>,

    /// Standard SPL Token program — for the USDC token account.
    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}
