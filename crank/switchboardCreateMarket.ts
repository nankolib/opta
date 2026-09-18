// ============================================================================
// crank/switchboardCreateMarket.ts — SB create-market off-chain builder
// (Stage 3 Phase-B prerequisite, net-new)
// ============================================================================
//
// The Switchboard analog of app/src/utils/pythPullPost.ts's
// buildPostUpdateAndCreateMarketTx: instead of posting a Hermes VAA, it fetches
// a fresh signed Switchboard quote (the proven buildManagedQuoteUpdateIxs +
// self-pack — the same machinery the posting/settle crank and the 1c-i-A gold
// smoke use) and assembles:
//   [ ComputeBudget, correctedEd25519Ix, create_market(asset, feedHash,
//     asset_class, oracle_source=1, +sb_queue/sb_slothashes/sb_instructions,
//     price_update:null) ]
// pointed at create_market's branched-HIGH-5 SB arm (the SB existence proof).
//
// LOCATION — crank/, not app/src/utils: it reuses buildManagedQuoteUpdateIxs and
// needs @switchboard-xyz/on-demand (a CRANK dep). Putting it in app/ would pull
// the SB SDK into the FE build/bundle for a function the live FE doesn't call yet
// (SB-create UI wiring is deferred). The Phase-C create-as-SB smoke is Node and
// calls this builder DIRECTLY (like the 1c-i-A gold smoke) — no UI needed. When a
// browser SB-create flow is built post-Phase-B, port/duplicate this to app/ +
// add the SB SDK there then.
//
// INERT until Phase B: nothing imports this yet (the smoke will). It references
// the 4-arg create_market signature via an `any` cast — consistent with the
// crank's SB method-chains — so it COMPILES against the current 3-arg app IDL and
// is CORRECT at runtime once the IDL syncs in Phase B. Until something calls it,
// the not-yet-deployed 4-arg signature can't break anything.
//
// The caller simulate-gates + sends (mirrors the crank's settle/push pattern).
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey, ComputeBudgetProgram, SystemProgram, Ed25519Program, TransactionInstruction,
} from "@solana/web3.js";
import {
  Queue, SPL_SYSVAR_SLOT_HASHES_ID, SPL_SYSVAR_INSTRUCTIONS_ID,
} from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";

import { buildManagedQuoteUpdateIxs } from "./switchboardQuotePost";
import { lookupSbFeed, buildOracleFeed, normFeedHash } from "./sbFeedRegistry";

const CREATE_CU_LIMIT = 400_000;
const PROTOCOL_SEED = "protocol_v2";
const MARKET_SEED = "market";
const ORACLE_SOURCE_SWITCHBOARD = 1;

export interface SbCreateMarketParams {
  /** Normalized asset name (ASCII upper, alphanumeric, 1..=16). */
  assetName: string;
  /** 32-byte SB feedHash — stored in the market's pyth_feed_id field (double-duty). */
  feedHashHex: string;
  /** 0..=4 (crypto/commodity/equity/forex/etf). */
  assetClass: number;
}

export interface SbCreateMarketBuild {
  /** [ComputeBudget, correctedEd25519Ix(idx 1), create_market] — ready to sim/send. */
  instructions: TransactionInstruction[];
  ed25519Bytes: number;
  marketPda: PublicKey;
}

/**
 * Build the create-SB-market instruction set. Throws if the feedHash isn't in the
 * SB registry or the gateway fetch fails (the caller retries with a fresh quote,
 * same as the posting/settle crank).
 */
export async function buildSwitchboardCreateMarketTx(
  program: anchor.Program<any>,
  payer: PublicKey,
  qObj: Queue,
  crossbar: CrossbarClient,
  params: SbCreateMarketParams,
): Promise<SbCreateMarketBuild> {
  const feedHashHex = normFeedHash(params.feedHashHex);
  const entry = lookupSbFeed(feedHashHex);
  if (!entry) throw new Error(`feedHash ${feedHashHex.slice(0, 10)} not in SB registry`);

  const feedIdBytes = Array.from(Buffer.from(feedHashHex, "hex"));
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PROTOCOL_SEED)], program.programId);
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(MARKET_SEED), Buffer.from(params.assetName)], program.programId);

  // Fresh signed quote → corrected (self-packed) ed25519 ix.
  const feed = buildOracleFeed(entry);
  const { ixs } = await buildManagedQuoteUpdateIxs(
    qObj, crossbar, feed, payer, { numSignatures: 2, instructionIdx: 1 });
  const edPid = Ed25519Program.programId.toBase58();
  const edIx = ixs.find((ix) => ix.programId.toBase58() === edPid);
  if (!edIx) throw new Error("no ed25519 ix in managed-update output");

  // create_market(asset, feedHash, class, oracle_source=1) + SB accounts.
  // `any` cast — see the module header (4-arg signature lands in Phase B).
  const createIx = await (program.methods as any)
    .createMarket(params.assetName, feedIdBytes, params.assetClass, ORACLE_SOURCE_SWITCHBOARD)
    .accounts({
      creator: payer,
      protocolState: protocolStatePda,
      priceUpdate: null, // SB existence proof uses the trailing SB accounts
      market: marketPda,
      systemProgram: SystemProgram.programId,
      sbQueue: entry.queue,
      sbSlothashes: SPL_SYSVAR_SLOT_HASHES_ID,
      sbInstructions: SPL_SYSVAR_INSTRUCTIONS_ID, optaPriceFeed: null,
    })
    .instruction();

  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_CU_LIMIT }), edIx, createIx,
    ],
    ed25519Bytes: edIx.data.length,
    marketPda,
  };
}
