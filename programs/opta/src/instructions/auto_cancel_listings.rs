// =============================================================================
// instructions/auto_cancel_listings.rs — Permissionless listing cleanup
// =============================================================================
//
// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §4.2 (Design A) + §5.1.
//
// Per-(vault, mint) — same shape as auto_finalize_holders. Crank groups
// listings by mint and processes one mint per call.
//
// remaining_accounts: 4-tuples of
//   (listing, resale_escrow, seller_option_account, seller_wallet)
// per listing in the batch. All four must be marked writable in the metas.
//
// Flow per tuple (revert on any validation failure — batch atomic, unlike
// auto_finalize_holders which silently skips, because this caller is the
// crank passing typed listings it just enumerated; mismatches are bugs,
// not benign drift):
//   1. Deserialize listing as Account<VaultResaleListing> (Account::try_from).
//   2. Cross-check listing.option_mint and listing.vault against batch state.
//   3. Verify seller_wallet.key() == listing.seller (rent-destination guard).
//   4. Re-derive expected listing PDA + escrow PDA and compare.
//   5. Read escrow balance from raw bytes 64..72.
//   6. Transfer escrow → seller_option_account via Token-2022
//      invoke_transfer_checked, signed by protocol_state PDA. Hook permits
//      this even post-expiry because source is protocol-owned (plan §1.8).
//   7. Close escrow Token-2022 account; rent → seller_wallet.
//   8. Manual lamport drain on listing PDA → seller_wallet, then reassign
//      to system_program + realloc(0). Mirrors auto_finalize_writers.rs:225-244.
//
// Empty remaining_accounts is a no-op early return. No event fires in that
// case — the crank should never send empty batches.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_program};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::VaultListingsAutoCancelled;
use crate::state::*;

pub fn handle_auto_cancel_listings<'info>(
    ctx: Context<'_, '_, 'info, 'info, AutoCancelListings<'info>>,
) -> Result<()> {
    if ctx.remaining_accounts.is_empty() {
        return Ok(());
    }
    require!(
        ctx.remaining_accounts.len() % 4 == 0,
        OptaError::InvalidBatchAccounts
    );

    // ---- Snapshot batch-level state used inside the loop -------------------
    let vault_key = ctx.accounts.shared_vault.key();
    let option_mint_key = ctx.accounts.option_mint.key();
    let token_2022_key = ctx.accounts.token_2022_program.key();
    let protocol_key = ctx.accounts.protocol_state.key();
    let protocol_bump = ctx.accounts.protocol_state.bump;
    let program_id = ctx.program_id;

    let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol_bump]];
    let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

    let mut listings_cancelled: u32 = 0;
    let mut tokens_returned: u64 = 0;

    for tuple in ctx.remaining_accounts.chunks_exact(4) {
        let listing_info = &tuple[0];
        let escrow_info = &tuple[1];
        let seller_opt_info = &tuple[2];
        let seller_wallet_info = &tuple[3];

        // 1. Deserialize listing — borrow drops at end of inner scope so the
        //    later manual lamport drain on listing_info has unrestricted access.
        let (listing_seller, listing_option_mint, listing_vault) = {
            let listing = Account::<VaultResaleListing>::try_from(listing_info)?;
            (listing.seller, listing.option_mint, listing.vault)
        };

        // 2. Cross-check listing fields against batch state.
        require!(
            listing_option_mint == option_mint_key,
            OptaError::ListingMismatch
        );
        require!(
            listing_vault == vault_key,
            OptaError::ListingMismatch
        );

        // 3. Verify seller_wallet.key() matches listing.seller — must be exact
        //    because rent goes to this wallet; sending to a stranger is a real bug.
        require_keys_eq!(
            seller_wallet_info.key(),
            listing_seller,
            OptaError::NotResaleSeller
        );

        // 4. Re-derive expected listing + escrow PDAs and verify the caller
        //    passed the right addresses.
        let (expected_listing_pda, _) = Pubkey::find_program_address(
            &[
                VAULT_RESALE_LISTING_SEED,
                option_mint_key.as_ref(),
                listing_seller.as_ref(),
            ],
            program_id,
        );
        require_keys_eq!(
            listing_info.key(),
            expected_listing_pda,
            OptaError::ListingMismatch
        );
        let (expected_escrow_pda, _) = Pubkey::find_program_address(
            &[VAULT_RESALE_ESCROW_SEED, listing_info.key().as_ref()],
            program_id,
        );
        require_keys_eq!(
            escrow_info.key(),
            expected_escrow_pda,
            OptaError::InvalidListingEscrow
        );

        // 5. Read escrow balance — Token-2022 ATA layout: amount at bytes 64..72.
        let escrow_balance = {
            let data = escrow_info.try_borrow_data()?;
            require!(data.len() >= 72, OptaError::MathOverflow);
            let bytes: [u8; 8] = data[64..72]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?;
            u64::from_le_bytes(bytes)
        };

        // 6. Transfer escrow → seller_option_account (always — Token-2022
        //    handles zero-amount cheaply, no need for a defensive guard here).
        spl_token_2022::onchain::invoke_transfer_checked(
            &token_2022_key,
            escrow_info.clone(),
            ctx.accounts.option_mint.to_account_info(),
            seller_opt_info.clone(),
            ctx.accounts.protocol_state.to_account_info(),
            &[
                ctx.accounts.extra_account_meta_list.to_account_info(),
                ctx.accounts.transfer_hook_program.to_account_info(),
                ctx.accounts.hook_state.to_account_info(),
            ],
            escrow_balance,
            0, // decimals = 0 for option tokens
            protocol_signer,
        )?;

        // 7. Close escrow Token-2022 account; rent → seller_wallet.
        invoke_signed(
            &spl_token_2022::instruction::close_account(
                &token_2022_key,
                escrow_info.key,
                seller_wallet_info.key,
                &protocol_key,
                &[],
            )?,
            &[
                escrow_info.clone(),
                seller_wallet_info.clone(),
                ctx.accounts.protocol_state.to_account_info(),
            ],
            protocol_signer,
        )?;

        // 8. Manual close of listing PDA — same idiom as
        //    auto_finalize_writers.rs:225-244 and buy_v2_resale.rs full-fill path.
        let rent_lamports = listing_info.lamports();
        **seller_wallet_info.try_borrow_mut_lamports()? = seller_wallet_info
            .lamports()
            .checked_add(rent_lamports)
            .ok_or(OptaError::MathOverflow)?;
        **listing_info.try_borrow_mut_lamports()? = 0;
        listing_info.assign(&system_program::ID);
        listing_info.resize(0)?;

        // 9. Aggregate.
        listings_cancelled = listings_cancelled
            .checked_add(1)
            .ok_or(OptaError::MathOverflow)?;
        tokens_returned = tokens_returned
            .checked_add(escrow_balance)
            .ok_or(OptaError::MathOverflow)?;
    }

    emit!(VaultListingsAutoCancelled {
        vault: vault_key,
        mint: option_mint_key,
        listings_cancelled,
        tokens_returned,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AutoCancelListings<'info> {
    /// Permissionless caller — pays the tx fee.
    pub caller: Signer<'info>,

    /// Vault these listings belong to. Read-only.
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Market — pinned to the vault.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// VaultMint record — pins option_mint to this vault.
    #[account(
        constraint = vault_mint_record.vault == shared_vault.key()
            @ crate::errors::OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == option_mint.key()
            @ crate::errors::OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Account<'info, VaultMint>,

    /// The single Token-2022 mint shared by every listing in this batch.
    /// CHECK: validated via vault_mint_record + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Protocol state — signs the escrow-source token-return transfers.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Transfer hook program.
    /// CHECK: ID-constrained.
    #[account(constraint = transfer_hook_program.key() == opta_transfer_hook::ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList for the transfer hook.
    /// CHECK: validated by Token-2022 hook dispatch.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState for the transfer hook.
    /// CHECK: validated by Token-2022 hook dispatch.
    pub hook_state: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: 4-tuples per listing —
    //   (listing, resale_escrow, seller_option_account, seller_wallet)
}
