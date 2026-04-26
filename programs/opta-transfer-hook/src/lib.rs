// =============================================================================
// butter-transfer-hook — Transfer hook for Butter Options token expiry
// =============================================================================
//
// This program implements the SPL Transfer Hook Interface. It is called
// automatically by the Token-2022 program on every transfer of an option token.
//
// Logic:
//   - Before expiry: ALL transfers allowed (users can trade freely)
//   - After expiry:
//       - Protocol escrow transfers allowed (source or dest owned by protocol PDA)
//       - User-to-user transfers BLOCKED (expired options can't be traded)
//
// Accounts per mint:
//   - ExtraAccountMetaList PDA: ["extra-account-metas", mint]
//     Required by Token-2022 to know which extra accounts the hook needs.
//   - HookState PDA: ["hook-state", mint]
//     Stores the option expiry timestamp and the Butter protocol PDA address.
// =============================================================================

use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta,
    seeds::Seed,
    state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

/// Seed for the HookState PDA (per-mint).
pub const HOOK_STATE_SEED: &[u8] = b"hook-state";

/// Seed for the ExtraAccountMetaList PDA (per-mint, required by Token-2022).
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

// =============================================================================
// State
// =============================================================================

/// Per-mint state that the transfer hook reads to decide whether to allow
/// or reject a transfer. Created during write_option via CPI.
#[account]
#[derive(InitSpace)]
pub struct HookState {
    /// Unix timestamp when the option expires. Copied from the OptionsMarket.
    pub expiry: i64,

    /// The Butter Options protocol PDA. Escrow accounts are owned by this PDA.
    /// If the source or destination token account owner matches this address,
    /// the transfer is considered protocol-internal and always allowed.
    pub protocol_state: Pubkey,

    /// PDA bump seed.
    pub bump: u8,
}

// =============================================================================
// Error codes
// =============================================================================

#[error_code]
pub enum TransferHookError {
    #[msg("Option has expired — transfers are no longer allowed")]
    OptionExpired,
}

// =============================================================================
// Instructions
// =============================================================================

#[program]
pub mod butter_transfer_hook {
    use super::*;

    /// Initialize the ExtraAccountMetaList and HookState for a new option mint.
    ///
    /// Called by the Butter Options program during write_option via CPI.
    /// This sets up the accounts that Token-2022 will pass to the hook on
    /// every transfer of this mint's tokens.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
        expiry: i64,
    ) -> Result<()> {
        // =====================================================================
        // 1. Initialize the HookState with expiry + protocol PDA
        // =====================================================================
        let hook_state = &mut ctx.accounts.hook_state;
        hook_state.expiry = expiry;
        hook_state.protocol_state = ctx.accounts.protocol_state.key();
        hook_state.bump = ctx.bumps.hook_state;

        // =====================================================================
        // 2. Build the ExtraAccountMetaList
        //
        // This tells Token-2022: "when calling the transfer hook, also pass
        // the HookState PDA." The HookState PDA is derived from seeds
        // ["hook-state", mint_pubkey], where mint is account index 1 in the
        // standard transfer hook Execute instruction.
        // =====================================================================
        let extra_account_metas = vec![
            // HookState PDA — derived from ["hook-state", mint]
            // In the Execute instruction layout, the mint is at index 1.
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal {
                        bytes: HOOK_STATE_SEED.to_vec(),
                    },
                    Seed::AccountKey { index: 1 }, // index 1 = mint in Execute
                ],
                false, // is_signer
                false, // is_writable
            )?,
        ];

        // =====================================================================
        // 3. Create the ExtraAccountMetaList account
        //
        // This PDA is owned by this hook program. We create it here via
        // system_program CPI and then write the meta list data into it.
        // =====================================================================
        let account_size = ExtraAccountMetaList::size_of(extra_account_metas.len())?;
        let lamports = Rent::get()?.minimum_balance(account_size);

        let meta_list_signer_seeds: &[&[u8]] = &[
            EXTRA_ACCOUNT_METAS_SEED,
            ctx.accounts.mint.key.as_ref(),
            &[ctx.bumps.extra_account_meta_list],
        ];

        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.extra_account_meta_list.to_account_info(),
                },
                &[meta_list_signer_seeds],
            ),
            lamports,
            account_size as u64,
            &crate::ID,
        )?;

        // Write the ExtraAccountMetaList data into the newly created account.
        let account_info = ctx.accounts.extra_account_meta_list.to_account_info();
        let mut data = account_info.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &extra_account_metas)?;

        msg!(
            "Transfer hook initialized for mint {}. Expiry: {}",
            ctx.accounts.mint.key(),
            expiry,
        );

        Ok(())
    }

    /// The transfer hook — called by Token-2022 on every transfer_checked.
    ///
    /// This is the Anchor-dispatch version. In production, Token-2022 calls
    /// via the fallback handler below (which uses the spl-transfer-hook-interface
    /// discriminator). This function exists for direct testing.
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        _check_expiry_and_escrow(
            &ctx.accounts.hook_state,
            &ctx.accounts.source_account,
            &ctx.accounts.destination_account,
        )
    }

    /// Required fallback for the spl-transfer-hook-interface.
    ///
    /// Token-2022 calls the transfer hook using the Execute instruction
    /// discriminator from spl-transfer-hook-interface, NOT an Anchor
    /// discriminator. This fallback catches that call and routes it to
    /// our expiry check logic.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        // The Execute instruction layout:
        //   bytes 0..8   = discriminator (spl-transfer-hook-interface execute)
        //   bytes 8..16  = amount (u64 LE)
        //
        // Account layout:
        //   0: source token account
        //   1: mint
        //   2: destination token account
        //   3: owner/authority
        //   4: extra_account_meta_list PDA
        //   5+: extra accounts (our HookState)

        // Minimum data: 8 bytes discriminator + 8 bytes amount
        if data.len() < 16 {
            return Err(ProgramError::InvalidInstructionData.into());
        }

        // Parse accounts from the raw account info array
        let account_infos = &mut accounts.iter();

        let source_account = next_account_info(account_infos)?;
        let mint = next_account_info(account_infos)?;
        let destination_account = next_account_info(account_infos)?;
        let _owner = next_account_info(account_infos)?;
        let _extra_account_meta_list = next_account_info(account_infos)?;
        let hook_state_info = next_account_info(account_infos)?;

        // Validate the HookState PDA derivation
        let (expected_hook_state, _bump) = Pubkey::find_program_address(
            &[HOOK_STATE_SEED, mint.key.as_ref()],
            program_id,
        );
        if *hook_state_info.key != expected_hook_state {
            return Err(ProgramError::InvalidSeeds.into());
        }

        // Deserialize HookState (skip 8-byte Anchor discriminator)
        let hook_state_data = hook_state_info.try_borrow_data()?;
        if hook_state_data.len() < 8 + 8 + 32 + 1 {
            // disc(8) + expiry(8) + pubkey(32) + bump(1)
            return Err(ProgramError::InvalidAccountData.into());
        }
        let hook_state: HookState =
            AnchorDeserialize::deserialize(&mut &hook_state_data[8..])?;

        // Run the expiry + escrow check
        _check_expiry_and_escrow_raw(&hook_state, source_account, destination_account)
    }
}

// =============================================================================
// Shared logic — the core expiry + escrow check
// =============================================================================

/// Check if the option is expired and whether the transfer involves a protocol
/// escrow. Used by both the Anchor dispatch and the fallback dispatch.
fn _check_expiry_and_escrow(
    hook_state: &HookState,
    source_account: &UncheckedAccount,
    destination_account: &UncheckedAccount,
) -> Result<()> {
    _check_expiry_and_escrow_raw(
        hook_state,
        &source_account.to_account_info(),
        &destination_account.to_account_info(),
    )
}

/// Raw version that works with AccountInfo references directly.
fn _check_expiry_and_escrow_raw(
    hook_state: &HookState,
    source_account: &AccountInfo,
    destination_account: &AccountInfo,
) -> Result<()> {
    let clock = Clock::get()?;

    // Before expiry: all transfers allowed.
    if clock.unix_timestamp < hook_state.expiry {
        return Ok(());
    }

    // After expiry: only allow protocol-internal transfers.
    //
    // Token account data layout (Token-2022 and standard SPL):
    //   bytes 0..32  = mint pubkey
    //   bytes 32..64 = owner pubkey  <-- this is what we check
    //
    // If either the source or destination token account is owned by the
    // protocol PDA, this is a protocol escrow operation. Allow it.
    let source_data = source_account.try_borrow_data()?;
    let dest_data = destination_account.try_borrow_data()?;

    // Safety: token accounts are always >= 165 bytes (Token) or >= 165 bytes (Token-2022).
    // Reading bytes 32..64 is always safe.
    if source_data.len() < 64 || dest_data.len() < 64 {
        return Err(ProgramError::InvalidAccountData.into());
    }

    let source_owner = Pubkey::try_from(&source_data[32..64])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    let dest_owner = Pubkey::try_from(&dest_data[32..64])
        .map_err(|_| ProgramError::InvalidAccountData)?;

    if source_owner == hook_state.protocol_state
        || dest_owner == hook_state.protocol_state
    {
        // Protocol escrow is involved — allow the transfer
        return Ok(());
    }

    // User-to-user transfer of an expired option — blocked
    msg!(
        "Transfer blocked: option expired at {}. Current time: {}",
        hook_state.expiry,
        clock.unix_timestamp,
    );
    err!(TransferHookError::OptionExpired)
}

// =============================================================================
// Account structs
// =============================================================================

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    /// The payer for account creation (the writer, forwarded from butter-options).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The option token mint that this hook is being set up for.
    /// CHECK: Validated by the caller (butter-options program).
    pub mint: UncheckedAccount<'info>,

    /// The ExtraAccountMetaList PDA — tells Token-2022 which extra accounts
    /// to pass when calling this hook.
    ///
    /// CHECK: Created and initialized in this instruction. PDA is validated
    /// by seeds. We use UncheckedAccount because ExtraAccountMetaList has
    /// a custom (non-Anchor) serialization format.
    #[account(
        mut,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// The HookState PDA — stores expiry timestamp and protocol authority.
    #[account(
        init,
        seeds = [HOOK_STATE_SEED, mint.key().as_ref()],
        bump,
        payer = payer,
        space = 8 + HookState::INIT_SPACE,
    )]
    pub hook_state: Account<'info, HookState>,

    /// The Butter Options protocol state PDA. Its pubkey is stored in
    /// HookState so the hook can identify protocol escrow accounts.
    /// CHECK: Validated by the butter-options program before CPI.
    pub protocol_state: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Accounts for the transfer_hook (Execute) instruction.
///
/// In production, Token-2022 calls via the fallback handler which manually
/// unpacks accounts. This struct is for Anchor-dispatched calls (e.g., tests).
#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// The source token account (tokens are being sent from here).
    /// CHECK: Validated by Token-2022 before calling the hook.
    pub source_account: UncheckedAccount<'info>,

    /// The option token mint.
    /// CHECK: Validated by Token-2022.
    pub mint: UncheckedAccount<'info>,

    /// The destination token account (tokens are being sent to here).
    /// CHECK: Validated by Token-2022.
    pub destination_account: UncheckedAccount<'info>,

    /// The owner/authority of the source token account.
    /// CHECK: Validated by Token-2022.
    pub owner: UncheckedAccount<'info>,

    /// The ExtraAccountMetaList PDA for this mint.
    /// CHECK: Validated by Token-2022 transfer hook dispatch.
    #[account(
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// The HookState PDA — contains expiry + protocol authority.
    #[account(
        seeds = [HOOK_STATE_SEED, mint.key().as_ref()],
        bump = hook_state.bump,
    )]
    pub hook_state: Account<'info, HookState>,
}
