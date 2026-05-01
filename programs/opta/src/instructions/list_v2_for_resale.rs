// =============================================================================
// instructions/list_v2_for_resale.rs — Seller lists V2 vault tokens for resale
// =============================================================================
//
// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §2.1.
//
// Flow:
//   1. Validate (quantity > 0, price > 0, vault not settled, not expired,
//      seller has enough tokens).
//   2. Create the resale escrow as a Token-2022 account with the
//      TransferHookAccount extension. Owner = protocol_state PDA.
//      Same shape as mint_from_vault.rs:303-342.
//   3. Transfer `quantity` option tokens from seller's ATA → escrow via
//      Token-2022 invoke_transfer_checked. Hook fires; pre-expiry it allows.
//      Seller signs the transfer (no PDA seeds; source is seller's wallet).
//   4. Populate the listing PDA fields (Anchor `init` already allocated it).
//   5. Emit VaultListingCreated.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction};
use anchor_spl::token_2022::Token2022;
use spl_token_2022::extension::ExtensionType;

use crate::errors::OptaError;
use crate::events::VaultListingCreated;
use crate::state::*;

pub fn handle_list_v2_for_resale(
    ctx: Context<ListV2ForResale>,
    price_per_contract: u64,
    quantity: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.shared_vault;

    // ---- 1. Pre-flight checks ----------------------------------------------
    require!(quantity > 0, OptaError::InvalidContractSize);
    require!(price_per_contract > 0, OptaError::InvalidContractSize);
    require!(!vault.is_settled, OptaError::VaultAlreadySettled);
    require!(clock.unix_timestamp < vault.expiry, OptaError::VaultExpired);

    // Seller balance: read raw Token-2022 amount at bytes 64..72.
    {
        let seller_data = ctx.accounts.seller_option_account.try_borrow_data()?;
        require!(seller_data.len() >= 72, OptaError::MathOverflow);
        let amount_bytes: [u8; 8] = seller_data[64..72]
            .try_into()
            .map_err(|_| OptaError::MathOverflow)?;
        let seller_balance = u64::from_le_bytes(amount_bytes);
        require!(quantity <= seller_balance, OptaError::InsufficientOptionTokens);
    }

    // ---- 2. Create the resale escrow Token-2022 account --------------------
    // Mirrors mint_from_vault.rs:303-342. The escrow needs the
    // TransferHookAccount extension because the option mint has TransferHook.
    let escrow_space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
        &[ExtensionType::TransferHookAccount],
    )
    .map_err(|_| OptaError::MathOverflow)?;
    let rent = Rent::get()?;
    let escrow_lamports = rent.minimum_balance(escrow_space);

    let token_2022_key = ctx.accounts.token_2022_program.key();
    let listing_key = ctx.accounts.listing.key();

    let escrow_seeds: &[&[u8]] = &[
        VAULT_RESALE_ESCROW_SEED,
        listing_key.as_ref(),
        &[ctx.bumps.resale_escrow],
    ];

    let escrow_info = ctx.accounts.resale_escrow.to_account_info();
    let mint_info = ctx.accounts.option_mint.to_account_info();

    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.seller.key,
            escrow_info.key,
            escrow_lamports,
            escrow_space as u64,
            &token_2022_key,
        ),
        &[
            ctx.accounts.seller.to_account_info(),
            escrow_info.clone(),
        ],
        &[escrow_seeds],
    )?;

    // Initialize as Token-2022 token account. mint = option_mint, owner = protocol PDA.
    invoke(
        &spl_token_2022::instruction::initialize_account3(
            &token_2022_key,
            escrow_info.key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
        )?,
        &[escrow_info.clone(), mint_info.clone()],
    )?;

    // ---- 3. Transfer option tokens: seller → escrow -----------------------
    // Decimals = 0 by protocol invariant — option tokens are minted with
    // decimals = 0 (see mint_from_vault.rs:212). Hardcoded for consistency
    // with mint_from_vault.rs and archive/v1-instructions/list_for_resale.rs.
    spl_token_2022::onchain::invoke_transfer_checked(
        &token_2022_key,
        ctx.accounts.seller_option_account.to_account_info(),
        mint_info.clone(),
        escrow_info.clone(),
        ctx.accounts.seller.to_account_info(),
        &[
            ctx.accounts.extra_account_meta_list.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
            ctx.accounts.hook_state.to_account_info(),
        ],
        quantity,
        0, // decimals = 0 for option tokens
        &[], // seller signs directly, no PDA seeds
    )?;

    // ---- 4. Populate the listing PDA --------------------------------------
    // Anchor's `init` constraint already allocated and zeroed the account.
    let listing = &mut ctx.accounts.listing;
    listing.seller = ctx.accounts.seller.key();
    listing.vault = ctx.accounts.shared_vault.key();
    listing.option_mint = ctx.accounts.option_mint.key();
    listing.listed_quantity = quantity;
    listing.price_per_contract = price_per_contract;
    listing.created_at = clock.unix_timestamp;
    listing.bump = ctx.bumps.listing;

    // ---- 5. Emit event ----------------------------------------------------
    emit!(VaultListingCreated {
        listing: listing_key,
        vault: ctx.accounts.shared_vault.key(),
        mint: ctx.accounts.option_mint.key(),
        seller: ctx.accounts.seller.key(),
        listed_quantity: quantity,
        price_per_contract,
        created_at: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ListV2ForResale<'info> {
    /// Seller — listing creator. Pays for listing PDA + escrow rent.
    #[account(mut)]
    pub seller: Signer<'info>,

    /// The vault this option mint was minted from.
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Market — pinned to the vault for sanity.
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

    /// Token-2022 mint being resold.
    /// CHECK: validated via vault_mint_record + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Seller's option ATA — source of the listing transfer.
    /// CHECK: balance + ownership validated by Token-2022 transfer.
    #[account(mut)]
    pub seller_option_account: UncheckedAccount<'info>,

    /// Listing PDA — initialized in this instruction. One per (mint, seller).
    #[account(
        init,
        seeds = [
            VAULT_RESALE_LISTING_SEED,
            option_mint.key().as_ref(),
            seller.key().as_ref(),
        ],
        bump,
        payer = seller,
        space = 8 + VaultResaleListing::INIT_SPACE,
    )]
    pub listing: Box<Account<'info, VaultResaleListing>>,

    /// Resale escrow Token-2022 account. Owned by protocol_state PDA.
    /// Created in handler via system_instruction + initialize_account3.
    /// CHECK: PDA seeds validate the address.
    #[account(
        mut,
        seeds = [VAULT_RESALE_ESCROW_SEED, listing.key().as_ref()],
        bump,
    )]
    pub resale_escrow: UncheckedAccount<'info>,

    /// Protocol state — escrow's owner authority.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Transfer hook program — pinned to the known opta-transfer-hook ID.
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
    pub rent: Sysvar<'info, Rent>,
}
