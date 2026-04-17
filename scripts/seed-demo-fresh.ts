// =============================================================================
// scripts/seed-demo-fresh.ts — Clean demo seed for live recording
// =============================================================================
// Usage: ANCHOR_WALLET=~/.config/solana/id.json ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npx ts-node scripts/seed-demo-fresh.ts
//
// Creates fresh v2-only demo data:
// - 5 assets: SOL, BTC, ETH, XAU, AAPL
// - 8 epoch vaults (next Friday expiry)
// - 1 custom vault with 10-min expiry (for lifecycle demo)
// All seeded with deposits + mints from admin wallet.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

const usdc = (n: number): BN => new BN(Math.round(n * 1_000_000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// =============================================================================
// PDA derivation
// =============================================================================
function deriveProtocolStatePda() { return PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID); }
function deriveEpochConfigPda() { return PublicKey.findProgramAddressSync([Buffer.from("epoch_config")], PROGRAM_ID); }
function deriveMarketPda(asset: string, strike: BN, expiry: BN, typeIdx: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(asset), strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([typeIdx])],
    PROGRAM_ID,
  );
}
function deriveSharedVaultPda(market: PublicKey, strike: BN, expiry: BN, typeIdx: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("shared_vault"), market.toBuffer(), strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([typeIdx])],
    PROGRAM_ID,
  );
}
function deriveVaultUsdcPda(vault: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("vault_usdc"), vault.toBuffer()], PROGRAM_ID); }
function deriveWriterPositionPda(vault: PublicKey, writer: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("writer_position"), vault.toBuffer(), writer.toBuffer()], PROGRAM_ID);
}
function deriveVaultOptionMintPda(vault: PublicKey, writer: PublicKey, createdAt: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_option_mint"), vault.toBuffer(), writer.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  );
}
function deriveVaultPurchaseEscrowPda(vault: PublicKey, writer: PublicKey, createdAt: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_purchase_escrow"), vault.toBuffer(), writer.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  );
}
function deriveVaultMintRecordPda(mint: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("vault_mint_record"), mint.toBuffer()], PROGRAM_ID); }
function deriveExtraMetaListPda(mint: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], HOOK_PROGRAM_ID); }
function deriveHookStatePda(mint: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from("hook-state"), mint.toBuffer()], HOOK_PROGRAM_ID); }

/** Next Friday 08:00 UTC that's at least 1 day away */
function nextFridayExpiry(): BN {
  const now = new Date();
  let daysUntil = (5 - now.getUTCDay() + 7) % 7;
  if (daysUntil === 0) {
    const todayAt8 = new Date(now); todayAt8.setUTCHours(8, 0, 0, 0);
    if (now >= todayAt8) daysUntil = 7;
  }
  if (daysUntil * 86400 < 86400 + 30) daysUntil += 7;
  const friday = new Date(now);
  friday.setUTCDate(friday.getUTCDate() + daysUntil);
  friday.setUTCHours(8, 0, 0, 0);
  return new BN(Math.floor(friday.getTime() / 1000));
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  console.log("=== Butter Options — Fresh Demo Seed ===\n");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.butterOptions as Program<ButterOptions>;
  const admin = provider.wallet as anchor.Wallet;
  const payer = (admin as any).payer as Keypair;

  console.log("Admin:", admin.publicKey.toBase58());

  const [protocolStatePda] = deriveProtocolStatePda();
  const [epochConfigPda] = deriveEpochConfigPda();

  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint;
  console.log("USDC mint:", usdcMint.toBase58());

  try { await program.account.epochConfig.fetch(epochConfigPda); console.log("✓ EpochConfig found"); }
  catch { console.error("ERROR: EpochConfig not initialized. Run initialize-epoch-config.ts first."); process.exit(1); }

  // Use admin as writer for demo (admin has USDC from previous seeds)
  const writer = payer;
  const writerAta = getAssociatedTokenAddressSync(usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);

  try {
    const bal = await provider.connection.getTokenAccountBalance(writerAta);
    const num = Number(bal.value.amount) / 1_000_000;
    console.log(`Writer USDC balance: $${num.toLocaleString()}`);
    if (num < 500_000) {
      console.log("  Minting more USDC...");
      await mintTo(provider.connection, payer, usdcMint, writerAta, payer.publicKey, 1_000_000_000_000);
    }
  } catch {
    console.error("ERROR: Writer USDC ATA not found. Run seed-devnet.ts first.");
    process.exit(1);
  }

  // Pyth feeds (from scripts/create-sample-markets.ts)
  const PYTH_FEEDS: Record<string, PublicKey> = {
    SOL: new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"),
    BTC: new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"),
    ETH: new PublicKey("EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9GvYRk4HY7y44"),
    XAU: new PublicKey("8y3WWjvmSmVGWVKH1rCA7VTRmuU7QbJ9axMK6JUUuCyi"),
    AAPL: new PublicKey("5yKHAuiDWKUGRgs3s6mYGdfZjFmTfgHVDBwFBDfMuZJH"),
  };

  const fridayExpiry = nextFridayExpiry();
  const now = Math.floor(Date.now() / 1000);
  console.log(`\nNext Friday expiry: ${new Date(fridayExpiry.toNumber() * 1000).toISOString()}\n`);

  // Asset class: 0=crypto, 1=commodity, 2=equity
  interface VaultDef {
    asset: string; strike: BN; typeIdx: 0 | 1; deposit: BN;
    vaultType: "epoch" | "custom"; expiry: BN; assetClass: number; label: string;
  }
  const defs: VaultDef[] = [
    // SOL (current ~$86)
    { asset: "SOL", strike: usdc(80),  typeIdx: 1, deposit: usdc(800),  vaultType: "epoch", expiry: fridayExpiry, assetClass: 0, label: "SOL $80 Put" },
    { asset: "SOL", strike: usdc(90),  typeIdx: 0, deposit: usdc(1800), vaultType: "epoch", expiry: fridayExpiry, assetClass: 0, label: "SOL $90 Call" },
    { asset: "SOL", strike: usdc(100), typeIdx: 0, deposit: usdc(2000), vaultType: "epoch", expiry: fridayExpiry, assetClass: 0, label: "SOL $100 Call" },
    // BTC (current ~$74K)
    { asset: "BTC", strike: usdc(75_000), typeIdx: 0, deposit: usdc(150_000), vaultType: "epoch", expiry: fridayExpiry, assetClass: 0, label: "BTC $75K Call" },
    { asset: "BTC", strike: usdc(85_000), typeIdx: 1, deposit: usdc(85_000),  vaultType: "epoch", expiry: fridayExpiry, assetClass: 0, label: "BTC $85K Put" },
    // ETH (current ~$2300)
    { asset: "ETH", strike: usdc(2_400), typeIdx: 0, deposit: usdc(4800), vaultType: "epoch", expiry: fridayExpiry, assetClass: 0, label: "ETH $2.4K Call" },
    // XAU / gold (current ~$3230)
    { asset: "XAU", strike: usdc(3_200), typeIdx: 0, deposit: usdc(6400), vaultType: "epoch", expiry: fridayExpiry, assetClass: 1, label: "XAU $3.2K Call" },
    // AAPL (current ~$200)
    { asset: "AAPL", strike: usdc(200), typeIdx: 0, deposit: usdc(400), vaultType: "epoch", expiry: fridayExpiry, assetClass: 2, label: "AAPL $200 Call" },
    // Custom 10-min expiry for live lifecycle demo
    { asset: "SOL", strike: usdc(90), typeIdx: 0, deposit: usdc(1800), vaultType: "custom", expiry: new BN(now + 600), assetClass: 0, label: "SOL $90 Call (Custom 10m)" },
  ];

  let created = 0, skipped = 0, totalDeposited = 0, totalMinted = 0;

  for (const d of defs) {
    console.log(`\n--- ${d.label} ---`);
    const optType = d.typeIdx === 0 ? { call: {} } : { put: {} };

    // 1. Ensure market
    const [marketPda] = deriveMarketPda(d.asset, d.strike, d.expiry, d.typeIdx);
    try {
      await program.account.optionsMarket.fetch(marketPda);
      console.log("  Market exists");
    } catch {
      try {
        const feed = PYTH_FEEDS[d.asset] || Keypair.generate().publicKey;
        await program.methods.createMarket(d.asset, d.strike, d.expiry, optType as any, feed, d.assetClass)
          .accountsStrict({ creator: admin.publicKey, protocolState: protocolStatePda, market: marketPda, systemProgram: SystemProgram.programId })
          .rpc({ commitment: "confirmed" });
        console.log("  ✓ Market created");
        await sleep(500);
      } catch (err: any) {
        console.error("  ✗ Market create failed:", err.message?.slice(0, 120));
        skipped++; continue;
      }
    }

    // 2. Ensure vault
    const [vaultPda] = deriveSharedVaultPda(marketPda, d.strike, d.expiry, d.typeIdx);
    const [vaultUsdcPda] = deriveVaultUsdcPda(vaultPda);
    let vaultExists = false;
    try { await program.account.sharedVault.fetch(vaultPda); vaultExists = true; } catch { /* */ }

    if (vaultExists) {
      console.log("  Vault exists, skipping...");
      skipped++; continue;
    }

    try {
      const vaultTypeEnum = d.vaultType === "epoch" ? { epoch: {} } : { custom: {} };
      const ecAccount = d.vaultType === "epoch" ? epochConfigPda : null;
      await program.methods.createSharedVault(d.strike, d.expiry, optType as any, vaultTypeEnum as any)
        .accountsStrict({
          creator: writer.publicKey, market: marketPda,
          sharedVault: vaultPda, vaultUsdcAccount: vaultUsdcPda,
          usdcMint, protocolState: protocolStatePda, epochConfig: ecAccount,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .signers([writer]).rpc({ commitment: "confirmed" });
      console.log("  ✓ Vault created");
      await sleep(1000);
    } catch (err: any) {
      console.error("  ✗ Vault create failed:", err.message?.slice(0, 120));
      skipped++; continue;
    }

    // 3. Deposit
    const [writerPosPda] = deriveWriterPositionPda(vaultPda, writer.publicKey);
    try {
      await program.methods.depositToVault(d.deposit)
        .accountsStrict({
          writer: writer.publicKey, sharedVault: vaultPda, writerPosition: writerPosPda,
          writerUsdcAccount: writerAta, vaultUsdcAccount: vaultUsdcPda, protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .signers([writer]).rpc({ commitment: "confirmed" });
      const dep = d.deposit.toNumber() / 1_000_000;
      totalDeposited += dep;
      console.log(`  ✓ Deposited $${dep.toLocaleString()}`);
      await sleep(1000);
    } catch (err: any) {
      console.error("  ✗ Deposit failed:", err.message?.slice(0, 120));
      continue;
    }

    // 4. Mint options
    const strikeN = d.strike.toNumber() / 1_000_000;
    const depN = d.deposit.toNumber() / 1_000_000;
    const contracts = d.typeIdx === 0 ? Math.floor(depN / (strikeN * 2)) : Math.floor(depN / strikeN);
    if (contracts <= 0) { created++; continue; }

    const premiumPer = usdc(strikeN * 0.05);
    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const [optionMintPda] = deriveVaultOptionMintPda(vaultPda, writer.publicKey, createdAt);
    const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(vaultPda, writer.publicKey, createdAt);
    const [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
    const [extraMeta] = deriveExtraMetaListPda(optionMintPda);
    const [hookState] = deriveHookStatePda(optionMintPda);

    try {
      await program.methods.mintFromVault(new BN(contracts), premiumPer, createdAt)
        .accountsStrict({
          writer: writer.publicKey, sharedVault: vaultPda, writerPosition: writerPosPda,
          market: marketPda, protocolState: protocolStatePda,
          optionMint: optionMintPda, purchaseEscrow: purchaseEscrowPda, vaultMintRecord: vaultMintRecordPda,
          transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMeta, hookState,
          systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
        })
        .preInstructions([EXTRA_CU]).signers([writer]).rpc({ commitment: "confirmed" });
      totalMinted += contracts;
      console.log(`  ✓ Minted ${contracts} contracts @ $${(premiumPer.toNumber() / 1_000_000).toFixed(2)} premium`);
      await sleep(1000);
    } catch (err: any) {
      console.error("  ✗ Mint failed:", err.message?.slice(0, 120));
    }
    created++;
  }

  console.log("\n=== Summary ===");
  console.log(`  Created: ${created}/${defs.length} vaults`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total deposited: $${totalDeposited.toLocaleString()} USDC`);
  console.log(`  Total minted: ${totalMinted} contracts`);
  console.log("\n=== Fresh demo seed complete! ===");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  if (err.logs) console.error("Logs:", err.logs.slice(-5).join("\n  "));
  process.exit(1);
});
