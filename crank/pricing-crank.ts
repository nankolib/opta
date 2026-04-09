// =============================================================================
// crank/pricing-crank.ts — Keeps on-chain fair values fresh via Pyth + solmath
// =============================================================================
//
// HOW IT WORKS:
// Every 60 seconds, for each active option position:
//   1. Check if a PricingData PDA exists — if not, create one
//   2. Look up the Pyth price feed account for the position's asset
//   3. Call update_pricing with the Pyth account + a default vol
//   4. The smart contract reads the Pyth price, runs Black-Scholes on-chain
//      via solmath, and stores the fair value + all 5 Greeks
//
// The crank doesn't compute any prices — all math runs on-chain.
// The crank just delivers fresh Pyth data and triggers the computation.
//
// Usage: npx ts-node crank/pricing-crank.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
import {
  Connection, PublicKey, Keypair,
} from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// =============================================================================
// Config
// =============================================================================
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const TICK_INTERVAL_MS = 60_000;

// Default implied volatility per asset class (bps).
// In production, these would be computed from EWMA on historical Pyth data.
const DEFAULT_VOL_BPS: Record<string, number> = {
  SOL: 8500,     // 85% — crypto
  BTC: 7000,     // 70% — crypto (lower vol than SOL)
  ETH: 7500,     // 75% — crypto
  XAU: 2000,     // 20% — commodity
  AAPL: 4000,    // 40% — equity
  "EUR/USD": 1000, // 10% — forex
};
const FALLBACK_VOL_BPS = 8000; // 80% default

// Pyth price feed account addresses on devnet (shard 0, pre-sponsored).
// These are derived from PythSolanaReceiver.getPriceFeedAccountAddress(0, feedId).
// If a feed doesn't exist here, we fall back to parameter mode (no Pyth account).
//
// To find these addresses:
//   1. Go to https://pyth.network/developers/price-feed-ids
//   2. Get the hex feed ID
//   3. Use @pythnetwork/pyth-solana-receiver to derive:
//      PythSolanaReceiver.getPriceFeedAccountAddress(0, feedIdBytes)
//
// For hackathon, we pass spot_price as parameter (no Pyth account) since
// existing markets use fake pyth_feed pubkeys. When real markets are created
// with proper Pyth feed IDs, enable the Pyth account path.
// TODO: Replace with live Pyth price fetching before mainnet.
// Hardcoded prices are acceptable for devnet/hackathon only.
// See: https://docs.pyth.network/price-feeds/use-real-time-data/solana
const DEVNET_SPOT_PRICES: Record<string, number> = {
  SOL: 180_000_000,     // $180
  BTC: 105_000_000_000, // $105,000
  ETH: 3_600_000_000,   // $3,600
  XAU: 3_100_000_000,   // $3,100
};

// =============================================================================
// Helpers
// =============================================================================
function getDiscriminator(name: string): Buffer {
  return Buffer.from(
    crypto.createHash("sha256").update("account:" + name).digest().slice(0, 8),
  );
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

function derivePricingDataPda(positionPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pricing"), positionPda.toBuffer()],
    PROGRAM_ID,
  );
}

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
// Pricing tick
// =============================================================================
async function tick(
  conn: Connection,
  program: Program<ButterOptions>,
  wallet: Keypair,
) {
  const nowTs = Math.floor(Date.now() / 1000);
  console.log(`\n[${ts()}] === PRICING TICK ===`);

  // Fetch all active positions
  const allPositions = await safeFetchAll(conn, program, "optionPosition", "OptionPosition");
  const activePositions = allPositions.filter(
    (p) => !p.account.isExercised && !p.account.isExpired && !p.account.isCancelled,
  );

  // Build market map
  const allMarkets = await safeFetchAll(conn, program, "optionsMarket", "OptionsMarket");
  const marketMap = new Map<string, { publicKey: PublicKey; account: any }>();
  allMarkets.forEach((m) => marketMap.set(m.publicKey.toBase58(), m));

  console.log(`  Active positions: ${activePositions.length}`);

  let updated = 0;
  let initialized = 0;

  for (const pos of activePositions) {
    const marketEntry = marketMap.get(pos.account.market.toBase58());
    if (!marketEntry) continue;

    const market = marketEntry.account;
    const assetName: string = market.assetName;

    // Skip if market already expired
    if (market.expiryTimestamp.toNumber() <= nowTs) continue;

    // Derive pricing PDA
    const [pricingDataPda] = derivePricingDataPda(pos.publicKey);

    // Check if PricingData exists
    let pricingExists = false;
    try {
      await program.account.pricingData.fetch(pricingDataPda);
      pricingExists = true;
    } catch { /* doesn't exist yet */ }

    // Initialize if needed
    if (!pricingExists) {
      try {
        await program.methods
          .initializePricing()
          .accountsStrict({
            payer: wallet.publicKey,
            position: pos.publicKey,
            pricingData: pricingDataPda,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .rpc({ commitment: "confirmed" });
        initialized++;
        console.log(`    INIT pricing for ${assetName} pos ${pos.publicKey.toBase58().slice(0, 12)}...`);
      } catch (err: any) {
        console.log(`    FAIL init ${pos.publicKey.toBase58().slice(0, 12)}...: ${err.message?.slice(0, 60)}`);
        continue;
      }
    }

    // Get spot price and vol for this asset
    const spotPrice = DEVNET_SPOT_PRICES[assetName];
    if (!spotPrice) {
      console.log(`    SKIP ${assetName} — no spot price configured`);
      continue;
    }
    const volBps = DEFAULT_VOL_BPS[assetName] || FALLBACK_VOL_BPS;

    // Call update_pricing (parameter mode — no Pyth account for hackathon)
    try {
      await program.methods
        .updatePricing(new BN(spotPrice), new BN(volBps))
        .accountsStrict({
          caller: wallet.publicKey,
          pricingData: pricingDataPda,
          optionPosition: pos.publicKey,
          market: marketEntry.publicKey,
          priceUpdate: null,
        })
        .rpc({ commitment: "confirmed" });

      // Read back the result to log it
      const pricing = await program.account.pricingData.fetch(pricingDataPda);
      const fairUsd = (pricing.fairValuePerToken.toNumber() / 1_000_000).toFixed(4);
      const delta = (pricing.deltaBps.toNumber() / 100).toFixed(1);
      const isCall = (market.optionType as any).call !== undefined;
      const strikeUsd = (market.strikePrice.toNumber() / 1e6).toFixed(0);

      console.log(
        `    PRICED ${assetName} $${strikeUsd} ${isCall ? "Call" : "Put"}: ` +
        `fair=$${fairUsd}, delta=${delta}%, spot=$${(spotPrice / 1e6).toFixed(0)}, vol=${volBps / 100}%`,
      );
      updated++;
    } catch (err: any) {
      console.log(`    FAIL price ${pos.publicKey.toBase58().slice(0, 12)}...: ${err.message?.slice(0, 80)}`);
    }
  }

  console.log(`  Initialized: ${initialized} | Updated: ${updated}`);
  console.log(`[${ts()}] === PRICING TICK COMPLETE ===`);
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  console.log("=== Butter Options Pricing Crank ===");
  console.log(`Tick interval: ${TICK_INTERVAL_MS / 1000}s`);

  const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "target", "idl", "butter_options.json"), "utf-8"),
  );
  const rawKey = JSON.parse(
    fs.readFileSync(
      path.join(process.env.HOME || process.env.USERPROFILE || "~", ".config/solana/id.json"),
      "utf-8",
    ),
  );
  const wallet = Keypair.fromSecretKey(Uint8Array.from(rawKey));
  const anchorWallet = new anchor.Wallet(wallet);
  const provider = new anchor.AnchorProvider(conn, anchorWallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl, provider) as Program<ButterOptions>;

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`RPC: ${process.env.RPC_URL || "https://api.devnet.solana.com"}`);
  console.log(`\nPricing crank started. Press Ctrl+C to stop.\n`);

  // First tick immediately
  await tick(conn, program, wallet);

  // Then on interval
  setInterval(async () => {
    try {
      await tick(conn, program, wallet);
    } catch (err: any) {
      console.error(`[${ts()}] TICK ERROR: ${err.message?.slice(0, 120)}`);
    }
  }, TICK_INTERVAL_MS);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
