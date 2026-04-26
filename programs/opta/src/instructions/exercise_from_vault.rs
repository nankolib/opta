// =============================================================================
// instructions/exercise_from_vault.rs — Token holder exercises from settled vault
// =============================================================================
//
// After a vault is settled, option token holders can exercise their tokens
// to receive USDC payout. The holder burns their own tokens (same pattern as
// v1 exercise_option.rs) and receives proportional payout from the vault.
//
// IMPORTANT: The holder signs for the burn of their own tokens. We do NOT
// use PermanentDelegate here. This matches the v1 exercise pattern exactly.
//
// Token-2022 note: Burns do NOT trigger the transfer hook.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::VaultExercised;
use crate::state::*;

pub fn handle_exercise_from_vault(
    ctx: Context<ExerciseFromVault>,
    quantity: u64,
) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;

    // Validation
    require!(vault.is_settled, OptaError::VaultNotSettled);
    require!(quantity > 0, OptaError::InvalidContractSize);

    // Read holder's token balance from Token-2022 account data (amount at bytes 64..72)
    let holder_data = ctx.accounts.holder_option_account.try_borrow_data()?;
    let holder_balance = u64::from_le_bytes(
        holder_data[64..72].try_into().map_err(|_| OptaError::MathOverflow)?
    );
    drop(holder_data);
    require!(quantity <= holder_balance, OptaError::InsufficientOptionTokens);

    // Calculate payout per contract (same formula as settle_vault)
    let settlement_price = vault.settlement_price;
    let strike_price = vault.strike_price;

    let payout_per_contract = match vault.option_type {
        OptionType::Call => {
            if settlement_price > strike_price {
                settlement_price.checked_sub(strike_price)
                    .ok_or(OptaError::MathOverflow)?
            } else {
                0
            }
        }
        OptionType::Put => {
            if strike_price > settlement_price {
                strike_price.checked_sub(settlement_price)
                    .ok_or(OptaError::MathOverflow)?
            } else {
                0
            }
        }
    };

    require!(payout_per_contract > 0, OptaError::OptionNotInTheMoney);

    let total_payout = quantity
        .checked_mul(payout_per_contract)
        .ok_or(OptaError::MathOverflow)?;

    // Cap at remaining collateral
    let total_payout = std::cmp::min(total_payout, vault.collateral_remaining);

    // =========================================================================
    // Burn option tokens — HOLDER signs for their own tokens (same as v1)
    //
    // This is NOT a PermanentDelegate burn. The holder authorizes the burn
    // of their own tokens, exactly like exercise_option.rs.
    // =========================================================================
    invoke(
        &spl_token_2022::instruction::burn(
            &ctx.accounts.token_2022_program.key(),
            ctx.accounts.holder_option_account.key,
            ctx.accounts.option_mint.key,
            ctx.accounts.holder.key,
            &[],
            quantity,
        )?,
        &[
            ctx.accounts.holder_option_account.to_account_info(),
            ctx.accounts.option_mint.to_account_info(),
            ctx.accounts.holder.to_account_info(),
        ],
    )?;

    // =========================================================================
    // Transfer USDC payout from vault to holder (signed by shared_vault PDA)
    // =========================================================================
    if total_payout > 0 {
        let market_key = vault.market;
        let strike_bytes = vault.strike_price.to_le_bytes();
        let expiry_bytes = vault.expiry.to_le_bytes();
        let option_type_byte = [vault.option_type as u8];
        let vault_bump = [vault.bump];

        let vault_seeds: &[&[u8]] = &[
            SHARED_VAULT_SEED,
            market_key.as_ref(),
            &strike_bytes,
            &expiry_bytes,
            &option_type_byte,
            &vault_bump,
        ];
        let signer_seeds = &[vault_seeds];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_usdc_account.to_account_info(),
                to: ctx.accounts.holder_usdc_account.to_account_info(),
                authority: ctx.accounts.shared_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, total_payout)?;
    }

    // Update vault state
    let vault_key = ctx.accounts.shared_vault.key();
    let holder_key = ctx.accounts.holder.key();

    let vault = &mut ctx.accounts.shared_vault;
    vault.collateral_remaining = vault.collateral_remaining
        .checked_sub(total_payout)
        .ok_or(OptaError::MathOverflow)?;

    emit!(VaultExercised {
        vault: vault_key,
        holder: holder_key,
        quantity,
        payout: total_payout,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExerciseFromVault<'info> {
    /// The option token holder exercising their tokens.
    #[account(mut)]
    pub holder: Signer<'info>,

    /// The settled shared vault.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The market — for settlement verification.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    // FIX H-02: validate option_mint belongs to vault via VaultMint record
    #[account(
        constraint = vault_mint_record.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == option_mint.key() @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Account<'info, VaultMint>,

    /// The Token-2022 option mint.
    /// CHECK: Validated by the Token-2022 burn instruction + vault_mint_record constraint.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Holder's option token account (Token-2022).
    /// CHECK: Validated by the Token-2022 burn instruction (checks mint + owner).
    #[account(mut)]
    pub holder_option_account: UncheckedAccount<'info>,

    /// Vault's USDC account — payout source.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Holder's USDC account — receives payout.
    #[account(
        mut,
        constraint = holder_usdc_account.owner == holder.key(),
        constraint = holder_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub holder_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Protocol state — for USDC mint validation.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Token-2022 program — for burning option tokens.
    pub token_2022_program: Program<'info, Token2022>,

    /// Standard SPL Token program — for USDC transfers.
    pub token_program: Program<'info, Token>,
}
