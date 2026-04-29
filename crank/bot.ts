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

// ---- Constants -------------------------------------------------------------

const DEFAULT_TICK_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_KEYPAIR_PATH = path.join(os.homedir(), ".config/solana/id.json");
const IDL_JSON_PATH = path.resolve(__dirname, "../app/src/idl/opta.json");

// ---- Logging ---------------------------------------------------------------

type LogLevel = "info" | "warn" | "error" | "fatal";

function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...fields };
  // stdout for info/warn, stderr for error/fatal so log redirection separates streams
  const stream = level === "error" || level === "fatal" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + "\n");
}

const logInfo = (msg: string, f?: Record<string, unknown>) => log("info", msg, f);
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

function readEnv(): { rpcUrl: string; keypairPath: string; tickMs: number } {
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
  return { rpcUrl, keypairPath, tickMs };
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
  return { connection, wallet, program, tickMs: env.tickMs };
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

  const tuples = computeExpiredTuples(
    vaults as AccountRecord[],
    markets as AccountRecord[],
  );

  if (tuples.length === 0) {
    return { tuplesFound: 0, tuplesProcessed: 0, errors: 0 };
  }

  logInfo("tuples to process", { count: tuples.length });

  let errors = 0;
  for (const t of tuples) {
    if (shutdownRequested) break;
    try {
      const result = await settleAllForExpiry(
        ctx.program,
        ctx.wallet,
        t.asset,
        t.expiry,
        t.feedIdHex,
        t.vaultPdas,
      );
      logInfo("tuple settled", {
        asset: t.asset,
        expiry: t.expiry,
        vaultsFinalized: result.vaultsFinalized,
        atomicSig: result.atomicSig,
        vaultBatchTxs: result.vaultSigs.length,
        resumed: result.atomicSig === null,
      });
    } catch (err) {
      errors++;
      logError("tuple failed (will retry next tick)", {
        asset: t.asset,
        expiry: t.expiry,
        err: String(err),
      });
    }
  }

  return {
    tuplesFound: tuples.length,
    tuplesProcessed: tuples.length - errors,
    errors,
  };
}

async function runForever(ctx: CrankContext): Promise<void> {
  while (!shutdownRequested) {
    const startMs = Date.now();
    try {
      const result = await tick(ctx);
      // Per locked decision: suppress idle-tick log noise. Only log
      // tick-complete when there was actual work in the tick.
      if (result.tuplesFound > 0) {
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
    intervalMs: ctx.tickMs,
    programId: ctx.program.programId.toBase58(),
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
