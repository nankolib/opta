// ============================================================================
// crank/autoFinalize.ts — Holder + writer auto-finalize passes for the crank
// ============================================================================
//
// Two top-level entry points:
//
//   runHolderFinalize(ctx, vault, ataBudget, options): HolderFinalizeReport
//     - Enumerates all VaultMint records for `vault`.
//     - For each mint, calls getProgramAccounts(TOKEN_2022_PROGRAM_ID, mint)
//       to find every holder ATA. Filters off-chain: drops zero-balance
//       accounts and accounts owned by the protocol PDA (purchase escrows).
//     - Pre-creates missing holder USDC ATAs (idempotent), bounded by the
//       per-tick ATA budget.
//     - Chunks holder pairs and fires `auto_finalize_holders` txs.
//
//   runWriterFinalize(ctx, vault, ataBudget, options): WriterFinalizeReport
//     - Enumerates WriterPosition accounts for `vault` via Anchor's typed
//       fetcher (discriminator + memcmp on the vault field).
//     - Pre-creates missing writer USDC ATAs (shares the per-tick budget).
//     - Chunks writer triples and fires `auto_finalize_writers` txs.
//
// Both functions are per-vault. The bot.ts tick loop calls them once per
// settled vault that hasn't yet been cached as fully finalized.
//
// Failure isolation: every batch + every ATA pre-create is in its own
// try/catch; one failure logs and moves on. No state is persisted between
// ticks, so a failed tx is naturally retried on the next tick once the
// underlying issue (RPC flake, missing ATA) clears.
//
// Dry-run: when options.dryRun === true, both passes enumerate, log, and
// compute reports normally but skip every write op (ATA creates and
// finalize txs). Designed to be the operator's first-deploy safety check
// and a debugging tool for Step 6's smoke test.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  AccountMeta,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

import type { Opta } from "@app/idl/opta";

// ---- Constants -------------------------------------------------------------

/// VaultMint layout: 8-byte discriminator, then `vault: Pubkey` first.
const VAULT_MINT_VAULT_OFFSET = 8;

/// WriterPosition layout: 8 disc + 32 owner + 32 vault.
const WRITER_POSITION_VAULT_OFFSET = 8 + 32;

/// SPL Token / Token-2022 account layout: mint(0..32), owner(32..64), amount(64..72).
const TOKEN_OWNER_OFFSET = 32;
const TOKEN_AMOUNT_OFFSET = 64;

/// Max accounts per `getMultipleAccountsInfo` request. Solana RPC tolerates
/// up to 100 per call.
const GET_MULTI_ACCOUNTS_CHUNK = 100;

/// How many idempotent-ATA creates to fit in one tx. Each ATA create is
/// ~24K CU + ~21 accounts (system + token + ATA program + payer + new ATA +
/// rent + mint). Keep tx-account-budget generous.
const ATA_CREATES_PER_TX = 5;

// ---- Public types ----------------------------------------------------------

export interface AutoFinalizeContext {
  connection: Connection;
  program: anchor.Program<Opta>;
  usdcMint: PublicKey;
  protocolStatePda: PublicKey;
  treasuryPda: PublicKey;
  log: LogFn;
}

export type LogLevel = "info" | "warn" | "error";
export type LogFn = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

export interface AutoFinalizeOptions {
  holderBatchSize: number;
  writerBatchSize: number;
  /// Default 1.4M — same as the per-tx ceiling Solana enforces.
  computeUnitLimit: number;
  /// When true, enumerate + log only; send no transactions.
  dryRun: boolean;
}

export interface AtaBudget {
  /// Decremented as ATAs are pre-created. Shared across holder + writer
  /// passes (per-tick total, not per-pass).
  remaining: number;
}

export interface HolderFinalizeReport {
  vault: string;
  /// Number of VaultMint records discovered for this vault.
  mintsScanned: number;
  /// Total Token-2022 accounts returned by getProgramAccounts (all mints).
  holdersTotal: number;
  /// Dropped because amount == 0 or owner == protocol_state PDA.
  holdersFiltered: number;
  /// Holders that would be passed to `auto_finalize_holders` after filtering.
  holdersBatched: number;
  /// Best-effort: sum of `holders_processed` across all confirmed events.
  holdersProcessedFromEvents: number;
  /// holdersBatched - holdersProcessedFromEvents (silent on-chain skips).
  holdersSilentSkipsInferred: number;
  atasPreCreated: number;
  atasFailed: number;
  /// True iff this pass needed more ATA-creates than the budget had remaining.
  ataBudgetExhausted: boolean;
  txSent: number;
  txFailed: number;
  /// RPC discipline: number of getProgramAccounts calls (one per VaultMint).
  gpaCalls: number;
  dryRun: boolean;
}

export interface WriterFinalizeReport {
  vault: string;
  writersTotal: number;
  writersBatched: number;
  writersProcessedFromEvents: number;
  writersSilentSkipsInferred: number;
  dustSweptToTreasuryFromEvents: number;
  atasPreCreated: number;
  atasFailed: number;
  ataBudgetExhausted: boolean;
  txSent: number;
  txFailed: number;
  dryRun: boolean;
}

export const DEFAULT_FINALIZE_OPTIONS: AutoFinalizeOptions = {
  holderBatchSize: 20,
  writerBatchSize: 20,
  computeUnitLimit: 1_400_000,
  dryRun: false,
};

// ---- Internal helpers ------------------------------------------------------

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be > 0, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/// Best-effort: scan a confirmed tx's logMessages for our event types and
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

/// Pre-create a batch of missing ATAs in chunked txs. Caller has already
/// confirmed the budget allowance and decremented it. Returns counts of
/// successful + failed creates.
async function createAtas(
  ctx: AutoFinalizeContext,
  atas: Array<{ ata: PublicKey; owner: PublicKey }>,
  options: AutoFinalizeOptions,
): Promise<{ created: number; failed: number; txs: number }> {
  if (atas.length === 0) return { created: 0, failed: 0, txs: 0 };
  if (options.dryRun) {
    ctx.log("info", "dry-run: would pre-create ATAs", { count: atas.length });
    return { created: 0, failed: 0, txs: 0 };
  }

  const payer = ctx.program.provider.publicKey!;
  let created = 0;
  let failed = 0;
  let txs = 0;

  for (const group of chunk(atas, ATA_CREATES_PER_TX)) {
    const tx = new Transaction();
    for (const a of group) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          a.ata,
          a.owner,
          ctx.usdcMint,
          TOKEN_PROGRAM_ID,
        ),
      );
    }
    try {
      await ctx.program.provider.sendAndConfirm!(tx);
      created += group.length;
      txs += 1;
    } catch (err) {
      failed += group.length;
      txs += 1;
      ctx.log("warn", "ATA pre-create batch failed (will retry next tick)", {
        count: group.length,
        err: String(err),
      });
    }
  }

  return { created, failed, txs };
}

// ---- Holder pass -----------------------------------------------------------

interface HolderPair {
  holderOptionAta: PublicKey;
  holderUsdcAta: PublicKey;
  ownerWallet: PublicKey;
}

interface MintGroup {
  optionMint: PublicKey;
  vaultMintRecordPda: PublicKey;
  holders: HolderPair[];
}

export async function runHolderFinalize(
  ctx: AutoFinalizeContext,
  vault: PublicKey,
  ataBudget: AtaBudget,
  options: AutoFinalizeOptions = DEFAULT_FINALIZE_OPTIONS,
): Promise<HolderFinalizeReport> {
  const report: HolderFinalizeReport = {
    vault: vault.toBase58(),
    mintsScanned: 0,
    holdersTotal: 0,
    holdersFiltered: 0,
    holdersBatched: 0,
    holdersProcessedFromEvents: 0,
    holdersSilentSkipsInferred: 0,
    atasPreCreated: 0,
    atasFailed: 0,
    ataBudgetExhausted: false,
    txSent: 0,
    txFailed: 0,
    gpaCalls: 0,
    dryRun: options.dryRun,
  };

  // Fetch the vault account once — we need its market and vault_usdc_account.
  const vaultAccount = await ctx.program.account.sharedVault.fetch(vault);
  const marketPda = vaultAccount.market as PublicKey;
  const vaultUsdcPda = vaultAccount.vaultUsdcAccount as PublicKey;

  // 1. Enumerate VaultMint records for this vault.
  const vaultMintRecords = await ctx.program.account.vaultMint.all([
    {
      memcmp: {
        offset: VAULT_MINT_VAULT_OFFSET,
        bytes: vault.toBase58(),
      },
    },
  ]);
  report.mintsScanned = vaultMintRecords.length;

  if (vaultMintRecords.length === 0) {
    return report;
  }

  // 2. For each mint, gpa Token-2022 accounts and parse holder owner+amount.
  const mintGroups: MintGroup[] = [];
  const candidateOwners: PublicKey[] = [];

  for (const vmRec of vaultMintRecords) {
    const optionMint = vmRec.account.optionMint as PublicKey;
    const vaultMintRecordPda = vmRec.publicKey;

    type GpaItem = { pubkey: PublicKey; account: { data: Buffer } };
    let accounts: ReadonlyArray<GpaItem> = [];
    try {
      // No dataSize filter — Token-2022 ATAs are variable-length due to
      // TransferHookAccount extension on every account.
      accounts = await ctx.connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: optionMint.toBase58(),
            },
          },
        ],
      });
      report.gpaCalls += 1;
    } catch (err) {
      ctx.log("error", "getProgramAccounts failed for mint", {
        mint: optionMint.toBase58(),
        err: String(err),
      });
      continue;
    }

    report.holdersTotal += accounts.length;

    const holders: HolderPair[] = [];
    for (const acc of accounts) {
      const data = acc.account.data;
      if (data.length < TOKEN_AMOUNT_OFFSET + 8) {
        report.holdersFiltered += 1;
        continue;
      }
      const owner = new PublicKey(
        data.subarray(TOKEN_OWNER_OFFSET, TOKEN_OWNER_OFFSET + 32),
      );
      const amount = data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);

      // Filter: zero-balance + protocol-state-owned (purchase escrows).
      if (amount === 0n || owner.equals(ctx.protocolStatePda)) {
        report.holdersFiltered += 1;
        continue;
      }

      const usdcAta = getAssociatedTokenAddressSync(
        ctx.usdcMint,
        owner,
        false,
        TOKEN_PROGRAM_ID,
      );
      holders.push({
        holderOptionAta: acc.pubkey,
        holderUsdcAta: usdcAta,
        ownerWallet: owner,
      });
      candidateOwners.push(owner);
    }

    if (holders.length > 0) {
      mintGroups.push({ optionMint, vaultMintRecordPda, holders });
    }
  }

  if (mintGroups.length === 0) {
    return report;
  }

  // 3. Bulk-check which USDC ATAs need pre-creation (one or two
  //    getMultipleAccountsInfo calls regardless of holder count).
  const allUsdcAtas: PublicKey[] = [];
  for (const g of mintGroups) {
    for (const h of g.holders) {
      allUsdcAtas.push(h.holderUsdcAta);
    }
  }

  const ataExists = new Map<string, boolean>();
  for (const group of chunk(allUsdcAtas, GET_MULTI_ACCOUNTS_CHUNK)) {
    const infos = await ctx.connection.getMultipleAccountsInfo(group, "confirmed");
    for (let i = 0; i < group.length; i += 1) {
      ataExists.set(group[i].toBase58(), infos[i] !== null);
    }
  }

  // 4. Build the missing-ATA list, dedupe by ATA pubkey, respect budget.
  const missingAtaMap = new Map<string, { ata: PublicKey; owner: PublicKey }>();
  for (const g of mintGroups) {
    for (const h of g.holders) {
      const exists = ataExists.get(h.holderUsdcAta.toBase58()) ?? false;
      if (exists) continue;
      const key = h.holderUsdcAta.toBase58();
      if (!missingAtaMap.has(key)) {
        missingAtaMap.set(key, { ata: h.holderUsdcAta, owner: h.ownerWallet });
      }
    }
  }
  const missingAtas = Array.from(missingAtaMap.values());

  let toCreate = missingAtas;
  if (missingAtas.length > ataBudget.remaining) {
    report.ataBudgetExhausted = true;
    toCreate = missingAtas.slice(0, ataBudget.remaining);
    ctx.log("warn", "ATA pre-create budget exhausted (holder pass)", {
      vault: vault.toBase58(),
      missing: missingAtas.length,
      budgetRemaining: ataBudget.remaining,
    });
  }
  if (toCreate.length > 0) {
    const result = await createAtas(ctx, toCreate, options);
    report.atasPreCreated = result.created;
    report.atasFailed = result.failed;
    ataBudget.remaining = Math.max(0, ataBudget.remaining - result.created);
    // Refresh ataExists for the just-created (best-effort — assume all
    // succeeded; the next gpa tick will catch any that didn't).
    for (const a of toCreate) {
      if (result.failed === 0) {
        ataExists.set(a.ata.toBase58(), true);
      }
    }
  }

  // 5. Send auto_finalize_holders txs per (mint, batch).
  if (options.dryRun) {
    let dryBatched = 0;
    for (const g of mintGroups) {
      const sendable = g.holders.filter((h) =>
        ataExists.get(h.holderUsdcAta.toBase58()) === true,
      );
      dryBatched += sendable.length;
    }
    report.holdersBatched = dryBatched;
    ctx.log("info", "dry-run: would send auto_finalize_holders batches", {
      vault: vault.toBase58(),
      mints: mintGroups.length,
      holdersBatched: dryBatched,
    });
    return report;
  }

  const callerPubkey = ctx.program.provider.publicKey!;
  for (const g of mintGroups) {
    // Skip holders whose USDC ATA still doesn't exist (pre-create failed or
    // was budget-skipped). The on-chain handler would silent-skip them
    // anyway, but filtering off-chain shrinks the batch.
    const sendable = g.holders.filter((h) =>
      ataExists.get(h.holderUsdcAta.toBase58()) === true,
    );

    if (sendable.length === 0) continue;

    for (const batch of chunk(sendable, options.holderBatchSize)) {
      report.holdersBatched += batch.length;

      const remainingAccounts: AccountMeta[] = [];
      for (const h of batch) {
        remainingAccounts.push({
          pubkey: h.holderOptionAta,
          isSigner: false,
          isWritable: true,
        });
        remainingAccounts.push({
          pubkey: h.holderUsdcAta,
          isSigner: false,
          isWritable: true,
        });
      }

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnitLimit }),
      );

      try {
        const ix: TransactionInstruction = await (ctx.program as any).methods
          .autoFinalizeHolders()
          .accounts({
            caller: callerPubkey,
            sharedVault: vault,
            market: marketPda,
            vaultMintRecord: g.vaultMintRecordPda,
            optionMint: g.optionMint,
            vaultUsdcAccount: vaultUsdcPda,
            protocolState: ctx.protocolStatePda,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(remainingAccounts)
          .instruction();
        tx.add(ix);

        const sig = await ctx.program.provider.sendAndConfirm!(tx);
        report.txSent += 1;

        const event = await readEventFromTx<{ holdersProcessed: number }>(
          ctx,
          sig,
          "holdersFinalized",
        );
        if (event && typeof event.holdersProcessed === "number") {
          report.holdersProcessedFromEvents += event.holdersProcessed;
        }

        ctx.log("info", "holder finalize batch ok", {
          vault: vault.toBase58(),
          mint: g.optionMint.toBase58(),
          batchSize: batch.length,
          sig,
        });
      } catch (err) {
        report.txFailed += 1;
        ctx.log("error", "holder finalize batch failed (will retry next tick)", {
          vault: vault.toBase58(),
          mint: g.optionMint.toBase58(),
          batchSize: batch.length,
          err: String(err),
        });
      }
    }
  }

  report.holdersSilentSkipsInferred = Math.max(
    0,
    report.holdersBatched - report.holdersProcessedFromEvents,
  );

  return report;
}

// ---- Writer pass -----------------------------------------------------------

interface WriterTriple {
  writerPositionPda: PublicKey;
  writerUsdcAta: PublicKey;
  writerWallet: PublicKey;
}

export async function runWriterFinalize(
  ctx: AutoFinalizeContext,
  vault: PublicKey,
  ataBudget: AtaBudget,
  options: AutoFinalizeOptions = DEFAULT_FINALIZE_OPTIONS,
): Promise<WriterFinalizeReport> {
  const report: WriterFinalizeReport = {
    vault: vault.toBase58(),
    writersTotal: 0,
    writersBatched: 0,
    writersProcessedFromEvents: 0,
    writersSilentSkipsInferred: 0,
    dustSweptToTreasuryFromEvents: 0,
    atasPreCreated: 0,
    atasFailed: 0,
    ataBudgetExhausted: false,
    txSent: 0,
    txFailed: 0,
    dryRun: options.dryRun,
  };

  const vaultAccount = await ctx.program.account.sharedVault.fetch(vault);
  const vaultUsdcPda = vaultAccount.vaultUsdcAccount as PublicKey;
  const marketPda = vaultAccount.market as PublicKey;

  // 1. Enumerate WriterPosition accounts via Anchor's typed fetcher. The
  //    discriminator filter is added automatically; we add memcmp on the
  //    `vault` field at offset 8+32=40.
  const positions = await ctx.program.account.writerPosition.all([
    {
      memcmp: {
        offset: WRITER_POSITION_VAULT_OFFSET,
        bytes: vault.toBase58(),
      },
    },
  ]);
  report.writersTotal = positions.length;

  if (positions.length === 0) {
    return report;
  }

  // 2. Build triples and collect USDC ATAs to check.
  const triples: WriterTriple[] = positions.map((p) => {
    const owner = p.account.owner as PublicKey;
    const usdcAta = getAssociatedTokenAddressSync(
      ctx.usdcMint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
    );
    return {
      writerPositionPda: p.publicKey,
      writerUsdcAta: usdcAta,
      writerWallet: owner,
    };
  });

  // 3. Bulk-check ATA existence.
  const ataExists = new Map<string, boolean>();
  const allAtas = triples.map((t) => t.writerUsdcAta);
  for (const group of chunk(allAtas, GET_MULTI_ACCOUNTS_CHUNK)) {
    const infos = await ctx.connection.getMultipleAccountsInfo(group, "confirmed");
    for (let i = 0; i < group.length; i += 1) {
      ataExists.set(group[i].toBase58(), infos[i] !== null);
    }
  }

  // 4. Pre-create missing ATAs (subject to shared budget).
  const missingAtaMap = new Map<string, { ata: PublicKey; owner: PublicKey }>();
  for (const t of triples) {
    if (ataExists.get(t.writerUsdcAta.toBase58()) === true) continue;
    const key = t.writerUsdcAta.toBase58();
    if (!missingAtaMap.has(key)) {
      missingAtaMap.set(key, { ata: t.writerUsdcAta, owner: t.writerWallet });
    }
  }
  const missingAtas = Array.from(missingAtaMap.values());

  let toCreate = missingAtas;
  if (missingAtas.length > ataBudget.remaining) {
    report.ataBudgetExhausted = true;
    toCreate = missingAtas.slice(0, ataBudget.remaining);
    ctx.log("warn", "ATA pre-create budget exhausted (writer pass)", {
      vault: vault.toBase58(),
      missing: missingAtas.length,
      budgetRemaining: ataBudget.remaining,
    });
  }
  if (toCreate.length > 0) {
    const result = await createAtas(ctx, toCreate, options);
    report.atasPreCreated = result.created;
    report.atasFailed = result.failed;
    ataBudget.remaining = Math.max(0, ataBudget.remaining - result.created);
    for (const a of toCreate) {
      if (result.failed === 0) {
        ataExists.set(a.ata.toBase58(), true);
      }
    }
  }

  // 5. Send auto_finalize_writers txs.
  if (options.dryRun) {
    const dryBatched = triples.filter(
      (t) => ataExists.get(t.writerUsdcAta.toBase58()) === true,
    ).length;
    report.writersBatched = dryBatched;
    ctx.log("info", "dry-run: would send auto_finalize_writers batches", {
      vault: vault.toBase58(),
      writersBatched: dryBatched,
    });
    return report;
  }

  const callerPubkey = ctx.program.provider.publicKey!;
  const sendable = triples.filter(
    (t) => ataExists.get(t.writerUsdcAta.toBase58()) === true,
  );

  for (const batch of chunk(sendable, options.writerBatchSize)) {
    report.writersBatched += batch.length;

    const remainingAccounts: AccountMeta[] = [];
    for (const t of batch) {
      remainingAccounts.push({
        pubkey: t.writerPositionPda,
        isSigner: false,
        isWritable: true,
      });
      remainingAccounts.push({
        pubkey: t.writerUsdcAta,
        isSigner: false,
        isWritable: true,
      });
      remainingAccounts.push({
        pubkey: t.writerWallet,
        isSigner: false,
        isWritable: true,
      });
    }

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnitLimit }),
    );

    try {
      const ix: TransactionInstruction = await (ctx.program as any).methods
        .autoFinalizeWriters()
        .accounts({
          caller: callerPubkey,
          sharedVault: vault,
          market: marketPda,
          vaultUsdcAccount: vaultUsdcPda,
          treasury: ctx.treasuryPda,
          protocolState: ctx.protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remainingAccounts)
        .instruction();
      tx.add(ix);

      const sig = await ctx.program.provider.sendAndConfirm!(tx);
      report.txSent += 1;

      const event = await readEventFromTx<{
        writersProcessed: number;
        dustSweptToTreasury: anchor.BN | number;
      }>(ctx, sig, "writersFinalized");
      if (event) {
        if (typeof event.writersProcessed === "number") {
          report.writersProcessedFromEvents += event.writersProcessed;
        }
        const dust = event.dustSweptToTreasury;
        if (dust !== undefined && dust !== null) {
          const dustNum =
            typeof dust === "number"
              ? dust
              : (dust as anchor.BN).toNumber
              ? (dust as anchor.BN).toNumber()
              : 0;
          report.dustSweptToTreasuryFromEvents += dustNum;
        }
      }

      ctx.log("info", "writer finalize batch ok", {
        vault: vault.toBase58(),
        batchSize: batch.length,
        sig,
      });
    } catch (err) {
      report.txFailed += 1;
      ctx.log("error", "writer finalize batch failed (will retry next tick)", {
        vault: vault.toBase58(),
        batchSize: batch.length,
        err: String(err),
      });
    }
  }

  report.writersSilentSkipsInferred = Math.max(
    0,
    report.writersBatched - report.writersProcessedFromEvents,
  );

  return report;
}
