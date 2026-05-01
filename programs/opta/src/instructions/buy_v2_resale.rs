// =============================================================================
// instructions/buy_v2_resale.rs — Buyer fills (partially or fully) a listing
// =============================================================================
//
// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §2.2.
//
// Flow:
//   1. Validate quantity > 0, vault not settled (belt-and-braces, plan
//      Open Q #4), not expired, buyer != seller, qty <= listed_quantity,
//      total_price <= max_total_price (slippage cap).
//   2. Compute fee = total_price * fee_bps / 10000, seller_share = total - fee.
//      Mirrors purchase_from_vault.rs:67-75 exactly. Same fee_bps as primary
//      (plan Open Q #3).
//   3. Two USDC transfers, both buyer-signed (SPL Token):
//        buyer → treasury        (fee)
//        buyer → seller_usdc_acc (seller_share)
//   4. Option token transfer escrow → buyer via Token-2022
//      invoke_transfer_checked, signed by protocol_state PDA. Hook permits
//      pre-expiry; we already blocked post-expiry above.
//   5. Decrement listing.listed_quantity.
//   6. On full fill (listed_quantity hits 0): close escrow Token-2022 account
//      (rent → seller) then manually close listing PDA via lamport drain +
//      reassign + realloc. Anchor's `close = X` derive can't be conditional,
//      so we mirror auto_finalize_writers.rs:225-244.
//   7. Emit VaultListingFilled.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_program};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::VaultListingFilled;
use crate::state::*;
use super::initialize_protocol::TREASURY_SEED;

pub fn handle_buy_v2_resale(
    ctx: Context<BuyV2Resale>,
    quantity: u64,
    max_total_price: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    // Snapshot listing fields before the in-loop mutations + manual close.
    let listing_seller = ctx.accounts.listing.seller;
    let listing_option_mint = ctx.accounts.listing.option_mint;
    let listing_listed_quantity = ctx.accounts.listing.listed_quantity;
    let listing_price = ctx.accounts.listing.price_per_contract;
    let listing_key = ctx.accounts.listing.key();

    // ---- 1. Pre-flight checks ---------------------------------------------
    require!(quantity > 0, OptaError::InvalidContractSize);
    require!(
        !ctx.accounts.shared_vault.is_settled,
        OptaError::VaultAlreadySettled
    );
    require!(
        clock.unix_timestamp < ctx.accounts.shared_vault.expiry,
        OptaError::VaultExpired
    );
    require!(
        ctx.accounts.buyer.key() != listing_seller,
        OptaError::CannotBuyOwnOption
    );
    require!(
        quantity <= listing_listed_quantity,
        OptaError::ListingExhausted
    );

    let total_price = quantity
        .checked_mul(listing_price)
        .ok_or(OptaError::MathOverflow)?;
    require!(total_price <= max_total_price, OptaError::SlippageExceeded);

    // ---- 2. Compute fee split (mirrors purchase_from_vault.rs:67-75) ------
    let fee_bps = ctx.accounts.protocol_state.fee_bps as u64;
    let fee = total_price
        .checked_mul(fee_bps)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(OptaError::MathOverflow)?;
    let seller_share = total_price
        .checked_sub(fee)
        .ok_or(OptaError::MathOverflow)?;

    // ---- 3. USDC transfers (buyer signs each) -----------------------------
    if fee > 0 {
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_usdc_account.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        );
        token::transfer(cpi, fee)?;
    }
    if seller_share > 0 {
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer_usdc_account.to_account_info(),
                to: ctx.accounts.seller_usdc_account.to_account_info(),
                authority: ctx.accounts.buyer.to_account_info(),
            },
        );
        token::transfer(cpi, seller_share)?;
    }

    // ---- 4. Option token transfer (escrow → buyer, protocol PDA signs) ----
    let token_2022_key = ctx.accounts.token_2022_program.key();
    let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

    spl_token_2022::onchain::invoke_transfer_checked(
        &token_2022_key,
        ctx.accounts.resale_escrow.to_account_info(),
        ctx.accounts.option_mint.to_account_info(),
        ctx.accounts.buyer_option_account.to_account_info(),
        ctx.accounts.protocol_state.to_account_info(),
        &[
            ctx.accounts.extra_account_meta_list.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
            ctx.accounts.hook_state.to_account_info(),
        ],
        quantity,
        0, // decimals = 0 for option tokens
        protocol_signer,
    )?;

    // ---- 5. Decrement listing.listed_quantity -----------------------------
    let new_listed_quantity = {
        let listing = &mut ctx.accounts.listing;
        listing.listed_quantity = listing
            .listed_quantity
            .checked_sub(quantity)
            .ok_or(OptaError::MathOverflow)?;
        listing.listed_quantity
    };

    // ---- 6. Conditional close on full fill --------------------------------
    let listing_closed = new_listed_quantity == 0;
    if listing_closed {
        // a) Close the escrow Token-2022 account; rent → seller.
        invoke_signed(
            &spl_token_2022::instruction::close_account(
                &token_2022_key,
                ctx.accounts.resale_escrow.key,
                ctx.accounts.seller.key,
                &ctx.accounts.protocol_state.key(),
                &[],
            )?,
            &[
                ctx.accounts.resale_escrow.to_account_info(),
                ctx.accounts.seller.to_account_info(),
                ctx.accounts.protocol_state.to_account_info(),
            ],
            protocol_signer,
        )?;

        // b) Close the listing PDA manually. Anchor's `close = X` derive is
        // unconditional, so we use the lamport-drain + reassign + realloc
        // idiom from auto_finalize_writers.rs:225-244. After reassign, the
        // owner != program_id and Anchor's exit hook on Account<T> skips the
        // serialize-back step (owner check inside Account::exit).
        let listing_info = ctx.accounts.listing.to_account_info();
        let seller_info = ctx.accounts.seller.to_account_info();
        let rent_lamports = listing_info.lamports();
        **seller_info.try_borrow_mut_lamports()? = seller_info
            .lamports()
            .checked_add(rent_lamports)
            .ok_or(OptaError::MathOverflow)?;
        **listing_info.try_borrow_mut_lamports()? = 0;
        listing_info.assign(&system_program::ID);
        listing_info.resize(0)?;
    }

    // ---- 7. Emit event ----------------------------------------------------
    emit!(VaultListingFilled {
        listing: listing_key,
        mint: listing_option_mint,
        seller: listing_seller,
        buyer: ctx.accounts.buyer.key(),
        quantity,
        total_price,
        fee,
        listing_remaining: new_listed_quantity,
        listing_closed,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct BuyV2Resale<'info> {
    /// Buyer — pays USDC, receives option tokens.
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// Vault — read for collateral_mint constraints + is_settled / expiry guards.
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

    /// Listing being filled. Mut for listed_quantity decrement. On full fill
    /// the handler manually closes via lamport drain + reassign + realloc
    /// (see auto_finalize_writers.rs:225-244 for the pattern). Anchor's
    /// `close = X` derive can't be conditional.
    #[account(
        mut,
        seeds = [
            VAULT_RESALE_LISTING_SEED,
            option_mint.key().as_ref(),
            listing.seller.as_ref(),
        ],
        bump = listing.bump,
    )]
    pub listing: Box<Account<'info, VaultResaleListing>>,

    /// Seller wallet — rent destination on full-fill close. Constraint pins
    /// it to listing.seller so a third-party caller can't redirect rent.
    /// CHECK: pubkey-pinned to listing.seller.
    #[account(mut, constraint = seller.key() == listing.seller)]
    pub seller: UncheckedAccount<'info>,

    /// Token-2022 mint.
    /// CHECK: validated via vault_mint_record + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Resale escrow — source of the option-token transfer.
    /// CHECK: PDA seeds validate the address.
    #[account(
        mut,
        seeds = [VAULT_RESALE_ESCROW_SEED, listing.key().as_ref()],
        bump,
    )]
    pub resale_escrow: UncheckedAccount<'info>,

    /// Buyer's option ATA — destination. Frontend pre-creates idempotently.
    /// CHECK: validated by Token-2022 transfer.
    #[account(mut)]
    pub buyer_option_account: UncheckedAccount<'info>,

    /// Buyer's USDC ATA.
    #[account(
        mut,
        constraint = buyer_usdc_account.owner == buyer.key(),
        constraint = buyer_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub buyer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Seller's USDC ATA — receives seller-share. Must exist (Open Q #6 locked).
    #[account(
        mut,
        constraint = seller_usdc_account.owner == listing.seller,
        constraint = seller_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub seller_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Treasury — receives protocol fee.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Protocol state — fee_bps + total_volume + escrow signer authority.
    #[account(
        mut,
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

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
