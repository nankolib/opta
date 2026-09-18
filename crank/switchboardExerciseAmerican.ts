// ============================================================================
// crank/switchboardExerciseAmerican.ts — SB early-exercise off-chain builder
// ============================================================================
//
// The Switchboard analog of app/src/utils/pythPullPost.ts's
// buildPostUpdateAndExerciseAmericanTx: instead of posting a Hermes VAA it
// fetches a fresh signed Switchboard quote (the same buildManagedQuoteUpdateIxs
// + self-pack the settle crank and the SB create-market builder use) and
// assembles:
//   [ setComputeUnitLimit, setComputeUnitPrice, correctedEd25519Ix(idx 2),
//     exercise_american(quantity, price_update:null,
//                       +sb_queue/sb_slothashes/sb_instructions) ]
// The priority-fee ix is ours on purpose — see EXERCISE_PRIORITY_MICROLAMPORTS.
// pointed at exercise_american.rs:118-175's ORACLE_SOURCE_SWITCHBOARD arm.
//
// WHY THIS EXISTS (P1, 2026-08-12). Early exercise was broken on every
// SB-sourced market — the whole traded board — because the FE had no
// oracle_source branch and sent the SB feedHash to Hermes, which 404s. The
// program has had both arms since it shipped; only a client-side builder for the
// SB arm was missing, and it could not live in app/ because the FE deliberately
// carries ZERO @switchboard-xyz dependencies (see the module header in
// app/src/utils/exerciseArm.ts).
//
// LOCATION — crank/, for exactly the reason switchboardCreateMarket.ts is here:
// buildManagedQuoteUpdateIxs needs @switchboard-xyz/on-demand, a CRANK dep.
//
// SIGNER SPLIT (the property that makes a server-built tx acceptable): the only
// required signature is the HOLDER's. The ed25519 quote ix is oracle-signed and
// independent of the fee payer, and exercise_american's sole signer is `holder`.
// So this builder produces a tx the crank CANNOT sign and has no reason to —
// the user pays their own ~6.6¢ quote cost. The FE re-derives every account and
// refuses to sign anything that does not match (assertExerciseTxShape).
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey, ComputeBudgetProgram, Ed25519Program, TransactionInstruction,
} from "@solana/web3.js";
import {
  Queue, SPL_SYSVAR_SLOT_HASHES_ID, SPL_SYSVAR_INSTRUCTIONS_ID,
} from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { buildManagedQuoteUpdateIxs } from "./switchboardQuotePost";
import { lookupSbFeed, buildOracleFeed, normFeedHash } from "./sbFeedRegistry";
import { assertPotSlots, POT_SLOTS } from "./potSlotGuard";

/** Token-2022 burn + SB verify + USDC payout. Same bump as the Pyth arm's
 *  atomic post+exercise tx, which is the closest measured comparable. */
const EXERCISE_CU_LIMIT = 1_400_000;

/**
 * Priority fee, in micro-lamports per compute unit.
 *
 * WHY WE SET ONE AT ALL (2026-08-16). Phantom attaches its own
 * `setComputeUnitPrice` instruction when it signs a transaction that has none.
 * That insertion shifts every instruction index by one, and the Switchboard
 * price proof's offsets are position-DEPENDENT — the crate re-reads the ed25519
 * ix through the instructions sysvar and asserts the field equals that ix's own
 * concrete index. The shift therefore killed every browser-signed early exercise
 * with `custom program error: 0x3` (ed25519 InvalidDataOffsets) before any
 * program ran.
 *
 * Supplying the instruction ourselves removes the wallet's REASON to insert one.
 * IT DOES NOT REMOVE ITS ABILITY: a wallet may still add or reorder
 * instructions, and if it does, this transaction fails exactly as it did before.
 * This is a mitigation, not a fix. The structural fix — the endpoint returns
 * INSTRUCTIONS and the FE assembles them, computing the ed25519 index last,
 * after anything it intends to add — is tracked on 86eymw9m1.
 *
 * At 1.4M CU this is ~1400 lamports (~0.0000014 SOL): real enough to be a
 * genuine fee, negligible against the exercise payout.
 */
const EXERCISE_PRIORITY_MICROLAMPORTS = 1_000;

/**
 * Index of the ed25519 ix in the assembled transaction below. It is passed to
 * the packer AND used to order `instructions`, so the two cannot drift: the
 * packed offsets are only valid at this exact position.
 *   [0] setComputeUnitLimit
 *   [1] setComputeUnitPrice
 *   [2] ed25519 price proof   <- ED25519_IX_INDEX
 *   [3] exercise_american
 */
const ED25519_IX_INDEX = 2;

/**
 * The on-chain freshness budget for an early-exercise quote, in SLOTS.
 *
 * Mirrors `secs_to_slots(PRICE_MAX_AGE_SECS)` in
 * programs/opta/src/utils/price_oracle.rs — PRICE_MAX_AGE_SECS is 60 and
 * SLOTS_PER_SEC is a hardcoded 5/2, so the chain accepts 150 slots and no more.
 *
 * ⚠️ 150 SLOTS IS NOT 60 SECONDS. That conversion assumes 2.5 slots/sec.
 * Measured on devnet 2026-08-13 over a 90-second window: 380 slots elapsed, a
 * rate of 4.22 slots/sec. At that rate the budget is worth ~35 SECONDS of
 * wall-clock, not 60 — and a wallet approval takes 15-60s. The window is
 * therefore genuinely marginal, and the shortfall is invisible from the
 * constant's name.
 *
 * Only a program upgrade can widen the budget. What this endpoint CAN do is
 * stop pretending the deadline is unknowable: it publishes the slot at which
 * the quote dies, so the client can act before wasting a signature. Duplicated
 * here rather than imported because the Rust constant cannot be read from TS;
 * if PRICE_MAX_AGE_SECS changes, this must change with it.
 */
export const QUOTE_MAX_AGE_SLOTS = 150;

export interface SbExerciseAmericanParams {
  /** 32-byte SB feedHash, read from the MARKET account by the caller — never
   *  taken from the request body. */
  feedHashHex: string;
  quantity: number;
  sharedVault: PublicKey;
  market: PublicKey;
  vaultMintRecord: PublicKey;
  optionMint: PublicKey;
  holderOptionAccount: PublicKey;
  vaultUsdcAccount: PublicKey;
  holderUsdcAccount: PublicKey;
}

export interface SbExerciseAmericanBuild {
  /** [cuLimit, cuPrice, correctedEd25519Ix(ED25519_IX_INDEX), exercise_american]. */
  instructions: TransactionInstruction[];
  ed25519Bytes: number;
  /** Slot observed immediately BEFORE the quote was fetched. The quote's own
   *  recent_slot is at or before this, so deadlines derived from it are an
   *  upper bound — deliberately, so the client errs toward rebuilding early. */
  quoteBuiltAtSlot: number;
}

/**
 * Build the SB early-exercise instruction set. Throws if the feedHash isn't in
 * the SB registry or the gateway fetch fails; the caller retries with a fresh
 * quote, same as the create endpoint and the posting/settle crank.
 */
export async function buildSwitchboardExerciseAmericanTx(
  program: anchor.Program<any>,
  holder: PublicKey,
  qObj: Queue,
  crossbar: CrossbarClient,
  params: SbExerciseAmericanParams,
): Promise<SbExerciseAmericanBuild> {
  const feedHashHex = normFeedHash(params.feedHashHex);
  const entry = lookupSbFeed(feedHashHex);
  if (!entry) throw new Error(`feedHash ${feedHashHex.slice(0, 10)} not in SB registry`);

  // Fresh signed quote → corrected (self-packed) ed25519 ix, packed for
  // ED25519_IX_INDEX. The order below is NOT free to change: the packed offsets
  // are absolute tx positions and the on-chain crate asserts they equal the ix's
  // own index. `find_ed25519_ix_index` scanning the sysvar was never the half
  // that pinned the order — the packed field is.
  const feed = buildOracleFeed(entry);
  // Sampled BEFORE the gateway round-trip so the deadline we publish can never
  // be later than the truth.
  const quoteBuiltAtSlot = await program.provider.connection.getSlot("confirmed");
  const { ixs } = await buildManagedQuoteUpdateIxs(
    qObj, crossbar, feed, holder, { numSignatures: 2, instructionIdx: ED25519_IX_INDEX });
  const edPid = Ed25519Program.programId.toBase58();
  const edIx = ixs.find((ix) => ix.programId.toBase58() === edPid);
  if (!edIx) throw new Error("no ed25519 ix in managed-update output");

  // ---- Writer-ask pot arm (2026-08-15) -------------------------------------
  // Derived here, never taken from the request: these three are seed-determined
  // from the option mint, so deriving them removes the caller's ability to name
  // a pot at all. Included ONLY when the pot record exists on chain — a
  // pool-funded series keeps the 14-account shape, byte-identical to every
  // exercise built before this arm existed.
  const potSeed = (prefix: string) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(prefix), params.optionMint.toBuffer()],
      program.programId,
    )[0];
  const writerAskPot = potSeed("writer_ask_pot");
  const writerAskPotUsdc = potSeed("writer_ask_pot_usdc");
  const protocolState = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  )[0];
  const potExists =
    (await program.provider.connection.getAccountInfo(writerAskPot, "confirmed")) !== null;

  const exerciseIx = await (program.methods as any)
    .exerciseAmerican(new anchor.BN(params.quantity))
    .accountsPartial({
      holder,
      sharedVault: params.sharedVault,
      market: params.market,
      // SB arm: no Pyth account. anchor 0.32.1 does NOT auto-null unprovided
      // optional accounts at .instruction() — it throws "Account `priceUpdate`
      // not provided" — so the null is explicit, mirroring how the Pyth arm
      // explicitly nulls the three SB accounts.
      priceUpdate: null,
      vaultMintRecord: params.vaultMintRecord,
      optionMint: params.optionMint,
      holderOptionAccount: params.holderOptionAccount,
      vaultUsdcAccount: params.vaultUsdcAccount,
      holderUsdcAccount: params.holderUsdcAccount,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      sbQueue: entry.queue,
      sbSlothashes: SPL_SYSVAR_SLOT_HASHES_ID,
      sbInstructions: SPL_SYSVAR_INSTRUCTIONS_ID, optaPriceFeed: null,
      // Explicit nulls when absent — anchor 0.32.1 does not auto-null optionals
      // at .instruction() (same reason priceUpdate is nulled above).
      writerAskPot: potExists ? writerAskPot : null,
      writerAskPotUsdc: potExists ? writerAskPotUsdc : null,
      protocolState: potExists ? protocolState : null,
    })
    .instruction();

  // NEVER SILENTLY DOWNGRADE (2026-08-16, production incident).
  //
  // Anchor builds an instruction's account list FROM THE IDL. If the IDL predates
  // the pot arm, `accountsPartial({ writerAskPot, … })` drops those keys without
  // a word and emits the legacy 14-account shape — which the program then
  // refuses with EarlyExercisePotRequired (6084), on chain, after the user has
  // signed. That is exactly what production served for a day: new builder code,
  // stale `app/src/idl/opta.json`, and no signal anywhere between them.
  //
  // So the builder now checks its own output. If we resolved a pot, the built
  // instruction MUST carry it. Failing loudly here costs a 500 the caller can
  // retry; failing silently costs a wallet signature and a support thread.
  // Upgraded from a COUNT check to a SLOT check on 2026-08-17. The count version
  // read `keys.length <= 14` and caught only the full legacy shape. Measured that
  // day: the pot arm here is THREE accounts (writer_ask_pot, writer_ask_pot_usdc,
  // protocol_state), 14 -> 17, so an IDL that dropped just the two pot-named
  // accounts produced 15 — above the threshold, straight through the guard, with
  // no pot on a payout path. A slot check cannot be fooled by a length that
  // happens to land in range.
  if (potExists) {
    assertPotSlots(
      exerciseIx,
      [
        {
          slot: POT_SLOTS.exercise_american.pot,
          expected: writerAskPot,
          name: "writer_ask_pot",
        },
        {
          slot: POT_SLOTS.exercise_american.potUsdc,
          expected: writerAskPotUsdc,
          name: "writer_ask_pot_usdc",
        },
      ],
      { instruction: "exercise_american", optionMint: params.optionMint },
    );
  }

  // ORDER IS LOAD-BEARING: edIx must land at ED25519_IX_INDEX, the index its
  // offsets were packed for. Adding, removing, or reordering anything ahead of
  // it requires updating that constant in the same edit.
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: EXERCISE_CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: EXERCISE_PRIORITY_MICROLAMPORTS }),
    edIx,
    exerciseIx,
  ];
  if (instructions[ED25519_IX_INDEX] !== edIx) {
    throw new Error(
      `assembly drift: ed25519 ix is at ${instructions.indexOf(edIx)}, packed for ${ED25519_IX_INDEX}`,
    );
  }

  return {
    instructions,
    ed25519Bytes: edIx.data.length,
    quoteBuiltAtSlot,
  };
}
