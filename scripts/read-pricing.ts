// =============================================================================
// scripts/read-pricing.ts — Demo on-chain Black-Scholes pricing via solmath
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");

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

function derivePricingDataPda(positionPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pricing"), positionPda.toBuffer()],
    PROGRAM_ID,
  );
}

function pad(s: string, len: number): string {
  return s + " ".repeat(Math.max(0, len - s.length));
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

async function main() {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const rawKey = JSON.parse(fs.readFileSync(
    path.join(process.env.HOME || process.env.USERPROFILE || "~", ".config/solana/id.json"), "utf-8",
  ));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(rawKey));
  const anchorWallet = new anchor.Wallet(wallet);
  const provider = new anchor.AnchorProvider(conn, anchorWallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl, provider) as Program<Opta>;

  // Find all active positions
  const disc = getDiscriminator("OptionPosition");
  const raw = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58Encode(disc) } }],
  });

  const positions: { publicKey: PublicKey; account: any }[] = [];
  for (const r of raw) {
    try {
      const account = program.coder.accounts.decode("optionPosition", r.account.data);
      if (!account.isExercised && !account.isExpired && !account.isCancelled) {
        positions.push({ publicKey: r.pubkey, account });
      }
    } catch {}
  }

  if (positions.length === 0) {
    console.log("No active option positions found on devnet.");
    return;
  }

  const nowTs = Math.floor(Date.now() / 1000);

  // Find the best non-expired position (prefer SOL)
  let bestPos: typeof positions[0] | null = null;
  let bestMarket: any = null;

  for (const p of positions) {
    const m = await program.account.optionsMarket.fetch(p.account.market);
    if (m.expiryTimestamp.toNumber() <= nowTs) continue;
    if (!bestPos || m.assetName === "SOL") {
      bestPos = p;
      bestMarket = m;
      if (m.assetName === "SOL") break; // prefer SOL
    }
  }

  if (!bestPos || !bestMarket) {
    console.log("No active non-expired option positions found on devnet.");
    return;
  }

  await pricePosition(program, wallet, bestPos, bestMarket);
}

async function pricePosition(
  program: Program<Opta>,
  wallet: Keypair,
  pos: { publicKey: PublicKey; account: any },
  market: any,
) {
  const assetName: string = market.assetName;
  const isCall = (market.optionType as any).call !== undefined;
  const strikeUsd = market.strikePrice.toNumber() / 1_000_000;
  const expiryTs = market.expiryTimestamp.toNumber();

  // Realistic spot prices per asset (USDC 6-decimals)
  const SPOT_PRICES: Record<string, number> = {
    SOL: 180_000_000,        // $180
    BTC: 105_000_000_000,    // $105,000
    ETH: 3_600_000_000,      // $3,600
    XAU: 3_100_000_000,      // $3,100
  };
  const spotUsdc = SPOT_PRICES[assetName] || 180_000_000;
  const volBps = 8500;

  const [pricingDataPda] = derivePricingDataPda(pos.publicKey);

  // Initialize pricing PDA if it doesn't exist
  try {
    await program.account.pricingData.fetch(pricingDataPda);
  } catch {
    console.log("Initializing PricingData PDA...");
    await program.methods
      .initializePricing()
      .accountsStrict({
        payer: wallet.publicKey,
        position: pos.publicKey,
        pricingData: pricingDataPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });
  }

  // Call update_pricing (parameter mode)
  console.log("Computing Black-Scholes on-chain via solmath...\n");
  await program.methods
    .updatePricing(new BN(spotUsdc), new BN(volBps))
    .accountsStrict({
      caller: wallet.publicKey,
      pricingData: pricingDataPda,
      optionPosition: pos.publicKey,
      market: pos.account.market,
      priceUpdate: null,
    })
    .rpc({ commitment: "confirmed" });

  // Read result
  const pricing = await program.account.pricingData.fetch(pricingDataPda);

  const fairValue = pricing.fairValuePerToken.toNumber() / 1_000_000;
  const spotRead = pricing.spotPriceUsed.toNumber() / 1_000_000;
  const volRead = pricing.impliedVolBps.toNumber() / 100;
  const delta = pricing.deltaBps.toNumber() / 10_000;
  const gamma = pricing.gammaBps.toNumber() / 10_000;
  const vega = pricing.vegaUsdc.toNumber() / 1_000_000;
  const theta = pricing.thetaUsdc.toNumber() / 1_000_000;

  const W = 44;
  const line = (label: string, value: string) => {
    const content = `  ${pad(label, 15)}${value}`;
    return `║${pad(content, W)}║`;
  };
  const sep = `╠${"═".repeat(W)}╣`;

  console.log(`╔${"═".repeat(W)}╗`);
  console.log(`║${pad("  BUTTER OPTIONS — ON-CHAIN PRICING", W)}║`);
  console.log(sep);
  console.log(line("Asset:", `${assetName}/USD`));
  console.log(line("Strike:", `$${strikeUsd.toFixed(2)}`));
  console.log(line("Expiry:", formatDate(expiryTs)));
  console.log(line("Type:", isCall ? "Call" : "Put"));
  console.log(sep);
  console.log(line("Spot:", `$${spotRead.toFixed(2)}`));
  console.log(line("Implied Vol:", `${volRead.toFixed(2)}%`));
  console.log(line("Fair Value:", `$${fairValue.toFixed(4)}`));
  console.log(sep);
  console.log(line("Delta:", delta.toFixed(4)));
  console.log(line("Gamma:", gamma.toFixed(4)));
  console.log(line("Vega:", `$${vega.toFixed(2)}`));
  console.log(line("Theta:", `${theta < 0 ? "-" : ""}$${Math.abs(theta).toFixed(2)}/day`));
  console.log(sep);
  console.log(`║${pad("  Computed on-chain via solmath", W)}║`);
  console.log(`║${pad("  ~50,000 compute units", W)}║`);
  console.log(`║${pad("  Updated: " + new Date(pricing.lastUpdated.toNumber() * 1000).toISOString().slice(0, 19), W)}║`);
  console.log(`╚${"═".repeat(W)}╝`);
}

main().catch(console.error);
