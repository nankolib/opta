// =============================================================================
// crank/bot.ts — Auto-settle, auto-exercise, auto-expire crank bot
// =============================================================================
//
// Runs on a 60-second timer. Each tick:
//   1. Fetch all markets — settle any that are expired but not settled
//   2. Fetch all positions for settled markets — exercise ITM, expire OTM
//   3. Burn expired option tokens from holders via permanent delegate
//
// The bot wallet must be the protocol admin (the deploy keypair).
//
// Usage: npx ts-node crank/bot.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
import {
  Connection, PublicKey, Keypair,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// =============================================================================
// Config
// =============================================================================
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const TICK_INTERVAL_MS = 60_000; // 60 seconds
const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

// Hardcoded price map for devnet (hackathon). In production, read from Pyth.
// Prices in USDC (scaled by 10^6).
const DEVNET_PRICES: Record<string, number> = {
  SOL: 195_000_000,    // $195
  BTC: 105_000_000_000, // $105,000
  ETH: 3_600_000_000,  // $3,600
  XAU: 3_100_000_000,  // $3,100
};

// =============================================================================
// Helpers
// =============================================================================
function getDiscriminator(name: string): Buffer {
  return Buffer.from(crypto.createHash("sha256").update("account:" + name).digest().slice(0, 8));
}

function bs58Encode(bytes: Buffer): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const d = [0];
  for (const b of bytes) {
    let c = b;
    for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; }
    while (c > 0) { d.push(c % 58); c = (c / 58) | 0; }
  }
  let s = "";
  for (const b of bytes) { if (b !== 0) break; s += "1"; }
  for (let i = d.length - 1; i >= 0; i--) s += A[d[i]];
  return s;
}

function ts() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

async function safeFetchAll(conn: Connection, program: Program<any>, accountName: string, displayName: string) {
  const disc = getDiscriminator(displayName);
  const raw = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58Encode(disc) } }],
  });
  const results: { publicKey: PublicKey; account: any }[] = [];
  for (const r of raw) {
    try {
      const account = program.coder.accounts.decode(accountName, r.account.data);
      results.push({ publicKey: r.pubkey, account });
    } catch { /* skip old format */ }
  }
  return results;
}

// =============================================================================
// Core bot logic
// =============================================================================
async function tick(
  conn: Connection,
  program: Program<ButterOptions>,
  admin: Keypair,
  protocolStatePda: PublicKey,
) {
  const nowTs = Math.floor(Date.now() / 1000);
  console.log(`\n[${ts()}] === CRANK TICK ===`);

  // Fetch all markets and positions (Token-2022 only)
  const allMarkets = await safeFetchAll(conn, program, "optionsMarket", "OptionsMarket");
  const allPositions = await safeFetchAll(conn, program, "optionPosition", "OptionPosition");

  // Filter to valid Token-2022 markets (assetClass 0-4)
  const markets = allMarkets.filter((m) => typeof m.account.assetClass === "number" && m.account.assetClass <= 4);
  const marketMap = new Map<string, any>();
  markets.forEach((m) => marketMap.set(m.publicKey.toBase58(), m));

  console.log(`  Markets: ${markets.length} | Positions: ${allPositions.length}`);

  // =========================================================================
  // Phase 1: Settle expired markets
  // =========================================================================
  const unsettled = markets.filter((m) => !m.account.isSettled && m.account.expiryTimestamp.toNumber() <= nowTs);
  if (unsettled.length > 0) {
    console.log(`\n  [SETTLE] ${unsettled.length} expired unsettled market(s)`);
    for (const m of unsettled) {
      const asset = m.account.assetName;
      const price = DEVNET_PRICES[asset];
      if (!price) {
        console.log(`    SKIP ${asset} — no price in DEVNET_PRICES map`);
        continue;
      }
      try {
        const tx = await program.methods
          .settleMarket(new BN(price))
          .accountsStrict({
            admin: admin.publicKey,
            protocolState: protocolStatePda,
            market: m.publicKey,
          })
          .rpc({ commitment: "confirmed" });
        const isCall = (m.account.optionType as any).call !== undefined;
        const strikeUsd = (m.account.strikePrice.toNumber() / 1e6).toFixed(0);
        console.log(`    SETTLED ${asset} $${strikeUsd} ${isCall ? "Call" : "Put"} @ $${(price / 1e6).toFixed(0)} — tx: ${tx.slice(0, 20)}...`);
      } catch (err: any) {
        console.log(`    FAILED to settle ${asset}: ${err.message?.slice(0, 80)}`);
      }
    }
  }

  // Refresh markets after settling
  const refreshedMarkets = await safeFetchAll(conn, program, "optionsMarket", "OptionsMarket");
  const settledMarketMap = new Map<string, any>();
  refreshedMarkets.filter((m) => m.account.isSettled).forEach((m) => settledMarketMap.set(m.publicKey.toBase58(), m));

  // =========================================================================
  // Phase 2: Exercise ITM positions + Expire OTM positions
  // =========================================================================
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint;

  for (const p of allPositions) {
    // Skip already processed
    if (p.account.isExercised || p.account.isExpired || p.account.isCancelled) continue;

    const settledMarket = settledMarketMap.get(p.account.market.toBase58());
    if (!settledMarket) continue; // market not settled yet

    const mkt = settledMarket.account;
    const isCall = (mkt.optionType as any).call !== undefined;
    const strike = mkt.strikePrice.toNumber();
    const settlement = mkt.settlementPrice.toNumber();
    const assetName = mkt.assetName;
    const strikeUsd = (strike / 1e6).toFixed(0);

    // Determine if ITM
    const itm = isCall ? settlement > strike : strike > settlement;

    // Derive common accounts
    const writer = p.account.writer;
    const [escrowPda] = PublicKey.findProgramAddressSync([
      Buffer.from("escrow"), p.account.market.toBuffer(), writer.toBuffer(),
      p.account.createdAt.toArrayLike(Buffer, "le", 8),
    ], PROGRAM_ID);
    const writerUsdcAccount = getAssociatedTokenAddressSync(usdcMint, writer, false, TOKEN_PROGRAM_ID);

    // Both ITM and OTM: expire the position to return collateral to writer.
    // Users exercise themselves via the frontend (exerciser must sign).
    // After expire, the crank burns remaining tokens via permanent delegate.
    try {
      const tx = await program.methods.expireOption().accountsStrict({
        caller: admin.publicKey,
        protocolState: protocolStatePda,
        market: p.account.market,
        position: p.publicKey,
        escrow: escrowPda,
        writerUsdcAccount,
        writer,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).preInstructions([EXTRA_CU]).rpc({ commitment: "confirmed" });
      const label = itm ? "ITM" : "OTM";
      console.log(`    EXPIRED ${assetName} $${strikeUsd} ${isCall ? "Call" : "Put"} (${label}) — pos: ${p.publicKey.toBase58().slice(0, 12)}... tx: ${tx.slice(0, 20)}...`);
    } catch (err: any) {
      console.log(`    FAIL expire ${p.publicKey.toBase58().slice(0, 12)}...: ${err.message?.slice(0, 80)}`);
    }
  }

  // =========================================================================
  // Phase 3: Burn expired tokens from holders via permanent delegate
  // =========================================================================
  // After exercise/expire, some holders may still have tokens for positions
  // that are now exercised/expired. Use permanent delegate to burn them.
  console.log(`\n  [BURN] Scanning for expired tokens to burn via permanent delegate...`);
  let burnCount = 0;

  for (const p of allPositions) {
    if (!p.account.isExercised && !p.account.isExpired) continue;

    const optionMint = p.account.optionMint;
    const mintInfo = await conn.getAccountInfo(optionMint);
    if (!mintInfo || !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) continue;

    // Scan for remaining token balances
    const tokenAccounts = await conn.getTokenLargestAccounts(optionMint, "confirmed");
    for (const ta of tokenAccounts.value) {
      if (ta.uiAmount === 0) continue;
      const taInfo = await conn.getAccountInfo(ta.address);
      if (!taInfo || taInfo.data.length < 72) continue;
      const holderPubkey = new PublicKey(Uint8Array.from(taInfo.data.slice(32, 64)));
      const balance = Number(taInfo.data.readBigUInt64LE(64));
      if (balance === 0) continue;

      // Permanent delegate burn requires a CPI from the on-chain program (PDA signer).
      // A dedicated "admin_burn" instruction would enable this. For now, log the remainder.
      // The transfer hook already blocks transfers of expired tokens, making them inert.
      console.log(`    ${balance} expired token(s) in ${holderPubkey.toBase58().slice(0, 12)}... (mint: ${optionMint.toBase58().slice(0, 12)}...) — blocked by transfer hook`);
      burnCount += balance;
    }
  }

  if (burnCount > 0) {
    console.log(`  [BURN] Found ${burnCount} expired token(s) across holders (worthless post-settlement)`);
  } else {
    console.log(`  [BURN] No expired tokens found`);
  }

  console.log(`[${ts()}] === TICK COMPLETE ===`);
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  console.log("=== Butter Options Crank Bot ===");
  console.log(`Tick interval: ${TICK_INTERVAL_MS / 1000}s`);

  const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "butter_options.json"), "utf-8"));
  const rawKey = JSON.parse(fs.readFileSync(path.join(process.env.HOME || "~", ".config/solana/id.json"), "utf-8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(rawKey));
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl, provider) as Program<ButterOptions>;

  const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);

  console.log(`Admin: ${admin.publicKey.toBase58()}`);
  console.log(`Protocol admin: ${protocolState.admin.toBase58()}`);

  if (!admin.publicKey.equals(protocolState.admin)) {
    console.error("ERROR: Bot wallet is not the protocol admin!");
    process.exit(1);
  }

  console.log(`Protocol USDC mint: ${protocolState.usdcMint.toBase58()}`);
  console.log(`\nBot started. Press Ctrl+C to stop.\n`);

  // Run first tick immediately
  await tick(conn, program, admin, protocolStatePda);

  // Then run on interval
  setInterval(async () => {
    try {
      await tick(conn, program, admin, protocolStatePda);
    } catch (err: any) {
      console.error(`[${ts()}] TICK ERROR: ${err.message?.slice(0, 120)}`);
    }
  }, TICK_INTERVAL_MS);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
