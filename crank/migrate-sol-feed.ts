// crank/migrate-sol-feed.ts
// =============================================================================
// One-shot admin script: rotate SOL market's pyth_feed_id from Beta to mainnet.
//
// Run (from crank/):
//   OPTA_RPC_URL="<helius>" npx ts-node -r tsconfig-paths/register \
//     migrate-sol-feed.ts
//
// Required: keypair at ~/.config/solana/id.json must equal protocol_state.admin.
// Aborts before submitting if either pre-flight check fails.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const ASSET_NAME = "SOL";
const NEW_FEED_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const EXPECTED_OLD_FEED_HEX =
  "fe650f0367d4a7ef9815a593ea15d36593f0643aaaf0149bb04be67ab851decd";
const KEYPAIR_PATH = path.join(os.homedir(), ".config/solana/id.json");
const IDL_JSON_PATH = path.resolve(__dirname, "../app/src/idl/opta.json");

function hexToBytes32(hex: string): number[] {
  const clean = hex.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error("invalid 32-byte hex");
  }
  const out: number[] = new Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hexFromBytes(bytes: Iterable<number>): string {
  let out = "";
  for (const b of bytes) out += (b & 0xff).toString(16).padStart(2, "0");
  return out;
}

function redactRpc(url: string): string {
  return url.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
}

function trunc(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

async function main(): Promise<void> {
  const rpc = process.env.OPTA_RPC_URL;
  if (!rpc) {
    console.error("FATAL: OPTA_RPC_URL is required");
    process.exit(1);
  }

  // ---- Bootstrap -----------------------------------------------------------
  const conn = new Connection(rpc, "confirmed");
  const secret = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8")) as number[];
  if (!Array.isArray(secret) || secret.length !== 64) {
    console.error(`FATAL: keypair file must be 64-byte JSON array (${KEYPAIR_PATH})`);
    process.exit(1);
  }
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  const idl = JSON.parse(fs.readFileSync(IDL_JSON_PATH, "utf-8")) as Opta;
  const program = new anchor.Program<Opta>(idl, provider);

  console.log("admin wallet:", kp.publicKey.toBase58());
  console.log("rpc:         ", redactRpc(rpc));
  console.log("");

  // ---- Derive PDAs ---------------------------------------------------------
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(ASSET_NAME)],
    PROGRAM_ID,
  );
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    PROGRAM_ID,
  );

  // ---- Pre-flight: admin authority -----------------------------------------
  const ps = await program.account.protocolState.fetch(protocolStatePda);
  if (!ps.admin.equals(kp.publicKey)) {
    console.error("FATAL: keypair is not the protocol admin");
    console.error("  keypair pubkey:", kp.publicKey.toBase58());
    console.error("  protocol admin:", ps.admin.toBase58());
    process.exit(1);
  }
  console.log("admin check: keypair == protocol_state.admin OK");

  // ---- Pre-flight: current feed_id state -----------------------------------
  const market = await program.account.optionsMarket.fetch(marketPda);
  const currentHex = hexFromBytes(market.pythFeedId as number[]);

  console.log("");
  console.log("market PDA:    ", marketPda.toBase58());
  console.log("  asset_name:  ", market.assetName);
  console.log("  current feed:", trunc(currentHex), `(full: ${currentHex})`);

  if (currentHex === NEW_FEED_HEX) {
    console.log("");
    console.log("STOP: SOL market is already on the mainnet feed_id.");
    console.log("Migration was somehow already done. Nothing to submit.");
    process.exit(0);
  }
  if (currentHex !== EXPECTED_OLD_FEED_HEX) {
    console.error("");
    console.error("STOP: current feed_id is neither the expected Beta value nor the mainnet target.");
    console.error("  expected old (Beta):    ", EXPECTED_OLD_FEED_HEX);
    console.error("  expected new (mainnet): ", NEW_FEED_HEX);
    console.error("  found on chain:         ", currentHex);
    console.error("Refusing to migrate from an unknown state. Investigate before retrying.");
    process.exit(1);
  }

  console.log("  new feed:    ", trunc(NEW_FEED_HEX), `(full: ${NEW_FEED_HEX})`);
  console.log("");

  // ---- Submit --------------------------------------------------------------
  const newBytes = hexToBytes32(NEW_FEED_HEX);
  console.log("submitting migrate_pyth_feed…");
  const sig = await program.methods
    .migratePythFeed(ASSET_NAME, newBytes)
    .accountsStrict({
      admin: kp.publicKey,
      protocolState: protocolStatePda,
      market: marketPda,
    })
    .rpc({ commitment: "confirmed" });

  console.log("");
  console.log("=== tx submitted");
  console.log("  signature:", sig);
  console.log("  solscan:  ", `https://solscan.io/tx/${sig}?cluster=devnet`);

  // ---- Post-flight: re-fetch + verify --------------------------------------
  const marketAfter = await program.account.optionsMarket.fetch(marketPda);
  const newHex = hexFromBytes(marketAfter.pythFeedId as number[]);

  console.log("");
  console.log("=== post-flight verification");
  console.log("  market.pythFeedId now:", newHex);

  if (newHex !== NEW_FEED_HEX) {
    console.error(`MISMATCH: expected ${NEW_FEED_HEX}, found ${newHex}`);
    process.exit(1);
  }
  console.log("  match: SOL market now points at mainnet SOL/USD feed");
}

main().catch((err: any) => {
  console.error("FATAL:", err?.message ?? err);
  if (err?.logs) console.error("Logs:", err.logs);
  process.exit(1);
});
