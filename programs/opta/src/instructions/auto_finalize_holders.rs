// =============================================================================
// instructions/auto_finalize_holders.rs — Permissionless holder-side wrap-up
// =============================================================================
//
// Step 1 of the auto-finalize work (see docs/AUTO_FINALIZE_PLAN.md). For a
// settled vault and one specific option_mint within that vault, walks a batch
// of (holder_option_ata, holder_usdc_ata) pairs in remaining_accounts and:
//
//   1. Reads the holder's option-token amount; skips silently if zero
//      (already burned / exercised / never held).
//   2. Verifies the holder_option_ata's mint == option_mint and reads the
//      holder's wallet address from offset 32..64.
//   3. Verifies holder_usdc_ata.mint == vault.collateral_mint and
//      holder_usdc_ata.owner == holder's wallet. On any mismatch, skips
//      silently. This is what catches purchase_escrows owned by the protocol
//      PDA and accidental cross-mint passes.
//   4. Computes payout_per_contract using the SAME formula as
//      exercise_from_vault.rs:46-63.
//   5. Burns the holder's tokens via PermanentDelegate authority signed by
//      protocol_state PDA.
//   6. If ITM, transfers USDC from vault → holder, signed by shared_vault PDA.
//   7. Decrements vault.collateral_remaining.
//
// Permissionless. Idempotent (zero-amount skip + per-holder isolation).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::HoldersFinalized;
use crate::state::*;

pub fn handle_auto_finalize_holders<'info>(
    ctx: Context<'_, '_, '_, 'info, AutoFinalizeHolders<'info>>,
) -> Result<()> {
    require!(
        ctx.accounts.shared_vault.is_settled,
        OptaError::VaultNotSettled
    );
    require!(
        ctx.remaining_accounts.len() % 2 == 0,
        OptaError::InvalidBatchAccounts
    );

    // ----- Snapshot read-only vault fields used inside the loop -------------
    let vault_pubkey = ctx.accounts.shared_vault.key();
    let option_type = ctx.accounts.shared_vault.option_type;
    let strike_price = ctx.accounts.shared_vault.strike_price;
    let settlement_price = ctx.accounts.shared_vault.settlement_price;
    let expiry = ctx.accounts.shared_vault.expiry;
    let market_key = ctx.accounts.shared_vault.market;
    let vault_bump = ctx.accounts.shared_vault.bump;
    let collateral_mint = ctx.accounts.shared_vault.collateral_mint;

    let option_mint_key = ctx.accounts.option_mint.key();
    let token_2022_key = ctx.accounts.token_2022_program.key();
    let protocol_bump = ctx.accounts.protocol_state.bump;
    let protocol_key = ctx.accounts.protocol_state.key();

    // Same formula as exercise_from_vault.rs:46-63 — single-asset payout per
    // contract. Computed once outside the loop because settlement_price,
    // strike_price and option_type are vault-wide.
    let payout_per_contract: u64 = match option_type {
        OptionType::Call => {
            if settlement_price > strike_price {
                settlement_price
                    .checked_sub(strike_price)
                    .ok_or(OptaError::MathOverflow)?
            } else {
                0
            }
        }
        OptionType::Put => {
            if strike_price > settlement_price {
                strike_price
                    .checked_sub(settlement_price)
                    .ok_or(OptaError::MathOverflow)?
            } else {
                0
            }
        }
    };

    let mut holders_processed: u32 = 0;
    let mut total_burned: u64 = 0;
    let mut total_paid_out: u64 = 0;

    for pair in ctx.remaining_accounts.chunks_exact(2) {
        let holder_option_ata = &pair[0];
        let holder_usdc_ata = &pair[1];

        // --------- Read holder_option_ata: mint(0..32), owner(32..64), amount(64..72)
        let amount: u64;
        let holder_owner: Pubkey;
        {
            let data = match holder_option_ata.try_borrow_data() {
                Ok(d) => d,
                Err(_) => continue,
            };
            if data.len() < 72 {
                continue;
            }
            let mint_bytes: [u8; 32] = match data[0..32].try_into() {
                Ok(b) => b,
                Err(_) => continue,
            };
            if Pubkey::new_from_array(mint_bytes) != option_mint_key {
                continue;
            }
            let owner_bytes: [u8; 32] = match data[32..64].try_into() {
                Ok(b) => b,
                Err(_) => continue,
            };
            holder_owner = Pubkey::new_from_array(owner_bytes);
            let amount_bytes: [u8; 8] = match data[64..72].try_into() {
                Ok(b) => b,
                Err(_) => continue,
            };
            amount = u64::from_le_bytes(amount_bytes);
        }
        if amount == 0 {
            continue;
        }

        // --------- Verify holder_usdc_ata: mint(0..32), owner(32..64)
        // Mismatch on either field = silent skip (covers purchase_escrows whose
        // mint != USDC, cross-vault USDC ATAs whose owner != holder, etc.)
        {
            let usdc_data = match holder_usdc_ata.try_borrow_data() {
                Ok(d) => d,
                Err(_) => continue,
            };
            if usdc_data.len() < 64 {
                continue;
            }
            let usdc_mint_bytes: [u8; 32] = match usdc_data[0..32].try_into() {
                Ok(b) => b,
                Err(_) => continue,
            };
            if Pubkey::new_from_array(usdc_mint_bytes) != collateral_mint {
                continue;
            }
            let usdc_owner_bytes: [u8; 32] = match usdc_data[32..64].try_into() {
                Ok(b) => b,
                Err(_) => continue,
            };
            if Pubkey::new_from_array(usdc_owner_bytes) != holder_owner {
                continue;
            }
        }

        // --------- Compute capped payout against current collateral_remaining
        let raw_payout = amount
            .checked_mul(payout_per_contract)
            .ok_or(OptaError::MathOverflow)?;
        let current_remaining = ctx.accounts.shared_vault.collateral_remaining;
        let total_payout = std::cmp::min(raw_payout, current_remaining);

        // --------- Burn via PermanentDelegate (protocol_state PDA signs)
        // Same CPI shape as plan §2 Option B step 5.
        let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol_bump]];
        let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

        invoke_signed(
            &spl_token_2022::instruction::burn(
                &token_2022_key,
                holder_option_ata.key,
                &option_mint_key,
                &protocol_key,
                &[],
                amount,
            )?,
            &[
                holder_option_ata.clone(),
                ctx.accounts.option_mint.to_account_info(),
                ctx.accounts.protocol_state.to_account_info(),
            ],
            protocol_signer,
        )?;

        // --------- Transfer USDC if ITM (shared_vault PDA signs)
        // Mirrors exercise_from_vault.rs:99-126.
        if total_payout > 0 {
            let strike_bytes = strike_price.to_le_bytes();
            let expiry_bytes = expiry.to_le_bytes();
            let option_type_byte = [option_type as u8];
            let vault_bump_arr = [vault_bump];
            let vault_seeds: &[&[u8]] = &[
                SHARED_VAULT_SEED,
                market_key.as_ref(),
                &strike_bytes,
                &expiry_bytes,
                &option_type_byte,
                &vault_bump_arr,
            ];
            let vault_signer: &[&[&[u8]]] = &[vault_seeds];

            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_usdc_account.to_account_info(),
                    to: holder_usdc_ata.clone(),
                    authority: ctx.accounts.shared_vault.to_account_info(),
                },
                vault_signer,
            );
            token::transfer(transfer_ctx, total_payout)?;

            ctx.accounts.shared_vault.collateral_remaining = ctx
                .accounts
                .shared_vault
                .collateral_remaining
                .checked_sub(total_payout)
                .ok_or(OptaError::MathOverflow)?;
        }

        holders_processed = holders_processed
            .checked_add(1)
            .ok_or(OptaError::MathOverflow)?;
        total_burned = total_burned
            .checked_add(amount)
            .ok_or(OptaError::MathOverflow)?;
        total_paid_out = total_paid_out
            .checked_add(total_payout)
            .ok_or(OptaError::MathOverflow)?;
    }

    emit!(HoldersFinalized {
        vault: vault_pubkey,
        holders_processed,
        total_burned,
        total_paid_out,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AutoFinalizeHolders<'info> {
    /// Permissionless caller — pays the tx fee. Not stored anywhere.
    pub caller: Signer<'info>,

    /// The settled shared vault.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The vault's market — pinned to the vault for sanity, not read in handler.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// Per-mint tracking record. Pins option_mint to this vault so callers
    /// can't pass an unrelated mint with a matching vault.
    #[account(
        constraint = vault_mint_record.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == option_mint.key() @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Account<'info, VaultMint>,

    /// The Token-2022 option mint being burned from. Must be `mut` so the
    /// burn CPI can decrement `supply` on the mint account.
    /// CHECK: Validated via vault_mint_record + Token-2022 burn CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Vault's USDC account — payout source.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Protocol state — PermanentDelegate authority on every option mint.
    /// Signs as `[b"protocol_v2", &[bump]]` to authorize the burns.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Token-2022 program — for burning option tokens.
    pub token_2022_program: Program<'info, Token2022>,

    /// Standard SPL Token program — for USDC transfers from vault → holder.
    pub token_program: Program<'info, Token>,
    // remaining_accounts: pairs of (holder_option_ata, holder_usdc_ata).
}
