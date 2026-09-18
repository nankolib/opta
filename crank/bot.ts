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
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
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
import { PersistentFinalizeCache } from "./finalizeCache";

/**
 * Persist the finalize cache every N marks during a sweep. A cold sweep covers
 * thousands of vaults over roughly an hour, so waiting for the end of the loop
 * would leave a long window in which a restart loses every mark. 200 keeps the
 * write volume trivial (one small rename per ~200 vaults) while capping the loss.
 */
const FINALIZE_CACHE_FLUSH_EVERY = 200;
import {
  runAutoCancelListings,
  type AutoCancelOptions,
} from "./autoCancelListings";
import {
  runSweepExpiredOrders,
  type SweepOptions,
} from "./sweepExpiredOrders";
import {
  planSettleFanout,
  runSettleFanout,
  cleanAssetName,
  FANOUT_MAX_PER_TICK,
} from "./settleVaultFanout";
import {
  runVolOracleCrank,
  type VolOracleCrankContext,
  type VolOracleCrankOptions,
} from "./volOracleCrank";
import { runOptaVolCrank, type OptaVolCrankContext } from "./optaVolCrank";
import {
  runTriggerCrank,
  type TriggerCrankContext,
  type TriggerCrankOptions,
} from "./triggerCrank";
import {
  runSbOracleCrank,
  parseForceFeeds,
  parseForceSettles,
  type SbOracleCrankContext,
  type SbOracleCrankOptions,
} from "./sbOracleCrank";
import {
  startSbCreateMarketServer,
  type SbCreateServerHandle,
} from "./sbCreateMarketEndpoint";
import {
  runLivenessCrank,
  type LivenessCrankContext,
  type LivenessCrankOptions,
} from "./livenessCrank";
import { runReclaimSweep, type ReclaimContext } from "./reclaimUnsettled";

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

// ---- Auto-cancel defaults (Step 6 wiring) ---------------------------------
const DEFAULT_LISTINGS_PER_BATCH = 8;
const DEFAULT_AUTO_CANCEL_CU = 800_000;

// ---- Sweep-expired-orders defaults (Phase 1 exchange book) ----------------
const DEFAULT_SWEEP_ORDERS_PER_BATCH = 8;
const DEFAULT_SWEEP_ORDERS_CU = 800_000;

// ---- Wallet-balance defaults (Phase 1 hardening) --------------------------
const DEFAULT_LOW_BALANCE_WARN_SOL = 0.1;
const DEFAULT_BALANCE_CHECK_TICKS = 12;

// ---- Hermes 429 adaptive backoff (settle-loop) ----------------------------
const DEFAULT_HERMES_BACKOFF_BASE_MS = 500;
const DEFAULT_HERMES_BACKOFF_CEILING_MS = 10_000;
/** Multiplicative-increase factor on 429/5xx. Hardcoded to keep env surface lean. */
const HERMES_BACKOFF_MULTIPLIER = 2;
/** Consecutive-success threshold before halving currentMs back toward BASE. */
const HERMES_BACKOFF_RECOVER_AFTER_N_OK = 3;

// ---- Heartbeat (Phase 1 hardening) ----------------------------------------
const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;

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

interface HermesBackoffState {
  currentMs: number;
  consecutiveOk: number;
}

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
  // Disk-backed since D1 (ticket 86eyn66b4): an in-memory Set was rebuilt from
  // nothing on every restart, re-paying a 10-credit gPA per settled vault per
  // process lifetime. Suppression is re-authorised against live state on every
  // read — see finalizeCache.ts.
  fullyFinalized: PersistentFinalizeCache;
  // Auto-cancel wiring (Step 6 — V2 secondary listing)
  autoCancelOptions: AutoCancelOptions;
  // Sweep-expired-orders wiring (Phase 1 exchange book)
  sweepOptions: SweepOptions;
  // Wallet-balance check (Phase 1 hardening)
  lowBalanceWarnSol: number;
  balanceCheckTicks: number;
  // Hermes 429 adaptive backoff (settle-loop only — independent from vol-oracle)
  hermesBackoff: HermesBackoffState;
  hermesBackoffBaseMs: number;
  hermesBackoffCeilingMs: number;
  // Dead-feed reclaim pass (Phase 3 — opt-in, moves money)
  reclaimEnabled: boolean;
  reclaimCtx: ReclaimContext;
  reclaimDryRun: boolean;
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
  /** Phase 1b — settle_vault fan-out (every oracle arm). */
  fanoutEligible: number;
  fanoutSettled: number;
  fanoutSkippedRaced: number;
  fanoutFailed: number;
  fanoutTxs: number;
  fanoutRemaining: number;
  tuplesProcessed: number;
  errors: number;
  errorsRateLimit: number;
  errorsHermesNoUpdate: number;
  errorsOther: number;
  // Auto-finalize wiring (Step 5)
  finalizeVaultsConsidered: number;
  finalizeVaultsAttempted: number;
  finalizeVaultsCachedDone: number;
  finalizeVaultsErrors: number;
  finalizeAtasCreated: number;
  finalizeGpaCalls: number;
  // Auto-cancel wiring (Step 6)
  finalizeListingsConsidered: number;
  finalizeListingsCancelled: number;
  finalizeListingsAtaSkipped: number;
  finalizeListingsErrors: number;
  // Sweep-expired-orders wiring (Phase 1 exchange book)
  sweepOrdersConsidered: number;
  sweepOrdersSwept: number;
  sweepOrdersAtaSkipped: number;
  sweepOrdersErrors: number;
  // Dead-feed reclaim (Phase 3)
  reclaimCandidates: number;
  reclaimVoided: number;
  reclaimWritersReclaimed: number;
  reclaimErrors: number;
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
    // Stage 3 1c-ii-B: Switchboard markets (oracle_source==1) are settled by the
    // sb-oracle crank's SB settle-at-expiry pass (fresh quote + settle_expiry SB
    // arm within the 300s window) — NOT the Pyth/Hermes path. Skip them here so
    // the Pyth settle loop never tries (and errors SwitchboardAccountsMissing) on
    // them. Pyth markets (oracle_source==0/undefined) are unaffected — byte-
    // identical tuple grouping.
    if ((market.account.oracleSource as number) === 1) continue;
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
  // Auto-cancel wiring (Step 6)
  listingsBatchSize: number;
  // Sweep-expired-orders wiring (Phase 1 exchange book)
  sweepOrdersBatchSize: number;
  // Phase 1 hardening
  lowBalanceWarnSol: number;
  balanceCheckTicks: number;
  // Hermes 429 adaptive backoff
  hermesBackoffBaseMs: number;
  hermesBackoffCeilingMs: number;
  // Dead-feed reclaim pass (Phase 3 — opt-in)
  reclaimEnabled: boolean;
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

  const parsePositiveFloat = (envVal: string | undefined, defaultVal: number, name: string): number => {
    if (!envVal) return defaultVal;
    const n = Number(envVal);
    if (!Number.isFinite(n) || n <= 0) {
      logFatal(`${name} must be a positive number`, { value: envVal });
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
  const listingsBatchSize = parsePositiveInt(
    process.env.OPTA_AUTO_CANCEL_BATCH_SIZE,
    DEFAULT_LISTINGS_PER_BATCH,
    "OPTA_AUTO_CANCEL_BATCH_SIZE",
  );
  const sweepOrdersBatchSize = parsePositiveInt(
    process.env.OPTA_SWEEP_ORDERS_BATCH_SIZE,
    DEFAULT_SWEEP_ORDERS_PER_BATCH,
    "OPTA_SWEEP_ORDERS_BATCH_SIZE",
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

  const lowBalanceWarnSol = parsePositiveFloat(
    process.env.OPTA_CRANK_LOW_BALANCE_WARN_SOL,
    DEFAULT_LOW_BALANCE_WARN_SOL,
    "OPTA_CRANK_LOW_BALANCE_WARN_SOL",
  );
  const balanceCheckTicks = parsePositiveInt(
    process.env.OPTA_CRANK_BALANCE_CHECK_TICKS,
    DEFAULT_BALANCE_CHECK_TICKS,
    "OPTA_CRANK_BALANCE_CHECK_TICKS",
  );

  const hermesBackoffBaseMs = parsePositiveInt(
    process.env.OPTA_HERMES_BACKOFF_BASE_MS,
    DEFAULT_HERMES_BACKOFF_BASE_MS,
    "OPTA_HERMES_BACKOFF_BASE_MS",
  );
  const hermesBackoffCeilingMs = parsePositiveInt(
    process.env.OPTA_HERMES_BACKOFF_CEILING_MS,
    DEFAULT_HERMES_BACKOFF_CEILING_MS,
    "OPTA_HERMES_BACKOFF_CEILING_MS",
  );

  // Dead-feed reclaim pass — opt-in (default OFF), opposite polarity to the
  // *_DISABLED flags because it moves money. Dry-run reuses OPTA_AUTO_FINALIZE_DRY_RUN.
  const reclaimEnabledRaw = (process.env.OPTA_RECLAIM_CRANK_ENABLED ?? "").toLowerCase();
  const reclaimEnabled =
    reclaimEnabledRaw === "1" || reclaimEnabledRaw === "true" || reclaimEnabledRaw === "yes";

  return {
    rpcUrl,
    keypairPath,
    tickMs,
    hermesBase,
    holderBatchSize,
    writerBatchSize,
    listingsBatchSize,
    sweepOrdersBatchSize,
    maxAtasPerTick,
    staleS,
    dryRun,
    lowBalanceWarnSol,
    balanceCheckTicks,
    hermesBackoffBaseMs,
    hermesBackoffCeilingMs,
    reclaimEnabled,
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

  const autoCancelOptions: AutoCancelOptions = {
    listingsBatchSize: env.listingsBatchSize,
    computeUnitLimit: DEFAULT_AUTO_CANCEL_CU,
    dryRun: env.dryRun, // shares the OPTA_AUTO_FINALIZE_DRY_RUN flag
  };

  const sweepOptions: SweepOptions = {
    ordersBatchSize: env.sweepOrdersBatchSize,
    computeUnitLimit: DEFAULT_SWEEP_ORDERS_CU,
    dryRun: env.dryRun, // shares the OPTA_AUTO_FINALIZE_DRY_RUN flag
  };

  // Dead-feed reclaim pass (Phase 3) — reuses the already-bootstrapped clients.
  const reclaimCtx: ReclaimContext = { connection, program, log: finalizeLog };

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
    fullyFinalized: PersistentFinalizeCache.load(
      process.env.OPTA_FINALIZE_CACHE_PATH ||
        "/var/lib/opta-crank/fully-finalized.json",
      (level, msg, extra) => {
        if (level === "warn") logWarn(msg, extra as Record<string, unknown>);
        else logInfo(msg, extra as Record<string, unknown>);
      },
    ),
    autoCancelOptions,
    sweepOptions,
    lowBalanceWarnSol: env.lowBalanceWarnSol,
    balanceCheckTicks: env.balanceCheckTicks,
    hermesBackoff: { currentMs: env.hermesBackoffBaseMs, consecutiveOk: 0 },
    hermesBackoffBaseMs: env.hermesBackoffBaseMs,
    hermesBackoffCeilingMs: env.hermesBackoffCeilingMs,
    reclaimEnabled: env.reclaimEnabled,
    reclaimCtx,
    reclaimDryRun: env.dryRun, // reuse OPTA_AUTO_FINALIZE_DRY_RUN
  };
}

// ---- Loop + signal handling ------------------------------------------------

let shutdownRequested = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Classify a settle-loop failure into a coarse category for backoff control. */
function classifySettleError(
  err: unknown,
): "rate-limit" | "hermes-no-update" | "other" {
  const s = String(err);
  if (
    s.includes("HTTP 429") ||
    s.includes("HTTP 503") ||
    s.includes("HTTP 502")
  ) {
    return "rate-limit";
  }
  if (s.includes("HTTP 404")) return "hermes-no-update";
  return "other";
}

async function tick(ctx: CrankContext): Promise<TickResult> {
  const [vaults, markets] = await Promise.all([
    safeFetchAll<any>(ctx.program, "sharedVault"),
    safeFetchAll<any>(ctx.program, "optionsMarket"),
  ]);

  const result: TickResult = {
    tuplesFound: 0,
    fanoutEligible: 0,
    fanoutSettled: 0,
    fanoutSkippedRaced: 0,
    fanoutFailed: 0,
    fanoutTxs: 0,
    fanoutRemaining: 0,
    tuplesProcessed: 0,
    errors: 0,
    errorsRateLimit: 0,
    errorsHermesNoUpdate: 0,
    errorsOther: 0,
    finalizeVaultsConsidered: 0,
    finalizeVaultsAttempted: 0,
    finalizeVaultsCachedDone: 0,
    finalizeVaultsErrors: 0,
    finalizeAtasCreated: 0,
    finalizeGpaCalls: 0,
    finalizeListingsConsidered: 0,
    finalizeListingsCancelled: 0,
    finalizeListingsAtaSkipped: 0,
    finalizeListingsErrors: 0,
    sweepOrdersConsidered: 0,
    sweepOrdersSwept: 0,
    sweepOrdersAtaSkipped: 0,
    sweepOrdersErrors: 0,
    reclaimCandidates: 0,
    reclaimVoided: 0,
    reclaimWritersReclaimed: 0,
    reclaimErrors: 0,
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

      // Adaptive backoff: pace Hermes by currentMs (starts at BASE, grows on
      // 429/5xx, halves toward BASE after N consecutive OKs). Even success
      // paths sleep — the controlled floor is what prevents the N-tuple burst.
      await sleep(ctx.hermesBackoff.currentMs);

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
        // Recovery: only meaningful when currentMs is above the base floor.
        if (ctx.hermesBackoff.currentMs > ctx.hermesBackoffBaseMs) {
          ctx.hermesBackoff.consecutiveOk += 1;
          if (
            ctx.hermesBackoff.consecutiveOk >= HERMES_BACKOFF_RECOVER_AFTER_N_OK
          ) {
            const next = Math.max(
              Math.floor(ctx.hermesBackoff.currentMs / 2),
              ctx.hermesBackoffBaseMs,
            );
            logInfo("hermes backoff recovered", {
              prevMs: ctx.hermesBackoff.currentMs,
              newMs: next,
            });
            ctx.hermesBackoff.currentMs = next;
            ctx.hermesBackoff.consecutiveOk = 0;
          }
        }
      } catch (err) {
        const cls = classifySettleError(err);
        result.errors += 1;
        if (cls === "rate-limit") {
          result.errorsRateLimit += 1;
          ctx.hermesBackoff.currentMs = Math.min(
            ctx.hermesBackoff.currentMs * HERMES_BACKOFF_MULTIPLIER,
            ctx.hermesBackoffCeilingMs,
          );
          ctx.hermesBackoff.consecutiveOk = 0;
          logWarn("tuple settle rate-limited by Hermes (backoff increased)", {
            asset: t.asset,
            expiry: t.expiry,
            err: String(err),
            hermesBackoffMs: ctx.hermesBackoff.currentMs,
          });
        } else if (cls === "hermes-no-update") {
          result.errorsHermesNoUpdate += 1;
          // 404 = Pyth hasn't published a VAA at/after expiry yet. Retry next
          // tick is the right remediation; backoff state unchanged.
          logInfo("tuple settle deferred: no Pyth update at expiry", {
            asset: t.asset,
            expiry: t.expiry,
            err: String(err),
          });
        } else {
          result.errorsOther += 1;
          logError("tuple settle failed (will retry next tick)", {
            asset: t.asset,
            expiry: t.expiry,
            err: String(err),
          });
        }
      }
    }
    result.tuplesProcessed = tuples.length - result.errors;
  }

  if (shutdownRequested) {
    return result;
  }

  // ---- Phase 1b: settle_vault FAN-OUT, for every oracle arm -------------
  //
  // Leg 1 (settle_expiry) records the price and needs a live oracle quote; the
  // Pyth loop above does it for Pyth markets and the SB pass does it for
  // Switchboard ones. Leg 2 (settle_vault) reads NO oracle and is permissionless
  // — but until now it ran ONLY inside the Pyth loop, which skips Switchboard
  // markets outright. Measured 2026-08-14: of the 14-AUG expiry, 2/2 Pyth vaults
  // settled and 0/330 Switchboard ones did, and the 3,039-vault backlog was
  // 100% Switchboard. The fan-out below closes that by asking the only question
  // the on-chain instruction asks: does a SettlementRecord exist?
  //
  // ⚠️ NO ORACLE-SOURCE FILTER — see settleVaultFanout.ts. One is exactly what
  // caused this.
  //
  // The Utilities pull path stays as a fallback and is untouched; this only
  // means holders no longer have to wait for someone to open a page.
  try {
    const records = (await safeFetchAll<any>(
      ctx.program,
      "settlementRecord",
    )) as AccountRecord[];
    const fanPlan = planSettleFanout({
      vaults: vaults as any,
      markets: markets as any,
      records: records as any,
      nowSecs: Math.floor(Date.now() / 1000),
      maxPerTick: FANOUT_MAX_PER_TICK,
    });
    result.fanoutEligible = fanPlan.eligibleTotal;
    result.fanoutRemaining = fanPlan.eligibleTotal;
    if (fanPlan.targets.length > 0) {
      logInfo("settle fan-out starting", {
        eligible: fanPlan.eligibleTotal,
        thisTick: fanPlan.targets.length,
        skipped: fanPlan.skipped,
      });
      const assetByMarket = new Map<string, string>(
        (markets as AccountRecord[]).map((m) => [
          m.publicKey.toBase58(),
          cleanAssetName(m.account.assetName as any),
        ]),
      );
      const rep = await runSettleFanout({
        program: ctx.program as any,
        connection: ctx.connection,
        payer: (ctx.wallet as any).payer,
        plan: fanPlan,
        assetByMarket,
        log: (lvl, msg, fields) =>
          lvl === "info" ? logInfo(msg, fields) : logWarn(msg, fields),
        shouldStop: () => shutdownRequested,
      });
      result.fanoutSettled = rep.settled;
      result.fanoutSkippedRaced = rep.skippedAlreadySettled;
      result.fanoutFailed = rep.failed;
      result.fanoutTxs = rep.txsSent;
      result.fanoutRemaining = rep.remaining;
      logInfo("settle fan-out complete", {
        settled: rep.settled,
        skippedRaced: rep.skippedAlreadySettled,
        failed: rep.failed,
        txs: rep.txsSent,
        remaining: rep.remaining,
      });
    }
  } catch (e) {
    // The fan-out must never take the tick down — settle/vol/trigger matter more.
    result.fanoutFailed += 1;
    logWarn("settle fan-out errored (tick continues)", {
      err: String((e as any)?.message ?? e).slice(0, 200),
    });
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
  let marksSinceFlush = 0;

  for (const v of refreshedVaults) {
    if (shutdownRequested) break;
    if (!v.account.isSettled) continue;

    const vaultKey = v.publicKey.toBase58();
    // Membership alone is NOT authority to skip. maySuppress re-checks the live
    // account: an unsettled vault, or any vault still holding collateral, is
    // always re-scanned no matter what the cache says. Entries also expire, so a
    // wrong one self-heals instead of withholding somebody's money forever.
    const collateralRemaining = BigInt(
      (v.account.collateralRemaining ?? 0).toString(),
    );
    if (
      ctx.fullyFinalized.maySuppress(
        vaultKey,
        { isSettled: v.account.isSettled === true, collateralRemaining },
        nowSec,
      )
    ) {
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

    let listingsProgressed = false;
    let listingsEmptyScan = false;
    let sweepProgressed = false;
    let sweepEmptyScan = false;
    let holderProgressed = false;
    let writerProgressed = false;
    let holderEmptyScan = false;
    let writerEmptyScan = false;

    // Auto-cancel pass — runs FIRST so freshly-returned tokens become
    // holder-finalize candidates. Per V2_SECONDARY_LISTING_PLAN.md §4.2
    // (Design A). Failure here is logged but does NOT skip holder/writer:
    // the holder pass naturally silent-skips protocol-state-owned escrows
    // so leftover listings don't corrupt subsequent passes.
    try {
      const cancelReport = await runAutoCancelListings(
        ctx.finalizeCtx,
        v.publicKey,
        ctx.autoCancelOptions,
      );
      result.finalizeListingsConsidered += 1;
      result.finalizeListingsCancelled += cancelReport.listingsCancelledFromEvents;
      result.finalizeListingsAtaSkipped += cancelReport.listingsSkippedMissingAta;
      result.finalizeListingsErrors += cancelReport.txFailed;
      listingsProgressed = cancelReport.txSent > 0;
      listingsEmptyScan = cancelReport.listingsTotal === 0;
      logInfo("auto-cancel pass", { ...cancelReport });
    } catch (err) {
      result.finalizeListingsErrors += 1;
      logError("auto-cancel pass crashed", {
        vault: vaultKey,
        err: String(err),
      });
      // Do NOT continue — let holder/writer attempt regardless.
    }

    // Sweep-expired-orders pass — also runs BEFORE finalize so an ask's
    // freshly-returned tokens become holder-finalize candidates (sweep-before-
    // finalize, exchange-spec §6.6). Same log-don't-continue isolation as
    // auto-cancel: a sweep failure must not skip holder/writer.
    try {
      const sweepReport = await runSweepExpiredOrders(
        ctx.finalizeCtx,
        v.publicKey,
        ctx.sweepOptions,
      );
      result.sweepOrdersConsidered += 1;
      result.sweepOrdersSwept += sweepReport.ordersSweptFromEvents;
      result.sweepOrdersAtaSkipped += sweepReport.ordersSkippedMissingAta;
      result.sweepOrdersErrors += sweepReport.txFailed;
      sweepProgressed = sweepReport.txSent > 0;
      sweepEmptyScan = sweepReport.ordersTotal === 0;
      logInfo("sweep-expired-orders pass", { ...sweepReport });
    } catch (err) {
      result.sweepOrdersErrors += 1;
      logError("sweep-expired-orders pass crashed", {
        vault: vaultKey,
        err: String(err),
      });
      // Do NOT continue — let holder/writer attempt regardless.
    }

    if (shutdownRequested) break;

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
      listingsEmptyScan &&
      sweepEmptyScan &&
      holderEmptyScan &&
      writerEmptyScan &&
      !listingsProgressed &&
      !sweepProgressed &&
      !holderProgressed &&
      !writerProgressed
    ) {
      ctx.fullyFinalized.add(vaultKey, nowSec);
      marksSinceFlush += 1;
      logInfo("vault marked fully finalized (persisted cache)", {
        vault: vaultKey,
      });
      // Flush mid-sweep, not just at the end. A cold sweep walks thousands of
      // vaults and takes the better part of an hour; if the only flush were at
      // the end, a restart inside that window would persist nothing and we would
      // re-pay the whole scan — precisely the bug this cache exists to fix.
      if (marksSinceFlush >= FINALIZE_CACHE_FLUSH_EVERY) {
        ctx.fullyFinalized.flush();
        marksSinceFlush = 0;
      }
    }
  }

  // Persist once per sweep rather than per vault: one rename beats 3,400, and a
  // crash mid-sweep costs only the marks from this tick (re-earned next tick).
  const cachePruned = ctx.fullyFinalized.prune(nowSec);
  ctx.fullyFinalized.flush();
  logInfo("finalize cache persisted", {
    entries: ctx.fullyFinalized.size(),
    pruned: cachePruned,
    cachedDoneThisTick: result.finalizeVaultsCachedDone,
  });

  // ---- Phase 3: dead-feed reclaim (opt-in; moves money) -----------------
  // OFF unless OPTA_RECLAIM_CRANK_ENABLED. Reuses refreshedVaults + markets
  // already in hand (no new gPA). Covers BOTH zero-premium and premium-bearing
  // dead-feed vaults: since H-03 (deployed 2026-07-04, opta slot 473901900)
  // reclaim_unsettled pays each writer's unclaimed premium + pro-rata collateral
  // atomically, so no premium is stranded. Per-candidate crash isolation lives in the sweep.
  if (ctx.reclaimEnabled && !shutdownRequested) {
    try {
      const sweep = await runReclaimSweep(
        ctx.reclaimCtx,
        refreshedVaults,
        markets as AccountRecord[],
        { dryRun: ctx.reclaimDryRun },
      );
      result.reclaimCandidates = sweep.candidates;
      result.reclaimVoided = sweep.voided;
      result.reclaimWritersReclaimed = sweep.writersReclaimed;
      result.reclaimErrors = sweep.errors;
    } catch (err) {
      logError("phase 3: reclaim sweep crashed", { err: String(err) });
    }
  }

  return result;
}

async function checkWalletBalance(
  ctx: CrankContext,
  reason: "boot" | "periodic",
): Promise<void> {
  let lamports: number;
  try {
    lamports = await ctx.connection.getBalance(ctx.wallet.publicKey);
  } catch (err) {
    logError("wallet-balance check failed", {
      event: "wallet-balance-check",
      reason,
      err: String(err),
    });
    return;
  }
  const balanceSol = lamports / LAMPORTS_PER_SOL;
  if (lamports === 0) {
    logFatal("wallet has zero SOL", {
      event: "wallet-balance-check",
      reason,
      balanceSol,
      thresholdSol: ctx.lowBalanceWarnSol,
    });
    process.exit(1);
  }
  if (balanceSol < ctx.lowBalanceWarnSol) {
    logWarn("wallet balance below warn threshold", {
      event: "wallet-balance-check",
      reason,
      balanceSol,
      thresholdSol: ctx.lowBalanceWarnSol,
    });
  } else {
    logInfo("wallet balance ok", {
      event: "wallet-balance-check",
      reason,
      balanceSol,
      thresholdSol: ctx.lowBalanceWarnSol,
    });
  }
}

async function runForever(ctx: CrankContext): Promise<void> {
  let lastHeartbeatMs = Date.now();
  let tickCountSinceLastHeartbeat = 0;
  let tickCounter = 0;
  let lastTickWasIdle = true;

  while (!shutdownRequested) {
    const startMs = Date.now();
    try {
      const result = await tick(ctx);
      // Per locked decision: suppress idle-tick log noise. Tick is "active"
      // if Phase 1 saw expired tuples OR Phase 2 considered any settled
      // vaults that weren't already cached as fully finalized.
      const hadWork =
        result.tuplesFound > 0 ||
        result.finalizeVaultsConsidered > 0 ||
        result.fanoutSettled > 0 ||
        result.fanoutEligible > 0 ||
        result.reclaimCandidates > 0;
      lastTickWasIdle = !hadWork;
      if (hadWork) {
        logInfo("tick complete", {
          ...result,
          durationMs: Date.now() - startMs,
          hermesBackoff: {
            currentMs: ctx.hermesBackoff.currentMs,
            consecutiveOk: ctx.hermesBackoff.consecutiveOk,
          },
        });
      }
    } catch (err) {
      lastTickWasIdle = false;
      logError("tick failed (will retry next interval)", {
        err: String(err),
        durationMs: Date.now() - startMs,
      });
    }

    tickCounter += 1;
    tickCountSinceLastHeartbeat += 1;

    if (Date.now() - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
      logInfo("settle-loop heartbeat", {
        event: "settle-loop-heartbeat",
        tickCountSinceLastHeartbeat,
        lastTickWasIdle,
      });
      lastHeartbeatMs = Date.now();
      tickCountSinceLastHeartbeat = 0;
    }

    if (tickCounter % ctx.balanceCheckTicks === 0) {
      await checkWalletBalance(ctx, "periodic");
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
    autoCancel: {
      listingsBatchSize: ctx.autoCancelOptions.listingsBatchSize,
      computeUnitLimit: ctx.autoCancelOptions.computeUnitLimit,
      dryRun: ctx.autoCancelOptions.dryRun,
    },
    walletBalanceCheck: {
      lowBalanceWarnSol: ctx.lowBalanceWarnSol,
      balanceCheckTicks: ctx.balanceCheckTicks,
    },
    hermesBackoff: {
      baseMs: ctx.hermesBackoffBaseMs,
      ceilingMs: ctx.hermesBackoffCeilingMs,
      currentMs: ctx.hermesBackoff.currentMs,
    },
    reclaim: { enabled: ctx.reclaimEnabled, dryRun: ctx.reclaimDryRun },
  });

  await checkWalletBalance(ctx, "boot");

  const onSignal = (sig: string) => {
    if (shutdownRequested) return; // ignore second signal
    shutdownRequested = true;
    logInfo("shutdown requested, exiting after current tick", { signal: sig });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // ---- Spawn the Stage B vol-oracle crank as a side-loop ------------------
  // Both loops share the shutdownRequested flag (read by runForever's
  // while-condition AND volOracleCrank's shouldShutdown callback). Both
  // also share the AnchorWallet, Connection, Program -- the vol crank just
  // re-uses ctx's already-bootstrapped clients with its own hermesBase
  // (same value; the option is here so a future tick-time override doesn't
  // require touching bot.ts).
  //
  // Fail-loud wrapping: Promise.all rejects on the first crash. We catch +
  // log + exit non-zero so a systemd-style supervisor restarts the process
  // (rather than letting one crashed loop linger while the other runs).
  // The graceful-shutdown path (SIGINT/SIGTERM) goes through
  // shutdownRequested and exits cleanly from both loops -- never hits the
  // catch handler.
  const volCrankCtx: VolOracleCrankContext = {
    connection: ctx.connection,
    wallet: ctx.wallet,
    program: ctx.program,
    hermesBase: ctx.hermesBase,
    log: (level, msg, fields) =>
      log(level, msg, { subsystem: "vol-oracle", ...(fields ?? {}) }),
    shouldShutdown: () => shutdownRequested,
  };
  const volCrankOptions: VolOracleCrankOptions = {
    tickOnce: (process.env.TICK_ONCE ?? "").toLowerCase() === "1"
      || (process.env.TICK_ONCE ?? "").toLowerCase() === "true",
  };

  // The settle/finalize loop always runs. The vol-oracle side-loop is
  // env-gated: set OPTA_VOL_CRANK_DISABLED=1 to skip spawning it entirely.
  // Gated OFF while American is dark (post-Stage-H) — the hourly pushes are
  // pure waste until American pricing reads the oracles. RE-ENABLE AT STAGE I
  // (unset the env / set != "1") so the oracles re-warm before the flag flip.
  const loops: Array<Promise<void>> = [
    runForever(ctx).catch((err) => {
      logFatal("settle/finalize loop crashed", {
        err: String(err),
        stack: (err as any)?.stack,
      });
      throw err;
    }),
  ];

  // FP-ORACLE plug (wave 1), layer 2: the vol-sample lane for oracle_source==2
  // markets. OWN flag, default OFF. Signs with the crank wallet only -- the
  // oracle authority key never enters this process (spec 6.3).
  if ((process.env.OPTA_VOL_OPTA_ENABLED ?? "") === "1") {
    const optaVolCtx: OptaVolCrankContext = {
      connection: ctx.connection,
      wallet: ctx.wallet,
      program: ctx.program,
      log: (level, msg, fields) => log(level as any, msg, { subsystem: "opta-vol", ...(fields ?? {}) }),
      shouldShutdown: () => shutdownRequested,
      dryRun: (process.env.OPTA_VOL_OPTA_DRY_RUN ?? "1") !== "0",
    };
    loops.push(
      runOptaVolCrank(optaVolCtx, { tickOnce: volCrankOptions.tickOnce }).catch((err) => {
        logFatal("opta-vol loop crashed", { err: String(err), stack: (err as any)?.stack });
        throw err;
      }),
    );
    logInfo("opta-vol side-loop ENABLED (OPTA_VOL_OPTA_ENABLED=1)", { dryRun: optaVolCtx.dryRun, note: "set OPTA_VOL_OPTA_DRY_RUN=0 to send" });
  } else {
    logInfo("opta-vol side-loop OFF (set OPTA_VOL_OPTA_ENABLED=1 at the layer-2 deploy)");
  }

  if ((process.env.OPTA_VOL_CRANK_DISABLED ?? "") === "1") {
    logInfo("vol-oracle side-loop DISABLED via OPTA_VOL_CRANK_DISABLED=1", {
      note: "re-enable at Stage I so oracles re-warm for American pricing",
    });
  } else {
    loops.push(
      runVolOracleCrank(volCrankCtx, volCrankOptions).catch((err) => {
        logFatal("vol-oracle loop crashed", {
          err: String(err),
          stack: (err as any)?.stack,
        });
        throw err;
      }),
    );
  }

  // ---- Spawn the Phase 4 trigger keeper as a side-loop --------------------
  // Same fail-loud + shutdown wiring as the vol loop: it reads shutdownRequested
  // via shouldShutdown, and a crash → logFatal + re-throw → Promise.all rejects
  // → process.exit(1) → supervisor restarts. Env-gated: set
  // OPTA_TRIGGER_CRANK_DISABLED=1 to skip it entirely.
  //
  // DEPLOY: keep this DISABLED on the VPS (OPTA_TRIGGER_CRANK_DISABLED=1) until
  // the P3 greenlight — execute_trigger isn't deployed/seeded yet. Dry-run is
  // ALSO on by default (OPTA_TRIGGER_DRY_RUN defaults ON), so even if spawned it
  // won't send until P3 explicitly sets OPTA_TRIGGER_DRY_RUN=0.
  const triggerCrankCtx: TriggerCrankContext = {
    connection: ctx.connection,
    wallet: ctx.wallet,
    hermesBase: ctx.hermesBase,
    log: (level, msg, fields) => log(level, msg, { subsystem: "trigger", ...(fields ?? {}) }),
    shouldShutdown: () => shutdownRequested,
  };
  const triggerCrankOptions: TriggerCrankOptions = {
    tickOnce:
      (process.env.TICK_ONCE ?? "").toLowerCase() === "1" ||
      (process.env.TICK_ONCE ?? "").toLowerCase() === "true",
  };

  if ((process.env.OPTA_TRIGGER_CRANK_DISABLED ?? "") === "1") {
    logInfo("trigger side-loop DISABLED via OPTA_TRIGGER_CRANK_DISABLED=1", {
      note: "enable at P3 greenlight (and set OPTA_TRIGGER_DRY_RUN=0 to actually send)",
    });
  } else {
    loops.push(
      runTriggerCrank(triggerCrankCtx, triggerCrankOptions).catch((err) => {
        logFatal("trigger loop crashed", {
          err: String(err),
          stack: (err as any)?.stack,
        });
        throw err;
      }),
    );
  }

  // ---- Spawn the Stage 3 1c-ii-A SB-oracle warming crank as a side-loop ----
  // Same fail-loud + shutdown wiring as the vol/trigger loops. Warms SB-sourced
  // VolOracles (oracle_source==1) by posting fresh Switchboard quotes through
  // push_vol_sample's SB arm. Env-gated:
  //   OPTA_SB_CRANK_DISABLED=1 → skip spawning entirely (the rollout default —
  //     no SB market exists until create-SB-market deploys with 1c-i-B+1c-ii).
  //   OPTA_SB_DRY_RUN (default "1" = ON) → build + simulate + log, NEVER send.
  //     Set OPTA_SB_DRY_RUN=0 ONLY after the coordinated deploy greenlight.
  //   OPTA_SB_FORCE_FEED=<hex[,hex]> → process feedHashes with no discoverable
  //     market yet (dry-run the push path against the 1c-i-A unlisted gold oracle).
  const sbDryRunRaw = (process.env.OPTA_SB_DRY_RUN ?? "1").toLowerCase();
  const sbCrankCtx: SbOracleCrankContext = {
    connection: ctx.connection,
    wallet: ctx.wallet,
    program: ctx.program,
    log: (level, msg, fields) => log(level, msg, { subsystem: "sb-oracle", ...(fields ?? {}) }),
    shouldShutdown: () => shutdownRequested,
    dryRun: !(sbDryRunRaw === "0" || sbDryRunRaw === "false"),
    forceFeeds: parseForceFeeds(process.env.OPTA_SB_FORCE_FEED),
    forceSettles: parseForceSettles(process.env.OPTA_SB_FORCE_SETTLE),
  };
  const sbCrankOptions: SbOracleCrankOptions = {
    tickOnce:
      (process.env.TICK_ONCE ?? "").toLowerCase() === "1" ||
      (process.env.TICK_ONCE ?? "").toLowerCase() === "true",
  };

  if ((process.env.OPTA_SB_CRANK_DISABLED ?? "") === "1") {
    logInfo("sb-oracle side-loop DISABLED via OPTA_SB_CRANK_DISABLED=1", {
      note: "enable at the coordinated 1c-i-B+1c-ii deploy (and set OPTA_SB_DRY_RUN=0 to send)",
    });
  } else {
    loops.push(
      runSbOracleCrank(sbCrankCtx, sbCrankOptions).catch((err) => {
        logFatal("sb-oracle loop crashed", {
          err: String(err),
          stack: (err as any)?.stack,
        });
        throw err;
      }),
    );
  }

  // ---- Spawn the liveness probe loop (Phase 2a) ---------------------------
  // Fills the shared liveness map the sb-create endpoint's GET /liveness serves.
  // Gated on OPTA_SB_CREATE_ENABLED (the map is only useful when the create
  // endpoint is live) + an OPTA_LIVENESS_DISABLED escape hatch (turn the loop off
  // without disabling create — e.g. if Hermes rate-limits). Same fail-loud
  // wrapper as the other side-loops; the loop body is fully defensive, so only a
  // genuine bug (not a transient probe failure) propagates → supervisor restart.
  const livenessEnabled =
    (process.env.OPTA_SB_CREATE_ENABLED ?? "") === "1" &&
    (process.env.OPTA_LIVENESS_DISABLED ?? "") !== "1";
  if (livenessEnabled) {
    const livenessCtx: LivenessCrankContext = {
      hermesBase: ctx.hermesBase,
      program: ctx.program,
      log: (level, msg, fields) =>
        log(level, msg, { subsystem: "liveness", ...(fields ?? {}) }),
      shouldShutdown: () => shutdownRequested,
    };
    const livenessOptions: LivenessCrankOptions = {
      tickOnce:
        (process.env.TICK_ONCE ?? "").toLowerCase() === "1" ||
        (process.env.TICK_ONCE ?? "").toLowerCase() === "true",
    };
    loops.push(
      runLivenessCrank(livenessCtx, livenessOptions).catch((err) => {
        logFatal("liveness loop crashed", {
          err: String(err),
          stack: (err as any)?.stack,
        });
        throw err;
      }),
    );
  } else {
    logInfo("liveness loop DISABLED", {
      note: "needs OPTA_SB_CREATE_ENABLED=1 and OPTA_LIVENESS_DISABLED!=1",
    });
  }

  // ---- Mount the SB create-market HTTP endpoint (Part 2) -------------------
  // CRASH-ISOLATED + mounted OUTSIDE `loops`: a failure here can NEVER reject
  // Promise.all or take down settle/vol/trigger/sb. Env-gated OFF by default —
  // set OPTA_SB_CREATE_ENABLED=1 at the coordinated SB-create deploy. The
  // listener binds 127.0.0.1 by default; front it with nginx TLS on the public
  // domain the FE points at.
  let sbCreateServer: SbCreateServerHandle | null = null;
  if ((process.env.OPTA_SB_CREATE_ENABLED ?? "") === "1") {
    try {
      sbCreateServer = startSbCreateMarketServer({
        connection: ctx.connection,
        wallet: ctx.wallet,
        program: ctx.program,
        log: (level, msg, fields) =>
          log(level, msg, { subsystem: "sb-create", ...(fields ?? {}) }),
      });
    } catch (err) {
      // Mount-time failure must not take the crank down.
      log("error", "sb-create endpoint failed to start (continuing without it)", {
        err: String(err),
      });
    }
  } else {
    logInfo("sb-create endpoint DISABLED (set OPTA_SB_CREATE_ENABLED=1 to start)");
  }

  try {
    await Promise.all(loops);
  } catch (err) {
    // Already logged above by whichever loop's .catch fired first. Exit
    // non-zero so process supervisors restart us instead of half-running.
    logFatal("crank exiting due to side-loop crash", { err: String(err) });
    process.exit(1);
  }

  if (sbCreateServer) sbCreateServer.close();
  logInfo("crank stopped cleanly");
}

main().catch((err) => {
  logFatal("main loop crashed", { err: String(err), stack: err?.stack });
  process.exit(1);
});
