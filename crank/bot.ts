// ============================================================================
// crank/bot.ts — Settle automation crank for Opta
// ============================================================================
//
// Periodically scans for expired vault tuples and settles them via
// settleAllForExpiry (post Pyth update + settle_expiry + batched
// settle_vault). One file, one process, no daemon. Operator runs it
// manually; manual restart on crash.
//
// Run: npm start (from crank/ directory)
// Required env: OPTA_RPC_URL
// Optional env: OPTA_CRANK_KEYPAIR (default ~/.config/solana/id.json)
//               OPTA_CRANK_TICK_MS (default 300000 = 5 minutes)
//
// Step 3 deliverable: skeleton only — bootstrap, log, loop, signal handling.
// Tick logic lives in Step 4.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";
import { settleAllForExpiry } from "@app/utils/pythPullPost";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { hexFromBytes } from "@app/utils/format";

import {
  runHolderFinalize,
  runWriterFinalize,
  type AutoFinalizeContext,
  type AutoFinalizeOptions,
  type AtaBudget,
} from "./autoFinalize";

// ---- Constants -------------------------------------------------------------

const DEFAULT_TICK_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_KEYPAIR_PATH = path.join(os.homedir(), ".config/solana/id.json");
const IDL_JSON_PATH = path.resolve(__dirname, "../app/src/idl/opta.json");

// ---- Auto-finalize defaults (Step 5 wiring) -------------------------------
const DEFAULT_HOLDER_BATCH = 20;
const DEFAULT_WRITER_BATCH = 20;
const DEFAULT_MAX_ATAS_PER_TICK = 100;
const DEFAULT_STALE_S = 3600;
const DEFAULT_AUTO_FINALIZE_CU = 1_400_000;

// ---- Logging ---------------------------------------------------------------

type LogLevel = "info" | "warn" | "error" | "fatal";

function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...fields };
  // stdout for info/warn, stderr for error/fatal so log redirection separates streams
  const stream = level === "error" || level === "fatal" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + "\n");
}

const logInfo = (msg: string, f?: Record<string, unknown>) => log("info", msg, f);
const logWarn = (msg: string, f?: Record<string, unknown>) => log("warn", msg, f);
const logError = (msg: string, f?: Record<string, unknown>) => log("error", msg, f);
const logFatal = (msg: string, f?: Record<string, unknown>) => log("fatal", msg, f);

/** Strip api-key query param so RPC URL is safe to log. */
function redactRpc(url: string): string {
  return url.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
}

// ---- Context ---------------------------------------------------------------

interface CrankContext {
  connection: Connection;
  wallet: anchor.Wallet;
  program: anchor.Program<Opta>;
  tickMs: number;
  hermesBase: string;
  // Auto-finalize wiring (Step 5)
  finalizeCtx: AutoFinalizeContext;
  finalizeOptions: AutoFinalizeOptions;
  maxAtasPerTick: number;
  staleS: number;
  fullyFinalized: Set<string>;
}

interface AccountRecord {
  publicKey: PublicKey;
  account: any;
}

interface ExpiryTuple {
  /** Stable key = `${asset}:${expiry}`. */
  key: string;
  asset: string;
  expiry: number;
  feedIdHex: string;
  vaultPdas: PublicKey[];
}

interface TickResult {
  tuplesFound: number;
  tuplesProcessed: number;
  errors: number;
  // Auto-finalize wiring (Step 5)
  finalizeVaultsConsidered: number;
  finalizeVaultsAttempted: number;
  finalizeVaultsCachedDone: number;
  finalizeVaultsErrors: number;
  finalizeAtasCreated: number;
  finalizeGpaCalls: number;
}

/**
 * Group expired non-settled vaults by (asset, expiry). Mirrors the
 * client-side derivation in AdminTools.tsx — no SettlementRecord-existence
 * filter, since settleAllForExpiry handles the resume case internally
 * via its own getAccountInfo check.
 */
function computeExpiredTuples(
  vaults: AccountRecord[],
  markets: AccountRecord[],
): ExpiryTuple[] {
  const now = Math.floor(Date.now() / 1000);
  const marketByPda = new Map<string, AccountRecord>();
  for (const m of markets) marketByPda.set(m.publicKey.toBase58(), m);

  const grouped = new Map<string, ExpiryTuple>();
  for (const v of vaults) {
    const expiry =
      typeof v.account.expiry === "number"
        ? v.account.expiry
        : v.account.expiry.toNumber();
    if (expiry >= now) continue;
    if (v.account.isSettled) continue;
    const market = marketByPda.get((v.account.market as PublicKey).toBase58());
    if (!market) continue;
    const asset = market.account.assetName as string;
    if (!asset) continue;
    const key = `${asset}:${expiry}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.vaultPdas.push(v.publicKey);
    } else {
      grouped.set(key, {
        key,
        asset,
        expiry,
        feedIdHex: hexFromBytes(market.account.pythFeedId as number[]),
        vaultPdas: [v.publicKey],
      });
    }
  }
  return Array.from(grouped.values()).sort((a, b) => a.expiry - b.expiry);
}

function readEnv(): {
  rpcUrl: string;
  keypairPath: string;
  tickMs: number;
  hermesBase: string;
  // Auto-finalize wiring (Step 5)
  holderBatchSize: number;
  writerBatchSize: number;
  maxAtasPerTick: number;
  staleS: number;
  dryRun: boolean;
} {
  const rpcUrl = process.env.OPTA_RPC_URL;
  if (!rpcUrl) {
    logFatal("OPTA_RPC_URL is required (e.g., a Helius devnet endpoint)");
    process.exit(1);
  }
  const keypairPath = process.env.OPTA_CRANK_KEYPAIR ?? DEFAULT_KEYPAIR_PATH;
  const tickMsEnv = process.env.OPTA_CRANK_TICK_MS;
  const tickMs = tickMsEnv ? parseInt(tickMsEnv, 10) : DEFAULT_TICK_MS;
  if (!Number.isFinite(tickMs) || tickMs < 1000) {
    logFatal("OPTA_CRANK_TICK_MS must be a number >= 1000", { value: tickMsEnv });
    process.exit(1);
  }
  // Hermes endpoint — mainnet default (production-signed Wormhole VAAs that
  // Solana devnet's Wormhole Core Bridge tracks). Override via env to point
  // at the Beta cluster for staging.
  const hermesBase =
    process.env.OPTA_HERMES_BASE ?? "https://hermes.pyth.network";

  const parsePositiveInt = (envVal: string | undefined, defaultVal: number, name: string): number => {
    if (!envVal) return defaultVal;
    const n = parseInt(envVal, 10);
    if (!Number.isFinite(n) || n < 1) {
      logFatal(`${name} must be a positive integer`, { value: envVal });
      process.exit(1);
    }
    return n;
  };

  const holderBatchSize = parsePositiveInt(
    process.env.OPTA_AUTO_FINALIZE_HOLDER_BATCH,
    DEFAULT_HOLDER_BATCH,
    "OPTA_AUTO_FINALIZE_HOLDER_BATCH",
  );
  const writerBatchSize = parsePositiveInt(
    process.env.OPTA_AUTO_FINALIZE_WRITER_BATCH,
    DEFAULT_WRITER_BATCH,
    "OPTA_AUTO_FINALIZE_WRITER_BATCH",
  );
  const maxAtasPerTick = parsePositiveInt(
    process.env.OPTA_AUTO_FINALIZE_MAX_ATAS_PER_TICK,
    DEFAULT_MAX_ATAS_PER_TICK,
    "OPTA_AUTO_FINALIZE_MAX_ATAS_PER_TICK",
  );
  const staleS = parsePositiveInt(
    process.env.OPTA_AUTO_FINALIZE_STALE_S,
    DEFAULT_STALE_S,
    "OPTA_AUTO_FINALIZE_STALE_S",
  );
  const dryRunRaw = (process.env.OPTA_AUTO_FINALIZE_DRY_RUN ?? "").toLowerCase();
  const dryRun = dryRunRaw === "true" || dryRunRaw === "1" || dryRunRaw === "yes";

  return {
    rpcUrl,
    keypairPath,
    tickMs,
    hermesBase,
    holderBatchSize,
    writerBatchSize,
    maxAtasPerTick,
    staleS,
    dryRun,
  };
}

function loadKeypair(keypairPath: string): Keypair {
  let raw: string;
  try {
    raw = fs.readFileSync(keypairPath, "utf-8");
  } catch (err) {
    logFatal("failed to read keypair file", { path: keypairPath, err: String(err) });
    process.exit(1);
  }
  let secret: number[];
  try {
    secret = JSON.parse(raw) as number[];
  } catch (err) {
    logFatal("keypair file is not valid JSON", { path: keypairPath, err: String(err) });
    process.exit(1);
  }
  if (!Array.isArray(secret) || secret.length !== 64) {
    logFatal("keypair file must be a 64-byte JSON array", {
      path: keypairPath,
      length: Array.isArray(secret) ? secret.length : "n/a",
    });
    process.exit(1);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (err) {
    logFatal("invalid keypair bytes", { err: String(err) });
    process.exit(1);
  }
}

function loadIdl(): Opta {
  let raw: string;
  try {
    raw = fs.readFileSync(IDL_JSON_PATH, "utf-8");
  } catch (err) {
    logFatal("failed to read IDL file", { path: IDL_JSON_PATH, err: String(err) });
    process.exit(1);
  }
  try {
    return JSON.parse(raw) as Opta;
  } catch (err) {
    logFatal("IDL file is not valid JSON", { path: IDL_JSON_PATH, err: String(err) });
    process.exit(1);
  }
}

async function bootstrapContext(): Promise<CrankContext> {
  const env = readEnv();
  const connection = new Connection(env.rpcUrl, "confirmed");
  const keypair = loadKeypair(env.keypairPath);
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = loadIdl();
  const program = new anchor.Program<Opta>(idl, provider);

  // Auto-finalize wiring (Step 5): one-time PDA derivation + protocol_state
  // fetch to learn the canonical USDC mint + treasury PDA. Both are
  // singletons that don't change across ticks; cache once at boot.
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint as PublicKey;
  const treasuryPda = protocolState.treasury as PublicKey;

  const finalizeLog = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => {
    log(level, msg, fields ?? {});
  };

  const finalizeCtx: AutoFinalizeContext = {
    connection,
    program,
    usdcMint,
    protocolStatePda,
    treasuryPda,
    log: finalizeLog,
  };

  const finalizeOptions: AutoFinalizeOptions = {
    holderBatchSize: env.holderBatchSize,
    writerBatchSize: env.writerBatchSize,
    computeUnitLimit: DEFAULT_AUTO_FINALIZE_CU,
    dryRun: env.dryRun,
  };

  return {
    connection,
    wallet,
    program,
    tickMs: env.tickMs,
    hermesBase: env.hermesBase,
    finalizeCtx,
    finalizeOptions,
    maxAtasPerTick: env.maxAtasPerTick,
    staleS: env.staleS,
    fullyFinalized: new Set<string>(),
  };
}

// ---- Loop + signal handling ------------------------------------------------

let shutdownRequested = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick(ctx: CrankContext): Promise<TickResult> {
  const [vaults, markets] = await Promise.all([
    safeFetchAll<any>(ctx.program, "sharedVault"),
    safeFetchAll<any>(ctx.program, "optionsMarket"),
  ]);

  const result: TickResult = {
    tuplesFound: 0,
    tuplesProcessed: 0,
    errors: 0,
    finalizeVaultsConsidered: 0,
    finalizeVaultsAttempted: 0,
    finalizeVaultsCachedDone: 0,
    finalizeVaultsErrors: 0,
    finalizeAtasCreated: 0,
    finalizeGpaCalls: 0,
  };

  // ---- Phase 1: settle expired non-settled vaults (existing behavior) ----
  const tuples = computeExpiredTuples(
    vaults as AccountRecord[],
    markets as AccountRecord[],
  );
  result.tuplesFound = tuples.length;

  if (tuples.length > 0) {
    logInfo("tuples to process", { count: tuples.length });

    for (const t of tuples) {
      if (shutdownRequested) break;
      try {
        const settleResult = await settleAllForExpiry(
          ctx.program,
          ctx.wallet,
          t.asset,
          t.expiry,
          t.feedIdHex,
          t.vaultPdas,
          ctx.hermesBase,
        );
        logInfo("tuple settled", {
          asset: t.asset,
          expiry: t.expiry,
          vaultsFinalized: settleResult.vaultsFinalized,
          atomicSig: settleResult.atomicSig,
          vaultBatchTxs: settleResult.vaultSigs.length,
          resumed: settleResult.atomicSig === null,
        });
      } catch (err) {
        result.errors += 1;
        logError("tuple failed (will retry next tick)", {
          asset: t.asset,
          expiry: t.expiry,
          err: String(err),
        });
      }
    }
    result.tuplesProcessed = tuples.length - result.errors;
  }

  if (shutdownRequested) {
    return result;
  }

  // ---- Phase 2: auto-finalize settled vaults (Step 5 wiring) ------------
  // Re-fetch shared vaults so newly-settled vaults from Phase 1 have their
  // is_settled flag refreshed locally. One extra RPC; acceptable cost.
  let refreshedVaults: AccountRecord[];
  try {
    refreshedVaults = (await safeFetchAll<any>(
      ctx.program,
      "sharedVault",
    )) as AccountRecord[];
  } catch (err) {
    logError("phase 2: re-fetch sharedVault failed", { err: String(err) });
    return result;
  }

  // Per-tick ATA pre-create budget — shared across holder + writer passes.
  const ataBudget: AtaBudget = { remaining: ctx.maxAtasPerTick };

  const nowSec = Math.floor(Date.now() / 1000);

  for (const v of refreshedVaults) {
    if (shutdownRequested) break;
    if (!v.account.isSettled) continue;

    const vaultKey = v.publicKey.toBase58();
    if (ctx.fullyFinalized.has(vaultKey)) {
      result.finalizeVaultsCachedDone += 1;
      continue;
    }

    result.finalizeVaultsConsidered += 1;

    // Stale warn: vault settled long ago but still not finalized.
    const expirySec =
      typeof v.account.expiry === "number"
        ? v.account.expiry
        : v.account.expiry.toNumber();
    if (expirySec > 0 && nowSec - expirySec > ctx.staleS) {
      logWarn("vault stale, still not fully finalized", {
        vault: vaultKey,
        secondsSinceExpiry: nowSec - expirySec,
        staleS: ctx.staleS,
      });
    }

    let holderProgressed = false;
    let writerProgressed = false;
    let holderEmptyScan = false;
    let writerEmptyScan = false;

    // Holder pass
    try {
      result.finalizeVaultsAttempted += 1;
      const holderReport = await runHolderFinalize(
        ctx.finalizeCtx,
        v.publicKey,
        ataBudget,
        ctx.finalizeOptions,
      );
      result.finalizeAtasCreated += holderReport.atasPreCreated;
      result.finalizeGpaCalls += holderReport.gpaCalls;
      holderProgressed = holderReport.txSent > 0 || holderReport.atasPreCreated > 0;
      // "Empty scan" = no holder ATAs with positive balance after filtering.
      // Equivalent to "vault has no remaining holders to burn".
      holderEmptyScan =
        holderReport.holdersTotal - holderReport.holdersFiltered === 0;

      logInfo("holder finalize pass", { ...holderReport });
    } catch (err) {
      result.finalizeVaultsErrors += 1;
      logError("holder finalize pass crashed", {
        vault: vaultKey,
        err: String(err),
      });
      continue;
    }

    if (shutdownRequested) break;

    // Writer pass
    try {
      const writerReport = await runWriterFinalize(
        ctx.finalizeCtx,
        v.publicKey,
        ataBudget,
        ctx.finalizeOptions,
      );
      result.finalizeAtasCreated += writerReport.atasPreCreated;
      writerProgressed = writerReport.txSent > 0 || writerReport.atasPreCreated > 0;
      writerEmptyScan = writerReport.writersTotal === 0;

      logInfo("writer finalize pass", { ...writerReport });
    } catch (err) {
      result.finalizeVaultsErrors += 1;
      logError("writer finalize pass crashed", {
        vault: vaultKey,
        err: String(err),
      });
      continue;
    }

    // "Fully finalized" cache: both passes saw nothing to do AND nothing
    // failed AND we did no real work this round. In dry-run mode we never
    // cache (the operator wants to see the same enumeration each tick).
    if (
      !ctx.finalizeOptions.dryRun &&
      holderEmptyScan &&
      writerEmptyScan &&
      !holderProgressed &&
      !writerProgressed
    ) {
      ctx.fullyFinalized.add(vaultKey);
      logInfo("vault marked fully finalized (process-lifetime cache)", {
        vault: vaultKey,
      });
    }
  }

  return result;
}

async function runForever(ctx: CrankContext): Promise<void> {
  while (!shutdownRequested) {
    const startMs = Date.now();
    try {
      const result = await tick(ctx);
      // Per locked decision: suppress idle-tick log noise. Tick is "active"
      // if Phase 1 saw expired tuples OR Phase 2 considered any settled
      // vaults that weren't already cached as fully finalized.
      const hadWork =
        result.tuplesFound > 0 || result.finalizeVaultsConsidered > 0;
      if (hadWork) {
        logInfo("tick complete", { ...result, durationMs: Date.now() - startMs });
      }
    } catch (err) {
      logError("tick failed (will retry next interval)", {
        err: String(err),
        durationMs: Date.now() - startMs,
      });
    }
    if (shutdownRequested) break;
    await sleep(ctx.tickMs);
  }
}

// ---- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const ctx = await bootstrapContext();
  logInfo("crank started", {
    wallet: ctx.wallet.publicKey.toBase58(),
    rpc: redactRpc(ctx.connection.rpcEndpoint),
    hermesBase: ctx.hermesBase,
    intervalMs: ctx.tickMs,
    programId: ctx.program.programId.toBase58(),
    autoFinalize: {
      holderBatchSize: ctx.finalizeOptions.holderBatchSize,
      writerBatchSize: ctx.finalizeOptions.writerBatchSize,
      computeUnitLimit: ctx.finalizeOptions.computeUnitLimit,
      maxAtasPerTick: ctx.maxAtasPerTick,
      staleS: ctx.staleS,
      dryRun: ctx.finalizeOptions.dryRun,
      treasury: ctx.finalizeCtx.treasuryPda.toBase58(),
      usdcMint: ctx.finalizeCtx.usdcMint.toBase58(),
    },
  });

  const onSignal = (sig: string) => {
    if (shutdownRequested) return; // ignore second signal
    shutdownRequested = true;
    logInfo("shutdown requested, exiting after current tick", { signal: sig });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  await runForever(ctx);
  logInfo("crank stopped cleanly");
}

main().catch((err) => {
  logFatal("main loop crashed", { err: String(err), stack: err?.stack });
  process.exit(1);
});
