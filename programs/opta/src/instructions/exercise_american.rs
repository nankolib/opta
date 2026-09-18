// =============================================================================
// instructions/exercise_american.rs — early (pre-expiry) American exercise
// =============================================================================
//
// The HOLDER of an American option burns N tokens BEFORE expiry and receives
// cash-settled capped intrinsic value in USDC from the vault. This is the
// defining American feature (European has no early exercise).
//
// Money flow (N contracts, capped intrinsic `i` per contract, P = N × i):
//   1. Gates (American + AMERICAN_ENABLED + pre-expiry + balance).
//   2. Read spot from a FRESH PriceUpdateV2 supplied by the exerciser
//      (atomic post+consume, same validation pattern as settle_expiry — read
//      the EMA field), normalized to 6-dec USDC.
//   3. i = exercise_capped_intrinsic(option_type, spot, strike, collateral_per_token)
//      (the (f) lock: CALL/PUT capped at 1× collateral). require!(i > 0).
//   4. Burn N tokens — HOLDER signs (same as exercise_from_vault, NOT delegate).
//   5. Transfer P USDC vault → holder, vault PDA signs via vault_namespace_seed.
//   6. vault.exercised_options += N; vault.early_exercise_payout += the
//      VAULT-funded share of P (see the pot leg below — a pot-funded dollar
//      accounts for itself through the reduced settle sweep).
//
// Deliberately does NOT mutate total_collateral / total_options_sold /
// collateral_remaining — Stage G's settlement math consumes the two counters
// above to net early exercises without double-paying. (Stage F owns the entire
// HOLDER-side exercise surface; the writer-side seed sweep + partial-supply
// settlement handshake is Stage G.)
//
// Gated off until Stage I via AMERICAN_ENABLED (the American arm reverts
// AmericanVaultsDisabled when the flag is false — the default).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::OptaError;
use crate::events::VaultExercised;
use crate::feature_flags::AMERICAN_ENABLED;
use crate::state::*;
use crate::utils::collateral::required_collateral_per_contract;
use crate::utils::exercise_intrinsic::exercise_capped_intrinsic;
use crate::utils::opta_price_read::opta_current_spot_usdc;
use crate::utils::price_oracle::{
    find_ed25519_ix_index, pyth_current_spot_usdc, sb_current_spot_usdc, secs_to_slots,
    SB_MIN_ORACLE_SAMPLES_FLOOR,
};

/// Max age of the supplied price update at exercise time, in seconds: the
/// price's `publish_time` must be within 60s of the on-chain clock (now). Early
/// exercise needs a CURRENT price; a stale/historical print would let a holder
/// cherry-pick a favorable spot (bounded by the per-contract cap, but real
/// value extraction). 60s reuses settle_expiry's EXPIRY_WINDOW_SECS magnitude.
///
/// Stage G Pass 2 tightened this from the loose 30d PYTH_MAX_AGE backstop that
/// Stage F shipped (decision (a) flip-blocker for the Stage I AMERICAN_ENABLED
/// flip). Deterministically testable only under bankrun setClock (a static
/// fixture's publish_time can't be aligned to a moving validator wall-clock).
///
/// `pub` so execute_trigger (Phase 4) reads the live EMA with the IDENTICAL
/// freshness constant — the trigger re-check mirrors this byte-for-byte.
pub const PRICE_MAX_AGE_SECS: i64 = 60;

/// Max Pyth EMA confidence width tolerated, in bps of the EMA price. Same
/// value + check as settle_expiry::MAX_CONF_BPS (CRIT-2): reject wide-conf
/// prints that surface during oracle stress. `pub` for execute_trigger reuse.
pub const MAX_CONF_BPS: u16 = 200;

pub fn handle_exercise_american(
    ctx: Context<ExerciseAmerican>,
    quantity: u64,
) -> Result<()> {
    // ----- Snapshot vault fields used by the wrapper gates ------------------
    // (option_type/strike/market/bump moved into american_exercise_core, which
    // re-reads them from shared_vault; the wrapper keeps only what its own gates
    // need so the gate ORDER vs. the pyth read stays byte-identical.)
    let vault = &ctx.accounts.shared_vault;
    let exercise_style = vault.exercise_style;
    let expiry = vault.expiry;

    // ----- Gates (in spec order) --------------------------------------------
    // 1. American feature gate (default-off until Stage I). The European arm
    //    never reaches this instruction (gate #2), so EUR is unaffected.
    require!(AMERICAN_ENABLED, OptaError::AmericanVaultsDisabled);

    // 2. American-only: early exercise is not a European feature.
    require!(
        exercise_style == ExerciseStyle::American,
        OptaError::NotAmericanOption
    );

    // 3. Pre-expiry only. At/after expiry holders route through settlement
    //    (settle_vault → exercise_from_vault / auto_finalize_holders).
    let clock = Clock::get()?;
    require!(clock.unix_timestamp < expiry, OptaError::OptionExpired);

    // 4. Quantity + holder balance.
    require!(quantity > 0, OptaError::InvalidContractSize);
    let holder_balance = {
        let data = ctx.accounts.holder_option_account.try_borrow_data()?;
        require!(data.len() >= 72, OptaError::InsufficientOptionTokens);
        u64::from_le_bytes(
            data[64..72]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?,
        )
    };
    require!(quantity <= holder_balance, OptaError::InsufficientOptionTokens);

    // ----- Read + normalize spot, ROUTED by market.oracle_source (Stage 3) ---
    // The match lives here (not american_exercise_core, which takes spot_6dec as
    // a param and reads no oracle). Both arms return the SAME u64 USDC-6dec; the
    // downstream core path is untouched.
    //
    //   Pyth (0): byte-for-byte the pre-Stage-3 read — just unwraps the now-
    //             optional price_update. Behavior/errors/EMA read unchanged.
    //   Switchboard (1): unwrap the 3 trailing SB accounts, runtime-address-check
    //             the two sysvars, derive the ed25519 ix index on-chain, then run
    //             the unit-1 sb_current_spot_usdc seam (60s → secs_to_slots).
    let oracle_source = ctx.accounts.market.oracle_source;
    let feed_id = ctx.accounts.market.pyth_feed_id;
    let spot_6dec = match oracle_source {
        ORACLE_SOURCE_PYTH => {
            let price_update = ctx
                .accounts
                .price_update
                .as_ref()
                .ok_or(error!(OptaError::PriceUpdateMissing))?;
            pyth_current_spot_usdc(
                price_update,
                feed_id,
                clock.unix_timestamp,
                PRICE_MAX_AGE_SECS,
                MAX_CONF_BPS,
            )?
        }
        ORACLE_SOURCE_SWITCHBOARD => {
            let queue = ctx
                .accounts
                .sb_queue
                .as_ref()
                .ok_or(error!(OptaError::SwitchboardAccountsMissing))?;
            let slothashes = ctx
                .accounts
                .sb_slothashes
                .as_ref()
                .ok_or(error!(OptaError::SwitchboardAccountsMissing))?;
            let instructions = ctx
                .accounts
                .sb_instructions
                .as_ref()
                .ok_or(error!(OptaError::SwitchboardAccountsMissing))?;
            // Runtime sysvar address checks — a struct-level `address =` constraint
            // would fire on the Pyth path where these are absent, so check here.
            require_keys_eq!(
                slothashes.key(),
                anchor_lang::solana_program::sysvar::slot_hashes::ID,
                OptaError::InvalidSwitchboardSysvar
            );
            require_keys_eq!(
                instructions.key(),
                anchor_lang::solana_program::sysvar::instructions::ID,
                OptaError::InvalidSwitchboardSysvar
            );
            let instructions_ai = instructions.to_account_info();
            let ed25519_ix_index = find_ed25519_ix_index(&instructions_ai)?;
            sb_current_spot_usdc(
                &queue.to_account_info(),
                &slothashes.to_account_info(),
                &instructions_ai,
                ed25519_ix_index,
                clock.slot,
                secs_to_slots(PRICE_MAX_AGE_SECS),
                feed_id,
                SB_MIN_ORACLE_SAMPLES_FLOOR,
            )?
        }
        ORACLE_SOURCE_OPTA => {
            // FP-ORACLE: current spot in USDC 6-dec, 180s freshness.
            let feed = ctx
                .accounts
                .opta_price_feed
                .as_ref()
                .ok_or(error!(OptaError::OptaFeedMissing))?;
            opta_current_spot_usdc(feed, feed_id, clock.unix_timestamp, OPTA_FEED_READ_MAX_AGE_SECS)?
        }
        _ => return Err(error!(OptaError::InvalidOracleSource)),
    };

    // ----- Delegate intrinsic + burn + payout + counters to the shared core --
    // Phase 4 extraction: american_exercise_core does the capped-intrinsic calc,
    // the burn, the vault→holder USDC payout, the two counter bumps, and the
    // VaultExercised emit — byte-identical to the prior inline block. Here the
    // burn authority is the HOLDER (a real tx signer → `invoke`; pda_bump=None)
    // and the payout goes to the holder. execute_trigger calls the SAME core
    // with the protocol-delegate burn (pda_bump=Some) + owner payout. The gates
    // above are kept verbatim (the core re-checks them harmlessly) so the revert
    // order vs. the pyth read is unchanged from the pre-extraction handler.
    // Assemble the pot leg only when all three optionals came in. A partial set
    // is a caller error, not a half-usable source — refuse it rather than
    // silently falling back to a vault account we may already know is empty.
    let pot_usdc_ai = ctx.accounts.writer_ask_pot_usdc.as_ref().map(|a| a.to_account_info());
    let protocol_ai = ctx.accounts.protocol_state.as_ref().map(|a| a.to_account_info());
    let protocol_bump = ctx.accounts.protocol_state.as_ref().map(|a| a.bump);
    let pot_leg = match (
        ctx.accounts.writer_ask_pot.as_mut(),
        pot_usdc_ai.as_ref(),
        protocol_ai.as_ref(),
        protocol_bump,
    ) {
        (Some(pot), Some(pot_usdc), Some(protocol_state), Some(bump)) => Some(PotLeg {
            pot,
            pot_usdc,
            protocol_state,
            protocol_bump: bump,
        }),
        _ => None,
    };

    american_exercise_core(
        &mut ctx.accounts.shared_vault,
        &ctx.accounts.option_mint.to_account_info(),
        &ctx.accounts.holder_option_account.to_account_info(),
        &ctx.accounts.holder.to_account_info(),
        None, // holder is a real signer → plain invoke
        &ctx.accounts.vault_usdc_account.to_account_info(),
        &ctx.accounts.holder_usdc_account.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.holder.key(),
        quantity,
        spot_6dec,
        pot_leg,
    )?;

    Ok(())
}

/// The writer-ask pot, as a payout source of last resort.
///
/// Borrowed rather than owned so the caller keeps its `ctx.accounts` intact, and
/// `protocol_bump` is passed explicitly so the core never re-derives a PDA it was
/// handed. Present only when the caller supplied the three trailing optionals;
/// `execute_trigger` passes `None` (its fires are pool-backed by construction).
pub struct PotLeg<'a, 'info> {
    pub pot: &'a mut Account<'info, WriterAskPot>,
    pub pot_usdc: &'a AccountInfo<'info>,
    pub protocol_state: &'a AccountInfo<'info>,
    pub protocol_bump: u8,
}

// =============================================================================
// american_exercise_core — shared early-American-exercise economics (Phase 4)
// =============================================================================
//
// Single source of truth for the capped-intrinsic exercise: gates → intrinsic →
// burn → vault→destination USDC payout → counter bumps → VaultExercised emit.
// Two callers with different authority wiring (the burn + the paid party):
//
//   exercise_american : burn_authority = holder (real signer),
//                       burn_authority_pda_bump = None  → plain `invoke`;
//                       payout_destination = holder's USDC; paid_to = holder.
//   execute_trigger   : burn_authority = protocol_state (the PermanentDelegate),
//                       burn_authority_pda_bump = Some(protocol_state.bump)
//                       → `invoke_signed` with [PROTOCOL_SEED, bump]
//                       (the auto_finalize_holders pattern — NO holder sig);
//                       payout_destination = owner's USDC; paid_to = owner.
//
// The vault→destination USDC payout ALWAYS signs as the vault PDA via
// vault_namespace_seed (American prefix). The EMA spot is supplied by the caller
// (`spot_6dec`) — the core never reads Pyth, so execute_trigger uses the SAME
// EMA it re-checked the comparator against.
//
// CRITICAL (Phase A note 3): the core TRUSTS `burn_source`. The 6060
// owner-match / mint-match / fresh-balance re-checks are execute_trigger's
// HANDLER responsibility (its source is a stored, possibly-stale/hostile
// address); exercise_american's source is constraint-pinned to the signer so it
// needs none. The core only enforces balance >= quantity (revert-on-short).
///
/// ── THE SECOND FUNDING SOURCE (2026-08-15) ──────────────────────────────────
/// `pot_leg` exists because the vault's own USDC account is EMPTY on a series
/// whose collateral came from writer asks. `fill_writer_ask` routes that money
/// into a per-series pot (`["writer_ask_pot_usdc", option_mint]`, authority =
/// `protocol_state`) and only `settle_vault` sweeps it into the vault — which
/// happens strictly AFTER expiry, i.e. after early exercise is possible at all.
/// Measured 2026-08-15: all 22 live SOL American CALL vaults for the 28-Aug
/// expiry held $0 in the vault account with the collateral sitting in pots, so
/// early exercise was impossible on 100% of them.
///
/// The pot leg pays the SHORTFALL only, after the vault account is drained
/// first, and it signs as `protocol_state` — the same authority, with the same
/// seeds, that `settle_vault` already uses to move this exact money. Nothing
/// new is authorised; a second caller reaches an existing authority.
///
/// `writer_ask_collateral_swept` is deliberately NOT touched here: it is
/// settlement's record of what the sweep moved, and pre-settlement it must stay
/// zero. The pot's own counters absorb the draw instead, which keeps
/// `settle_vault`'s `pot_bal >= swept` invariant exact.
#[allow(clippy::too_many_arguments)]
pub fn american_exercise_core<'info>(
    shared_vault: &mut Account<'info, SharedVault>,
    option_mint: &AccountInfo<'info>,
    burn_source: &AccountInfo<'info>,
    burn_authority: &AccountInfo<'info>,
    burn_authority_pda_bump: Option<u8>,
    vault_usdc_account: &AccountInfo<'info>,
    payout_destination: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
    paid_to: Pubkey,
    quantity: u64,
    spot_6dec: u64,
    mut pot_leg: Option<PotLeg<'_, 'info>>,
) -> Result<u64> {
    // Snapshot vault fields (read through the &mut).
    let exercise_style = shared_vault.exercise_style;
    let option_type = shared_vault.option_type;
    let strike_price = shared_vault.strike_price;
    let expiry = shared_vault.expiry;
    let market_key = shared_vault.market;
    let vault_bump = shared_vault.bump;

    // ----- Gates (mirror exercise_american; redundant for that caller) ------
    require!(AMERICAN_ENABLED, OptaError::AmericanVaultsDisabled);
    require!(
        exercise_style == ExerciseStyle::American,
        OptaError::NotAmericanOption
    );
    let clock = Clock::get()?;
    require!(clock.unix_timestamp < expiry, OptaError::OptionExpired);
    require!(quantity > 0, OptaError::InvalidContractSize);
    let balance = {
        let data = burn_source.try_borrow_data()?;
        require!(data.len() >= 72, OptaError::InsufficientOptionTokens);
        u64::from_le_bytes(
            data[64..72]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?,
        )
    };
    require!(quantity <= balance, OptaError::InsufficientOptionTokens);

    // ----- Capped intrinsic (the (f) lock) ----------------------------------
    let collateral_per_token = required_collateral_per_contract(strike_price, option_type);
    let intrinsic_per_contract =
        exercise_capped_intrinsic(option_type, spot_6dec, strike_price, collateral_per_token);
    require!(intrinsic_per_contract > 0, OptaError::OptionNotInTheMoney);

    let total_payout = quantity
        .checked_mul(intrinsic_per_contract)
        .ok_or(OptaError::MathOverflow)?;

    // ----- Burn N tokens: holder `invoke` OR delegate `invoke_signed` -------
    let burn_ix = spl_token_2022::instruction::burn(
        &token_2022_program.key(),
        burn_source.key,
        option_mint.key,
        burn_authority.key,
        &[],
        quantity,
    )?;
    let burn_accounts = [
        burn_source.clone(),
        option_mint.clone(),
        burn_authority.clone(),
    ];
    match burn_authority_pda_bump {
        None => invoke(&burn_ix, &burn_accounts)?,
        Some(bump) => {
            let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[bump]];
            invoke_signed(&burn_ix, &burn_accounts, &[protocol_seeds])?;
        }
    }

    // ----- Transfer USDC vault → destination — vault PDA signs via namespace -
    let ns = vault_namespace_seed(exercise_style);
    let strike_bytes = strike_price.to_le_bytes();
    let expiry_bytes = expiry.to_le_bytes();
    let option_type_byte = [option_type as u8];
    let vault_bump_arr = [vault_bump];
    let vault_seeds: &[&[u8]] = &[
        ns,
        market_key.as_ref(),
        &strike_bytes,
        &expiry_bytes,
        &option_type_byte,
        &vault_bump_arr,
    ];
    let signer_seeds = &[vault_seeds];

    // Vault first, pot for whatever the vault cannot cover. A pool-funded series
    // takes the first branch alone and is byte-identical to the pre-2026-08-15
    // behaviour; a writer-ask series has an empty vault account and takes the
    // second alone; a mixed vault takes both.
    let vault_balance = {
        let data = vault_usdc_account.try_borrow_data()?;
        require!(data.len() >= 72, OptaError::MathOverflow);
        u64::from_le_bytes(
            data[64..72]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?,
        )
    };
    let from_vault = total_payout.min(vault_balance);
    let shortfall = total_payout.saturating_sub(from_vault);

    if from_vault > 0 {
        let transfer_ctx = CpiContext::new_with_signer(
            token_program.clone(),
            Transfer {
                from: vault_usdc_account.clone(),
                to: payout_destination.clone(),
                authority: shared_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, from_vault)?;
    }

    if shortfall > 0 {
        let leg = pot_leg
            .as_mut()
            .ok_or(error!(OptaError::EarlyExercisePotRequired))?;

        // Belt and braces. The cap makes this unreachable — intrinsic per
        // contract is capped at collateral_per_token and the pot holds
        // collateral_per_token x contracts — but an assertion that never fires
        // costs nothing, and the alternative to reverting on a broken invariant
        // is paying out money the pot does not have.
        let pot_balance = {
            let data = leg.pot_usdc.try_borrow_data()?;
            require!(data.len() >= 72, OptaError::MathOverflow);
            u64::from_le_bytes(
                data[64..72]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?,
            )
        };
        require!(
            pot_balance >= shortfall,
            OptaError::EarlyExercisePotUnderfunded
        );
        require!(
            leg.pot.total_collateral >= shortfall,
            OptaError::EarlyExercisePotUnderfunded
        );

        // protocol_state signs, exactly as settle_vault.rs does for this account.
        let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[leg.protocol_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                token_program.clone(),
                Transfer {
                    from: leg.pot_usdc.clone(),
                    to: payout_destination.clone(),
                    authority: leg.protocol_state.clone(),
                },
                &[protocol_seeds],
            ),
            shortfall,
        )?;

        // Keep the pot's record in step with its token account, or settle_vault's
        // `pot_bal >= swept` check would sweep against a stale figure.
        leg.pot.total_collateral = leg
            .pot
            .total_collateral
            .checked_sub(shortfall)
            .ok_or(OptaError::MathOverflow)?;
        // Contracts the pot no longer backs. `saturating_sub` because a MIXED
        // vault can burn contracts the pot never wrote (peg-minted ones), and
        // per-contract funding attribution is not tracked. The money invariant
        // above is the exact one; this counter is bookkeeping.
        leg.pot.total_contracts = leg.pot.total_contracts.saturating_sub(quantity);
    }

    // ----- Accounting: increment the two Stage F counters ONLY --------------
    //
    // `early_exercise_payout` accrues `from_vault`, NOT `total_payout`. It exists
    // for one consumer: settle_vault subtracts it from the writer-claimable pool
    // because those dollars left the vault before settlement could count them.
    // Dollars paid by the pot leg never were in that pool, and they have already
    // self-accounted — the leg debits `pot.total_collateral`, which is the exact
    // figure settle_vault later sweeps. Charging them here as well removes the
    // same money twice: CRITICAL-01's double-deduction, in a new place. A
    // pool-funded exercise has `shortfall == 0` ⇒ `from_vault == total_payout`
    // ⇒ this line is byte-identical to the pre-pot-leg behaviour.
    let vault_key = shared_vault.key();
    shared_vault.exercised_options = shared_vault
        .exercised_options
        .checked_add(quantity)
        .ok_or(OptaError::MathOverflow)?;
    shared_vault.early_exercise_payout = shared_vault
        .early_exercise_payout
        .checked_add(from_vault)
        .ok_or(OptaError::MathOverflow)?;

    emit!(VaultExercised {
        vault: vault_key,
        holder: paid_to,
        quantity,
        payout: total_payout,
    });

    Ok(total_payout)
}

#[derive(Accounts)]
pub struct ExerciseAmerican<'info> {
    /// The option token holder exercising early.
    #[account(mut)]
    pub holder: Signer<'info>,

    /// The (unsettled, pre-expiry) American shared vault.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The vault's market — provides the canonical `pyth_feed_id` the supplied
    /// price update is validated against.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver (exerciser posts it in the
    /// same tx). Validated for Full verification + feed_id + confidence +
    /// freshness in the handler.
    ///
    /// Stage 3: now `Option`. REQUIRED (present) for a Pyth market — its position
    /// is unchanged (4), so a present price_update is wire-identical to before.
    /// A Switchboard market passes None (program-id sentinel) and uses the
    /// trailing SB accounts instead. The Pyth arm errors `PriceUpdateMissing` if
    /// it is absent on a Pyth market.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

    /// Validates option_mint belongs to this vault (same guard as
    /// exercise_from_vault).
    #[account(
        constraint = vault_mint_record.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == option_mint.key() @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Account<'info, VaultMint>,

    /// The Token-2022 option mint.
    /// CHECK: Validated by the Token-2022 burn instruction + vault_mint_record.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Holder's option token account (Token-2022).
    /// CHECK: Validated by the Token-2022 burn instruction (mint + owner).
    #[account(mut)]
    pub holder_option_account: UncheckedAccount<'info>,

    /// Vault's USDC account — payout source.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Holder's USDC account — receives the cash-settled payout.
    #[account(
        mut,
        constraint = holder_usdc_account.owner == holder.key(),
        constraint = holder_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub holder_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Token-2022 program — for burning option tokens.
    pub token_2022_program: Program<'info, Token2022>,

    /// Standard SPL Token program — for the USDC transfer.
    pub token_program: Program<'info, Token>,

    // --- Switchboard read-arm accounts (Stage 3). TRAILING optionals: a Pyth
    // market omits all three (allow-missing-optionals → None), keeping its tx
    // byte-identical to pre-Stage-3. Required only when
    // market.oracle_source == Switchboard; the handler unwraps them and runtime-
    // address-checks the two sysvars. Appended AFTER token_program; no existing
    // account moved. ---
    /// CHECK: Switchboard oracle queue. Not address-pinned (per-network queue);
    /// QuoteVerifier validates it against the quote's oracle-key set in the SB arm.
    pub sb_queue: Option<UncheckedAccount<'info>>,

    /// CHECK: SlotHashes sysvar. Address-checked == sysvar::slot_hashes::ID at
    /// runtime in the SB arm (used by QuoteVerifier for slothash freshness).
    pub sb_slothashes: Option<UncheckedAccount<'info>>,

    /// CHECK: Instructions sysvar. Address-checked == sysvar::instructions::ID at
    /// runtime in the SB arm, then scanned for the ed25519 ix index.
    pub sb_instructions: Option<UncheckedAccount<'info>>,

    // --- Writer-ask pot payout arm (2026-08-15). TRAILING optionals, appended
    // AFTER the sb_* set so no existing account moves: a pool-funded exercise
    // omits all three and its transaction is byte-identical to before. Required
    // only when the vault's own USDC account cannot cover the payout, which is
    // every series funded by writer asks. ---
    /// The series' collateral pot. Seed-derived AND field-linked, so a caller
    /// cannot point this at another series' pot to drain it: the seeds pin it to
    /// `option_mint`, `pot.vault` pins it to THIS vault, and `pot.usdc_account`
    /// pins the token account below.
    #[account(
        mut,
        seeds = [WRITER_ASK_POT_SEED, option_mint.key().as_ref()],
        bump = writer_ask_pot.bump,
        constraint = writer_ask_pot.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
        constraint = writer_ask_pot.option_mint == option_mint.key() @ OptaError::InvalidVaultMint,
    )]
    pub writer_ask_pot: Option<Box<Account<'info, WriterAskPot>>>,

    /// The pot's USDC account — the shortfall payout source. Authority is
    /// `protocol_state`, which is why that account is required alongside it.
    #[account(
        mut,
        constraint = writer_ask_pot_usdc.mint == shared_vault.collateral_mint,
    )]
    pub writer_ask_pot_usdc: Option<Box<Account<'info, TokenAccount>>>,

    /// Signs the pot -> holder transfer. Same authority, same seeds settle_vault
    /// uses to move this money at settlement.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Option<Box<Account<'info, ProtocolState>>>,

    /// FP-ORACLE arm (plug, wave 1). Trailing optional, appended LAST so every
    /// existing transaction stays byte-identical. REQUIRED when oracle_source ==
    /// ORACLE_SOURCE_OPTA; the arm errors OptaFeedMissing if absent.
    pub opta_price_feed: Option<Account<'info, OptaPriceFeed>>,
}
