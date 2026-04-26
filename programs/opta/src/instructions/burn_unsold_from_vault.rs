// =============================================================================
// instructions/burn_unsold_from_vault.rs — Burn unsold tokens from a vault mint
// =============================================================================
//
// When a writer wants to exit a position with unsold inventory, they burn the
// remaining tokens in the purchase escrow. This frees up their committed
// collateral so they can withdraw it or re-mint at a different price.
//
// The burn uses the protocol PDA as the token account owner (not PermanentDelegate)
// since the purchase escrow is owned by the protocol PDA — same as v1.
//
// After burning, the purchase escrow is closed and rent returned to the writer.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::VaultBurnUnsold;
use crate::state::*;

pub fn handle_burn_unsold_from_vault(ctx: Context<BurnUnsoldFromVault>) -> Result<()> {
    let vault_mint = &ctx.accounts.vault_mint_record;

    // Validate writer owns this position
    require!(
        ctx.accounts.writer_position.owner == ctx.accounts.writer.key(),
        OptaError::NotWriter
    );
    require!(
        vault_mint.writer == ctx.accounts.writer.key(),
        OptaError::NotWriter
    );
    require!(
        vault_mint.vault == ctx.accounts.shared_vault.key(),
        OptaError::Unauthorized
    );

    // Read unsold count from the purchase escrow (Token-2022 layout: amount at bytes 64..72)
    let escrow_data = ctx.accounts.purchase_escrow.try_borrow_data()?;
    let unsold = u64::from_le_bytes(
        escrow_data[64..72].try_into().map_err(|_| OptaError::MathOverflow)?
    );
    drop(escrow_data);

    require!(unsold > 0, OptaError::NoTokensToBurn);

    // Protocol PDA signs for the burn (it owns the purchase escrow)
    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    let token_2022_key = ctx.accounts.token_2022_program.key();

    // Burn all unsold tokens from the purchase escrow
    invoke_signed(
        &spl_token_2022::instruction::burn(
            &token_2022_key,
            ctx.accounts.purchase_escrow.key,
            ctx.accounts.option_mint.key,
            &ctx.accounts.protocol_state.key(),
            &[],
            unsold,
        )?,
        &[
            ctx.accounts.purchase_escrow.to_account_info(),
            ctx.accounts.option_mint.to_account_info(),
            ctx.accounts.protocol_state.to_account_info(),
        ],
        signer_seeds,
    )?;

    // Close the purchase escrow — return rent to the writer
    invoke_signed(
        &spl_token_2022::instruction::close_account(
            &token_2022_key,
            ctx.accounts.purchase_escrow.key,
            ctx.accounts.writer.key,
            &ctx.accounts.protocol_state.key(),
            &[],
        )?,
        &[
            ctx.accounts.purchase_escrow.to_account_info(),
            ctx.accounts.writer.to_account_info(),
            ctx.accounts.protocol_state.to_account_info(),
        ],
        signer_seeds,
    )?;

    // Capture keys before mutable borrows
    let vault_key = ctx.accounts.shared_vault.key();
    let writer_key = ctx.accounts.writer.key();
    let mint_key = *ctx.accounts.option_mint.key;

    // Update VaultMint record
    let vault_mint = &mut ctx.accounts.vault_mint_record;
    vault_mint.quantity_minted = vault_mint.quantity_minted
        .checked_sub(unsold)
        .ok_or(OptaError::MathOverflow)?;

    // Update writer position
    let writer_pos = &mut ctx.accounts.writer_position;
    writer_pos.options_minted = writer_pos.options_minted
        .checked_sub(unsold)
        .ok_or(OptaError::MathOverflow)?;

    // Update vault totals
    let vault = &mut ctx.accounts.shared_vault;
    vault.total_options_minted = vault.total_options_minted
        .checked_sub(unsold)
        .ok_or(OptaError::MathOverflow)?;

    emit!(VaultBurnUnsold {
        vault: vault_key,
        writer: writer_key,
        mint: mint_key,
        burned: unsold,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct BurnUnsoldFromVault<'info> {
    /// The writer burning their unsold tokens.
    #[account(mut)]
    pub writer: Signer<'info>,

    /// The shared vault.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Writer's position in the vault.
    #[account(
        mut,
        seeds = [WRITER_POSITION_SEED, shared_vault.key().as_ref(), writer.key().as_ref()],
        bump = writer_position.bump,
    )]
    pub writer_position: Box<Account<'info, WriterPosition>>,

    /// VaultMint record for this specific mint.
    #[account(mut)]
    pub vault_mint_record: Box<Account<'info, VaultMint>>,

    /// Protocol state — signs as purchase escrow owner for the burn.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The Token-2022 option mint being burned.
    /// CHECK: Validated against vault_mint_record.option_mint.
    #[account(mut, constraint = option_mint.key() == vault_mint_record.option_mint)]
    pub option_mint: UncheckedAccount<'info>,

    /// Purchase escrow holding the unsold tokens.
    /// CHECK: Validated by PDA seeds and Token-2022 burn instruction.
    // FIX LOW-01: Added PDA seed validation for purchase_escrow
    #[account(
        mut,
        seeds = [
            VAULT_PURCHASE_ESCROW_SEED,
            shared_vault.key().as_ref(),
            vault_mint_record.writer.as_ref(),
            &vault_mint_record.created_at.to_le_bytes(),
        ],
        bump,
    )]
    pub purchase_escrow: UncheckedAccount<'info>,

    /// Token-2022 program.
    pub token_2022_program: Program<'info, Token2022>,
}
