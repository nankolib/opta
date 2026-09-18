// =============================================================================
// instructions/execute_trigger.rs — Keeper fires a trigger (Phase 4 Pass 1)
// =============================================================================
//
// The keeper (off-chain, P2) watches live Pyth prices and calls this when a
// stored TriggerOrder's condition crosses. The keeper's assertion is NEVER
// trusted: execute_trigger re-reads a FRESH Pyth EMA in-tx and re-checks the
// stored comparator itself before acting. It then routes to the SAME shared
// cores the direct instructions use. Which core depends on whether the keeper
// handed over book accounts (`BOOK_TRIGGERS_ENABLED && book_order.is_some()`):
//
//                   book accounts passed          no book accounts (fallback)
//   StopEntryBuy    writer_ask_fill_core (B1)     vault_peg_fill_core
//                   / resale_ask_fill_core        (escrow pays, mints to owner)
//   TakeProfitSell  bid_fill_core (B2)            american_exercise_core
//                                                 (delegate burns, vault pays)
//   StopLossSell    bid_fill_core (B2)            SKIP — stays armed. No vault
//                                                 path exists: an OTM long
//                                                 cannot be exercised.
//
// The fallbacks are what a flag-off production build always takes, so prod
// behaviour is byte-identical to pre-B1 until the flip.
//
// SELL-SIDE PRICE FLOOR: this instruction is PERMISSIONLESS. On the book sell
// path the owner's stored `max_premium` is re-read as a per-contract MINIMUM-
// PROCEEDS floor and enforced against the bid (6082/6083) — without it any
// caller could fire a stranger's stop-loss into their own dust bid.
//
// Flag-gated: require!(AMERICAN_ENABLED) is the FIRST line (6052 while dark).
// AMERICAN_ENABLED is LIVE (flipped Jun 18) so this is active the moment it
// deploys — no dark buffer.
//
// ⚠️ COMPUTE BUDGET: the BUY path (post_update_atomic + EMA re-check + vol_oracle
// + full peg set + BS-2002) is the heaviest tx in the protocol. The instruction
// can't set its own budget — CALLERS MUST prepend
// ComputeBudgetProgram.setComputeUnitLimit. Keepers request 700_000 (raised from
// 400_000 in 2A to cover a contract-tape fire under the pessimistic reading
// below).
//
// MEASURED 2026-08-18 (devnet simulation of get_option_price, which calls the
// SAME price_american helper, on live American series at ~10 DTE):
//     BTC 24,492 · JTO 38,038 · XRP 40,035 · FARTCOIN 40,786 CU
// So the American pricing kernel is ~25-41K CU, not the "~250-280K for the
// pricing kernel alone" this comment used to claim. That older figure is either
// the whole BUY path (post_update_atomic dominates it) or simply stale; it was
// never the cost of the pricing call. Both readings clear the 1.4M ceiling —
// 441K measured (68.5% margin), 680K pessimistic (51.4%) — which is why the
// contract-tape branch was allowed to ship rather than being stubbed out.
//
// Method note, because the first two attempts produced confident wrong numbers:
// synthetic strikes bail out early (6012) and measure nothing, and the enum
// filter must match the RUNTIME shape, which is PascalCase ({"American":{}}).
//
// FIRE-TIME RE-VERIFICATION (SELL): the cores TRUST their token-account params.
// Because the SELL burn source is a STORED address (possibly stale or hostile),
// execute_trigger's HANDLER re-asserts holder_option_ata.owner == owner and
// .mint == option_mint (6060) and re-reads the live balance BEFORE calling the
// core. This is the theft-vector guard — exercise_american needs none (its
// source is constraint-pinned to the signer).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_program};
use anchor_spl::token::{self, spl_token, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::OptaError;
use crate::events::{TriggerExecuted, TriggerSkipped};
use crate::feature_flags::AMERICAN_ENABLED;
use crate::instructions::exercise_american::{
    american_exercise_core, MAX_CONF_BPS, PRICE_MAX_AGE_SECS,
};
use crate::instructions::fill_vault_peg::vault_peg_fill_core;
use crate::utils::american_pricing::quote::{price_american, AmericanQuoteInputs};
use crate::instructions::fill_writer_ask::writer_ask_fill_core;
use crate::instructions::fill_order::{bid_fill_core, resale_ask_fill_core};
use crate::feature_flags::BOOK_TRIGGERS_ENABLED;
use crate::state::*;
use crate::utils::opta_price_read::opta_current_spot_usdc;
use crate::utils::price_oracle::{
    find_ed25519_ix_index, pyth_current_spot_usdc, sb_current_spot_usdc, secs_to_slots,
    SB_MIN_ORACLE_SAMPLES_FLOOR,
};
use super::initialize_protocol::TREASURY_SEED;

/// Manual conditional close: drain rent → `dest`, zero the account, hand it back
/// to the system program. The fill_order / auto_finalize_writers idiom (Anchor
/// `close =` can't be conditional — a SELL closes only on full fill).
fn close_trigger_order<'info>(
    order_info: &AccountInfo<'info>,
    dest_info: &AccountInfo<'info>,
) -> Result<()> {
    let rent_lamports = order_info.lamports();
    **dest_info.try_borrow_mut_lamports()? = dest_info
        .lamports()
        .checked_add(rent_lamports)
        .ok_or(OptaError::MathOverflow)?;
    **order_info.try_borrow_mut_lamports()? = 0;
    order_info.assign(&system_program::ID);
    order_info.resize(0)?;
    Ok(())
}

pub fn handle_execute_trigger(ctx: Context<ExecuteTrigger>) -> Result<()> {
    let clock = Clock::get()?;

    // 1. Flag gate FIRST (spec strict order). 6052 while AMERICAN_ENABLED=false.
    require!(AMERICAN_ENABLED, OptaError::AmericanVaultsDisabled);

    // 2. Fresh spot, ROUTED by market.oracle_source (Stage 3 wiring 1a-ii).
    //    This is the SINGLE match site in execute_trigger: the direct EMA feeds
    //    BOTH the comparator re-check (below) AND the SELL intrinsic (passed to
    //    american_exercise_core). The BUY peg reads the CACHED
    //    VolOracle.last_spot_price via price_american and needs NO routing here —
    //    it becomes SB-sourced automatically once 1a-iii routes push_vol_sample.
    //    Pyth arm is byte-for-byte the pre-Stage-3 read (60s / 200bps); the SB
    //    arm mirrors exercise_american's (60s → secs_to_slots → 150 slots).
    let oracle_source = ctx.accounts.market.oracle_source;
    let feed_id = ctx.accounts.market.pyth_feed_id;
    let ema = match oracle_source {
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
            // FP-ORACLE: no EMA exists on a first-party feed -- spot, like the SB arm.
            let feed = ctx
                .accounts
                .opta_price_feed
                .as_ref()
                .ok_or(error!(OptaError::OptaFeedMissing))?;
            opta_current_spot_usdc(feed, feed_id, clock.unix_timestamp, OPTA_FEED_READ_MAX_AGE_SECS)?
        }
        _ => return Err(error!(OptaError::InvalidOracleSource)),
    };

    // 3. Re-check the stored comparator against the tape THE ORDER SELECTED.
    //
    //    `ema` above is still the underlying, and is still what the SELL
    //    intrinsic uses — only the comparator input is switched here. Keeping
    //    them separate matters: a contract-tape trigger must fire on the option's
    //    own mark while still settling its payout against the underlying.
    //
    //    Contract tape is recomputed ON CHAIN through the same `price_american`
    //    the vault peg and `get_option_price` use. It is never supplied by the
    //    keeper: execute_trigger's entire security property is that it re-checks
    //    the condition itself, and a caller-asserted mark would hand the fire
    //    decision back to the caller.
    //
    //    MEASURED COST (2026-08-18, devnet simulation of get_option_price on live
    //    American series at ~10 DTE): 24,492 CU (BTC) to 40,786 CU (FARTCOIN),
    //    median 40,035. The older "~250-280K CU for the pricing kernel alone"
    //    note further up this file is either whole-BUY-path (post_update_atomic
    //    dominates) or stale — it is NOT the cost of this call. Even at that
    //    pessimistic figure the worst case is ~680K against the 1.4M ceiling.
    //    Keepers request 700K.
    //
    //    A cold or stale VolOracle reverts here (6044 warmup / 6045 stale) rather
    //    than firing on a guessed mark. For TradFi series that is the practical
    //    effect of market hours: no samples overnight, so the oracle goes stale
    //    and contract-tape triggers simply do not fire until it refreshes.
    let threshold = ctx.accounts.trigger_order.threshold_usdc;
    let tape_price = match ctx.accounts.trigger_order.tape {
        TapeSource::Underlying => ema,
        TapeSource::Contract => {
            let vault = &ctx.accounts.shared_vault;
            // Belt-and-braces: placement already rejects European contract-tape
            // orders (6086). This re-check costs nothing and means a hand-written
            // or migrated order cannot reach `price_american` on a style it
            // cannot price.
            require!(
                vault.exercise_style == ExerciseStyle::American,
                OptaError::ContractTapeRequiresAmerican
            );
            let oracle = ctx.accounts.vol_oracle.load()?;
            let quote = price_american(
                &*oracle,
                clock.unix_timestamp,
                AmericanQuoteInputs {
                    strike: vault.strike_price,
                    expiry_ts: vault.expiry,
                    option_type: vault.option_type,
                    carry_rate_bps: vault.carry_rate_bps,
                },
            )?;
            quote.premium_per_contract
        }
    };
    match ctx.accounts.trigger_order.comparator {
        Comparator::LessOrEqual => {
            require!(tape_price <= threshold, OptaError::TriggerConditionNotMet)
        }
        Comparator::GreaterOrEqual => {
            require!(tape_price >= threshold, OptaError::TriggerConditionNotMet)
        }
    }

    // 4. Dispatch on kind.
    let kind = ctx.accounts.trigger_order.kind;
    let owner = ctx.accounts.trigger_order.owner;
    let order_key = ctx.accounts.trigger_order.key();
    // Read the OCO link BEFORE dispatch: a full fill closes `trigger_order`, and
    // the sibling still has to be settled after that.
    let oco_link = ctx.accounts.trigger_order.oco_link;
    // ...and drop this side's link NOW, while the account is guaranteed open.
    //
    // Both sides must end a fire unlinked. Clearing only the peer would leave a
    // surviving partial-fill parent pointing at a sibling that no longer points
    // back, which execute_trigger reads as a mismatch (6088) and cancel_trigger
    // as a missing peer (6087) — bricking it. Clearing only this side would brick
    // the sibling the same way once this account closes. If the fire reverts, so
    // does this write.
    ctx.accounts.trigger_order.oco_link = None;
    // Set at every site that actually fires; 0 means nothing fired, so the
    // sibling must not move.
    let mut oco_fired: u64 = 0;

    match kind {
        // ---------------------------------------------------------------------
        TriggerKind::StopEntryBuy => {
          if BOOK_TRIGGERS_ENABLED && ctx.accounts.book_order.is_some() {
            // ============ BOOK PATH: lift a live writer ask ============
            // B2: expiry guard for the whole book path. The vault peg gets this
            // inside vault_peg_fill_core (fill_vault_peg.rs:182) and every direct
            // book instruction re-checks it in its own handler
            // (fill_order.rs:235 / fill_writer_ask.rs:247), but the B1 book arm
            // calls the *cores* directly and so inherited neither. Skip rather
            // than revert: expiry is a benign, permanent time condition, and a
            // revert would have the keeper re-attempting a doomed tx every tick.
            if clock.unix_timestamp >= ctx.accounts.shared_vault.expiry {
                emit!(TriggerSkipped { trigger_order: order_key, owner, reason: 3, ts: clock.unix_timestamp });
                return Ok(());
            }
            // Trigger escrow pays the ask premium (escrow-pays arm); the series is
            // minted to the owner's ATA; the writer's collateral moves escrow→pot.
            // fire_qty = min(trigger.quantity, ask depth); remainder stays armed.
            let (ask_price, ask_cpt, ask_mint, ask_vault, ask_owner, ask_remaining, ask_kind, ask_key) = {
                let o = ctx.accounts.book_order.as_ref().unwrap();
                (o.price_per_contract, o.collateral_per_contract, o.option_mint, o.vault,
                 o.owner, o.quantity_remaining, o.kind, o.key())
            };
            // Accept a WriterAsk (primary) or a ResaleAsk (secondary). The keeper
            // chooses which order to pass — a ResaleAsk only when it is better-priced
            // than the best WriterAsk yet still within max_premium (checked below).
            require!(
                ask_kind == OrderKind::WriterAsk || ask_kind == OrderKind::ResaleAsk,
                OptaError::NotAWriterAsk
            );
            require!(ask_mint == ctx.accounts.trigger_order.option_mint, OptaError::InvalidVaultMint);
            require!(ask_vault == ctx.accounts.trigger_order.vault, OptaError::InvalidVaultMint);
            require!(ask_price <= ctx.accounts.trigger_order.max_premium, OptaError::AskPriceExceedsMax);

            // Shared validation: maker pin, per-order escrow PDA, maker USDC owner.
            // The escrow seed [resting_order_escrow, order] is identical for both
            // kinds (only the token program / held asset differ).
            let book_maker_key = ctx.accounts.book_maker.as_ref().unwrap().key();
            require_keys_eq!(book_maker_key, ask_owner, OptaError::WriterWalletMismatch);
            let (exp_escrow, _) = Pubkey::find_program_address(&[RESTING_ORDER_ESCROW_SEED, ask_key.as_ref()], &crate::ID);
            require_keys_eq!(ctx.accounts.book_escrow.as_ref().unwrap().key(), exp_escrow, OptaError::InvalidVaultMint);
            require!(ctx.accounts.book_maker_usdc.as_ref().unwrap().owner == ask_owner, OptaError::WriterWalletMismatch);

            let want = ctx.accounts.trigger_order.quantity;
            let fire_qty = want.min(ask_remaining);
            if fire_qty == 0 {
                // Benign: no depth on the passed ask. Stay armed, no revert.
                emit!(TriggerSkipped { trigger_order: order_key, owner, reason: 1, ts: clock.unix_timestamp });
                return Ok(());
            }

            let protocol_bump = ctx.accounts.protocol_state.bump;
            let fee_bps = ctx.accounts.protocol_state.fee_bps;
            let trigger_escrow_ai = ctx.accounts.trigger_escrow.to_account_info();
            let protocol_ai = ctx.accounts.protocol_state.to_account_info();
            let treasury_ai = ctx.accounts.treasury.to_account_info();
            let option_mint_ai = ctx.accounts.option_mint.to_account_info();
            let holder_ata_ai = ctx.accounts.holder_option_ata.to_account_info();
            let tok_ai = ctx.accounts.token_program.to_account_info();
            let tok22_ai = ctx.accounts.token_2022_program.to_account_info();
            let book_escrow_ai = ctx.accounts.book_escrow.as_ref().unwrap().to_account_info();
            let book_maker_usdc_ai = ctx.accounts.book_maker_usdc.as_ref().unwrap().to_account_info();

            // Fill — escrow-pays (usdc_source = trigger_escrow, Some(protocol_bump)).
            // Returns the gross premium (fire_qty × ask_price) charged to the escrow,
            // used below for the TriggerExecuted event.
            let fill_total: u64 = match ask_kind {
                OrderKind::WriterAsk => {
                    // WriterAsk-only pot/position PDAs ([25]-[27]).
                    let (exp_pot, _) = Pubkey::find_program_address(&[WRITER_ASK_POT_SEED, ask_mint.as_ref()], &crate::ID);
                    require_keys_eq!(ctx.accounts.writer_ask_pot.as_ref().unwrap().key(), exp_pot, OptaError::InvalidVaultMint);
                    let (exp_pot_usdc, _) = Pubkey::find_program_address(&[WRITER_ASK_POT_USDC_SEED, ask_mint.as_ref()], &crate::ID);
                    require_keys_eq!(ctx.accounts.writer_ask_pot_usdc.as_ref().unwrap().key(), exp_pot_usdc, OptaError::InvalidVaultMint);
                    let (exp_pos, _) = Pubkey::find_program_address(&[WRITER_ASK_POSITION_SEED, ask_mint.as_ref(), ask_owner.as_ref()], &crate::ID);
                    require_keys_eq!(ctx.accounts.writer_ask_position.as_ref().unwrap().key(), exp_pos, OptaError::InvalidVaultMint);

                    let pot_usdc_ai = ctx.accounts.writer_ask_pot_usdc.as_ref().unwrap().to_account_info();
                    let pot_usdc_key = ctx.accounts.writer_ask_pot_usdc.as_ref().unwrap().key();
                    let pot_bump = ctx.accounts.writer_ask_pot.as_ref().unwrap().bump;
                    let position_bump = ctx.accounts.writer_ask_position.as_ref().unwrap().bump;

                    let fill = writer_ask_fill_core(
                        ask_price, ask_cpt, fire_qty, fee_bps, protocol_bump,
                        &trigger_escrow_ai, &protocol_ai, Some(protocol_bump),
                        &book_maker_usdc_ai, &treasury_ai,
                        &option_mint_ai, &holder_ata_ai, &protocol_ai,
                        &book_escrow_ai, &pot_usdc_ai,
                        ctx.accounts.writer_ask_pot.as_mut().unwrap(),
                        ctx.accounts.writer_ask_position.as_mut().unwrap(),
                        ask_mint, ask_vault, ask_owner, pot_usdc_key, pot_bump, position_bump, clock.unix_timestamp,
                        &tok_ai, &tok22_ai,
                    )?;
                    fill.total
                }
                OrderKind::ResaleAsk => {
                    // ResaleAsk-only hook accounts ([28]-[30]); the option-token leg
                    // is a Token-2022 transfer_checked that dispatches the hook.
                    require_keys_eq!(
                        ctx.accounts.book_hook_program.as_ref().unwrap().key(),
                        opta_transfer_hook::ID,
                        OptaError::InvalidVaultMint
                    );
                    let metas_ai = ctx.accounts.book_hook_metas.as_ref().unwrap().to_account_info();
                    let prog_ai = ctx.accounts.book_hook_program.as_ref().unwrap().to_account_info();
                    let state_ai = ctx.accounts.book_hook_state.as_ref().unwrap().to_account_info();

                    // Fee split (mirrors fill_order.rs:242-255 exactly).
                    let total: u64 = (fire_qty as u128)
                        .checked_mul(ask_price as u128)
                        .ok_or(OptaError::MathOverflow)?
                        .try_into()
                        .map_err(|_| OptaError::MathOverflow)?;
                    let fee: u64 = (total as u128)
                        .checked_mul(fee_bps as u128)
                        .ok_or(OptaError::MathOverflow)?
                        .checked_div(10_000)
                        .ok_or(OptaError::MathOverflow)?
                        .try_into()
                        .map_err(|_| OptaError::MathOverflow)?;
                    let counterparty_share = total.checked_sub(fee).ok_or(OptaError::MathOverflow)?;

                    resale_ask_fill_core(
                        &trigger_escrow_ai, &protocol_ai, Some(protocol_bump),
                        &book_maker_usdc_ai, &treasury_ai,
                        &book_escrow_ai, &option_mint_ai, &holder_ata_ai,
                        &metas_ai, &prog_ai, &state_ai,
                        &protocol_ai, protocol_bump,
                        &tok_ai, &tok22_ai,
                        fire_qty, counterparty_share, fee,
                    )?;
                    total
                }
                // Rejected by the require! above; kept exhaustive for the compiler.
                _ => return err!(OptaError::NotAWriterAsk),
            };

            let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol_bump]];
            let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

            // Ask order bookkeeping (mirror fill_writer_ask step 9).
            let ask_closed = {
                let o = ctx.accounts.book_order.as_mut().unwrap();
                o.quantity_remaining = o.quantity_remaining.checked_sub(fire_qty).ok_or(OptaError::MathOverflow)?;
                o.quantity_remaining == 0
            };
            if ask_closed {
                {
                    let data = ctx.accounts.book_escrow.as_ref().unwrap().try_borrow_data()?;
                    require!(data.len() >= 72, OptaError::MathOverflow);
                    let bal = u64::from_le_bytes(data[64..72].try_into().map_err(|_| OptaError::MathOverflow)?);
                    require!(bal == 0, OptaError::EscrowNotEmpty);
                }
                // Close the emptied escrow; rent → maker. The token program is
                // kind-specific: a WriterAsk escrow is a classic-SPL USDC account,
                // a ResaleAsk escrow is a Token-2022 option-token account.
                let (close_prog_key, close_prog_ai) = match ask_kind {
                    OrderKind::WriterAsk => (
                        ctx.accounts.token_program.key(),
                        ctx.accounts.token_program.to_account_info(),
                    ),
                    _ => (
                        ctx.accounts.token_2022_program.key(),
                        ctx.accounts.token_2022_program.to_account_info(),
                    ),
                };
                let close_ix = if ask_kind == OrderKind::WriterAsk {
                    spl_token::instruction::close_account(
                        &close_prog_key,
                        ctx.accounts.book_escrow.as_ref().unwrap().key,
                        &book_maker_key,
                        &ctx.accounts.protocol_state.key(),
                        &[],
                    )?
                } else {
                    spl_token_2022::instruction::close_account(
                        &close_prog_key,
                        ctx.accounts.book_escrow.as_ref().unwrap().key,
                        &book_maker_key,
                        &ctx.accounts.protocol_state.key(),
                        &[],
                    )?
                };
                invoke_signed(
                    &close_ix,
                    &[
                        ctx.accounts.book_escrow.as_ref().unwrap().to_account_info(),
                        ctx.accounts.book_maker.as_ref().unwrap().to_account_info(),
                        ctx.accounts.protocol_state.to_account_info(),
                        close_prog_ai,
                    ],
                    protocol_signer,
                )?;
                let order_info = ctx.accounts.book_order.as_ref().unwrap().to_account_info();
                let maker_info = ctx.accounts.book_maker.as_ref().unwrap().to_account_info();
                let rent = order_info.lamports();
                **maker_info.try_borrow_mut_lamports()? = maker_info.lamports().checked_add(rent).ok_or(OptaError::MathOverflow)?;
                **order_info.try_borrow_mut_lamports()? = 0;
                order_info.assign(&system_program::ID);
                order_info.resize(0)?;
            }

            // Trigger bookkeeping: decrement; on full fill refund remaining escrow + close.
            let remaining = {
                let t = &mut ctx.accounts.trigger_order;
                t.quantity = t.quantity.checked_sub(fire_qty).ok_or(OptaError::MathOverflow)?;
                t.quantity
            };
            if remaining == 0 {
                let esc_bal = {
                    let data = ctx.accounts.trigger_escrow.try_borrow_data()?;
                    require!(data.len() >= 72, OptaError::MathOverflow);
                    u64::from_le_bytes(data[64..72].try_into().map_err(|_| OptaError::MathOverflow)?)
                };
                if esc_bal > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: ctx.accounts.trigger_escrow.to_account_info(),
                                to: ctx.accounts.owner_usdc_account.to_account_info(),
                                authority: ctx.accounts.protocol_state.to_account_info(),
                            },
                            protocol_signer,
                        ),
                        esc_bal,
                    )?;
                }
                invoke_signed(
                    &spl_token::instruction::close_account(
                        &ctx.accounts.token_program.key(),
                        ctx.accounts.trigger_escrow.key,
                        ctx.accounts.owner_wallet.key,
                        &ctx.accounts.protocol_state.key(),
                        &[],
                    )?,
                    &[
                        ctx.accounts.trigger_escrow.to_account_info(),
                        ctx.accounts.owner_wallet.to_account_info(),
                        ctx.accounts.protocol_state.to_account_info(),
                    ],
                    protocol_signer,
                )?;
                close_trigger_order(
                    &ctx.accounts.trigger_order.to_account_info(),
                    &ctx.accounts.owner_wallet.to_account_info(),
                )?;
            }

            oco_fired = fire_qty;
            emit!(TriggerExecuted {
                trigger_order: order_key,
                owner,
                kind: kind.as_u8(),
                fire_quantity: fire_qty,
                ema_used: ema,
                premium_or_payout: fill_total,
                remaining_quantity: remaining,
                ts: clock.unix_timestamp,
            });
          } else {
            // ============ VAULT PEG PATH (flag-off / no book accounts) — UNCHANGED ============
            let quantity = ctx.accounts.trigger_order.quantity;
            let max_premium_pc = ctx.accounts.trigger_order.max_premium;
            // The SAME product P0 escrowed → the peg's fee-inclusive TOTAL ceiling.
            let peg_total_ceiling = max_premium_pc
                .checked_mul(quantity)
                .ok_or(OptaError::MathOverflow)?;

            // Escrow balance BEFORE the fill (for refund math). Authority is
            // protocol_state (P0 set the escrow owner) — the None-branch debit
            // below signs as protocol_state, so the SPL transfer's authority
            // check enforces that invariant at runtime.
            let escrow_balance = {
                let data = ctx.accounts.trigger_escrow.try_borrow_data()?;
                require!(data.len() >= 72, OptaError::MathOverflow);
                u64::from_le_bytes(
                    data[64..72]
                        .try_into()
                        .map_err(|_| OptaError::MathOverflow)?,
                )
            };

            // Peg fill: protocol PDA signs the escrow debit (usdc_external_signer
            // = None) + mints to the owner's pre-created ATA.
            let result = vault_peg_fill_core(
                &mut ctx.accounts.shared_vault,
                &mut ctx.accounts.vault_mint_record,
                &mut ctx.accounts.protocol_state,
                &ctx.accounts.vol_oracle,
                &ctx.accounts.option_mint.to_account_info(),
                &ctx.accounts.holder_option_ata.to_account_info(),
                &ctx.accounts.trigger_escrow.to_account_info(),
                None, // protocol PDA signs the escrow debit
                &ctx.accounts.vault_usdc_account.to_account_info(),
                &ctx.accounts.treasury.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                &ctx.accounts.token_2022_program.to_account_info(),
                owner,
                quantity,
                peg_total_ceiling,
                clock.unix_timestamp,
            )?;

            // Refund unspent escrow → owner (protocol PDA signs), then close it.
            let protocol_bump = ctx.accounts.protocol_state.bump;
            let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol_bump]];
            let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

            let refund = escrow_balance
                .checked_sub(result.total)
                .ok_or(OptaError::MathOverflow)?;
            if refund > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.trigger_escrow.to_account_info(),
                            to: ctx.accounts.owner_usdc_account.to_account_info(),
                            authority: ctx.accounts.protocol_state.to_account_info(),
                        },
                        protocol_signer,
                    ),
                    refund,
                )?;
            }
            // Close the now-empty escrow token account → rent to owner_wallet.
            invoke_signed(
                &spl_token::instruction::close_account(
                    &ctx.accounts.token_program.key(),
                    ctx.accounts.trigger_escrow.key,
                    ctx.accounts.owner_wallet.key,
                    &ctx.accounts.protocol_state.key(),
                    &[],
                )?,
                &[
                    ctx.accounts.trigger_escrow.to_account_info(),
                    ctx.accounts.owner_wallet.to_account_info(),
                    ctx.accounts.protocol_state.to_account_info(),
                ],
                protocol_signer,
            )?;

            // A buy fires once → close the TriggerOrder (rent → owner_wallet).
            close_trigger_order(
                &ctx.accounts.trigger_order.to_account_info(),
                &ctx.accounts.owner_wallet.to_account_info(),
            )?;

            oco_fired = quantity; // peg full-fill path fires the whole order
            emit!(TriggerExecuted {
                trigger_order: order_key,
                owner,
                kind: kind.as_u8(),
                fire_quantity: quantity,
                ema_used: ema,
                premium_or_payout: result.total,
                remaining_quantity: 0,
                ts: clock.unix_timestamp,
            });
          }
        }
        // ---------------------------------------------------------------------
        // B2: the two sell kinds share one arm. They differ ONLY in their
        // fallback when no book accounts are passed: a TakeProfitSell drops to
        // the vault exercise path (its long is ITM by construction), while a
        // StopLossSell has no vault path at all (an OTM long cannot be exercised)
        // and simply stays armed until a bid shows up.
        TriggerKind::TakeProfitSell | TriggerKind::StopLossSell => {
            // FIRE-TIME RE-VERIFICATION against the STORED holder_option_ata.
            // The context already pins its address to trigger_order.holder_option_ata;
            // here we re-read its CURRENT owner/mint/balance (the address could be
            // re-init'd or the balance moved since placement).
            let (ata_owner, ata_mint, balance) = {
                let data = ctx.accounts.holder_option_ata.try_borrow_data()?;
                require!(data.len() >= 72, OptaError::TriggerSourceAtaInvalid);
                let mint_bytes: [u8; 32] = data[0..32]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?;
                let owner_bytes: [u8; 32] = data[32..64]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?;
                let amount_bytes: [u8; 8] = data[64..72]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?;
                (
                    Pubkey::new_from_array(owner_bytes),
                    Pubkey::new_from_array(mint_bytes),
                    u64::from_le_bytes(amount_bytes),
                )
            };
            require!(ata_owner == owner, OptaError::TriggerSourceAtaInvalid);
            require!(
                ata_mint == ctx.accounts.trigger_order.option_mint,
                OptaError::TriggerSourceAtaInvalid
            );

          if BOOK_TRIGGERS_ENABLED && ctx.accounts.book_order.is_some() {
            // ============ BOOK PATH: hit a live bid (B2) ============
            // The owner's long is delegate-pulled straight into the bidder's ATA
            // and the bid's PRE-FUNDED USDC escrow pays the owner (minus fee →
            // treasury). Nothing is minted and nothing is burned — a sell into the
            // book is a pure change of holder, which is why it works for an OTM
            // long that `american_exercise_core` would reject outright.
            let (bid_price, bid_mint, bid_vault, bid_owner, bid_remaining, bid_kind, bid_key) = {
                let o = ctx.accounts.book_order.as_ref().unwrap();
                (o.price_per_contract, o.option_mint, o.vault, o.owner,
                 o.quantity_remaining, o.kind, o.key())
            };
            // A sell can only be crossed by the BID side; an ask in this slot is a
            // keeper bug, so fail closed rather than skip.
            require!(bid_kind == OrderKind::Bid, OptaError::NotABid);
            require!(bid_mint == ctx.accounts.trigger_order.option_mint, OptaError::InvalidVaultMint);
            require!(bid_vault == ctx.accounts.trigger_order.vault, OptaError::InvalidVaultMint);

            // ---- The owner's price constraint (the mirror of B1's 6080) ------
            // `max_premium` on a SELL is the per-contract MINIMUM-PROCEEDS FLOOR.
            // execute_trigger is PERMISSIONLESS: without this bound, anyone could
            // post a 1-unit bid, fire a stranger's stop-loss into it and take the
            // contract for a rounding error. REVERT, not skip — the keeper chose
            // this bid, so below-floor is error or attack, never a market state.
            let floor = ctx.accounts.trigger_order.max_premium;
            require!(floor > 0, OptaError::SellFloorRequired);
            require!(bid_price >= floor, OptaError::BidPriceBelowMin);

            // Expiry: SKIP (see the StopEntryBuy arm's note). Must precede every
            // token leg — the series transfer hook also blocks post-expiry moves,
            // and a revert there would be an opaque hook failure instead of a
            // legible skip.
            if clock.unix_timestamp >= ctx.accounts.shared_vault.expiry {
                emit!(TriggerSkipped { trigger_order: order_key, owner, reason: 3, ts: clock.unix_timestamp });
                return Ok(());
            }

            // Maker pin + per-order escrow PDA. The escrow seed
            // [resting_order_escrow, order] is kind-agnostic; only the held asset
            // differs, and a Bid escrow is ALWAYS classic-SPL USDC.
            let bid_maker_key = ctx.accounts.book_maker.as_ref().unwrap().key();
            require_keys_eq!(bid_maker_key, bid_owner, OptaError::WriterWalletMismatch);
            let (exp_escrow, _) = Pubkey::find_program_address(&[RESTING_ORDER_ESCROW_SEED, bid_key.as_ref()], &crate::ID);
            require_keys_eq!(ctx.accounts.book_escrow.as_ref().unwrap().key(), exp_escrow, OptaError::InvalidVaultMint);

            // C-1 (Run-8) destination pin, applied to the trigger path. Token-2022
            // transfer_checked validates the destination's mint/decimals but NOT
            // its ownership — an unpinned [31] would let a keeper route the
            // owner's contracts into their OWN account while still draining the
            // bidder's escrow to the owner. Same raw-layout read as
            // fill_order.rs:299-316.
            {
                let dest = ctx.accounts.book_maker_option.as_ref().unwrap();
                let data = dest.try_borrow_data()?;
                require!(data.len() >= 72, OptaError::MakerOptionAccountInvalid);
                let mint_bytes: [u8; 32] = data[0..32].try_into().map_err(|_| OptaError::MakerOptionAccountInvalid)?;
                let owner_bytes: [u8; 32] = data[32..64].try_into().map_err(|_| OptaError::MakerOptionAccountInvalid)?;
                require!(Pubkey::new_from_array(mint_bytes) == bid_mint, OptaError::MakerOptionAccountInvalid);
                require!(Pubkey::new_from_array(owner_bytes) == bid_owner, OptaError::MakerOptionAccountInvalid);
            }
            // Hook program pin ([29]) — the option leg dispatches the series hook.
            require_keys_eq!(
                ctx.accounts.book_hook_program.as_ref().unwrap().key(),
                opta_transfer_hook::ID,
                OptaError::InvalidVaultMint
            );

            // Bounded by BOTH sides AND the owner's live balance.
            let want = ctx.accounts.trigger_order.quantity;
            let fire_qty = want.min(bid_remaining).min(balance);
            if fire_qty == 0 {
                // Benign: no crossable depth, or the holder moved their tokens
                // out. Stay armed, no revert.
                emit!(TriggerSkipped { trigger_order: order_key, owner, reason: 1, ts: clock.unix_timestamp });
                return Ok(());
            }

            // Fee split — identical to fill_order.rs:242-255.
            let fee_bps = ctx.accounts.protocol_state.fee_bps;
            let total: u64 = (fire_qty as u128)
                .checked_mul(bid_price as u128)
                .ok_or(OptaError::MathOverflow)?
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?;
            let fee: u64 = (total as u128)
                .checked_mul(fee_bps as u128)
                .ok_or(OptaError::MathOverflow)?
                .checked_div(10_000)
                .ok_or(OptaError::MathOverflow)?
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?;
            let counterparty_share = total.checked_sub(fee).ok_or(OptaError::MathOverflow)?;

            let protocol_bump = ctx.accounts.protocol_state.bump;
            let protocol_ai = ctx.accounts.protocol_state.to_account_info();
            let option_mint_ai = ctx.accounts.option_mint.to_account_info();
            let holder_ata_ai = ctx.accounts.holder_option_ata.to_account_info();
            let maker_option_ai = ctx.accounts.book_maker_option.as_ref().unwrap().to_account_info();
            let metas_ai = ctx.accounts.book_hook_metas.as_ref().unwrap().to_account_info();
            let hook_prog_ai = ctx.accounts.book_hook_program.as_ref().unwrap().to_account_info();
            let hook_state_ai = ctx.accounts.book_hook_state.as_ref().unwrap().to_account_info();
            let bid_escrow_ai = ctx.accounts.book_escrow.as_ref().unwrap().to_account_info();
            let owner_usdc_ai = ctx.accounts.owner_usdc_account.to_account_info();
            let treasury_ai = ctx.accounts.treasury.to_account_info();
            let tok_ai = ctx.accounts.token_program.to_account_info();
            let tok22_ai = ctx.accounts.token_2022_program.to_account_info();

            // Delegate-pull arm: option_delegate_bump = Some(protocol_bump), so the
            // protocol PermanentDelegate signs the option leg (the keeper fires,
            // not the owner). usdc_recipient is the TRIGGER OWNER, pinned at the
            // struct level to trigger_order.owner + the USDC mint.
            bid_fill_core(
                &holder_ata_ai, &option_mint_ai, &maker_option_ai,
                &protocol_ai, Some(protocol_bump),
                &metas_ai, &hook_prog_ai, &hook_state_ai,
                &bid_escrow_ai, &owner_usdc_ai, &treasury_ai,
                &protocol_ai, protocol_bump,
                &tok_ai, &tok22_ai,
                fire_qty, counterparty_share, fee,
            )?;

            let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol_bump]];
            let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

            // Bid bookkeeping (mirrors fill_order step 4).
            let bid_closed = {
                let o = ctx.accounts.book_order.as_mut().unwrap();
                o.quantity_remaining = o.quantity_remaining.checked_sub(fire_qty).ok_or(OptaError::MathOverflow)?;
                o.quantity_remaining == 0
            };
            if bid_closed {
                // Funded price×quantity at post time and debited exactly
                // price×fill per fill ⇒ exhaustion means empty. Assert it, so a
                // residue is a loud revert rather than a silent burn on close.
                {
                    let data = ctx.accounts.book_escrow.as_ref().unwrap().try_borrow_data()?;
                    require!(data.len() >= 72, OptaError::MathOverflow);
                    let bal = u64::from_le_bytes(data[64..72].try_into().map_err(|_| OptaError::MathOverflow)?);
                    require!(bal == 0, OptaError::EscrowNotEmpty);
                }
                invoke_signed(
                    &spl_token::instruction::close_account(
                        &ctx.accounts.token_program.key(),
                        ctx.accounts.book_escrow.as_ref().unwrap().key,
                        &bid_maker_key,
                        &ctx.accounts.protocol_state.key(),
                        &[],
                    )?,
                    &[
                        ctx.accounts.book_escrow.as_ref().unwrap().to_account_info(),
                        ctx.accounts.book_maker.as_ref().unwrap().to_account_info(),
                        ctx.accounts.protocol_state.to_account_info(),
                        ctx.accounts.token_program.to_account_info(),
                    ],
                    protocol_signer,
                )?;
                let order_info = ctx.accounts.book_order.as_ref().unwrap().to_account_info();
                let maker_info = ctx.accounts.book_maker.as_ref().unwrap().to_account_info();
                let rent = order_info.lamports();
                **maker_info.try_borrow_mut_lamports()? = maker_info.lamports().checked_add(rent).ok_or(OptaError::MathOverflow)?;
                **order_info.try_borrow_mut_lamports()? = 0;
                order_info.assign(&system_program::ID);
                order_info.resize(0)?;
            }

            // Trigger bookkeeping: decrement, close on exhaustion. A SELL escrows
            // NOTHING, so — unlike the buy arms — there is no trigger_escrow to
            // refund or close; that account stays the derived, uninitialized
            // address it has always been on this path.
            let remaining = {
                let t = &mut ctx.accounts.trigger_order;
                t.quantity = t.quantity.checked_sub(fire_qty).ok_or(OptaError::MathOverflow)?;
                t.quantity
            };
            if remaining == 0 {
                close_trigger_order(
                    &ctx.accounts.trigger_order.to_account_info(),
                    &ctx.accounts.owner_wallet.to_account_info(),
                )?;
            }

            oco_fired = fire_qty;
            emit!(TriggerExecuted {
                trigger_order: order_key,
                owner,
                kind: kind.as_u8(),
                fire_quantity: fire_qty,
                ema_used: ema,
                // Sell arms report OWNER PROCEEDS (net of fee), matching the vault
                // exercise arm's `payout`; the buy arms report gross premium paid.
                premium_or_payout: counterparty_share,
                remaining_quantity: remaining,
                ts: clock.unix_timestamp,
            });
          } else if kind == TriggerKind::StopLossSell {
            // No book accounts were passed and a StopLossSell has NO vault path —
            // an OTM long cannot be exercised. Two outcomes, by build:
            //   flag ON  → SKIP-UNTIL-BID. The bid side is empty by design today,
            //              so "nothing to cross" is the normal steady state, not a
            //              failure: stay armed, emit a quiet TriggerSkipped and let
            //              the keeper re-offer the trigger next tick.
            //   flag OFF → the unchanged B0 revert, so the feature-free production
            //              build behaves byte-for-byte as it does today (6079).
            if BOOK_TRIGGERS_ENABLED {
                emit!(TriggerSkipped {
                    trigger_order: order_key,
                    owner,
                    reason: 2, // 2 = no crossing bid offered
                    ts: clock.unix_timestamp,
                });
                return Ok(());
            }
            return err!(OptaError::StopLossSellDark);
          } else {
            // ============ VAULT EXERCISE PATH (TakeProfitSell) — UNCHANGED ============
            let want = ctx.accounts.trigger_order.quantity;
            let fire_qty = want.min(balance);

            // Benign no-op: the holder moved everything out. Keeper logs + skips;
            // the trigger STAYS OPEN (no revert, no close, no decrement).
            if fire_qty == 0 {
                emit!(TriggerSkipped {
                    trigger_order: order_key,
                    owner,
                    reason: 0, // 0 = zero source balance
                    ts: clock.unix_timestamp,
                });
                return Ok(());
            }

            // Exercise via the shared core: delegate burn (protocol_state is the
            // PermanentDelegate → pda_bump = Some), payout to the owner. The core
            // enforces intrinsic > 0 (OTM → OptionNotInTheMoney), which is exactly
            // why a StopLossSell can never reach this branch — it sells an OTM
            // long, and only the book bid side can absorb that.
            let protocol_bump = ctx.accounts.protocol_state.bump;
            let payout = american_exercise_core(
                &mut ctx.accounts.shared_vault,
                &ctx.accounts.option_mint.to_account_info(),
                &ctx.accounts.holder_option_ata.to_account_info(),
                &ctx.accounts.protocol_state.to_account_info(),
                Some(protocol_bump), // delegate signs (invoke_signed [PROTOCOL_SEED, bump])
                &ctx.accounts.vault_usdc_account.to_account_info(),
                &ctx.accounts.owner_usdc_account.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                &ctx.accounts.token_2022_program.to_account_info(),
                owner,
                fire_qty,
                ema, // SAME EMA the comparator fired on
                // No pot leg. A trigger fires against pooled vault collateral;
                // this instruction carries no pot accounts, so a writer-ask-only
                // series reverts EarlyExercisePotRequired rather than paying out
                // of an account it never validated.
                None,
            )?;

            // PARTIAL-FIRE: decrement remaining; close only when fully filled.
            let remaining = {
                let order = &mut ctx.accounts.trigger_order;
                order.quantity = order
                    .quantity
                    .checked_sub(fire_qty)
                    .ok_or(OptaError::MathOverflow)?;
                order.quantity
            };
            if remaining == 0 {
                close_trigger_order(
                    &ctx.accounts.trigger_order.to_account_info(),
                    &ctx.accounts.owner_wallet.to_account_info(),
                )?;
            }

            oco_fired = fire_qty;
            emit!(TriggerExecuted {
                trigger_order: order_key,
                owner,
                kind: kind.as_u8(),
                fire_quantity: fire_qty,
                ema_used: ema,
                premium_or_payout: payout,
                remaining_quantity: remaining,
                ts: clock.unix_timestamp,
            });
          }
        }
    }

    // ---- B3: OCO — the sibling leg moves in the SAME transaction ----------
    //
    // Keeper-enforced OCO was rejected outright: two ticks, or one tick
    // evaluating both legs against the same tape, can fire both and hand the
    // owner a double exit on a funds path. The only way a single atomic fire
    // cannot gap through both legs is to move the sibling here.
    //
    // The link must be MUTUAL and same-owner. Without the back-link check a
    // caller could point `oco_peer` at any stranger's trigger and decrement it.
    if oco_fired > 0 {
        if let Some(link) = oco_link {
            let peer = ctx
                .accounts
                .oco_peer
                .as_mut()
                .ok_or(error!(OptaError::OcoPeerRequired))?;
            require_keys_eq!(peer.key(), link, OptaError::OcoPeerMismatch);
            require!(
                peer.oco_link == Some(order_key),
                OptaError::OcoPeerMismatch
            );
            require_keys_eq!(peer.owner, owner, OptaError::OcoPeerMismatch);
            // saturating: a fire larger than the sibling's remaining size zeroes
            // it rather than wrapping. A zero-quantity trigger cannot fire.
            peer.quantity = peer.quantity.saturating_sub(oco_fired);
            // The pairing has done its job. Leaving the sibling linked to an
            // account this transaction may have just closed is what made the
            // survivor uncancellable (6087) in the first behavioural run.
            peer.oco_link = None;
        }
    }

    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteTrigger<'info> {
    /// Permissionless keeper — pays the tx fee. NOT the trigger owner.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// The trigger being executed. Self-referential seeds (owner+mint+nonce are
    /// stored fields) so the keeper — not the owner — can derive it. Conditionally
    /// closed in-handler (BUY always; SELL only when fully filled).
    #[account(
        mut,
        seeds = [
            TRIGGER_ORDER_SEED,
            trigger_order.owner.as_ref(),
            trigger_order.option_mint.as_ref(),
            &trigger_order.nonce.to_le_bytes(),
        ],
        bump = trigger_order.bump,
    )]
    pub trigger_order: Box<Account<'info, TriggerOrder>>,

    /// Market — pinned to vault + trigger; provides pyth_feed_id for the EMA
    /// re-check + the vol_oracle seed.
    #[account(
        constraint = market.key() == shared_vault.market,
        constraint = market.key() == trigger_order.market,
    )]
    pub market: Account<'info, OptionsMarket>,

    /// The vault — peg-fill source (BUY) / exercise-payout source (SELL).
    #[account(
        mut,
        constraint = shared_vault.key() == trigger_order.vault,
    )]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Series/VaultMint record — the peg core bumps its supply counters (BUY);
    /// validated but untouched on SELL.
    #[account(
        mut,
        constraint = vault_mint_record.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == trigger_order.option_mint @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Box<Account<'info, VaultMint>>,

    /// The series option mint — peg mint_to target (BUY) / burn target (SELL).
    /// CHECK: pinned to trigger_order.option_mint; Token-2022 CPIs validate.
    #[account(
        mut,
        constraint = option_mint.key() == trigger_order.option_mint @ OptaError::InvalidVaultMint,
    )]
    pub option_mint: UncheckedAccount<'info>,

    /// Fresh PriceUpdateV2 the keeper posts in-tx. The live-EMA source for the
    /// comparator re-check (BUY+SELL) AND the intrinsic spot (SELL).
    ///
    /// Stage 3 (1a-ii): now `Option`, position unchanged. REQUIRED (present) for
    /// a Pyth market — a present price_update is wire-identical to before. A
    /// Switchboard market passes None (sentinel) and uses the trailing SB
    /// accounts. The Pyth arm errors `PriceUpdateMissing` if absent on a Pyth market.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

    /// VolOracle for the market's feed — the BUY peg's BS-2002 input. Validated
    /// on SELL but unused.
    #[account(
        seeds = [VOL_ORACLE_SEED, market.pyth_feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,

    /// Protocol state — fee_bps + total_volume + mint authority (BUY), escrow
    /// authority (BUY refund/debit + close), and the PermanentDelegate burn
    /// authority (SELL).
    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Treasury — BUY fee destination. Validated but unused on SELL.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Per-trigger USDC escrow (BUY): peg USDC source + unspent refund + close.
    /// SELL: the derived (uninitialized) address, never touched.
    /// CHECK: PDA seeds validate the address; classic USDC layout (BUY).
    #[account(
        mut,
        seeds = [TRIGGER_ESCROW_SEED, trigger_order.key().as_ref()],
        bump,
    )]
    pub trigger_escrow: UncheckedAccount<'info>,

    /// The owner's option ATA stored at placement.
    ///   BUY : peg mint destination (pre-created in P0).
    ///   SELL: the delegate-burn source (re-verified in-handler).
    /// CHECK: pinned to trigger_order.holder_option_ata; CPIs / raw reads validate.
    #[account(
        mut,
        constraint = holder_option_ata.key() == trigger_order.holder_option_ata @ OptaError::TriggerSourceAtaInvalid,
    )]
    pub holder_option_ata: UncheckedAccount<'info>,

    /// Owner's USDC account — BUY: unspent-escrow refund dest; SELL: payout dest.
    /// Pinned to the trigger owner + USDC mint so a keeper can't redirect proceeds.
    #[account(
        mut,
        constraint = owner_usdc_account.owner == trigger_order.owner,
        constraint = owner_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub owner_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Owner's wallet — rent destination on close (escrow + trigger_order).
    /// CHECK: pinned to trigger_order.owner; receives lamports only.
    #[account(
        mut,
        constraint = owner_wallet.key() == trigger_order.owner,
    )]
    pub owner_wallet: UncheckedAccount<'info>,

    /// Vault's USDC account — BUY vault_share destination / SELL payout source.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,

    // --- Switchboard read-arm accounts (Stage 3 1a-ii). TRAILING optionals: a
    // Pyth trigger omits all three (allow-missing-optionals → None), keeping its
    // tx byte-identical. Required only when market.oracle_source == Switchboard;
    // the handler unwraps + runtime-address-checks the two sysvars in the SB arm.
    // Appended AFTER system_program; no existing account moved. ---
    /// CHECK: Switchboard oracle queue; validated by QuoteVerifier (oracle-key
    /// set) in the SB arm. Not address-pinned (per-network queue).
    pub sb_queue: Option<UncheckedAccount<'info>>,

    /// CHECK: SlotHashes sysvar; address-checked == sysvar::slot_hashes::ID at
    /// runtime in the SB arm.
    pub sb_slothashes: Option<UncheckedAccount<'info>>,

    /// CHECK: Instructions sysvar; address-checked == sysvar::instructions::ID at
    /// runtime in the SB arm, then scanned for the ed25519 ix index.
    pub sb_instructions: Option<UncheckedAccount<'info>>,

    // --- Book-fire accounts (B1 buy side [21]-[30], B2 sell side adds [31]).
    // TRAILING optionals AFTER the three SB optionals; ALL None on the vault-peg
    // path, the vault-exercise path, and every flag-off fire (byte-identical).
    // Present only for a BOOK_TRIGGERS_ENABLED fire that crosses the live board.
    //
    // THREE fire shapes share these slots. Read the table by column — a slot is
    // populated only where its column says so:
    //
    //   slot                     WriterAsk buy   ResaleAsk buy   Bid sell
    //   ---------------------------------------------------------------------
    //   [21] book_order              ✔               ✔             ✔
    //   [22] book_maker              ✔               ✔             ✔
    //   [23] book_escrow             ✔               ✔             ✔
    //   [24] book_maker_usdc         ✔               ✔             ·
    //   [25] writer_ask_pot          ✔               ·             ·
    //   [26] writer_ask_pot_usdc     ✔               ·             ·
    //   [27] writer_ask_position     ✔               ·             ·
    //   [28] book_hook_metas         ·               ✔             ✔
    //   [29] book_hook_program       ·               ✔             ✔
    //   [30] book_hook_state         ·               ✔             ✔
    //   [31] book_maker_option       ·               ·             ✔
    //
    // ROLE OF EACH SLOT (identical across shapes — this is why they are reused):
    //   [21] the RestingOrder being crossed (WriterAsk / ResaleAsk / Bid)
    //   [22] that order's maker wallet = book_order.owner; rent dest on close
    //   [23] its per-order escrow, PDA [resting_order_escrow, book_order]. The
    //        seed is kind-agnostic; only the held asset differs — WriterAsk:
    //        classic-SPL USDC collateral, ResaleAsk: Token-2022 option tokens,
    //        Bid: classic-SPL USDC.
    //   [24] the maker's classic USDC — the PREMIUM RECIPIENT. A buy pays the
    //        maker, so it is required there. A sell pays the TRIGGER OWNER out of
    //        [23], and owner_usdc_account (base slot 12) is that destination —
    //        the maker has no USDC leg at all, hence None.
    //   [25]-[27] WriterAsk-only pot/position bookkeeping. MUST pre-exist (no
    //        init_if_needed in an optional context): a trigger crosses a writer
    //        ask only on a series that has already had one direct fill.
    //   [28]-[30] the SHARED per-series transfer-hook triad. Required by ANY leg
    //        that moves option tokens through Token-2022 transfer_checked: the
    //        ResaleAsk buy (escrow → owner) and every Bid sell (owner → maker).
    //        Not "resale" accounts — series accounts. [29] is ID-pinned in-handler.
    //   [31] the MAKER'S option ATA — the sell leg's delivery destination. Bid-only
    //        (a buy delivers to holder_option_ata, base slot 11). Ownership is
    //        runtime-pinned to (book_order.owner, option_mint) before the transfer:
    //        transfer_checked validates the destination's mint but NOT its owner,
    //        so an unpinned slot would let the keeper redirect the delivery.
    //
    // A Pyth book fire passes price_update=Some, sb_*=None. An SB book fire passes
    // price_update=None, sb_*=Some. The handler validates every book account's PDA
    // and fields (kind/mint/vault/owner) at runtime — no struct-level seeds, which
    // cannot be self-referential to optionals.
    /// CHECK: validated in-handler (kind, option_mint/vault == trigger, PDA).
    #[account(mut)]
    pub book_order: Option<Box<Account<'info, RestingOrder>>>,

    /// CHECK: writer wallet, pinned == book_order.owner in-handler; rent dest on close.
    #[account(mut)]
    pub book_maker: Option<UncheckedAccount<'info>>,

    /// CHECK: per-order escrow; PDA [resting_order_escrow, book_order] checked in-handler.
    /// Holds the maker's USDC (WriterAsk collateral / Bid funds) or option tokens (ResaleAsk).
    #[account(mut)]
    pub book_escrow: Option<UncheckedAccount<'info>>,

    /// Maker's USDC (premium recipient on a BUY); owner==book_order.owner checked
    /// in-handler. None on a sell — proceeds go to owner_usdc_account instead.
    #[account(mut)]
    pub book_maker_usdc: Option<Box<Account<'info, TokenAccount>>>,

    /// Per-series WriterAskPot (must pre-exist); PDA [writer_ask_pot, option_mint] checked in-handler.
    #[account(mut)]
    pub writer_ask_pot: Option<Box<Account<'info, WriterAskPot>>>,

    /// Per-series pot USDC (must pre-exist); PDA [writer_ask_pot_usdc, option_mint] checked in-handler.
    #[account(mut)]
    pub writer_ask_pot_usdc: Option<Box<Account<'info, TokenAccount>>>,

    /// Per-(series, writer) WriterAskPosition (must pre-exist); PDA checked in-handler.
    #[account(mut)]
    pub writer_ask_position: Option<Box<Account<'info, WriterAskPosition>>>,

    // --- Shared per-series transfer-hook triad ([28]-[30]); None for a WriterAsk
    // fire, which moves no option tokens through transfer_checked. Required by the
    // ResaleAsk BUY leg (escrow → owner) and by every Bid SELL leg (owner → maker),
    // because both dispatch the series transfer hook. Validated in-handler (program
    // ID-pinned; metas/state validated by the hook dispatch itself).
    /// CHECK: ExtraAccountMetaList for the transfer hook; validated by T22 hook dispatch.
    pub book_hook_metas: Option<UncheckedAccount<'info>>,

    /// CHECK: transfer-hook program; pinned == opta_transfer_hook::ID in-handler.
    pub book_hook_program: Option<UncheckedAccount<'info>>,

    /// CHECK: HookState for the transfer hook; validated by T22 hook dispatch.
    pub book_hook_state: Option<UncheckedAccount<'info>>,

    // --- B2 sell-leg slot ([31]); None on every buy fire and every flag-off fire.
    /// CHECK: the maker's option ATA — the sell leg's delivery destination.
    /// Runtime-pinned to (book_order.owner, option_mint) from the raw Token-2022
    /// layout BEFORE the transfer (the fill_order.rs C-1 guard, applied to the
    /// trigger path). A typed constraint is not usable: these are Token-2022
    /// accounts, which `Account<TokenAccount>` rejects.
    #[account(mut)]
    pub book_maker_option: Option<UncheckedAccount<'info>>,

    // --- B3 OCO slot ([32]) ------------------------------------------------
    /// The paired TriggerOrder when this one carries an `oco_link`, else None.
    ///
    /// APPENDED, deliberately: every existing account keeps its index, so the
    /// pot stays at [25]/[26] and the book optionals stay at [21]-[31]. The slot
    /// guards are still re-derived against the rebuilt IDL rather than assumed —
    /// an append that silently did not hold would be exactly the class of bug
    /// those guards exist for.
    #[account(mut)]
    pub oco_peer: Option<Account<'info, TriggerOrder>>,

    /// FP-ORACLE arm (plug, wave 1). Trailing optional, appended LAST so every
    /// existing transaction stays byte-identical. REQUIRED when oracle_source ==
    /// ORACLE_SOURCE_OPTA; the arm errors OptaFeedMissing if absent.
    pub opta_price_feed: Option<Account<'info, OptaPriceFeed>>,
}
