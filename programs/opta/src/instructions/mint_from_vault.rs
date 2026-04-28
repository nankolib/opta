// =============================================================================
// instructions/mint_from_vault.rs — Writer mints Living Option Tokens from vault
// =============================================================================
//
// A writer with shares in a SharedVault can mint option tokens backed by their
// portion of the vault's collateral. The minted tokens are IDENTICAL to tokens
// created via write_option (v1) — same Token-2022 extensions, same metadata
// format, same transfer hook behavior.
//
// Key difference from write_option:
//   - Collateral already lives in the shared vault (no transfer needed)
//   - The writer's available collateral is calculated from their share ratio
//   - A VaultMint record tracks per-mint state (premium, quantity, sold count)
//
// Token-2022 authority = protocol_state (same as v1, keeps tokens identical)
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction};
use anchor_spl::token_2022::Token2022;
use spl_token_2022::extension::ExtensionType;

use crate::errors::OptaError;
use crate::events::VaultMinted;
use crate::state::*;

// Month abbreviations — same as write_option.rs for identical metadata
const MONTHS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

// FIX I-04: Use shared time utilities instead of duplicated code
use crate::utils::time::timestamp_to_month_day;

pub fn handle_mint_from_vault(
    ctx: Context<MintFromVault>,
    quantity: u64,
    premium_per_contract: u64,
    created_at: i64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let vault = &ctx.accounts.shared_vault;
    let writer_pos = &ctx.accounts.writer_position;
    let clock = Clock::get()?;

    // =========================================================================
    // Validation
    // =========================================================================
    require!(quantity > 0, OptaError::InvalidContractSize);
    require!(premium_per_contract > 0, OptaError::InvalidPremium);
    require!(!vault.is_settled, OptaError::VaultAlreadySettled);
    require!(vault.expiry > clock.unix_timestamp, OptaError::VaultExpired);
    require!(writer_pos.vault == vault.key(), OptaError::Unauthorized);
    require!(writer_pos.owner == ctx.accounts.writer.key(), OptaError::NotWriter);

    // =========================================================================
    // Calculate writer's available collateral
    //
    // FIX M-04: Match v1 collateral formula — calls require 2x strike.
    // The writer can only mint options backed by their free (uncommitted) share.
    // =========================================================================
    let collateral_per_contract = match vault.option_type {
        OptionType::Call => vault.strike_price
            .checked_mul(2)
            .ok_or(OptaError::MathOverflow)?,
        OptionType::Put => vault.strike_price,
    };

    let total_collateral_needed = quantity
        .checked_mul(collateral_per_contract)
        .ok_or(OptaError::MathOverflow)?;

    // Writer's total collateral share based on their proportion of the pool
    let writer_share_of_collateral = (writer_pos.shares as u128)
        .checked_mul(vault.total_collateral as u128)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(vault.total_shares as u128)
        .ok_or(OptaError::MathOverflow)? as u64;

    // Already committed collateral (options already minted)
    let already_committed = writer_pos.options_minted
        .checked_mul(collateral_per_contract)
        .ok_or(OptaError::MathOverflow)?;

    let available = writer_share_of_collateral
        .checked_sub(already_committed)
        .ok_or(OptaError::MathOverflow)?;

    require!(
        total_collateral_needed <= available,
        OptaError::InsufficientVaultCollateral
    );

    // =========================================================================
    // Build the human-readable token name (IDENTICAL to write_option.rs)
    //
    // Format: "OPTA-{ASSET}-{STRIKE}{C/P}-{MONTH}{DAY}"
    // Example: "OPTA-SOL-200C-APR15"
    // =========================================================================
    // Stage 2: strike/expiry/option_type read from vault (canonical post-refactor).
    let strike_dollars = vault.strike_price / 1_000_000;
    let type_char = match vault.option_type {
        OptionType::Call => "C",
        OptionType::Put => "P",
    };
    let (month_idx, day) = timestamp_to_month_day(vault.expiry);
    let month_name = MONTHS[month_idx];
    let token_name = format!(
        "OPTA-{}-{}{}-{}{}",
        market.asset_name, strike_dollars, type_char, month_name, day
    );
    let token_name = if token_name.len() > 32 {
        token_name[..32].to_string()
    } else {
        token_name
    };

    // Protocol PDA signer seeds — same authority as write_option
    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    // =========================================================================
    // Create Token-2022 mint with 3 extensions (IDENTICAL to write_option.rs)
    //
    // Extensions:
    //   1. TransferHook — runs our hook program on every transfer
    //   2. PermanentDelegate — protocol PDA can burn tokens from any holder
    //   3. MetadataPointer — metadata lives on the mint account itself
    // =========================================================================
    let mint_info = ctx.accounts.option_mint.to_account_info();
    let token_2022_key = ctx.accounts.token_2022_program.key();

    // Calculate mint account space (base + 3 fixed extensions, no metadata yet)
    let base_space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(
        &[
            ExtensionType::TransferHook,
            ExtensionType::PermanentDelegate,
            ExtensionType::MetadataPointer,
        ],
    )
    .map_err(|_| OptaError::MathOverflow)?;

    let rent = Rent::get()?;
    // Overfund for metadata realloc (same as write_option: base_space + 854)
    let mint_lamports = rent.minimum_balance(base_space + 854);

    // Mint PDA seeds: ["vault_option_mint", vault, writer, created_at(8)]
    let mint_seeds: &[&[u8]] = &[
        VAULT_OPTION_MINT_SEED,
        ctx.accounts.shared_vault.to_account_info().key.as_ref(),
        ctx.accounts.writer.to_account_info().key.as_ref(),
        &created_at.to_le_bytes(),
        &[ctx.bumps.option_mint],
    ];

    // Create the mint account (owned by Token-2022 program)
    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.writer.key,
            mint_info.key,
            mint_lamports,
            base_space as u64,
            &token_2022_key,
        ),
        &[
            ctx.accounts.writer.to_account_info(),
            mint_info.clone(),
        ],
        &[mint_seeds],
    )?;

    // Extension 1: TransferHook — points to our transfer hook program
    invoke(
        &spl_token_2022::extension::transfer_hook::instruction::initialize(
            &token_2022_key,
            mint_info.key,
            None,
            Some(ctx.accounts.transfer_hook_program.key()),
        )?,
        &[mint_info.clone()],
    )?;

    // Extension 2: PermanentDelegate — protocol PDA can burn tokens from any holder
    invoke(
        &spl_token_2022::instruction::initialize_permanent_delegate(
            &token_2022_key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
        )?,
        &[mint_info.clone()],
    )?;

    // Extension 3: MetadataPointer — metadata lives on the mint account itself
    invoke(
        &spl_token_2022::extension::metadata_pointer::instruction::initialize(
            &token_2022_key,
            mint_info.key,
            None,
            Some(*mint_info.key),
        )?,
        &[mint_info.clone()],
    )?;

    // Initialize the mint (MUST come after all extension initializations)
    invoke(
        &spl_token_2022::instruction::initialize_mint2(
            &token_2022_key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(), // mint authority = protocol PDA
            None,
            0, // decimals = 0 for option tokens
        )?,
        &[mint_info.clone()],
    )?;

    // =========================================================================
    // Initialize on-chain metadata (IDENTICAL to write_option.rs)
    // =========================================================================

    // Base metadata: name, symbol, URI
    invoke_signed(
        &spl_token_metadata_interface::instruction::initialize(
            &token_2022_key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
            token_name.clone(),
            "oOPT".to_string(),
            "".to_string(),
        ),
        &[
            mint_info.clone(),
            ctx.accounts.protocol_state.to_account_info(),
        ],
        signer_seeds,
    )?;

    // Additional metadata fields (same as write_option + vault reference)
    let collateral_per_token = collateral_per_contract;

    // Stage 2: strike/expiry/option_type sourced from vault.
    let additional_fields: Vec<(&str, String)> = vec![
        ("asset_name", market.asset_name.clone()),
        ("asset_class", market.asset_class.to_string()),
        ("strike_price", vault.strike_price.to_string()),
        ("expiry", vault.expiry.to_string()),
        (
            "option_type",
            match vault.option_type {
                OptionType::Call => "call",
                OptionType::Put => "put",
            }
            .to_string(),
        ),
        ("pyth_feed", market.pyth_feed.to_string()),
        ("collateral_per_token", collateral_per_token.to_string()),
        ("market_pda", ctx.accounts.market.key().to_string()),
        ("vault_pda", ctx.accounts.shared_vault.key().to_string()),
    ];

    for (key, value) in additional_fields {
        invoke_signed(
            &spl_token_metadata_interface::instruction::update_field(
                &token_2022_key,
                mint_info.key,
                &ctx.accounts.protocol_state.key(),
                spl_token_metadata_interface::state::Field::Key(key.to_string()),
                value,
            ),
            &[
                mint_info.clone(),
                ctx.accounts.protocol_state.to_account_info(),
            ],
            signer_seeds,
        )?;
    }

    // =========================================================================
    // Initialize transfer hook state via CPI (IDENTICAL to write_option.rs)
    // =========================================================================
    let cpi_ctx = CpiContext::new(
        ctx.accounts.transfer_hook_program.to_account_info(),
        opta_transfer_hook::cpi::accounts::InitializeExtraAccountMetaList {
            payer: ctx.accounts.writer.to_account_info(),
            mint: mint_info.clone(),
            extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
            hook_state: ctx.accounts.hook_state.to_account_info(),
            protocol_state: ctx.accounts.protocol_state.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    opta_transfer_hook::cpi::initialize_extra_account_meta_list(
        cpi_ctx,
        vault.expiry,
    )?;

    // =========================================================================
    // Create purchase escrow (Token-2022 token account) — same as write_option
    // =========================================================================
    let purchase_escrow_info = ctx.accounts.purchase_escrow.to_account_info();

    let escrow_space =
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
            &[ExtensionType::TransferHookAccount],
        )
        .map_err(|_| OptaError::MathOverflow)?;
    let escrow_lamports = rent.minimum_balance(escrow_space);

    let escrow_seeds: &[&[u8]] = &[
        VAULT_PURCHASE_ESCROW_SEED,
        ctx.accounts.shared_vault.to_account_info().key.as_ref(),
        ctx.accounts.writer.to_account_info().key.as_ref(),
        &created_at.to_le_bytes(),
        &[ctx.bumps.purchase_escrow],
    ];

    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.writer.key,
            purchase_escrow_info.key,
            escrow_lamports,
            escrow_space as u64,
            &token_2022_key,
        ),
        &[
            ctx.accounts.writer.to_account_info(),
            purchase_escrow_info.clone(),
        ],
        &[escrow_seeds],
    )?;

    // Initialize as Token-2022 token account: mint = option_mint, owner = protocol PDA
    invoke(
        &spl_token_2022::instruction::initialize_account3(
            &token_2022_key,
            purchase_escrow_info.key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
        )?,
        &[purchase_escrow_info.clone(), mint_info.clone()],
    )?;

    // =========================================================================
    // Mint option tokens to the purchase escrow
    // =========================================================================
    invoke_signed(
        &spl_token_2022::instruction::mint_to(
            &token_2022_key,
            mint_info.key,
            purchase_escrow_info.key,
            &ctx.accounts.protocol_state.key(),
            &[],
            quantity,
        )?,
        &[
            mint_info.clone(),
            purchase_escrow_info.clone(),
            ctx.accounts.protocol_state.to_account_info(),
        ],
        signer_seeds,
    )?;

    // =========================================================================
    // Initialize the VaultMint record (tracks per-mint state)
    // =========================================================================
    let vault_mint = &mut ctx.accounts.vault_mint_record;
    vault_mint.vault = ctx.accounts.shared_vault.key();
    vault_mint.writer = ctx.accounts.writer.key();
    vault_mint.option_mint = *mint_info.key;
    vault_mint.premium_per_contract = premium_per_contract;
    vault_mint.quantity_minted = quantity;
    vault_mint.quantity_sold = 0;
    vault_mint.created_at = created_at;
    vault_mint.bump = ctx.bumps.vault_mint_record;

    // =========================================================================
    // Update writer position and vault state
    // =========================================================================
    let writer_pos = &mut ctx.accounts.writer_position;
    writer_pos.options_minted = writer_pos.options_minted
        .checked_add(quantity)
        .ok_or(OptaError::MathOverflow)?;

    let vault = &mut ctx.accounts.shared_vault;
    vault.total_options_minted = vault.total_options_minted
        .checked_add(quantity)
        .ok_or(OptaError::MathOverflow)?;

    emit!(VaultMinted {
        vault: ctx.accounts.shared_vault.key(),
        writer: ctx.accounts.writer.key(),
        mint: *mint_info.key,
        quantity,
        premium_per_contract,
    });

    Ok(())
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
#[instruction(quantity: u64, premium_per_contract: u64, created_at: i64)]
pub struct MintFromVault<'info> {
    /// The writer minting option tokens.
    #[account(mut)]
    pub writer: Signer<'info>,

    /// The shared vault providing collateral backing.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Writer's position in the vault — validates ownership and available collateral.
    #[account(
        mut,
        seeds = [WRITER_POSITION_SEED, shared_vault.key().as_ref(), writer.key().as_ref()],
        bump = writer_position.bump,
    )]
    pub writer_position: Box<Account<'info, WriterPosition>>,

    /// The OptionsMarket — for strike price, expiry, asset info in metadata.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// Protocol state — mint authority and permanent delegate for Token-2022.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Token-2022 mint for the option tokens — created manually via CPI.
    /// CHECK: Created via CPI. PDA seeds validate the address.
    #[account(
        mut,
        seeds = [
            VAULT_OPTION_MINT_SEED,
            shared_vault.key().as_ref(),
            writer.key().as_ref(),
            &created_at.to_le_bytes(),
        ],
        bump,
    )]
    pub option_mint: UncheckedAccount<'info>,

    /// Purchase escrow — holds minted tokens until buyers purchase.
    /// CHECK: Created via CPI. PDA seeds validate the address.
    #[account(
        mut,
        seeds = [
            VAULT_PURCHASE_ESCROW_SEED,
            shared_vault.key().as_ref(),
            writer.key().as_ref(),
            &created_at.to_le_bytes(),
        ],
        bump,
    )]
    pub purchase_escrow: UncheckedAccount<'info>,

    /// VaultMint record — tracks premium, quantity, and sold count per mint.
    #[account(
        init,
        seeds = [VAULT_MINT_RECORD_SEED, option_mint.key().as_ref()],
        bump,
        payer = writer,
        space = 8 + VaultMint::INIT_SPACE,
    )]
    pub vault_mint_record: Box<Account<'info, VaultMint>>,

    /// The transfer hook program — for initializing hook state.
    /// CHECK: Constrained to the known opta-transfer-hook program ID.
    #[account(constraint = transfer_hook_program.key() == opta_transfer_hook::ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList PDA — created by the hook program during CPI.
    /// CHECK: Created and validated by the transfer hook program via CPI.
    #[account(mut)]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState PDA — stores expiry + protocol PDA for the transfer hook.
    /// CHECK: Created and validated by the transfer hook program via CPI.
    #[account(mut)]
    pub hook_state: UncheckedAccount<'info>,

    // Programs
    pub system_program: Program<'info, System>,

    /// Token-2022 program — for the option mint and token accounts.
    pub token_2022_program: Program<'info, Token2022>,

    pub rent: Sysvar<'info, Rent>,
}
