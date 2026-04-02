// =============================================================================
// example_integration.rs — Example CPI integration with Butter Options
// =============================================================================
//
// This file shows how another Solana program (e.g., a vault, strategy, or
// hedging engine) would call Butter Options via Cross-Program Invocation.
//
// This is EXAMPLE CODE — it won't compile on its own. It demonstrates the
// patterns and account structures needed for integration.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

// Import Butter Options types via the `cpi` feature
// In your Cargo.toml: butter-options = { path = "...", features = ["cpi"] }
use butter_options::cpi::accounts::{CreateMarket, WriteOption, BuyOption};
use butter_options::cpi;
use butter_options::state::{OptionType, ProtocolState, OptionsMarket, OptionPosition};

declare_id!("YourProgramIdHere1111111111111111111111111111");

#[program]
pub mod example_vault {
    use super::*;

    // =========================================================================
    // Example 1: Create a market for any asset
    //
    // Your program decides which asset to create a market for. This could be
    // triggered by governance, a keeper bot, or user request.
    // =========================================================================
    pub fn create_hedging_market(
        ctx: Context<CreateHedgingMarket>,
        asset_name: String,
        strike_price: u64,
        expiry_timestamp: i64,
        pyth_feed: Pubkey,
    ) -> Result<()> {
        // Build the CPI call to Butter Options
        let cpi_program = ctx.accounts.butter_options_program.to_account_info();
        let cpi_accounts = CreateMarket {
            creator: ctx.accounts.vault_authority.to_account_info(),
            protocol_state: ctx.accounts.protocol_state.to_account_info(),
            market: ctx.accounts.market.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };

        // If the creator is a PDA, sign with its seeds
        let seeds = &[b"vault_authority", &[ctx.accounts.vault_state.authority_bump]];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Call create_market — creates a Put option market for hedging
        cpi::create_market(
            cpi_ctx,
            asset_name,
            strike_price,
            expiry_timestamp,
            OptionType::Put,  // Puts for downside protection
            pyth_feed,
        )?;

        msg!("Hedging market created via CPI");
        Ok(())
    }

    // =========================================================================
    // Example 2: Write a covered call (earn yield on vault assets)
    //
    // The vault locks USDC collateral and writes a call option. The premium
    // earned is yield for vault depositors.
    // =========================================================================
    pub fn write_covered_call(
        ctx: Context<WriteCoveredCall>,
        collateral_amount: u64,
        premium: u64,
        contract_size: u64,
    ) -> Result<()> {
        let cpi_program = ctx.accounts.butter_options_program.to_account_info();
        let cpi_accounts = WriteOption {
            writer: ctx.accounts.vault_authority.to_account_info(),
            protocol_state: ctx.accounts.protocol_state.to_account_info(),
            market: ctx.accounts.market.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            escrow: ctx.accounts.escrow.to_account_info(),
            writer_token_account: ctx.accounts.vault_usdc.to_account_info(),
            usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
        };

        let seeds = &[b"vault_authority", &[ctx.accounts.vault_state.authority_bump]];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        // Use current timestamp for the created_at PDA seed
        let clock = Clock::get()?;
        let created_at = clock.unix_timestamp;

        cpi::write_option(cpi_ctx, collateral_amount, premium, contract_size, created_at)?;

        msg!("Covered call written via CPI — premium: {}", premium);
        Ok(())
    }

    // =========================================================================
    // Example 3: Buy a put option for hedging
    //
    // The vault buys a put option to protect against downside risk on its
    // collateral. This is portfolio insurance.
    // =========================================================================
    pub fn buy_hedge(ctx: Context<BuyHedge>) -> Result<()> {
        let cpi_program = ctx.accounts.butter_options_program.to_account_info();
        let cpi_accounts = BuyOption {
            buyer: ctx.accounts.vault_authority.to_account_info(),
            protocol_state: ctx.accounts.protocol_state.to_account_info(),
            market: ctx.accounts.market.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            buyer_token_account: ctx.accounts.vault_usdc.to_account_info(),
            writer_token_account: ctx.accounts.writer_usdc.to_account_info(),
            treasury: ctx.accounts.treasury.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };

        let seeds = &[b"vault_authority", &[ctx.accounts.vault_state.authority_bump]];
        let signer_seeds = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        cpi::buy_option(cpi_ctx)?;

        msg!("Hedge purchased via CPI");
        Ok(())
    }
}

// =============================================================================
// Account structs (simplified — you'd add your own vault state accounts)
// =============================================================================

#[account]
pub struct VaultState {
    pub authority_bump: u8,
    // ... your vault fields
}

#[derive(Accounts)]
pub struct CreateHedgingMarket<'info> {
    #[account(mut)]
    pub vault_authority: Signer<'info>,
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: Butter Options protocol state PDA
    #[account(mut)]
    pub protocol_state: UncheckedAccount<'info>,
    /// CHECK: New market PDA (Butter Options will init it)
    #[account(mut)]
    pub market: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Butter Options program
    pub butter_options_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WriteCoveredCall<'info> {
    #[account(mut)]
    pub vault_authority: Signer<'info>,
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: Butter Options protocol state
    pub protocol_state: UncheckedAccount<'info>,
    /// CHECK: Market to write option on
    pub market: UncheckedAccount<'info>,
    /// CHECK: New position PDA
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: New escrow PDA
    #[account(mut)]
    pub escrow: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault_usdc: Account<'info, TokenAccount>,
    /// CHECK: USDC mint
    pub usdc_mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
    /// CHECK: Butter Options program
    pub butter_options_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BuyHedge<'info> {
    #[account(mut)]
    pub vault_authority: Signer<'info>,
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: Butter Options protocol state
    #[account(mut)]
    pub protocol_state: UncheckedAccount<'info>,
    /// CHECK: Market
    pub market: UncheckedAccount<'info>,
    /// CHECK: Position to buy
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault_usdc: Account<'info, TokenAccount>,
    /// CHECK: Writer's USDC account
    #[account(mut)]
    pub writer_usdc: UncheckedAccount<'info>,
    /// CHECK: Protocol treasury
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: Butter Options program
    pub butter_options_program: UncheckedAccount<'info>,
}
