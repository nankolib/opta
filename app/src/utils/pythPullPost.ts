// =============================================================================
// pythPullPost.ts — Pyth Pull settle helpers
// =============================================================================
//
// Builds + submits the atomic transaction that posts a fresh PriceUpdateV2
// to the Pyth Receiver program and consumes it in our settle_expiry IX, all
// in one tx. The Pyth SDK's `closeUpdateAccounts: true` mode arranges
// post + consume + close into a single tx and reclaims rent for the
// ephemeral price account when the tx ends.
//
// Tx-size analysis (P4d): single-feed VAA ≈ 519 bytes, settle_expiry IX
// ≈ 150 bytes; comfortably under Solana's 1232-byte limit. The SDK will
// auto-split into multiple sequential txs if a future change ever pushes
// the budget — submitWithFallback handles that case.
//
// On-chain seed constants (verified against programs/opta/src/instructions/
//   - market PDA       : [b"market", asset_name.as_bytes()]            (variable)
//   - settlement PDA   : [b"settlement", asset_name.as_bytes(), &expiry.to_le_bytes()]
// =============================================================================

import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  Signer,
  TransactionMessage,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Program } from "@coral-xyz/anchor";
import type { Opta } from "../idl/opta";

/**
 * Minimal wallet shape both pythPullPost callers satisfy:
 *   browser → AnchorWallet from @solana/wallet-adapter-react
 *   Node    → Wallet from @coral-xyz/anchor (when used by crank/bot.ts)
 *
 * Defined structurally so the helper is portable across both runtimes
 * without runtime-specific imports.
 */
export type SignerWallet = {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
};

const HERMES_BASE = "https://hermes-beta.pyth.network";
const HERMES_PRICE_PATH = "/v2/updates/price/latest";
const FETCH_TIMEOUT_MS = 15000;
const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 50_000;

const MARKET_SEED = "market";
const SETTLEMENT_SEED = "settlement";

// ---------------------------------------------------------------------------
// Hermes off-chain endpoint helpers
// ---------------------------------------------------------------------------

async function hermesGet(feedIdHex: string): Promise<any> {
  const hex = feedIdHex.replace(/^0x/, "").toLowerCase();
  const url = `${HERMES_BASE}${HERMES_PRICE_PATH}?ids[]=0x${hex}&encoding=base64`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`Hermes price HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the binary Wormhole VAA for a single feed_id. Pyth Receiver's
 *  post_update_atomic IX consumes this Buffer directly. */
export async function fetchHermesUpdate(feedIdHex: string): Promise<Buffer> {
  const json = await hermesGet(feedIdHex);
  const b64 = json?.binary?.data?.[0];
  if (typeof b64 !== "string") {
    throw new Error("Hermes response missing binary.data[0]");
  }
  return Buffer.from(b64, "base64");
}

/** Fetch the parsed display price (USD float + publish_time). Used by the
 *  post-click confirmation modal so we can show "Settled at $X" without
 *  re-decoding the on-chain account. */
export async function fetchHermesParsedPrice(
  feedIdHex: string,
): Promise<{ price: number; publishTime: number } | null> {
  try {
    const json = await hermesGet(feedIdHex);
    const p = json?.parsed?.[0]?.price;
    if (!p || typeof p.price !== "string" || typeof p.expo !== "number") {
      return null;
    }
    const value = parseFloat(p.price) * Math.pow(10, p.expo);
    return Number.isFinite(value)
      ? {
          price: value,
          publishTime: typeof p.publish_time === "number" ? p.publish_time : 0,
        }
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tx builder
// ---------------------------------------------------------------------------

export type BuiltTx = { tx: VersionedTransaction; signers: Signer[] };

/**
 * Compose the atomic post_update_atomic + settle_expiry transaction(s).
 * Returns an array because the SDK may split if we ever exceed tx size;
 * for our single-feed case this is virtually always length 1.
 */
export async function buildPostUpdateAndSettleTx(
  program: Program<Opta>,
  wallet: SignerWallet,
  assetName: string,
  expiry: number,
  feedIdHex: string,
): Promise<BuiltTx[]> {
  const priceUpdateData = await fetchHermesUpdate(feedIdHex);

  const receiver = new PythSolanaReceiver({
    connection: program.provider.connection,
    // SDK types expect NodeWallet (which has a `payer` Keypair); the
    // runtime only uses publicKey + signTransaction + signAllTransactions,
    // all present on AnchorWallet. Cast through `any` to bypass the
    // stricter-than-runtime type.
    wallet: wallet as any,
  });

  const builder = receiver.newTransactionBuilder({
    closeUpdateAccounts: true, // reclaim rent for the ephemeral PriceUpdateV2 at tx end
  });

  // SDK 0.14.0: a single addPostPriceUpdates call works for both atomic
  // (closeUpdateAccounts: true) and persistent (false) flows. There is no
  // separate "Atomic" method — that was a pre-investigation misread.
  // The SDK expects base64 strings, not raw Buffers — re-encode here.
  await builder.addPostPriceUpdates([priceUpdateData.toString("base64")]);

  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    // The receiver's helper indexes by 0x-prefixed lowercase hex.
    const hexKey = `0x${feedIdHex.replace(/^0x/, "").toLowerCase()}`;
    const priceUpdatePda = getPriceUpdateAccount(hexKey);
    if (!priceUpdatePda) {
      throw new Error(`No ephemeral PriceUpdate PDA for feed ${feedIdHex}`);
    }

    const expiryBN = new BN(expiry);
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
      program.programId,
    );
    const [settlementPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(SETTLEMENT_SEED),
        Buffer.from(assetName),
        expiryBN.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );

    const ix = await program.methods
      .settleExpiry(assetName, expiryBN)
      .accountsStrict({
        caller: wallet.publicKey,
        market: marketPda,
        priceUpdate: priceUpdatePda,
        settlementRecord: settlementPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    return [{ instruction: ix, signers: [] }];
  });

  return (await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  })) as BuiltTx[];
}

/**
 * Sign + send the built tx(s) sequentially. Each tx must confirm before
 * the next is sent (the second tx in a split scenario references state
 * created by the first). Returns the FINAL tx signature — i.e. the one
 * containing our settle_expiry IX, which the modal links out to Solscan.
 *
 * Single-tx atomic path is the norm. Multi-tx fallback only triggers if
 * the SDK can't fit post+consume+close in 1232 bytes; on retry, if the
 * second tx fails with PriceTooOld or MismatchedFeedId (rare race where
 * the ephemeral account expired between submissions), we surface the
 * error to the caller — the modal offers "Try again" which rebuilds
 * with a fresh Hermes update.
 */
export async function submitWithFallback(
  connection: Connection,
  wallet: SignerWallet,
  txs: BuiltTx[],
): Promise<string> {
  // Pre-sign with any ephemeral signers the SDK needs.
  for (const { tx, signers } of txs) {
    if (signers.length > 0) tx.sign(signers);
  }
  const userSigned = await wallet.signAllTransactions(txs.map((t) => t.tx));

  let lastSig = "";
  for (const signedTx of userSigned) {
    const sig = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, "confirmed");
    lastSig = sig;
  }
  return lastSig;
}

// ---------------------------------------------------------------------------
// One-stop settle helper — atomic Pyth tx + batched settle_vault calls
// ---------------------------------------------------------------------------

export type SettleAllResult = {
  /** Atomic tx signature (post + settle_expiry). Null if the SettlementRecord
   *  already existed and we resumed straight to Phase 2. */
  atomicSig: string | null;
  /** One signature per follow-up vault batch tx. */
  vaultSigs: string[];
  /** Total vault count finalized in this call. */
  vaultsFinalized: number;
};

const SETTLE_VAULT_CHUNK_SIZE = 5;

/**
 * One-stop "settle everything for this (asset, expiry) tuple" helper.
 *
 * Sequence:
 *   Phase 1 — Atomic Pyth tx: post_update + settle_expiry + close. Skipped
 *             if a SettlementRecord PDA already exists (partial-failure
 *             resume path).
 *   Phase 2 — settle_vault batches: one IX per vault, chunked into
 *             VersionedTransactions of SETTLE_VAULT_CHUNK_SIZE IXs each.
 *             Each chunk gets a fresh blockhash and is submitted
 *             sequentially with confirmation between chunks.
 *
 * This is the **client-side replacement for the not-yet-built crank bot**.
 * Once a crank exists, Phase 2 becomes redundant — the crank watches for
 * SettlementRecord events and calls settle_vault per vault in the
 * background. Phase 1 stays user-triggered either way.
 */
export async function settleAllForExpiry(
  program: Program<Opta>,
  wallet: SignerWallet,
  assetName: string,
  expiry: number,
  feedIdHex: string,
  vaultPdas: PublicKey[],
): Promise<SettleAllResult> {
  const connection = program.provider.connection;
  const expiryBN = new BN(expiry);

  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
    program.programId,
  );
  const [settlementPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(SETTLEMENT_SEED),
      Buffer.from(assetName),
      expiryBN.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );

  // ---- Phase 1: atomic Pyth tx (skipped if SettlementRecord exists) ----
  let atomicSig: string | null = null;
  const existing = await connection.getAccountInfo(settlementPda);
  if (!existing) {
    const atomicTxs = await buildPostUpdateAndSettleTx(
      program,
      wallet,
      assetName,
      expiry,
      feedIdHex,
    );
    atomicSig = await submitWithFallback(connection, wallet, atomicTxs);
  }

  // ---- Phase 2: settle_vault batches ----
  if (vaultPdas.length === 0) {
    return { atomicSig, vaultSigs: [], vaultsFinalized: 0 };
  }

  const ixs: TransactionInstruction[] = [];
  for (const vaultPda of vaultPdas) {
    const ix = await program.methods
      .settleVault()
      .accountsStrict({
        authority: wallet.publicKey,
        sharedVault: vaultPda,
        market: marketPda,
        settlementRecord: settlementPda,
      })
      .instruction();
    ixs.push(ix);
  }

  const vaultSigs: string[] = [];
  for (let i = 0; i < ixs.length; i += SETTLE_VAULT_CHUNK_SIZE) {
    const chunk = ixs.slice(i, i + SETTLE_VAULT_CHUNK_SIZE);
    const { blockhash } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: chunk,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const signed = (await wallet.signAllTransactions([tx]))[0];
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, "confirmed");
    vaultSigs.push(sig);
  }

  return { atomicSig, vaultSigs, vaultsFinalized: vaultPdas.length };
}
