// =============================================================================
// instructions/list_for_resale.rs — List option tokens for resale (partial)
// =============================================================================
//
// Token holder lists a specified number of tokens for resale.
// They can keep some tokens and only list a portion.
//
// Option token transfer uses Token-2022 with transfer hook.
// Resale escrow is created on-chain if it doesn't exist yet.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token_2022::Token2022;
use spl_token_2022::extension::ExtensionType;

use crate::errors::ButterError;
use crate::events::OptionListedForResale;
use crate::state::*;

pub fn handle_list_for_resale(ctx: Context<ListForResale>, resale_premium: u64, token_amount: u64) -> Result<()> {
    let position = &ctx.accounts.position;

    require!(!position.is_exercised && !position.is_expired && !position.is_cancelled, ButterError::PositionNotActive);
    require!(!position.is_listed_for_resale, ButterError::AlreadyListedForResale);
    require!(resale_premium > 0, ButterError::InvalidPremium);
    require!(token_amount > 0, ButterError::InvalidContractSize);

    // Read seller balance from raw account data (Token-2022 layout: amount at bytes 64..72)
    let seller_data = ctx.accounts.seller_option_account.try_borrow_data()?;
    let seller_balance = u64::from_le_bytes(
        seller_data[64..72].try_into().map_err(|_| ButterError::MathOverflow)?
    );
    drop(seller_data);
    require!(token_amount <= seller_balance, ButterError::InsufficientOptionTokens);

    // Create the resale escrow Token-2022 account if it doesn't exist yet.
    // We check lamports == 0 to detect a missing account.
    let resale_escrow_info = ctx.accounts.resale_escrow.to_account_info();
    if resale_escrow_info.lamports() == 0 {
        // Token accounts for TransferHook mints need the TransferHookAccount extension.
        let escrow_space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
            &[ExtensionType::TransferHookAccount],
        ).map_err(|_| ButterError::MathOverflow)?;
        let rent = Rent::get()?;
        let escrow_lamports = rent.minimum_balance(escrow_space);
        let escrow_seeds: &[&[u8]] = &[
            RESALE_ESCROW_SEED,
            ctx.accounts.position.to_account_info().key.as_ref(),
            &[ctx.bumps.resale_escrow],
        ];

        // Allocate the account via system program (PDA signs)
        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.seller.key,
                resale_escrow_info.key,
                escrow_lamports,
                escrow_space as u64,
                &ctx.accounts.token_2022_program.key(),
            ),
            &[ctx.accounts.seller.to_account_info(), resale_escrow_info.clone()],
            &[escrow_seeds],
        )?;

        // Initialize as a Token-2022 token account owned by the protocol PDA
        invoke(
            &spl_token_2022::instruction::initialize_account3(
                &ctx.accounts.token_2022_program.key(),
                resale_escrow_info.key,
                ctx.accounts.option_mint.key,
                &ctx.accounts.protocol_state.key(),
            )?,
            &[resale_escrow_info.clone(), ctx.accounts.option_mint.to_account_info()],
        )?;
    }

    // Transfer option tokens from seller to resale escrow via Token-2022.
    // Seller signs this transfer (not the protocol PDA).
    let source_info = ctx.accounts.seller_option_account.to_account_info();
    let mint_info = ctx.accounts.option_mint.to_account_info();
    let dest_info = ctx.accounts.resale_escrow.to_account_info();

    // Use invoke_transfer_checked which properly handles transfer hook accounts.
    spl_token_2022::onchain::invoke_transfer_checked(
        &ctx.accounts.token_2022_program.key(),
        source_info.clone(),
        mint_info.clone(),
        dest_info.clone(),
        ctx.accounts.seller.to_account_info(),
        &[
            ctx.accounts.extra_account_meta_list.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
            ctx.accounts.hook_state.to_account_info(),
        ],
        token_amount,
        0, // decimals = 0 for option tokens
        &[], // seller signs directly, no PDA seeds
    )?;

    let position = &mut ctx.accounts.position;
    position.is_listed_for_resale = true;
    position.resale_premium = resale_premium;
    position.resale_token_amount = token_amount;
    position.resale_seller = ctx.accounts.seller.key();

    emit!(OptionListedForResale {
        position: ctx.accounts.position.key(),
        seller: ctx.accounts.seller.key(),
        resale_premium,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ListForResale<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(seeds = [PROTOCOL_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(mut)]
    pub position: Box<Account<'info, OptionPosition>>,

    /// Seller's option token account (Token-2022).
    /// CHECK: Balance validated from raw data; ownership checked by Token-2022 transfer.
    #[account(mut)]
    pub seller_option_account: UncheckedAccount<'info>,

    /// Resale escrow for holding listed option tokens (Token-2022 PDA).
    /// Created in handler if it doesn't exist yet.
    /// CHECK: Validated by PDA seeds.
    #[account(
        mut,
        seeds = [RESALE_ESCROW_SEED, position.key().as_ref()],
        bump,
    )]
    pub resale_escrow: UncheckedAccount<'info>,

    /// Option token mint (Token-2022 mint).
    /// CHECK: Validated via position.option_mint constraint.
    #[account(constraint = option_mint.key() == position.option_mint)]
    pub option_mint: UncheckedAccount<'info>,

    /// Token-2022 program — for option token transfers.
    pub token_2022_program: Program<'info, Token2022>,

    /// Transfer hook program.
    /// CHECK: Validated against known program ID.
    #[account(constraint = transfer_hook_program.key() == butter_transfer_hook::ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList for the transfer hook.
    /// CHECK: Validated by the transfer hook program during execution.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState with expiry info for the transfer hook.
    /// CHECK: Validated by the transfer hook program during execution.
    pub hook_state: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
