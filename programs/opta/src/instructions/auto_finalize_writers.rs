// =============================================================================
// instructions/auto_finalize_writers.rs — Permissionless writer-side wrap-up
// =============================================================================
//
// Step 3 of the auto-finalize work (see docs/AUTO_FINALIZE_PLAN.md). For a
// settled vault, walks a batch of (writer_position, writer_usdc_ata,
// writer_wallet) triples in remaining_accounts and:
//
//   1. Tries to deserialize writer_position. If deserialization fails (the
//      account was closed by an earlier withdraw_post_settlement or by an
//      earlier auto_finalize_writers tx), skips silently.
//   2. Verifies writer_position.vault == shared_vault.key(). If not, reverts
//      with WriterPositionVaultMismatch — the caller passed a wrong-vault
//      position, that's a real bug, not a race.
//   3. Verifies writer_wallet.key() == writer_position.owner. If not, reverts
//      with WriterWalletMismatch — needed because we drain rent to the
//      wallet, sending it to the wrong place would lose the writer's rent.
//   4. Verifies writer_usdc_ata.mint == vault.collateral_mint AND
//      writer_usdc_ata.owner == writer_position.owner. If either fails, skip
//      silently — same idempotent-skip path the holder side uses.
//   5. Computes unclaimed premium and pro-rata collateral share with the
//      EXACT formulas from withdraw_post_settlement.rs:30-48.
//   6. Transfers USDC vault → writer_usdc_ata signed by shared_vault PDA
//      (mirrors withdraw_post_settlement.rs:71-95).
//   7. Decrements vault.collateral_remaining, total_shares, total_collateral
//      (mirrors withdraw_post_settlement.rs:100-109).
//   8. Manually closes writer_position by draining lamports to the writer's
//      wallet, reassigning to system_program, and reallocating to zero data.
//
// After the loop, if vault.total_shares == 0 (last writer was in this batch),
// sweeps any remaining USDC from vault_usdc_account → protocol treasury and
// closes vault_usdc_account with the rent SOL going to the treasury too.
//
// Permissionless. Idempotent (deserialization-fail → skip; mismatched USDC
// ATA → skip; closed accounts on second call → silent no-op).
//
// remaining_accounts: triples are used here (not pairs as in
// auto_finalize_holders) because writer_position.owner is a Pubkey, not an
// AccountInfo, and the manual rent-drain on close needs the wallet's
// AccountInfo. Caller passes the wallet pubkey as the third member of each
// triple; the handler verifies it matches writer_position.owner.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::errors::OptaError;
use crate::events::WritersFinalized;
use crate::state::*;

/// Reward-per-share scale used by the premium accumulator. Mirrors the
/// constant baked into deposit_to_vault / claim_premium / withdraw_post_settlement.
const PREMIUM_SCALE: u128 = 1_000_000_000_000u128;

pub fn handle_auto_finalize_writers<'info>(
    ctx: Context<'_, '_, 'info, 'info, AutoFinalizeWriters<'info>>,
) -> Result<()> {
    require!(
        ctx.accounts.shared_vault.is_settled,
        OptaError::VaultNotSettled
    );
    require!(
        ctx.remaining_accounts.len() % 3 == 0,
        OptaError::InvalidBatchAccounts
    );

    // ---- Snapshot vault fields used inside the loop --------------------------
    let vault_pubkey = ctx.accounts.shared_vault.key();
    let market_key = ctx.accounts.shared_vault.market;
    let strike_price = ctx.accounts.shared_vault.strike_price;
    let expiry = ctx.accounts.shared_vault.expiry;
    let option_type = ctx.accounts.shared_vault.option_type;
    let vault_bump = ctx.accounts.shared_vault.bump;
    let collateral_mint = ctx.accounts.shared_vault.collateral_mint;

    let mut writers_processed: u32 = 0;
    let mut total_paid_out: u64 = 0;

    for triple in ctx.remaining_accounts.chunks_exact(3) {
        let writer_position_info = &triple[0];
        let writer_usdc_info = &triple[1];
        let writer_wallet_info = &triple[2];

        // ---- 1. Try to deserialize the writer position --------------------
        // Borrow lives only inside this scope — Account drops at end-of-block,
        // releasing the AccountInfo data borrow before we try to close it.
        let (owner, writer_vault, shares, premium_debt, premium_claimed) = {
            let pos = match Account::<WriterPosition>::try_from(writer_position_info) {
                Ok(p) => p,
                Err(_) => continue, // closed / wrong type / wrong owner → skip
            };
            (
                pos.owner,
                pos.vault,
                pos.shares,
                pos.premium_debt,
                pos.premium_claimed,
            )
        };

        // ---- 2. Vault match — wrong vault is a real bug, revert ----------
        require_keys_eq!(
            writer_vault,
            vault_pubkey,
            OptaError::WriterPositionVaultMismatch
        );

        // ---- 3. Wallet match — wrong wallet is a real bug, revert --------
        // We drain rent SOL to writer_wallet_info; sending to the wrong wallet
        // would gift the writer's rent to a stranger.
        require_keys_eq!(
            writer_wallet_info.key(),
            owner,
            OptaError::WriterWalletMismatch
        );

        // ---- 4. USDC ATA mint+owner check — silent skip on mismatch ------
        // Same pattern as auto_finalize_holders.rs: we read mint(0..32) and
        // owner(32..64) directly from the SPL Token account layout without
        // deserializing as a TokenAccount type. Mismatch leaves the writer
        // unprocessed for this batch; their funds stay in the vault and a
        // future call (after the ATA exists) will pick them up.
        {
            let data = match writer_usdc_info.try_borrow_data() {
                Ok(d) => d,
                Err(_) => continue,
            };
            if data.len() < 64 {
                continue;
            }
            let mint_bytes: [u8; 32] = match data[0..32].try_into() {
                Ok(b) => b,
                Err(_) => continue,
            };
            if Pubkey::new_from_array(mint_bytes) != collateral_mint {
                continue;
            }
            let owner_bytes: [u8; 32] = match data[32..64].try_into() {
                Ok(b) => b,
                Err(_) => continue,
            };
            if Pubkey::new_from_array(owner_bytes) != owner {
                continue;
            }
        }

        // ---- 5. Premium + collateral math (verbatim from
        //         withdraw_post_settlement.rs:30-48) -----------------------
        let cumulative = ctx.accounts.shared_vault.premium_per_share_cumulative;
        let total_shares = ctx.accounts.shared_vault.total_shares;
        let collateral_remaining = ctx.accounts.shared_vault.collateral_remaining;
        let total_collateral = ctx.accounts.shared_vault.total_collateral;

        let total_earned = (shares as u128)
            .checked_mul(cumulative)
            .ok_or(OptaError::MathOverflow)?
            .checked_div(PREMIUM_SCALE)
            .ok_or(OptaError::MathOverflow)?;

        let earned_since_deposit = total_earned.checked_sub(premium_debt).unwrap_or(0);

        let unclaimed_premium = earned_since_deposit
            .saturating_sub(premium_claimed as u128) as u64;

        let writer_remaining = (shares as u128)
            .checked_mul(collateral_remaining as u128)
            .ok_or(OptaError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(OptaError::MathOverflow)? as u64;

        // ---- 6. Transfer USDC (premium + collateral share) ---------------
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

        if unclaimed_premium > 0 {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_usdc_account.to_account_info(),
                    to: writer_usdc_info.clone(),
                    authority: ctx.accounts.shared_vault.to_account_info(),
                },
                vault_signer,
            );
            token::transfer(cpi_ctx, unclaimed_premium)?;
        }

        if writer_remaining > 0 {
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_usdc_account.to_account_info(),
                    to: writer_usdc_info.clone(),
                    authority: ctx.accounts.shared_vault.to_account_info(),
                },
                vault_signer,
            );
            token::transfer(cpi_ctx, writer_remaining)?;
        }

        // ---- 7. Decrement vault accumulators ------------------------------
        let vault = &mut ctx.accounts.shared_vault;
        vault.collateral_remaining = collateral_remaining
            .checked_sub(writer_remaining)
            .ok_or(OptaError::MathOverflow)?;
        vault.total_shares = total_shares
            .checked_sub(shares)
            .ok_or(OptaError::MathOverflow)?;
        vault.total_collateral = total_collateral
            .checked_sub(writer_remaining)
            .ok_or(OptaError::MathOverflow)?;

        // ---- 8. Manual close of writer_position --------------------------
        // Canonical Anchor 0.32.1 manual-close idiom for an AccountInfo (no
        // `close = X` derive available since the account lives in
        // remaining_accounts):
        //   a. transfer all lamports to the destination wallet
        //   b. zero the source's lamports
        //   c. reassign the source to system_program (so it can no longer be
        //      deserialized as a WriterPosition by anyone in the same tx)
        //   d. realloc to 0 bytes (drops the data)
        // Steps (c) and (d) together replicate what Anchor's close-derive
        // does internally and what the SBF runtime needs to garbage-collect
        // the account after the tx commits.
        let rent_lamports = writer_position_info.lamports();
        **writer_wallet_info.try_borrow_mut_lamports()? = writer_wallet_info
            .lamports()
            .checked_add(rent_lamports)
            .ok_or(OptaError::MathOverflow)?;
        **writer_position_info.try_borrow_mut_lamports()? = 0;
        writer_position_info.assign(&system_program::ID);
        writer_position_info.resize(0)?;

        let payout = unclaimed_premium
            .checked_add(writer_remaining)
            .ok_or(OptaError::MathOverflow)?;
        total_paid_out = total_paid_out
            .checked_add(payout)
            .ok_or(OptaError::MathOverflow)?;
        writers_processed = writers_processed
            .checked_add(1)
            .ok_or(OptaError::MathOverflow)?;
    }

    // ---- Last-writer dust sweep ------------------------------------------
    // Only fires if this batch contained the very last writer. Otherwise
    // total_shares > 0 still — the next batch will trigger the sweep.
    let mut dust_swept_to_treasury: u64 = 0;
    if ctx.accounts.shared_vault.total_shares == 0 {
        // Reload to refresh amount after the in-loop transfers
        ctx.accounts.vault_usdc_account.reload()?;
        let dust = ctx.accounts.vault_usdc_account.amount;

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

        if dust > 0 {
            let dust_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_usdc_account.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.shared_vault.to_account_info(),
                },
                vault_signer,
            );
            token::transfer(dust_ctx, dust)?;
            dust_swept_to_treasury = dust;
        }

        // Close vault_usdc_account; SOL rent goes to treasury.
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_usdc_account.to_account_info(),
                destination: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.shared_vault.to_account_info(),
            },
            vault_signer,
        );
        token::close_account(close_ctx)?;
    }

    emit!(WritersFinalized {
        vault: vault_pubkey,
        writers_processed,
        total_paid_out,
        dust_swept_to_treasury,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AutoFinalizeWriters<'info> {
    /// Permissionless caller — pays the tx fee. Not stored anywhere.
    pub caller: Signer<'info>,

    /// The settled shared vault. Mut because we decrement collateral_remaining,
    /// total_shares, and total_collateral as each writer is processed.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The vault's market — pinned to the vault for sanity. Not read by the
    /// handler beyond the constraint.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// Vault's USDC account — payout source for in-loop writer transfers and
    /// the last-writer dust sweep. Closed (with rent → treasury) when the last
    /// writer in the batch zeros total_shares.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Protocol treasury USDC account — receives any leftover dust + the
    /// vault_usdc_account rent SOL when the vault is fully drained. Pinned via
    /// protocol_state.treasury so callers can't redirect dust to themselves.
    #[account(
        mut,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Protocol state — supplies the canonical treasury pubkey for the
    /// constraint above.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Standard SPL Token program — for USDC transfers and CloseAccount CPIs.
    pub token_program: Program<'info, Token>,
    // remaining_accounts: triples of (writer_position, writer_usdc_ata,
    // writer_wallet). Each element must be marked writable in the metas:
    //   - writer_position: closed via lamport drain + realloc(0)
    //   - writer_usdc_ata: receives USDC transfer (premium + collateral)
    //   - writer_wallet:   receives rent SOL from the closed writer_position
}
