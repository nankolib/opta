// ============================================================================
// crank/sweepExpiredOrders.ts — Post-expiry order-sweep pass for the crank
// ============================================================================
//
// Cloned from autoCancelListings.ts, adapted to the two-sided RestingOrder
// book. Single top-level entry point:
//
//   runSweepExpiredOrders(ctx, vault, options): SweepReport
//     - Enumerates all RestingOrder accounts via safeFetchAll, filters
//       client-side to ones whose `vault` field matches the passed vault.
//     - For each order: derives the per-order escrow PDA + the owner's asset
//       ATA (option ATA for ResaleAsk, USDC ATA for Bid) + the owner wallet.
//     - Bulk-checks owner asset ATAs via getMultipleAccountsInfo; skips + warns
//       on missing ATAs (owners recover via cancel_order themselves — the crank
//       doesn't pre-create user state).
//     - Groups surviving orders by option_mint (mixed kinds OK).
//     - Per (mint, batch): builds 4-tuple remaining_accounts, sends
//       `sweep_expired_orders` with an 800K CU budget.
//
// Runs BEFORE the holder finalize pass (sweep-before-finalize), so an ask's
// freshly-returned tokens become holder-finalize candidates. Per-batch failure
// isolation: every tx is in its own try/catch; a failing batch is logged and
// the loop continues. No state persisted between ticks — the next tick
// re-enumerates from chain state and naturally retries.
//
// Dry-run: when options.dryRun === true, enumerate + log only, send nothing.
// Shares the OPTA_AUTO_FINALIZE_DRY_RUN flag.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  AccountMeta,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { safeFetchAll } from "@app/hooks/useFetchAccounts";

import type { AutoFinalizeContext } from "./autoFinalize";
import { SweepQuarantine, quarantineKey } from "./sweepQuarantine";

// ---- Constants -------------------------------------------------------------

/// Match programs/opta/src/state/resting_order.rs.
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");

/// Match programs/opta/src/state/vault_mint.rs.
const VAULT_MINT_RECORD_SEED = Buffer.from("vault_mint_record");

/// Hook program for derived hook PDAs. Hardcoded — same value used by every
/// existing crank/script that touches the hook.
const HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG",
);

const EXTRA_ACCOUNT_METAS_SEED = Buffer.from("extra-account-metas");
const HOOK_STATE_SEED = Buffer.from("hook-state");

/// Max accounts per `getMultipleAccountsInfo` request.
const GET_MULTI_ACCOUNTS_CHUNK = 100;

// ---- Public types ----------------------------------------------------------

export interface SweepOptions {
  /// Orders per `sweep_expired_orders` transaction. Each order occupies 4
  /// remaining-account slots — the 4-tuple precedent caps this at 8 (the
  /// auto-cancel default), well under the 1232-byte tx serialization limit.
  ordersBatchSize: number;
  /// Per-tx CU budget. Defaults to 800K — comfortably fits 8 orders with the
  /// hook + close_account overhead.
  computeUnitLimit: number;
  /// When true, enumerate + log only; send no transactions.
  dryRun: boolean;
  /// A (vault, mint) batch that failed QUARANTINE_AFTER_FAILURES times in a
  /// row is quarantined: announced once, retried daily. Absent = never quarantine.
  quarantine?: SweepQuarantine;
}

export const DEFAULT_SWEEP_OPTIONS: SweepOptions = {
  ordersBatchSize: 8,
  computeUnitLimit: 800_000,
  dryRun: false,
};

export interface SweepReport {
  vault: string;
  /// Orders whose `vault` field matches this vault.
  ordersTotal: number;
  /// Distinct option_mints across this vault's orders.
  mintsScanned: number;
  /// Orders dropped pre-batch because the owner's asset ATA doesn't exist.
  ordersSkippedMissingAta: number;
  /// Orders sent in any tx (post-filter, pre-on-chain).
  ordersBatched: number;
  /// Best-effort: count of OrderSwept events across all confirmed txs.
  ordersSweptFromEvents: number;
  txSent: number;
  txFailed: number;
  /// Batches not sent this pass because they are quarantined and not yet due.
  batchesQuarantined: number;
  /// Batches whose failure crossed the quarantine line on this pass.
  batchesNewlyQuarantined: number;
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

/// True when an anchor-decoded OrderKind enum is the ResaleAsk variant.
function isResaleAsk(kind: any): boolean {
  return kind != null && typeof kind === "object" && "resaleAsk" in kind;
}
function isBid(kind: any): boolean {
  return kind != null && typeof kind === "object" && "bid" in kind;
}

/// Best-effort: count OrderSwept events in a confirmed tx's logMessages.
/// sweep_expired_orders emits one OrderSwept per tuple (no summary event), so
/// we scan all "Program data:" lines rather than returning the first match.
async function countOrderSweptEvents(
  ctx: AutoFinalizeContext,
  signature: string,
): Promise<number> {
  let count = 0;
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
        if (decoded?.name === "orderSwept") count += 1;
      } catch {
        // Skip non-event "Program data:" lines silently.
      }
    }
  } catch {
    // RPC flake on getTransaction — surface as zero, not a hard fail.
  }
  return count;
}

// ---- Per-order context -----------------------------------------------------

interface OrderContext {
  orderPda: PublicKey;
  escrowPda: PublicKey;
  optionMint: PublicKey;
  /// Owner's option ATA (ResaleAsk) or USDC ATA (Bid) — the return destination.
  ownerAssetAta: PublicKey;
  ownerWallet: PublicKey;
}

interface MintGroup {
  optionMint: PublicKey;
  vaultMintRecordPda: PublicKey;
  extraAccountMetaList: PublicKey;
  hookState: PublicKey;
  orders: OrderContext[];
}

// ---- Public entry point ----------------------------------------------------

export async function runSweepExpiredOrders(
  ctx: AutoFinalizeContext,
  vault: PublicKey,
  options: SweepOptions = DEFAULT_SWEEP_OPTIONS,
): Promise<SweepReport> {
  const report: SweepReport = {
    vault: vault.toBase58(),
    ordersTotal: 0,
    mintsScanned: 0,
    ordersSkippedMissingAta: 0,
    ordersBatched: 0,
    ordersSweptFromEvents: 0,
    txSent: 0,
    txFailed: 0,
    batchesQuarantined: 0,
    batchesNewlyQuarantined: 0,
    dryRun: options.dryRun,
  };

  // 1. Fetch the vault account once — we need market for accountsStrict.
  const vaultAccount = await ctx.program.account.sharedVault.fetch(vault);
  const marketPda = vaultAccount.market as PublicKey;

  // 2. Enumerate orders via safeFetchAll, filter to this vault.
  const allOrders = await safeFetchAll<{
    owner: PublicKey;
    optionMint: PublicKey;
    vault: PublicKey;
    kind: any;
    pricePerContract: anchor.BN;
    quantityRemaining: anchor.BN;
  }>(ctx.program, "restingOrder");
  const ordersForVault = allOrders.filter((o) =>
    (o.account.vault as PublicKey).equals(vault),
  );
  report.ordersTotal = ordersForVault.length;

  if (ordersForVault.length === 0) {
    return report;
  }

  // 3. Build per-order context (asset ATA depends on kind).
  const allContexts: OrderContext[] = [];
  for (const o of ordersForVault) {
    const owner = o.account.owner as PublicKey;
    const optionMint = o.account.optionMint as PublicKey;
    const kind = o.account.kind;
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [RESTING_ORDER_ESCROW_SEED, o.publicKey.toBuffer()],
      ctx.program.programId,
    );

    let ownerAssetAta: PublicKey;
    if (isResaleAsk(kind)) {
      ownerAssetAta = getAssociatedTokenAddressSync(
        optionMint,
        owner,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
    } else if (isBid(kind)) {
      ownerAssetAta = getAssociatedTokenAddressSync(
        ctx.usdcMint,
        owner,
        false,
        TOKEN_PROGRAM_ID,
      );
    } else {
      // WriterAsk can never be posted; skip defensively (don't batch it).
      ctx.log("warn", "sweep: order has unexpected kind — skipped", {
        vault: vault.toBase58(),
        order: o.publicKey.toBase58(),
        kind: JSON.stringify(kind),
      });
      continue;
    }

    allContexts.push({
      orderPda: o.publicKey,
      escrowPda,
      optionMint,
      ownerAssetAta,
      ownerWallet: owner,
    });
  }

  // 4. Bulk-check owner asset ATAs.
  const ataExists = new Map<string, boolean>();
  const allAtas = allContexts.map((c) => c.ownerAssetAta);
  for (const group of chunk(allAtas, GET_MULTI_ACCOUNTS_CHUNK)) {
    const infos = await ctx.connection.getMultipleAccountsInfo(group, "confirmed");
    for (let i = 0; i < group.length; i += 1) {
      ataExists.set(group[i].toBase58(), infos[i] !== null);
    }
  }

  const sendable: OrderContext[] = [];
  for (const c of allContexts) {
    if (ataExists.get(c.ownerAssetAta.toBase58()) === true) {
      sendable.push(c);
    } else {
      report.ordersSkippedMissingAta += 1;
      ctx.log("warn", "sweep: owner asset ATA missing — order skipped", {
        vault: vault.toBase58(),
        order: c.orderPda.toBase58(),
        owner: c.ownerWallet.toBase58(),
        ownerAssetAta: c.ownerAssetAta.toBase58(),
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
        orders: [],
      };
      mintGroupMap.set(key, g);
    }
    g.orders.push(c);
  }
  const mintGroups = Array.from(mintGroupMap.values());
  report.mintsScanned = mintGroups.length;

  // 6. Dry-run short-circuit.
  if (options.dryRun) {
    for (const g of mintGroups) {
      report.ordersBatched += g.orders.length;
    }
    ctx.log("info", "dry-run: would send sweep_expired_orders batches", {
      vault: vault.toBase58(),
      mints: mintGroups.length,
      ordersBatched: report.ordersBatched,
    });
    return report;
  }

  // 7. Send per (mint, batch).
  const callerPubkey = ctx.program.provider.publicKey!;

  for (const g of mintGroups) {
    const qKey = quarantineKey(vault.toBase58(), g.optionMint.toBase58());
    const decision = options.quarantine?.decide(qKey, Date.now());
    if (decision && !decision.attempt) {
      // Quarantined and not yet due. Silent on the tick: the announcement was
      // made once, at the transition; the heartbeat carries the count.
      report.batchesQuarantined += chunk(g.orders, options.ordersBatchSize).length;
      continue;
    }
    if (decision && decision.reason === "daily-retry") {
      ctx.log("info", "sweep: quarantined batch retried (daily)", { vault: vault.toBase58(), mint: g.optionMint.toBase58() });
    }
    for (const batch of chunk(g.orders, options.ordersBatchSize)) {
      report.ordersBatched += batch.length;

      const remainingAccounts: AccountMeta[] = [];
      for (const c of batch) {
        remainingAccounts.push({ pubkey: c.orderPda, isSigner: false, isWritable: true });
        remainingAccounts.push({ pubkey: c.escrowPda, isSigner: false, isWritable: true });
        remainingAccounts.push({ pubkey: c.ownerAssetAta, isSigner: false, isWritable: true });
        remainingAccounts.push({ pubkey: c.ownerWallet, isSigner: false, isWritable: true });
      }

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnitLimit }),
      );

      try {
        const ix: TransactionInstruction = await (ctx.program as any).methods
          .sweepExpiredOrders()
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
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts(remainingAccounts)
          .instruction();
        tx.add(ix);

        const sig = await ctx.program.provider.sendAndConfirm!(tx);
        report.txSent += 1;
        options.quarantine?.recordSuccess(qKey);
        report.ordersSweptFromEvents += await countOrderSweptEvents(ctx, sig);

        ctx.log("info", "sweep batch ok", {
          vault: vault.toBase58(),
          mint: g.optionMint.toBase58(),
          batchSize: batch.length,
          sig,
        });
      } catch (err) {
        const outcome = options.quarantine?.recordFailure(qKey, Date.now());
        if (outcome?.transitioned) {
          report.batchesNewlyQuarantined += 1;
          ctx.log("warn", "sweep batch QUARANTINED: failed on " + outcome.failures + " consecutive passes; retried once a day from now", {
            vault: vault.toBase58(),
            mint: g.optionMint.toBase58(),
            batchSize: batch.length,
            failures: outcome.failures,
            err: String(err).slice(0, 300),
          });
        } else if (outcome?.quarantined) {
          // A failed daily retry: stays quarantined, no second announcement,
          // and not an error on the heartbeat.
          report.batchesQuarantined += 1;
          ctx.log("info", "sweep: quarantined batch still failing", { vault: vault.toBase58(), mint: g.optionMint.toBase58(), failures: outcome.failures });
        } else {
          report.txFailed += 1;
          ctx.log("error", "sweep batch failed (will retry next tick)", {
            vault: vault.toBase58(),
            mint: g.optionMint.toBase58(),
            batchSize: batch.length,
            failures: outcome?.failures ?? null,
            err: String(err),
          });
        }
      }
    }
  }

  return report;
}
