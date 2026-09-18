import { useCallback, useState } from "react";
import { withResolvedOutcome } from "../../utils/txOutcome";
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createBurnCheckedInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import {
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  PROTOCOL_SEED,
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
  deriveWriterAskPotPda,
  deriveWriterAskPotUsdcPda,
} from "../../utils/constants";
import { usdcToNumber, hexFromBytes } from "../../utils/format";
import {
  deriveVaultResaleListing,
  deriveVaultResaleEscrow,
} from "../../hooks/useAccounts";
import {
  buildOptaExerciseAmericanTx,
  buildPostUpdateAndExerciseAmericanTx,
  submitWithFallback,
} from "../../utils/pythPullPost";
import {
  assertExerciseTxShape,
  chooseExerciseArm,
  deserializeExerciseTx,
  isQuoteExpired,
  postSbExercise,
} from "../../utils/exerciseArm";
// GATE 3 (2026-08-13): the exercise path uses its OWN retry predicate, not the
// create module's. `isStaleSubmitError` retries on `custom program error: 0x3`,
// justified there because a create transaction invokes only ComputeBudget, the
// ed25519 precompile and Opta — so a low code cannot be a real verdict. An
// EXERCISE transaction also invokes SPL Token and Token-2022, whose error 3 is
// OwnerMismatch and whose error 1 is InsufficientFunds: both permanent. Reusing
// create's fingerprint here spent a second wallet approval to fail identically,
// which is exactly what happened on 2026-08-12. Create keeps its behaviour.
import { isStaleQuoteFailure } from "../../utils/txFailure";
import { getSbCreateEndpoint } from "../../utils/env";
import { decodeError, isWalletReplay } from "../../utils/errorDecoder";
import { showToast } from "../../components/Toast";
import type { Position } from "./positions";

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

export type PortfolioActions = {
  /** Position id (option-mint base58) currently being acted on; `null` when idle. Drives row-level button disabled state. */
  busyId: string | null;
  exercise: (p: Position) => Promise<void>;
  /** American early exercise (pre-expiry). Posts a fresh PriceUpdateV2 + calls
   *  exercise_american. Dark until Stage I — deriveAction only emits the
   *  "exercise-american" action when AMERICAN_ENABLED_UI is true. */
  exerciseAmerican: (p: Position) => Promise<void>;
  listResale: (p: Position, premiumUsd: number, tokenAmount: number) => Promise<void>;
  cancelResale: (p: Position) => Promise<void>;
  burn: (p: Position) => Promise<void>;
};

/**
 * Bundles the four buyer-side action handlers (exercise / listResale /
 * cancelResale / burn) plus a single busyId state for in-flight tracking.
 *
 * On-chain instruction calls are lifted verbatim from the legacy
 * Portfolio.tsx (preserved at git revision 7405348~1) — only the
 * orchestration around them changed. v1 dispatches via Anchor program
 * methods on the protocol; v2 routes through `exerciseFromVault`. Burn
 * uses Token-2022's `burnChecked` SPL instruction directly since it
 * doesn't require a protocol-side state update — it's just removing
 * worthless dust from the wallet.
 *
 * Errors surface via the existing showToast pipeline through
 * decodeError, matching the legacy UX.
 */
export function usePortfolioActions(onSuccess: () => void): PortfolioActions {
  const { program, provider } = useProgram();
  const { publicKey } = useWallet();
  const [busyId, setBusyId] = useState<string | null>(null);

  const exercise = useCallback(
    async (p: Position) => {
      if (!program || !provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await exerciseV2({ program, publicKey, position: p });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Exercised",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Exercise failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [program, provider, publicKey, onSuccess],
  );

  const exerciseAmerican = useCallback(
    async (p: Position) => {
      if (!program || !provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await exerciseAmericanV2({ program, provider, publicKey, position: p });
        onSuccess();
      } catch (err: any) {
        // The early-exercise transaction always carries an ed25519 price proof,
        // so low custom codes may be read as precompile errors here.
        const msg = decodeError(err, { hasPriceProof: true });
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Exercised early",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Early exercise failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [program, provider, publicKey, onSuccess],
  );

  const listResale = useCallback(
    async (p: Position, premiumUsd: number, tokenAmount: number) => {
      if (!program || !provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await listResaleV2({ program, publicKey, position: p, premiumUsd, tokenAmount });
        showToast({
          type: "success",
          title: "Listed for resale",
          message: `Asking $${premiumUsd.toFixed(2)}`,
        });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Listed for resale",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Listing failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [program, provider, publicKey, onSuccess],
  );

  const cancelResale = useCallback(
    async (p: Position) => {
      if (!program || !provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await cancelResaleV2({ program, publicKey, position: p });
        showToast({
          type: "success",
          title: "Listing cancelled",
          message: "Tokens returned to wallet.",
        });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Listing cancelled",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Cancel listing failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [program, provider, publicKey, onSuccess],
  );

  const burn = useCallback(
    async (p: Position) => {
      if (!provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await burnTokens({ provider, publicKey, position: p });
        showToast({
          type: "success",
          title: "Tokens burned",
          message: `${p.contracts} contracts removed from your wallet.`,
        });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Tokens burned",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Burn failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [provider, publicKey, onSuccess],
  );

  return { busyId, exercise, exerciseAmerican, listResale, cancelResale, burn };
}

// ---------------------------------------------------------------------------
// On-chain implementations
// ---------------------------------------------------------------------------

async function exerciseV2({
  program,
  publicKey,
  position,
}: {
  program: any;
  publicKey: PublicKey;
  position: Position;
}) {
  const { vault, vaultMint } = position.source;
  const v = vault.account;
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const optionMint = vaultMint.account.optionMint as PublicKey;
  const holderUsdcAccount = await getAssociatedTokenAddress(
    protocolState.usdcMint,
    publicKey,
  );
  const holderOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  const isCall = "call" in v.optionType;
  const settlement = usdcToNumber(v.settlementPrice);
  const strike = usdcToNumber(v.strikePrice);
  const pnl = isCall
    ? Math.max(0, settlement - strike)
    : Math.max(0, strike - settlement);
  const totalPayout = (pnl * position.contracts).toFixed(2);

  const tx = await program.methods
    .exerciseFromVault(new BN(position.contracts))
    .accountsStrict({
      holder: publicKey,
      sharedVault: vault.publicKey,
      market: v.market,
      vaultMintRecord: vaultMint.publicKey,
      optionMint,
      holderOptionAccount,
      vaultUsdcAccount: v.vaultUsdcAccount,
      holderUsdcAccount,
      protocolState: protocolStatePda,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([EXTRA_CU])
    .rpc({ commitment: "confirmed" });

  showToast({
    type: "success",
    title: "Exercised!",
    message: `${position.contracts} contracts burned. Received $${totalPayout} USDC.`,
    txSignature: tx,
  });
}

async function exerciseAmericanV2({
  program,
  provider,
  publicKey,
  position,
}: {
  program: any;
  provider: any;
  publicKey: PublicKey;
  position: Position;
}) {
  const { vault, vaultMint } = position.source;
  const v = vault.account;
  const marketPda = v.market as PublicKey;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint as PublicKey;
  const optionMint = vaultMint.account.optionMint as PublicKey;

  const holderUsdcAccount = await getAssociatedTokenAddress(usdcMint, publicKey);
  const holderOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  // ── WHICH PRICE ARM? ──────────────────────────────────────────────────────
  // This branch is the P1 fix. Until 2026-08-12 there was none: every market
  // took the Pyth path, so every Switchboard market sent its SB feedHash to a
  // Pyth endpoint and got a 404 — i.e. early exercise was broken on the entire
  // traded board and worked only on the handful of Pyth-sourced assets. See
  // app/src/utils/exerciseArm.ts for the reproduction.
  //
  // Prefer the joined market body (present on most held positions); fall back to
  // a direct fetch if this position surfaced without its market, or if the body
  // predates the oracle_source field. chooseExerciseArm THROWS on an unreadable
  // source rather than defaulting — there is no safe default.
  let mktBody: any = position.source.market;
  if (mktBody?.pythFeedId === undefined || mktBody?.oracleSource === undefined) {
    mktBody = await program.account.optionsMarket.fetch(marketPda);
  }
  const arm = chooseExerciseArm(mktBody?.oracleSource);

  if (arm === "switchboard") {
    await exerciseAmericanSwitchboard({
      program,
      provider,
      publicKey,
      position,
      accounts: {
        sharedVault: vault.publicKey,
        market: marketPda,
        vaultMintRecord: vaultMint.publicKey,
        optionMint,
        holderOptionAccount,
        vaultUsdcAccount: v.vaultUsdcAccount as PublicKey,
        holderUsdcAccount,
      },
    });
    return;
  }

  // ── OPTA ARM (plug wave 1) — local build, no off-chain post, no endpoint ──
  if (arm === "opta") {
    const optaFeedIdHex = hexFromBytes(mktBody.pythFeedId as number[]);
    const optaTxs = await buildOptaExerciseAmericanTx(program, provider.wallet, {
      feedIdHex: optaFeedIdHex,
      quantity: position.contracts,
      sharedVault: vault.publicKey,
      market: marketPda,
      vaultMintRecord: vaultMint.publicKey,
      optionMint,
      holderOptionAccount,
      vaultUsdcAccount: v.vaultUsdcAccount as PublicKey,
      holderUsdcAccount,
    });
    const optaSig = await submitWithFallback(program.provider.connection, provider.wallet, optaTxs);
    showToast({
      type: "success",
      title: "Exercised early!",
      message: `${position.contracts} contract${position.contracts === 1 ? "" : "s"} exercised · USDC sent to your wallet.`,
      txSignature: optaSig,
    });
    return;
  }

  // ── PYTH ARM — unchanged below this line ──────────────────────────────────
  const feedIdHex = hexFromBytes(mktBody.pythFeedId as number[]);

  // Atomic post fresh /latest PriceUpdateV2 + exercise_american + close, 1.4M CU.
  const txs = await buildPostUpdateAndExerciseAmericanTx(program, provider.wallet, {
    feedIdHex,
    quantity: position.contracts,
    sharedVault: vault.publicKey,
    market: marketPda,
    vaultMintRecord: vaultMint.publicKey,
    optionMint,
    holderOptionAccount,
    vaultUsdcAccount: v.vaultUsdcAccount as PublicKey,
    holderUsdcAccount,
  });
  const sig = await submitWithFallback(program.provider.connection, provider.wallet, txs);

  // No client-side payout estimate: a post-submit Hermes /latest read races the
  // Pyth price the tx actually posted + consumed, so the two spots diverge and
  // any $ figure here can mislead (observed ~$0.96 shown vs $1.12 paid). The
  // exact USDC intrinsic settled on-chain and is in the wallet.
  showToast({
    type: "success",
    title: "Exercised early!",
    message: `${position.contracts} contract${position.contracts === 1 ? "" : "s"} exercised · USDC sent to your wallet.`,
    txSignature: sig,
  });
}

/**
 * SWITCHBOARD ARM of early exercise.
 *
 * Why a server round-trip instead of building it here: a Switchboard quote needs
 * @switchboard-xyz/on-demand, and app/ carries ZERO Switchboard dependencies by
 * a deliberate, documented bundle decision. So this mirrors sb-create-market —
 * the crank assembles [CU, oracle-signed proof, exercise_american] and returns
 * it UNSIGNED; the holder signs and pays. The crank key is not a signer on the
 * result and could not be: exercise_american's only signer is `holder`.
 *
 * assertExerciseTxShape is the reason that is acceptable. Every account, the
 * discriminator, the quantity, the signer set and the absence of lookup tables
 * are checked against values derived HERE before the wallet is opened. We
 * operate the endpoint today; the guard is what makes that irrelevant.
 *
 * Retry policy is lifted from the SB create arm: exactly one refetch, and ONLY
 * on a genuine stale signal. A stale tx is rebuilt from scratch — never
 * resubmitted, because both the blockhash and the embedded quote are dead.
 */
async function exerciseAmericanSwitchboard({
  program,
  provider,
  publicKey,
  position,
  accounts,
}: {
  program: any;
  provider: any;
  publicKey: PublicKey;
  position: Position;
  accounts: {
    sharedVault: PublicKey;
    market: PublicKey;
    vaultMintRecord: PublicKey;
    optionMint: PublicKey;
    holderOptionAccount: PublicKey;
    vaultUsdcAccount: PublicKey;
    holderUsdcAccount: PublicKey;
  };
}) {
  const endpoint = getSbCreateEndpoint();
  if (!endpoint) {
    throw new Error("Early exercise is unavailable right now. Please try again later.");
  }

  const connection = program.provider.connection;
  const request = {
    holder: publicKey.toBase58(),
    sharedVault: accounts.sharedVault.toBase58(),
    market: accounts.market.toBase58(),
    vaultMintRecord: accounts.vaultMintRecord.toBase58(),
    optionMint: accounts.optionMint.toBase58(),
    holderOptionAccount: accounts.holderOptionAccount.toBase58(),
    vaultUsdcAccount: accounts.vaultUsdcAccount.toBase58(),
    holderUsdcAccount: accounts.holderUsdcAccount.toBase58(),
    quantity: position.contracts,
  };
  // The three pot-arm accounts are DERIVED HERE, never sent in the request and
  // never taken from the response. The endpoint derives its own copy the same
  // way; the guard then refuses unless the two agree. That is the whole point —
  // a server that could name the pot could name ANOTHER series' pot and have
  // protocol_state sign the transfer out of it.
  //
  // Omitting these is not a soft failure: assertExerciseTxShape refuses any
  // carried pot it has no local expectation for, so a pot-funded series cannot
  // be exercised at all until this is supplied.
  const [writerAskPotPda] = deriveWriterAskPotPda(accounts.optionMint);
  const [writerAskPotUsdcPda] = deriveWriterAskPotUsdcPda(accounts.optionMint);
  const [potProtocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PROTOCOL_SEED)],
    program.programId,
  );
  const expected = {
    ...request,
    programId: program.programId.toBase58(),
    writerAskPot: writerAskPotPda.toBase58(),
    writerAskPotUsdc: writerAskPotUsdcPda.toBase58(),
    protocolState: potProtocolStatePda.toBase58(),
  };

  let sig = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await postSbExercise(endpoint, request);
    const tx = deserializeExerciseTx(resp.transactionBase64);
    // Refuse BEFORE the wallet is opened. A shape failure is never retried:
    // it is not staleness, it is the wrong transaction.
    assertExerciseTxShape(tx, expected);

    // GATE 4: check the tighter of the two deadlines BEFORE opening the wallet.
    // The price quote now expires before the blockhash does (~35 s vs 60-90 s),
    // so a slow first attempt can hand the user a transaction that is already
    // dead. Rebuilding costs a round-trip; the alternative costs a signature.
    if (attempt === 0 && isQuoteExpired(resp, await connection.getSlot("confirmed"))) {
      continue;
    }

    let signed;
    try {
      signed = await provider.wallet.signTransaction(tx);
    } catch (e) {
      if (attempt === 0 && !isWalletReplay(e) && isStaleQuoteFailure(e)) continue;
      throw e;
    }
    try {
      sig = await withResolvedOutcome(connection, async () => {
        const s = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await connection.confirmTransaction(
          {
            signature: s,
            blockhash: tx.message.recentBlockhash,
            lastValidBlockHeight: resp.lastValidBlockHeight,
          },
          "confirmed",
        );
        return s;
      });
      break;
    } catch (e) {
      if (attempt === 0 && isStaleQuoteFailure(e)) continue;
      throw e;
    }
  }

  // No client-side payout estimate — same reason as the Pyth arm: a post-submit
  // spot read races the price the transaction actually consumed, and any $ figure
  // here can disagree with what landed.
  showToast({
    type: "success",
    title: "Exercised early!",
    message: `${position.contracts} contract${position.contracts === 1 ? "" : "s"} exercised · USDC sent to your wallet.`,
    txSignature: sig,
  });
}

async function listResaleV2({
  program,
  publicKey,
  position,
  premiumUsd,
  tokenAmount,
}: {
  program: any;
  publicKey: PublicKey;
  position: Position;
  premiumUsd: number;
  tokenAmount: number;
}) {
  const { vault, vaultMint } = position.source;
  const optionMint = vaultMint.account.optionMint as PublicKey;
  const marketPda = vault.account.market as PublicKey;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint as PublicKey;

  const [listingPda] = deriveVaultResaleListing(optionMint, publicKey);
  const [resaleEscrowPda] = deriveVaultResaleEscrow(listingPda);
  const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
  const [hookState] = deriveHookStatePda(optionMint);

  const sellerOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const sellerUsdcAccount = getAssociatedTokenAddressSync(
    usdcMint,
    publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  // Floor at the lamport level so the on-chain total never exceeds the user's
  // typed input. Worst case: user receives up to (tokenAmount - 1) micro-USDC
  // less than they intended (e.g. $9.999999 instead of $10.00 on a $10/3
  // listing). Rounding direction matters: an overcharged listing would
  // confuse buyers and break the modal's "Total: $X" preview math.
  const totalMicros = Math.floor(premiumUsd * 1_000_000);
  const perContractMicros = Math.floor(totalMicros / tokenAmount);
  const pricePerContract = new BN(perContractMicros);

  // CRITICAL per V2_SECONDARY_FRONTEND_PLAN.md §10: buy_v2_resale reverts if
  // the seller's USDC ATA is missing (it's not pre-created by the buy flow
  // per the on-chain plan's OQ#6). The list flow MUST always pre-create it,
  // idempotent — otherwise the first buy attempt against this listing fails
  // and the seller has no in-app recovery path.
  const createSellerUsdcAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    publicKey,
    sellerUsdcAccount,
    publicKey,
    usdcMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  await program.methods
    .listV2ForResale(pricePerContract, new BN(tokenAmount))
    .accountsStrict({
      seller: publicKey,
      sharedVault: vault.publicKey,
      market: marketPda,
      vaultMintRecord: vaultMint.publicKey,
      optionMint,
      sellerOptionAccount,
      listing: listingPda,
      resaleEscrow: resaleEscrowPda,
      protocolState: protocolStatePda,
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([EXTRA_CU, createSellerUsdcAtaIx])
    .rpc({ commitment: "confirmed" });
}

async function cancelResaleV2({
  program,
  publicKey,
  position,
}: {
  program: any;
  publicKey: PublicKey;
  position: Position;
}) {
  const { vault, vaultMint } = position.source;
  const optionMint = vaultMint.account.optionMint as PublicKey;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  );
  const [listingPda] = deriveVaultResaleListing(optionMint, publicKey);
  const [resaleEscrowPda] = deriveVaultResaleEscrow(listingPda);
  const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
  const [hookState] = deriveHookStatePda(optionMint);

  const sellerOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  // Defensive: the seller had to have an option ATA at list time, but they
  // may have closed it afterward (rare). Idempotent re-create is free if it
  // already exists and prevents a "destination ATA not found" revert.
  const createSellerOptionAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    publicKey,
    sellerOptionAccount,
    publicKey,
    optionMint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  await program.methods
    .cancelV2Resale()
    .accountsStrict({
      seller: publicKey,
      sharedVault: vault.publicKey,
      optionMint,
      listing: listingPda,
      resaleEscrow: resaleEscrowPda,
      sellerOptionAccount,
      protocolState: protocolStatePda,
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([EXTRA_CU, createSellerOptionAtaIx])
    .rpc({ commitment: "confirmed" });
}

async function burnTokens({
  provider,
  publicKey,
  position,
}: {
  provider: any;
  publicKey: PublicKey;
  position: Position;
}) {
  // Token-2022 burn. Doesn't update on-chain state; just removes
  // worthless tokens from the wallet so they stop appearing in
  // heldBalances.
  const optionMint = position.source.vaultMint.account.optionMint as PublicKey;

  const ata = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  const tx = new Transaction();
  tx.add(EXTRA_CU);
  tx.add(
    createBurnCheckedInstruction(
      ata,
      optionMint,
      publicKey,
      BigInt(position.contracts),
      0, // option tokens use 0 decimals — each token = 1 contract
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  await withResolvedOutcome(provider.connection as never, () =>
    provider.sendAndConfirm(tx, [], { commitment: "confirmed" }));
}
