// ============================================================================
// crank/fpOracleMain.ts -- entrypoint for the FP-ORACLE push lane
// ============================================================================
//
// Its OWN process, its OWN unit, its OWN env file. Not a side-loop in bot.ts.
// See FP_ORACLE_MODULE_SPEC_V2 section 6.3 -- runtime isolation is a boundary
// INVARIANT here, not a preference: this process holds a key that can write
// settlement prices, and it must not be reachable from a shared env file that
// gets edited under incident pressure.
//
// EVERY env var is OPTA_FP_-prefixed and read ONLY from this lane's env file.
// Nothing is shared with opta-crank. OPTA_FP_RPC_URL deliberately duplicates the
// value of OPTA_RPC_URL rather than reusing the name: a shared variable is a
// path by which editing one lane silently changes another.
//
//   OPTA_FP_RPC_URL          (required) RPC endpoint
//   OPTA_FP_PROGRAM_ID       (required) the CANONICAL program id -- see the guard below
//   OPTA_FP_KEYPAIR          (required) oracle authority keypair path
//   OPTA_FP_JSONL            (default /opt/opta-fp-oracle/fp-oracle-samples.jsonl)
//   OPTA_FP_DRY_RUN          (default "1" = ON; "0" to actually send)
//   OPTA_FP_CRANK_DISABLED   ("1" -> exit 0 immediately)
//   OPTA_FP_FORCE_FEED       (optional) comma-separated feed hashes
//   OPTA_FP_INTERVAL_MS      (default 60000)
//   TICK_ONCE                ("1" -> one tick then exit)
//
// THREE BOOT REFUSALS, all fail-closed and all loud. Each exists because the
// quiet version of the same mistake is expensive:
//
//   1. PROGRAM ID. OPTA_FP_PROGRAM_ID is REQUIRED and, since the plug (wave 1),
//      MUST equal the canonical id: the scratch program is retired. A soak
//      against another deployment needs OPTA_FP_ALLOW_NONCANONICAL=1 and is
//      logged as such on line one. (During the soak the refusal ran the other
//      way -- canonical was refused -- which is why this is a boot refusal at
//      all: whichever direction is wrong for the moment is the expensive one.)
//   2. KEYPAIR PATH. Refuse any path under /opt/opta-crank. opta-trigger already
//      shares opta-crank's signing key; that pattern must not reach a key that
//      can write prices (spec 6.3).
//   3. AUTHORITY != ADMIN is enforced ON-CHAIN by init/rotate, so it is not
//      re-checked here -- but the loaded pubkey is logged at boot so a
//      misconfiguration is visible in the journal on line one.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import { runFpOracleCrank, type FpCrankContext, type FpLogLevel } from "./fpOracleCrank";

/** The live production program. Post-plug, the only program this lane serves. */
const CANONICAL_PROGRAM_ID = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq";
// LANE-LOCAL IDL. Post-plug every tracked IDL copy carries the module's
// instructions (the arms are in the canonical surface now), so this is the same
// content as ../app/src/idl/opta.json -- but the lane still reads its OWN copy
// under its own tree: one more thing not shared with another service (spec
// 6.3), and a redeploy of the app cannot change what this process decodes.
//
// The `address` field is overridden below with OPTA_FP_PROGRAM_ID regardless.
const IDL_JSON_PATH =
  process.env.OPTA_FP_IDL?.trim() || path.resolve(__dirname, "../idl/opta.json");
const DEFAULT_JSONL = "/opt/opta-fp-oracle/fp-oracle-samples.jsonl";

function log(level: FpLogLevel, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, subsystem: "fp-oracle", ...(fields ?? {}) });
  if (level === "error" || level === "fatal") console.error(line);
  else console.log(line);
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    log("fatal", `${name} is required`, { hint: "set it in /opt/opta-fp-oracle/.env" });
    process.exit(1);
  }
  return v;
}

function loadKeypair(p: string): Keypair {
  // BOUNDARY INVARIANT (spec 6.3): the oracle authority never lives under
  // another lane's tree. Checked on the RESOLVED path so a symlink or a
  // ../ cannot walk into opta-crank's secrets.
  const resolved = path.resolve(p);
  if (resolved.startsWith("/opt/opta-crank")) {
    log("fatal", "REFUSING to load the oracle authority from opta-crank's tree", {
      path: resolved,
      invariant: "FP_ORACLE_MODULE_SPEC_V2 section 6.3 — runtime isolation",
    });
    process.exit(1);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf-8"))));
  } catch (e) {
    // Never echo the path's CONTENTS, only its path.
    log("fatal", "could not load oracle authority keypair", { path: resolved, err: String(e).slice(0, 120) });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if ((process.env.OPTA_FP_CRANK_DISABLED ?? "") === "1") {
    log("info", "fp-oracle DISABLED via OPTA_FP_CRANK_DISABLED=1 — exiting cleanly");
    return;
  }

  const rpcUrl = required("OPTA_FP_RPC_URL");
  const programIdRaw = required("OPTA_FP_PROGRAM_ID");
  const keypairPath = required("OPTA_FP_KEYPAIR");

  // PLUG (wave 1): the invariant INVERTS. During the soak this lane refused the
  // canonical program and addressed the scratch deployment only. The scratch
  // program is retired with the cfg-gated declare_id; from here the lane serves
  // the canonical program and refuses anything else -- unless explicitly told it
  // is running a soak against a non-canonical id (OPTA_FP_ALLOW_NONCANONICAL=1),
  // which is logged loudly on line one so a misconfiguration cannot hide.
  if (programIdRaw !== CANONICAL_PROGRAM_ID) {
    if ((process.env.OPTA_FP_ALLOW_NONCANONICAL ?? "") !== "1") {
      log("fatal", "REFUSING to run against a NON-CANONICAL program", {
        programId: programIdRaw, canonical: CANONICAL_PROGRAM_ID,
        hint: "post-plug the lane serves the canonical program; set OPTA_FP_ALLOW_NONCANONICAL=1 only for a soak",
      });
      process.exit(1);
    }
    log("warn", "running against a NON-CANONICAL program (soak mode, OPTA_FP_ALLOW_NONCANONICAL=1)", { programId: programIdRaw });
  }
  let programId: PublicKey;
  try {
    programId = new PublicKey(programIdRaw);
  } catch {
    log("fatal", "OPTA_FP_PROGRAM_ID is not a valid pubkey", { value: programIdRaw });
    process.exit(1);
    return;
  }

  const dryRunRaw = (process.env.OPTA_FP_DRY_RUN ?? "1").toLowerCase();
  const dryRun = !(dryRunRaw === "0" || dryRunRaw === "false");
  const jsonlPath = process.env.OPTA_FP_JSONL?.trim() || DEFAULT_JSONL;
  const intervalMs = Number(process.env.OPTA_FP_INTERVAL_MS ?? 60_000) || 60_000;
  const forceFeeds = (process.env.OPTA_FP_FORCE_FEED ?? "")
    .split(",").map((x) => x.trim().replace(/^0x/, "").toLowerCase()).filter(Boolean);
  const tickOnce = (process.env.TICK_ONCE ?? "").toLowerCase() === "1";

  const keypair = loadKeypair(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  // --- web3.js confirmation-race leak plug (see ledger section 22) ----------
  //
  // web3.js 1.98.4 Connection.getTransactionConfirmationPromise builds the
  // confirmation as a Promise.race between a websocket onSignature subscription
  // and an expiry poller. Alongside the race it fires a FLOATING async IIFE
  // (lib/index.cjs.js:6587) as a fast path:
  //
  //     (async () => {
  //       await subscriptionSetupPromise;
  //       if (done) return;
  //       const response = await this.getSignatureStatus(signature);  // HTTP
  //       if (done) return;
  //       if (response == null) return;
  //       ...
  //     })();          <-- not awaited, no .catch attached
  //
  // That IIFE has no try/catch and nothing holds its promise. When the race is
  // won by the websocket, `done` is set and sendAndConfirm returns -- but the
  // getSignatureStatus HTTP request is ALREADY IN FLIGHT. If it then rejects
  // (transport error), the `if (done) return` guard is never reached: a
  // rejection skips the line entirely. The rejection is unhandled and Node
  // kills the process.
  //
  // That is exactly what killed this lane at 2026-09-04T10:35:51Z, 0.5s after a
  // SUCCESSFUL push: ECONNRESET on a leftover status call from an already
  // completed confirmation.
  //
  // We cannot attach .catch to that promise -- it is internal and never
  // exposed. So we make the call it awaits non-rejecting instead. Returning
  // null is the graceful-degrade path web3.js itself defines one line later
  // (`if (response == null) return;`): the fast path is skipped and the
  // websocket subscription resolves the confirmation as normal. The stray
  // promise dies silently AS A PROMISE. The process lives.
  //
  // Surgical by construction: getSignatureStatus (singular) has exactly two
  // internal call sites -- this IIFE and the durable-nonce strategy we never
  // use -- and this lane never calls it directly.
  {
    const inner = connection.getSignatureStatus.bind(connection);
    (connection as any).getSignatureStatus = async (...args: any[]) => {
      try {
        return await (inner as any)(...args);
      } catch (e) {
        // Never a correctness signal: confirmation still arrives over the
        // subscription. Debug-level so it is greppable without being noise.
        log("debug", "fp-oracle: getSignatureStatus transport error absorbed (confirmation unaffected)", {
          err: String(e).slice(0, 200),
        });
        return null;
      }
    };
  }

  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  // Override the IDL's baked-in canonical address with the scratch program.
  const idl = { ...JSON.parse(fs.readFileSync(IDL_JSON_PATH, "utf-8")), address: programId.toBase58() };
  const program = new anchor.Program(idl as anchor.Idl, provider);

  let shutdown = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { log("info", `${sig} — shutting down after this tick`); shutdown = true; });
  }

  log("info", "fp-oracle boot", {
    programId: program.programId.toBase58(),
    authority: wallet.publicKey.toBase58(),
    rpcHost: (() => { try { return new URL(rpcUrl).host; } catch { return "?"; } })(),
    keypairPath: path.resolve(keypairPath),
    jsonlPath, dryRun, intervalMs, tickOnce,
    forceFeeds: forceFeeds.length ? forceFeeds.map((f) => f.slice(0, 10)) : "all",
  });

  const ctx: FpCrankContext = {
    connection, wallet, program, log,
    shouldShutdown: () => shutdown,
    dryRun, forceFeeds, jsonlPath, intervalMs,
  };
  await runFpOracleCrank(ctx, { tickOnce });
}

// ---- last-resort loudness ---------------------------------------------------
//
// A rejection that reaches here was never awaited by anything, so no catch in
// the call graph could have seen it -- including main().catch below. Before
// this handler existed, Node's default killed the process with a RAW STACK
// TRACE and no JSON line, which is how the 2026-09-04T10:35:51Z death came to
// be invisible to every log-based check (grep '"level":"fatal"' returned 0
// across the whole soak journal, while the process had in fact died).
//
// This does NOT make the lane survive. It makes it die LOUDLY and in-band.
// systemd remains the sole restart authority -- we exit non-zero and let
// Restart= do its job. Deliberately no swallow-and-continue: a rejection
// arriving here is by definition one we have not accounted for, and continuing
// on unexamined state in a process that signs prices is not a trade worth
// making. The one leak we HAVE accounted for is plugged at its source above,
// so it never reaches this handler at all.
process.on("unhandledRejection", (reason, promise) => {
  const r: any = reason;
  log("fatal", "fp-oracle: UNHANDLED REJECTION — exiting for systemd restart", {
    err: String(reason).slice(0, 500),
    name: r?.name ?? null,
    code: r?.code ?? r?.cause?.code ?? null,
    errno: r?.errno ?? r?.cause?.errno ?? null,
    syscall: r?.syscall ?? r?.cause?.syscall ?? null,
    cause: r?.cause ? String(r.cause).slice(0, 300) : null,
    stack: (r?.stack ?? "").slice(0, 2000),
    promise: String(promise).slice(0, 200),
  });
  process.exit(1);
});

process.on("uncaughtException", (e) => {
  log("fatal", "fp-oracle: UNCAUGHT EXCEPTION — exiting for systemd restart", {
    err: String(e).slice(0, 500), stack: (e?.stack ?? "").slice(0, 2000),
  });
  process.exit(1);
});

main().catch((e) => {
  log("fatal", "fp-oracle crashed", { err: String(e), stack: (e as any)?.stack });
  process.exit(1);
});
