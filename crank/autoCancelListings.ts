// ============================================================================
// crank/autoCancelListings.ts — Auto-cancel-listings pass for the crank
// ============================================================================
//
// Single top-level entry point:
//
//   runAutoCancelListings(ctx, vault, options): AutoCancelReport
//     - Enumerates all VaultResaleListing accounts via safeFetchAll, filters
//       client-side to ones whose `vault` field matches the passed vault.
//     - For each surviving listing: derives the resale_escrow PDA + the
//       seller's Token-2022 option ATA + the seller's wallet pubkey.
//     - Bulk-checks seller option ATAs via getMultipleAccountsInfo;
//       skips + warns on missing ATAs (sellers can recover via
//       cancel_v2_resale themselves — the crank doesn't pre-create user state).
//     - Groups surviving listings by option_mint.
//     - Per (mint, batch): builds 4-tuple remaining_accounts, sends
//       `auto_cancel_listings` with an 800K CU budget.
//     - Reads VaultListingsAutoCancelled events to aggregate counts.
//
// Per-batch failure isolation: every tx is in its own try/catch. A single
// failing batch is logged and the loop continues with other batches. No
// state is persisted between ticks; the next tick re-enumerates from
// chain state and naturally retries.
//
// Dry-run: when options.dryRun === true, enumerate + log normally but
// skip every send op. Shares the OPTA_AUTO_FINALIZE_DRY_RUN flag the
// holder/writer passes already honor.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  AccountMeta,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { safeFetchAll } from "@app/hooks/useFetchAccounts";

import type { AutoFinalizeContext } from "./autoFinalize";

// ---- Constants -------------------------------------------------------------

/// Match programs/opta/src/state/vault_resale_listing.rs.
const VAULT_RESALE_LISTING_SEED = Buffer.from("vault_resale_listing");
const VAULT_RESALE_ESCROW_SEED = Buffer.from("vault_resale_escrow");

/// Match programs/opta/src/state/vault_mint.rs.
const VAULT_MINT_RECORD_SEED = Buffer.from("vault_mint_record");

/// Hook program for derived hook PDAs. Hardcoded — same value used by
/// every existing crank/script that touches the hook.
const HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG",
);

const EXTRA_ACCOUNT_METAS_SEED = Buffer.from("extra-account-metas");
const HOOK_STATE_SEED = Buffer.from("hook-state");

/// Max accounts per `getMultipleAccountsInfo` request.
const GET_MULTI_ACCOUNTS_CHUNK = 100;

// ---- Public types ----------------------------------------------------------

export interface AutoCancelOptions {
  /// Listings per `auto_cancel_listings` transaction. Each listing occupies
  /// 4 remaining-account slots and ~65K CU (Step 5 smoke measurement).
  listingsBatchSize: number;
  /// Per-tx CU budget for the auto-cancel call. Defaults to 800K — comfortably
  /// fits 8 listings × ~65K = 520K with headroom for the hook + close_account.
  computeUnitLimit: number;
  /// When true, enumerate + log only; send no transactions.
  dryRun: boolean;
}

export const DEFAULT_AUTO_CANCEL_OPTIONS: AutoCancelOptions = {
  listingsBatchSize: 8,
  computeUnitLimit: 800_000,
  dryRun: false,
};

export interface AutoCancelReport {
  vault: string;
  /// Listings whose `vault` field matches this vault.
  listingsTotal: number;
  /// Distinct option_mints across this vault's listings (= number of batches' mint groups).
  mintsScanned: number;
  /// Listings dropped pre-batch because the seller's option ATA doesn't exist.
  listingsSkippedMissingAta: number;
  /// Listings sent in any tx (post-filter, pre-on-chain).
  listingsBatched: number;
  /// Best-effort: sum of `listings_cancelled` across all confirmed events.
  listingsCancelledFromEvents: number;
  /// Best-effort: sum of `tokens_returned` across all confirmed events.
  tokensReturnedFromEvents: number;
  txSent: number;
  txFailed: number;
  dryRun: boolean;
}

// ---- Internal helpers ------------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be > 0, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/// Best-effort: scan a confirmed tx's logMessages for the target event and
/// return the parsed payload. Returns null if event not found / undecodeable.
async function readEventFromTx<T = any>(
  ctx: AutoFinalizeContext,
  signature: string,
  eventName: string,
): Promise<T | null> {
  try {
    const txInfo = await ctx.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = txInfo?.meta?.logMessages ?? [];
    for (const line of logs) {
      if (!line.startsWith("Program data: ")) continue;
      const base64 = line.slice("Program data: ".length);
      try {
        const decoded = ctx.program.coder.events.decode(base64);
        if (decoded?.name === eventName) {
          return decoded.data as T;
        }
      } catch {
        // Skip non-event "Program data:" lines silently.
      }
    }
  } catch {
    // RPC flake on getTransaction — surface as missing event, not a hard fail.
  }
  return null;
}

// ---- Per-listing context ---------------------------------------------------

interface ListingContext {
  listingPda: PublicKey;
  escrowPda: PublicKey;
  optionMint: PublicKey;
  sellerOptionAta: PublicKey;
  sellerWallet: PublicKey;
}

interface MintGroup {
  optionMint: PublicKey;
  vaultMintRecordPda: PublicKey;
  extraAccountMetaList: PublicKey;
  hookState: PublicKey;
  listings: ListingContext[];
}

// ---- Public entry point ----------------------------------------------------

export async function runAutoCancelListings(
  ctx: AutoFinalizeContext,
  vault: PublicKey,
  options: AutoCancelOptions = DEFAULT_AUTO_CANCEL_OPTIONS,
): Promise<AutoCancelReport> {
  const report: AutoCancelReport = {
    vault: vault.toBase58(),
    listingsTotal: 0,
    mintsScanned: 0,
    listingsSkippedMissingAta: 0,
    listingsBatched: 0,
    listingsCancelledFromEvents: 0,
    tokensReturnedFromEvents: 0,
    txSent: 0,
    txFailed: 0,
    dryRun: options.dryRun,
  };

  // 1. Fetch the vault account once — we need market for accountsStrict.
  const vaultAccount = await ctx.program.account.sharedVault.fetch(vault);
  const marketPda = vaultAccount.market as PublicKey;

  // 2. Enumerate listings via safeFetchAll, filter to this vault.
  const allListings = await safeFetchAll<{
    seller: PublicKey;
    vault: PublicKey;
    optionMint: PublicKey;
    listedQuantity: anchor.BN;
    pricePerContract: anchor.BN;
  }>(ctx.program, "vaultResaleListing");
  const listingsForVault = allListings.filter((l) =>
    (l.account.vault as PublicKey).equals(vault),
  );
  report.listingsTotal = listingsForVault.length;

  if (listingsForVault.length === 0) {
    return report;
  }

  // 3. Build per-listing context.
  const allContexts: ListingContext[] = listingsForVault.map((l) => {
    const seller = l.account.seller as PublicKey;
    const optionMint = l.account.optionMint as PublicKey;
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [VAULT_RESALE_ESCROW_SEED, l.publicKey.toBuffer()],
      ctx.program.programId,
    );
    const sellerOptionAta = getAssociatedTokenAddressSync(
      optionMint,
      seller,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    return {
      listingPda: l.publicKey,
      escrowPda,
      optionMint,
      sellerOptionAta,
      sellerWallet: seller,
    };
  });

  // 4. Bulk-check seller option ATAs.
  const ataExists = new Map<string, boolean>();
  const allAtas = allContexts.map((c) => c.sellerOptionAta);
  for (const group of chunk(allAtas, GET_MULTI_ACCOUNTS_CHUNK)) {
    const infos = await ctx.connection.getMultipleAccountsInfo(group, "confirmed");
    for (let i = 0; i < group.length; i += 1) {
      ataExists.set(group[i].toBase58(), infos[i] !== null);
    }
  }

  const sendable: ListingContext[] = [];
  for (const c of allContexts) {
    if (ataExists.get(c.sellerOptionAta.toBase58()) === true) {
      sendable.push(c);
    } else {
      report.listingsSkippedMissingAta += 1;
      ctx.log("warn", "auto-cancel: seller option ATA missing — listing skipped", {
        vault: vault.toBase58(),
        listing: c.listingPda.toBase58(),
        seller: c.sellerWallet.toBase58(),
        sellerOptionAta: c.sellerOptionAta.toBase58(),
      });
    }
  }

  if (sendable.length === 0) {
    return report;
  }

  // 5. Group by mint, derive per-mint shared accounts.
  const mintGroupMap = new Map<string, MintGroup>();
  for (const c of sendable) {
    const key = c.optionMint.toBase58();
    let g = mintGroupMap.get(key);
    if (!g) {
      const [vaultMintRecordPda] = PublicKey.findProgramAddressSync(
        [VAULT_MINT_RECORD_SEED, c.optionMint.toBuffer()],
        ctx.program.programId,
      );
      const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
        [EXTRA_ACCOUNT_METAS_SEED, c.optionMint.toBuffer()],
        HOOK_PROGRAM_ID,
      );
      const [hookState] = PublicKey.findProgramAddressSync(
        [HOOK_STATE_SEED, c.optionMint.toBuffer()],
        HOOK_PROGRAM_ID,
      );
      g = {
        optionMint: c.optionMint,
        vaultMintRecordPda,
        extraAccountMetaList,
        hookState,
        listings: [],
      };
      mintGroupMap.set(key, g);
    }
    g.listings.push(c);
  }
  const mintGroups = Array.from(mintGroupMap.values());
  report.mintsScanned = mintGroups.length;

  // 6. Dry-run short-circuit.
  if (options.dryRun) {
    for (const g of mintGroups) {
      report.listingsBatched += g.listings.length;
    }
    ctx.log("info", "dry-run: would send auto_cancel_listings batches", {
      vault: vault.toBase58(),
      mints: mintGroups.length,
      listingsBatched: report.listingsBatched,
    });
    return report;
  }

  // 7. Send per (mint, batch).
  const callerPubkey = ctx.program.provider.publicKey!;

  for (const g of mintGroups) {
    for (const batch of chunk(g.listings, options.listingsBatchSize)) {
      report.listingsBatched += batch.length;

      const remainingAccounts: AccountMeta[] = [];
      for (const c of batch) {
        remainingAccounts.push({ pubkey: c.listingPda, isSigner: false, isWritable: true });
        remainingAccounts.push({ pubkey: c.escrowPda, isSigner: false, isWritable: true });
        remainingAccounts.push({ pubkey: c.sellerOptionAta, isSigner: false, isWritable: true });
        remainingAccounts.push({ pubkey: c.sellerWallet, isSigner: false, isWritable: true });
      }

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnitLimit }),
      );

      try {
        const ix: TransactionInstruction = await (ctx.program as any).methods
          .autoCancelListings()
          .accounts({
            caller: callerPubkey,
            sharedVault: vault,
            market: marketPda,
            vaultMintRecord: g.vaultMintRecordPda,
            optionMint: g.optionMint,
            protocolState: ctx.protocolStatePda,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList: g.extraAccountMetaList,
            hookState: g.hookState,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(remainingAccounts)
          .instruction();
        tx.add(ix);

        const sig = await ctx.program.provider.sendAndConfirm!(tx);
        report.txSent += 1;

        const event = await readEventFromTx<{
          listingsCancelled: number;
          tokensReturned: anchor.BN | number;
        }>(ctx, sig, "vaultListingsAutoCancelled");
        if (event) {
          if (typeof event.listingsCancelled === "number") {
            report.listingsCancelledFromEvents += event.listingsCancelled;
          }
          const tr = event.tokensReturned;
          if (tr !== undefined && tr !== null) {
            const trNum =
              typeof tr === "number"
                ? tr
                : (tr as anchor.BN).toNumber
                ? (tr as anchor.BN).toNumber()
                : 0;
            report.tokensReturnedFromEvents += trNum;
          }
        }

        ctx.log("info", "auto-cancel batch ok", {
          vault: vault.toBase58(),
          mint: g.optionMint.toBase58(),
          batchSize: batch.length,
          sig,
        });
      } catch (err) {
        report.txFailed += 1;
        ctx.log("error", "auto-cancel batch failed (will retry next tick)", {
          vault: vault.toBase58(),
          mint: g.optionMint.toBase58(),
          batchSize: batch.length,
          err: String(err),
        });
      }
    }
  }

  return report;
}
