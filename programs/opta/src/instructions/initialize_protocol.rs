// =============================================================================
// instructions/initialize_protocol.rs — One-time protocol setup
// =============================================================================
//
// This instruction creates the global ProtocolState account and a treasury
// token account (for collecting USDC fees). It can only be called once because
// the ProtocolState PDA is derived from a fixed seed — any second call will
// fail with "already in use".
//
// Who can call: Anyone (but practically, the deployer calls this once).
// What it does:
//   1. Creates the ProtocolState PDA
//   2. Creates a treasury token account (PDA) owned by the protocol
//   3. Sets the caller as admin, fee to 50 bps
//   4. Stores the USDC mint for validation in other instructions
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::{ProtocolState, PROTOCOL_SEED};

/// Seed for deriving the treasury token account PDA.
pub const TREASURY_SEED: &[u8] = b"treasury_v2";

/// Handler: initialize the protocol with default settings.
pub fn handle_initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol_state;

    // Set the admin to whoever signed this transaction.
    // The admin can later update fees, transfer admin rights, etc.
    protocol.admin = ctx.accounts.admin.key();

    // Default fee: 50 basis points (0.50%).
    // This means on a 100 USDC premium, the protocol takes 0.50 USDC.
    protocol.fee_bps = 50;

    // Store the treasury token account address for easy lookup.
    protocol.treasury = ctx.accounts.treasury.key();

    // Store the USDC mint so other instructions can validate token accounts.
    protocol.usdc_mint = ctx.accounts.usdc_mint.key();

    // Counters start at zero.
    protocol.total_markets = 0;
    protocol.total_volume = 0;

    // Store the bump so we can sign for this PDA in future instructions.
    protocol.bump = ctx.bumps.protocol_state;

    msg!(
        "Opta protocol initialized. Admin: {}",
        protocol.admin
    );

    Ok(())
}

// =============================================================================
// Account validation — Anchor checks these constraints BEFORE the handler runs
// =============================================================================

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    /// The admin who is initializing the protocol. They pay for account rent
    /// and become the protocol admin.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// ProtocolState PDA — the global config singleton.
    /// `init` means Anchor will create this account. If it already exists,
    /// the transaction fails (preventing double-initialization).
    #[account(
        init,
        seeds = [PROTOCOL_SEED],
        bump,
        payer = admin,
        space = 8 + ProtocolState::INIT_SPACE,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Treasury — a USDC token account owned by the protocol PDA.
    /// This is where protocol fees accumulate.
    #[account(
        init,
        seeds = [TREASURY_SEED],
        bump,
        payer = admin,
        token::mint = usdc_mint,
        token::authority = protocol_state,
    )]
    pub treasury: Account<'info, TokenAccount>,

    /// The USDC mint account. On devnet, this is a test mint.
    pub usdc_mint: Account<'info, Mint>,

    /// Required system programs for account creation.
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}
