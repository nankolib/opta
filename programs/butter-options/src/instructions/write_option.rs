// =============================================================================
// instructions/write_option.rs — Writer creates a tokenized option (Token-2022)
// =============================================================================
//
// The writer:
//   1. Locks USDC collateral in an escrow PDA (standard SPL Token)
//   2. A new Token-2022 mint is created with three extensions:
//      - TransferHook: blocks transfers of expired option tokens
//      - PermanentDelegate: lets the protocol burn tokens from any holder
//      - MetadataPointer + TokenMetadata: on-chain metadata with financial terms
//   3. Option tokens are minted to the purchase escrow (Token-2022)
//   4. Transfer hook state is initialized via CPI to the hook program
//   5. Buyers can purchase without the writer needing to co-sign
//
// The token name is human-readable: "BUTTER-SOL-200C-APR15"
// This shows up directly in Phantom wallet so holders know what they own.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;
use spl_token_2022::extension::ExtensionType;

use crate::errors::ButterError;
use crate::events::OptionWritten;
use crate::state::*;

// =============================================================================
// Month abbreviations for human-readable expiry dates in token names.
// "BUTTER-SOL-200C-APR15" is much more useful than a unix timestamp.
// =============================================================================
const MONTHS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/// Convert a unix timestamp to (month_index 0-11, day 1-31).
/// Basic civil calendar math — no external crate needed.
fn timestamp_to_month_day(timestamp: i64) -> (usize, u8) {
    let total_days = timestamp / 86400;
    let mut year = 1970i64;
    let mut remaining = total_days;

    // Walk forward year by year until we find the right year
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    // Walk forward month by month to find month and day
    let days_in_months: [i64; 12] = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 0usize;
    for (i, &dim) in days_in_months.iter().enumerate() {
        if remaining < dim {
            month = i;
            break;
        }
        remaining -= dim;
    }

    (month, remaining as u8 + 1) // 0-indexed month, 1-indexed day
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// =============================================================================
// Handler
// =============================================================================

pub fn handle_write_option(
    ctx: Context<WriteOption>,
    collateral_amount: u64,
    premium: u64,
    contract_size: u64,
    created_at: i64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let clock = Clock::get()?;

    // =========================================================================
    // Validation (unchanged from original)
    // =========================================================================
    require!(clock.unix_timestamp < market.expiry_timestamp, ButterError::MarketExpired);
    require!(contract_size > 0, ButterError::InvalidContractSize);
    require!(premium > 0, ButterError::InvalidPremium);

    let required_collateral = match market.option_type {
        OptionType::Put => market.strike_price
            .checked_mul(contract_size).ok_or(ButterError::MathOverflow)?,
        OptionType::Call => market.strike_price
            .checked_mul(2).ok_or(ButterError::MathOverflow)?
            .checked_mul(contract_size).ok_or(ButterError::MathOverflow)?,
    };
    require!(collateral_amount >= required_collateral, ButterError::InsufficientCollateral);

    // =========================================================================
    // Step 1: Transfer USDC collateral from writer to escrow (standard Token)
    // =========================================================================
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.writer_usdc_account.to_account_info(),
            to: ctx.accounts.escrow.to_account_info(),
            authority: ctx.accounts.writer.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, collateral_amount)?;

    // Protocol PDA signer seeds — used for all protocol-authority operations
    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    // =========================================================================
    // Step 2: Build the human-readable token name
    //
    // Format: "BUTTER-{ASSET}-{STRIKE}{C/P}-{MONTH}{DAY}"
    // Example: "BUTTER-SOL-200C-APR15"
    // This shows up in Phantom wallet so holders know exactly what they own.
    // =========================================================================
    let strike_dollars = market.strike_price / 1_000_000;
    let type_char = match market.option_type {
        OptionType::Call => "C",
        OptionType::Put => "P",
    };
    let (month_idx, day) = timestamp_to_month_day(market.expiry_timestamp);
    let month_name = MONTHS[month_idx];
    let token_name = format!(
        "BUTTER-{}-{}{}-{}{}",
        market.asset_name, strike_dollars, type_char, month_name, day
    );
    // Truncate to 32 chars if needed (unlikely but safe)
    let token_name = if token_name.len() > 32 {
        token_name[..32].to_string()
    } else {
        token_name
    };

    // =========================================================================
    // Step 3: Create Token-2022 mint with three extensions
    //
    // Extensions:
    //   1. TransferHook — runs our hook program on every transfer
    //   2. PermanentDelegate — protocol can burn tokens from any holder
    //   3. MetadataPointer — tells wallets where to find metadata (on mint itself)
    //
    // IMPORTANT: Extensions must be initialized BEFORE initialize_mint2.
    // Token-2022 requires this specific ordering.
    // =========================================================================
    let mint_info = ctx.accounts.option_mint.to_account_info();
    let token_2022_key = ctx.accounts.token_2022_program.key();

    // Calculate mint account space:
    // Base mint + 3 fixed extensions (TransferHook, PermanentDelegate, MetadataPointer).
    // NOTE: We allocate ONLY the base extension space here. Token-2022 rejects
    // accounts with extra uninitialized bytes in the TLV area during InitializeMint2.
    // The TokenMetadata extension is variable-length — Token-2022 auto-reallocs the
    // account when we call spl_token_metadata_interface::initialize later.
    // We overfund with lamports so the realloc has enough for rent exemption.
    let base_space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(
        &[
            ExtensionType::TransferHook,
            ExtensionType::PermanentDelegate,
            ExtensionType::MetadataPointer,
        ],
    )
    .map_err(|_| ButterError::MathOverflow)?;

    let rent = Rent::get()?;
    // Fund for full size (base + metadata headroom) so auto-realloc has rent covered
    let mint_lamports = rent.minimum_balance(base_space + 854);

    // Mint PDA signer seeds: ["option_mint", position_pubkey]
    let mint_seeds: &[&[u8]] = &[
        OPTION_MINT_SEED,
        ctx.accounts.position.to_account_info().key.as_ref(),
        &[ctx.bumps.option_mint],
    ];

    // Create the mint account (owned by Token-2022 program)
    // Space = base_space only; lamports overfunded for metadata realloc later
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

    // Extension 1: TransferHook — points to our transfer hook program.
    invoke(
        &spl_token_2022::extension::transfer_hook::instruction::initialize(
            &token_2022_key,
            mint_info.key,
            None,
            Some(ctx.accounts.transfer_hook_program.key()),
        )?,
        &[mint_info.clone()],
    )?;

    // Extension 2: PermanentDelegate — protocol PDA can burn tokens from any holder.
    invoke(
        &spl_token_2022::instruction::initialize_permanent_delegate(
            &token_2022_key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
        )?,
        &[mint_info.clone()],
    )?;

    // Extension 3: MetadataPointer — metadata lives on the mint account itself.
    invoke(
        &spl_token_2022::extension::metadata_pointer::instruction::initialize(
            &token_2022_key,
            mint_info.key,
            None,
            Some(*mint_info.key),
        )?,
        &[mint_info.clone()],
    )?;

    // Initialize the mint (must come AFTER all extension initializations)
    invoke(
        &spl_token_2022::instruction::initialize_mint2(
            &token_2022_key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
            None,
            0,
        )?,
        &[mint_info.clone()],
    )?;


    // =========================================================================
    // Step 4: Initialize on-chain metadata
    // =========================================================================

    // Initialize base metadata (name, symbol, uri)
    invoke_signed(
        &spl_token_metadata_interface::instruction::initialize(
            &token_2022_key,       // Token-2022 implements the metadata interface
            mint_info.key,         // metadata account (= mint, self-referencing)
            &ctx.accounts.protocol_state.key(), // update authority
            mint_info.key,         // mint
            &ctx.accounts.protocol_state.key(), // mint authority (must sign)
            token_name.clone(),
            "bOPT".to_string(),
            "".to_string(), // no off-chain URI needed — everything is on-chain
        ),
        &[
            mint_info.clone(),
            ctx.accounts.protocol_state.to_account_info(),
        ],
        signer_seeds,
    )?;

    // Add the detailed financial terms as additional metadata fields.
    // These key-value pairs make the token fully self-describing on-chain.
    let collateral_per_token = collateral_amount
        .checked_div(contract_size)
        .ok_or(ButterError::MathOverflow)?;

    let additional_fields: Vec<(&str, String)> = vec![
        ("asset_name", market.asset_name.clone()),
        ("asset_class", market.asset_class.to_string()),
        ("strike_price", market.strike_price.to_string()),
        ("expiry", market.expiry_timestamp.to_string()),
        (
            "option_type",
            match market.option_type {
                OptionType::Call => "call",
                OptionType::Put => "put",
            }
            .to_string(),
        ),
        ("pyth_feed", market.pyth_feed.to_string()),
        ("collateral_per_token", collateral_per_token.to_string()),
        ("market_pda", ctx.accounts.market.key().to_string()),
    ];

    for (key, value) in additional_fields {
        invoke_signed(
            &spl_token_metadata_interface::instruction::update_field(
                &token_2022_key,
                mint_info.key,         // metadata account (= mint)
                &ctx.accounts.protocol_state.key(), // update authority (must sign)
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
    // Step 5: Initialize transfer hook state (CPI to hook program)
    //
    // This creates the HookState and ExtraAccountMetaList accounts that the
    // transfer hook reads on every transfer to check expiry.
    // =========================================================================
    let cpi_ctx = CpiContext::new(
        ctx.accounts.transfer_hook_program.to_account_info(),
        butter_transfer_hook::cpi::accounts::InitializeExtraAccountMetaList {
            payer: ctx.accounts.writer.to_account_info(),
            mint: mint_info.clone(),
            extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
            hook_state: ctx.accounts.hook_state.to_account_info(),
            protocol_state: ctx.accounts.protocol_state.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    butter_transfer_hook::cpi::initialize_extra_account_meta_list(
        cpi_ctx,
        market.expiry_timestamp,
    )?;

    // =========================================================================
    // Step 6: Create purchase escrow (Token-2022 token account)
    //
    // This holds the option tokens until buyers purchase them. The protocol
    // PDA owns the escrow so buyers don't need writer co-signatures.
    // =========================================================================
    let purchase_escrow_info = ctx.accounts.purchase_escrow.to_account_info();

    // Token accounts for TransferHook mints need the TransferHookAccount extension.
    // Token-2022 adds it automatically during initialize_account3, but we must
    // allocate enough space for it.
    let escrow_space =
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
            &[ExtensionType::TransferHookAccount],
        )
        .map_err(|_| ButterError::MathOverflow)?;
    let escrow_lamports = rent.minimum_balance(escrow_space);

    let escrow_seeds: &[&[u8]] = &[
        PURCHASE_ESCROW_SEED,
        ctx.accounts.position.to_account_info().key.as_ref(),
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
    // Step 7: Mint option tokens to the purchase escrow
    // =========================================================================
    invoke_signed(
        &spl_token_2022::instruction::mint_to(
            &token_2022_key,
            mint_info.key,
            purchase_escrow_info.key,
            &ctx.accounts.protocol_state.key(),
            &[], // no multisig
            contract_size,
        )?,
        &[
            mint_info.clone(),
            purchase_escrow_info.clone(),
            ctx.accounts.protocol_state.to_account_info(),
        ],
        signer_seeds,
    )?;

    // =========================================================================
    // Step 8: Initialize the position account (same data as before)
    // =========================================================================
    let position = &mut ctx.accounts.position;
    position.market = ctx.accounts.market.key();
    position.writer = ctx.accounts.writer.key();
    position.option_mint = *mint_info.key;
    position.total_supply = contract_size;
    position.tokens_sold = 0;
    position.collateral_amount = collateral_amount;
    position.premium = premium;
    position.contract_size = contract_size;
    position.created_at = created_at;
    position.is_exercised = false;
    position.is_expired = false;
    position.is_cancelled = false;
    position.is_listed_for_resale = false;
    position.resale_premium = 0;
    position.resale_token_amount = 0;
    position.resale_seller = Pubkey::default();
    position.bump = ctx.bumps.position;

    emit!(OptionWritten {
        market: ctx.accounts.market.key(),
        writer: ctx.accounts.writer.key(),
        position: ctx.accounts.position.key(),
        option_mint: *mint_info.key,
        premium,
        collateral: collateral_amount,
        contract_size,
    });

    Ok(())
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
#[instruction(collateral_amount: u64, premium: u64, contract_size: u64, created_at: i64)]
pub struct WriteOption<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,

    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    pub market: Account<'info, OptionsMarket>,

    #[account(
        init,
        seeds = [POSITION_SEED, market.key().as_ref(), writer.key().as_ref(), &created_at.to_le_bytes()],
        bump,
        payer = writer,
        space = 8 + OptionPosition::INIT_SPACE,
    )]
    pub position: Box<Account<'info, OptionPosition>>,

    /// USDC escrow for collateral. Authority = protocol PDA.
    /// This stays on the standard SPL Token program (USDC is not Token-2022).
    #[account(
        init,
        seeds = [ESCROW_SEED, market.key().as_ref(), writer.key().as_ref(), &created_at.to_le_bytes()],
        bump,
        payer = writer,
        token::mint = usdc_mint,
        token::authority = protocol_state,
    )]
    pub escrow: Box<Account<'info, TokenAccount>>,

    /// Option token mint — Token-2022 with TransferHook + PermanentDelegate +
    /// MetadataPointer extensions. Created manually via CPI in the handler
    /// because Anchor's `init` doesn't support Token-2022 extensions.
    ///
    /// CHECK: Created via CPI to Token-2022 in the handler. Seeds validate
    /// the address matches the expected PDA.
    #[account(
        mut,
        seeds = [OPTION_MINT_SEED, position.key().as_ref()],
        bump,
    )]
    pub option_mint: UncheckedAccount<'info>,

    /// Purchase escrow — holds option tokens for buyers. Token-2022 token
    /// account created manually in the handler (same reason as mint).
    ///
    /// CHECK: Created via CPI to Token-2022 in the handler. Seeds validate
    /// the address matches the expected PDA.
    #[account(
        mut,
        seeds = [PURCHASE_ESCROW_SEED, position.key().as_ref()],
        bump,
    )]
    pub purchase_escrow: UncheckedAccount<'info>,

    /// Writer's USDC account (source of collateral).
    #[account(
        mut,
        constraint = writer_usdc_account.owner == writer.key(),
        constraint = writer_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub writer_usdc_account: Account<'info, TokenAccount>,

    #[account(constraint = usdc_mint.key() == protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, anchor_spl::token::Mint>,

    // -------------------------------------------------------------------------
    // Transfer hook accounts — for initializing the hook state via CPI
    // -------------------------------------------------------------------------

    /// The transfer hook program. Validated against the known program ID.
    /// CHECK: Constrained to the known butter-transfer-hook program ID.
    #[account(
        constraint = transfer_hook_program.key() == butter_transfer_hook::ID
    )]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList PDA — created by the hook program during CPI.
    /// Seeds: ["extra-account-metas", mint] on the hook program.
    /// CHECK: Created and validated by the transfer hook program via CPI.
    #[account(mut)]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState PDA — stores expiry + protocol PDA for the transfer hook.
    /// Seeds: ["hook-state", mint] on the hook program.
    /// CHECK: Created and validated by the transfer hook program via CPI.
    #[account(mut)]
    pub hook_state: UncheckedAccount<'info>,

    // -------------------------------------------------------------------------
    // Programs
    // -------------------------------------------------------------------------

    pub system_program: Program<'info, System>,

    /// Standard SPL Token program — used for USDC operations only.
    pub token_program: Program<'info, Token>,

    /// Token-2022 program — used for the option mint and token accounts.
    pub token_2022_program: Program<'info, Token2022>,

    pub rent: Sysvar<'info, Rent>,
}
