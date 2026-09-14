// =============================================================================
// canary/sweep.ts — clear anything the canary may have left on chain
// =============================================================================
//
//   run:  node node_modules/ts-node/dist/bin.js --transpile-only \
//           -r tsconfig-paths/register canary/sweep.ts --host local [--dry-run]
//
// This is the answer to "what if the run is killed". In-process cleanup cannot
// survive SIGKILL, so the journal records intent BEFORE each send and this reads
// that journal, ASKS THE CHAIN what actually exists, and clears it.
//
// THE CHAIN IS THE AUTHORITY, NOT THE JOURNAL
//   A PENDING entry means "we were about to send" — it may or may not have
//   landed. The journal cannot answer that and must not guess; it only tells the
//   sweep WHERE to look.
//
// FILLED IS NOT AN ORPHAN
//   A bid that is gone was either cancelled or FILLED, and those are opposite
//   outcomes: filled is the canary succeeding. The sweep distinguishes them by
//   whether this run recorded its own cancel, and records which it found — a
//   sweep that reported "cleaned up" after a successful fire would be lying
//   about the very thing being tested.
//
// ONE HOST, ONE KEY, ONE SCOPE
//   It clears only what its own key can sign for. The admin key (local) cancels
//   triggers; the writer key (box) cancels the bid. Neither can clean the
//   other's, and pretending otherwise would leave a silent orphan.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction,
} from "@solana/web3.js";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";

import {
  buildCancelOrder, buildCancelTrigger, protocolStatePda,
  restingOrderPda, triggerOrderPda,
} from "./chain";
import { needsSweep, openJournals, readJournal, updateAction, type JournalFile } from "./journal";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : d;
};
const HOST = (arg("host", "local") as "local" | "box");
const DRY = process.argv.includes("--dry-run");
const RPC = process.env.OPTA_RPC_URL || "https://rpc.opta.fyi/devnet";

const KEY_FOR: Record<string, string> = {
  local: process.env.OPTA_CANARY_OWNER_KEY || (process.env.HOME ?? process.env.USERPROFILE ?? ".") + "/.config/solana/id.json",
  box: process.env.OPTA_CANARY_WRITER_KEY || "/opt/opta-writer/secrets/writer-keypair.json",
};
const JOURNAL_DIR = process.env.OPTA_CANARY_JOURNAL_DIR
  || path.join(__dirname, "..", "_canary-journal", HOST);

async function main() {
  const dir = JOURNAL_DIR;
  const files = openJournals(dir, HOST);
  console.log(`sweep host=${HOST} dir=${dir} openJournals=${files.length}${DRY ? " (DRY RUN)" : ""}`);
  if (files.length === 0) { console.log("nothing to sweep"); return; }

  const conn = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEY_FOR[HOST], "utf8"))));
  const idl = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "..", "app", "src", "idl", "opta.json"), "utf8"));
  const p = new anchor.Program(
    idl as anchor.Idl,
    new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }),
  ) as anchor.Program<any>;
  const ps: any = await (p.account as any).protocolState.fetch(protocolStatePda(p.programId));
  const usdcMint = new PublicKey(ps.usdcMint);

  let cleared = 0, cancelled = 0, filled = 0;

  for (const file of files) {
    const j = readJournal(file) as JournalFile;
    console.log(`\njournal ${path.basename(file)}  run=${j.runId}`);
    for (const a of needsSweep(j, HOST)) {
      const mint = new PublicKey(String(a.expect.optionMint));
      const nonce = new BN(String(a.expect.nonce));
      const owner = kp.publicKey;

      const key = a.kind === "bid-post"
        ? restingOrderPda(mint, owner, nonce, p.programId)
        : triggerOrderPda(owner, mint, nonce, p.programId);

      const info = await conn.getAccountInfo(key, "confirmed");
      if (!info) {
        // Gone. Cancelled by this run, or FILLED. Opposite outcomes.
        const weCancelled = j.actions.some(
          (x) => x.kind === (a.kind === "bid-post" ? "bid-cancel" : "trigger-cancel")
            && String(x.expect.nonce) === String(a.expect.nonce)
            && (x.status === "CONFIRMED" || x.status === "SENT"),
        );
        const note = weCancelled ? "gone: cancelled by this run" : "gone: FILLED or externally cancelled";
        if (!weCancelled) filled += 1;
        console.log(`  seq ${a.seq} ${a.kind} ${key.toBase58()} -> ${note}`);
        if (!DRY) updateAction(file, j, a.seq, { status: "CLEARED", note });
        cleared += 1;
        continue;
      }

      console.log(`  seq ${a.seq} ${a.kind} ${key.toBase58()} -> STILL ON CHAIN, cancelling`);
      if (DRY) { continue; }

      try {
        const peerRaw = a.expect.ocoPeer ? String(a.expect.ocoPeer) : "";
        const ix = a.kind === "bid-post"
          ? await buildCancelOrder(p, owner, mint, key, usdcMint)
          : await buildCancelTrigger(p, owner, key, usdcMint, peerRaw ? new PublicKey(peerRaw) : null);
        const tx = new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
          .add(ix);
        const sig = await anchor.web3.sendAndConfirmTransaction(conn, tx, [kp], {
          commitment: "confirmed", skipPreflight: false,
        });
        console.log(`     cancelled  sig=${sig}`);
        updateAction(file, j, a.seq, { status: "CLEARED", note: `swept: cancelled ${sig}` });
        cancelled += 1; cleared += 1;
      } catch (e) {
        // Leave it UNCLEARED so the next sweep tries again. A sweep that marks
        // something clean it failed to clean is worse than one that gives up.
        console.error(`     FAILED to cancel: ${(e as Error).message.slice(0, 200)}`);
        updateAction(file, j, a.seq, { note: `sweep failed: ${(e as Error).message.slice(0, 120)}` });
      }
    }
  }

  console.log(`\nswept: ${cleared} resolved (${cancelled} cancelled on chain, ${filled} already gone/filled)`);
  const stillOpen = openJournals(dir, HOST).length;
  console.log(stillOpen === 0 ? "SWEEP CLEAN — no state left" : `WARNING: ${stillOpen} journal(s) still unresolved`);
  process.exit(stillOpen === 0 ? 0 : 1);
}

void main();
