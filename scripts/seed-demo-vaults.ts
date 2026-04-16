// =============================================================================
// scripts/seed-demo-vaults.ts — Create demo shared vaults with deposits and mints
// =============================================================================
// Usage: npx ts-node scripts/seed-demo-vaults.ts
// Prereqs: protocol initialized, EpochConfig initialized, markets created,
//          writer wallet funded with SOL + USDC (run seed-devnet.ts first)
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

// =============================================================================
// Constants
// =============================================================================
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

function usdc(amount: number): BN {
  return new BN(Math.round(amount * 1_000_000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// PDA derivation
// =============================================================================
function deriveProtocolStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
}

function deriveEpochConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("epoch_config")], PROGRAM_ID);
}

function deriveMarketPda(
  assetName: string, strike: BN, expiry: BN, optionTypeIndex: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      Buffer.from(assetName),
      strike.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([optionTypeIndex]),
    ],
    PROGRAM_ID,
  );
}

function deriveSharedVaultPda(
  marketPda: PublicKey, strike: BN, expiry: BN, optionTypeIndex: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("shared_vault"),
      marketPda.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([optionTypeIndex]),
    ],
    PROGRAM_ID,
  );
}

function deriveVaultUsdcPda(vaultPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_usdc"), vaultPda.toBuffer()],
    PROGRAM_ID,
  );
}

function deriveWriterPositionPda(vaultPda: PublicKey, writer: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("writer_position"), vaultPda.toBuffer(), writer.toBuffer()],
    PROGRAM_ID,
  );
}

function deriveVaultOptionMintPda(
  vaultPda: PublicKey, writer: PublicKey, createdAt: BN,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_option_mint"),
      vaultPda.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
}

function deriveVaultPurchaseEscrowPda(
  vaultPda: PublicKey, writer: PublicKey, createdAt: BN,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_purchase_escrow"),
      vaultPda.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
}

function deriveVaultMintRecordPda(optionMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mint_record"), optionMint.toBuffer()],
    PROGRAM_ID,
  );
}

function deriveExtraAccountMetaListPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
}

function deriveHookStatePda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), mint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
}

// =============================================================================
// Helpers
// =============================================================================

/** Next Friday 08:00 UTC that is at least 1 day (min_epoch_duration_days) from now */
function nextFridayExpiry(): BN {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 5=Fri
  let daysUntilFriday = (5 - dayOfWeek + 7) % 7;
  if (daysUntilFriday === 0) {
    const fridayAt8 = new Date(now);
    fridayAt8.setUTCHours(8, 0, 0, 0);
    if (now >= fridayAt8) daysUntilFriday = 7;
  }
  // Ensure at least 1 full day from now (min_epoch_duration_days = 1)
  // Add 30s buffer for devnet clock skew
  if (daysUntilFriday === 0 || daysUntilFriday * 86400 < 86400 + 30) {
    daysUntilFriday += 7; // Skip to the following Friday
  }
  const friday = new Date(now);
  friday.setUTCDate(friday.getUTCDate() + daysUntilFriday);
  friday.setUTCHours(8, 0, 0, 0);
  return new BN(Math.floor(friday.getTime() / 1000));
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  console.log("=== Butter Options — Demo Vault Seeder ===\n");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.butterOptions as Program<ButterOptions>;
  const admin = provider.wallet as anchor.Wallet;
  const payer = (admin as any).payer as Keypair;

  console.log("Admin:", admin.publicKey.toBase58());

  const [protocolStatePda] = deriveProtocolStatePda();
  const [epochConfigPda] = deriveEpochConfigPda();

  // Fetch protocol state for USDC mint
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint;
  console.log("USDC mint:", usdcMint.toBase58());

  // Verify EpochConfig exists
  try {
    await program.account.epochConfig.fetch(epochConfigPda);
    console.log("✓ EpochConfig found");
  } catch {
    console.error("ERROR: EpochConfig not initialized. Run initialize-epoch-config.ts first.");
    process.exit(1);
  }

  // Load or create writer keypair
  const writerPath = path.join(__dirname, ".devnet-writer-keypair.json");
  let writer: Keypair;
  if (fs.existsSync(writerPath)) {
    writer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(writerPath, "utf-8"))),
    );
    console.log("Writer:", writer.publicKey.toBase58());
  } else {
    console.error("ERROR: Writer keypair not found. Run seed-devnet.ts first.");
    process.exit(1);
  }

  // Ensure writer has USDC ATA and sufficient balance
  const writerAta = getAssociatedTokenAddressSync(usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);
  try {
    const info = await provider.connection.getTokenAccountBalance(writerAta);
    const balance = Number(info.value.amount);
    console.log("Writer USDC balance:", (balance / 1_000_000).toFixed(2));
    if (balance < 500_000_000_000) {
      console.log("  Minting more USDC to writer...");
      await mintTo(provider.connection, payer, usdcMint, writerAta, payer.publicKey, 1_000_000_000_000);
    }
  } catch {
    console.error("ERROR: Writer USDC ATA not found. Run seed-devnet.ts first.");
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Define vaults — prices based on current spot:
  //   SOL ~$86, BTC ~$74K, ETH ~$2,300
  // Strikes chosen to give a mix of ITM, ATM, and OTM options.
  // ---------------------------------------------------------------------------
  const fridayExpiry = nextFridayExpiry();
  const now = Math.floor(Date.now() / 1000);
  const fridayDate = new Date(fridayExpiry.toNumber() * 1000).toISOString();
  console.log(`\nNext Friday expiry: ${fridayDate}`);

  interface VaultDef {
    asset: string;
    strike: BN;
    optionType: any;
    typeIndex: number;
    expiry: BN;
    vaultType: any;
    deposit: BN;
    label: string;
    assetClass: number;
  }

  const vaults: VaultDef[] = [
    // --- Epoch vaults (Friday expiry) ---
    // SOL ATM call: strike $90 (~4.5% OTM), deposit $1800 → 10 contracts at 2x strike
    { asset: "SOL", strike: usdc(90), optionType: { call: {} }, typeIndex: 0, expiry: fridayExpiry, vaultType: { epoch: {} }, deposit: usdc(1800), label: "SOL $90 Call (Epoch)", assetClass: 0 },
    // SOL OTM call: strike $100 (~16% OTM), deposit $2000 → 10 contracts
    { asset: "SOL", strike: usdc(100), optionType: { call: {} }, typeIndex: 0, expiry: fridayExpiry, vaultType: { epoch: {} }, deposit: usdc(2000), label: "SOL $100 Call (Epoch)", assetClass: 0 },
    // SOL ITM put: strike $80 (~7% OTM for puts), deposit $800 → 10 contracts
    { asset: "SOL", strike: usdc(80), optionType: { put: {} },  typeIndex: 1, expiry: fridayExpiry, vaultType: { epoch: {} }, deposit: usdc(800), label: "SOL $80 Put (Epoch)", assetClass: 0 },
    // BTC ATM call: strike $75K (~1.5% OTM), deposit $150K → 1 contract at 2x strike
    { asset: "BTC", strike: usdc(75_000), optionType: { call: {} }, typeIndex: 0, expiry: fridayExpiry, vaultType: { epoch: {} }, deposit: usdc(150_000), label: "BTC $75K Call (Epoch)", assetClass: 0 },
    // ETH ATM call: strike $2400 (~4% OTM), deposit $4800 → 1 contract
    { asset: "ETH", strike: usdc(2_400), optionType: { call: {} }, typeIndex: 0, expiry: fridayExpiry, vaultType: { epoch: {} }, deposit: usdc(4800), label: "ETH $2.4K Call (Epoch)", assetClass: 0 },

    // --- Custom vaults (short expiry for demo lifecycle) ---
    // SOL near-ATM call: strike $90, expires in 10 minutes
    { asset: "SOL", strike: usdc(90), optionType: { call: {} }, typeIndex: 0, expiry: new BN(now + 600), vaultType: { custom: {} }, deposit: usdc(1800), label: "SOL $90 Call (Custom 10m)", assetClass: 0 },
    // SOL OTM put: strike $70, expires in 15 minutes
    { asset: "SOL", strike: usdc(70), optionType: { put: {} },  typeIndex: 1, expiry: new BN(now + 900), vaultType: { custom: {} }, deposit: usdc(700), label: "SOL $70 Put (Custom 15m)", assetClass: 0 },
  ];

  let created = 0;
  let skipped = 0;
  let totalDeposited = 0;
  let totalMinted = 0;

  for (const v of vaults) {
    console.log(`\n--- ${v.label} ---`);

    // Step 1: Ensure market exists
    const [marketPda] = deriveMarketPda(v.asset, v.strike, v.expiry, v.typeIndex);
    try {
      await program.account.optionsMarket.fetch(marketPda);
      console.log("  Market exists:", marketPda.toBase58().slice(0, 16) + "...");
    } catch {
      const fakePythFeed = Keypair.generate().publicKey;
      try {
        await program.methods
          .createMarket(v.asset, v.strike, v.expiry, v.optionType, fakePythFeed, v.assetClass)
          .accountsStrict({
            creator: admin.publicKey,
            protocolState: protocolStatePda,
            market: marketPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        console.log("  ✓ Market created:", marketPda.toBase58().slice(0, 16) + "...");
        await sleep(500);
      } catch (err: any) {
        console.error("  ✗ Failed to create market:", err.message || err);
        skipped++;
        continue;
      }
    }

    // Step 2: Create shared vault
    const [vaultPda] = deriveSharedVaultPda(marketPda, v.strike, v.expiry, v.typeIndex);
    const [vaultUsdcPda] = deriveVaultUsdcPda(vaultPda);

    try {
      await program.account.sharedVault.fetch(vaultPda);
      console.log("  Vault already exists, skipping...");
      skipped++;
      continue;
    } catch {
      // Does not exist — create it
    }

    try {
      const epochConfigAccount = "epoch" in v.vaultType ? epochConfigPda : null;
      await program.methods
        .createSharedVault(v.strike, v.expiry, v.optionType, v.vaultType)
        .accountsStrict({
          creator: writer.publicKey,
          market: marketPda,
          sharedVault: vaultPda,
          vaultUsdcAccount: vaultUsdcPda,
          usdcMint: usdcMint,
          protocolState: protocolStatePda,
          epochConfig: epochConfigAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writer])
        .rpc();
      console.log("  ✓ Vault created:", vaultPda.toBase58().slice(0, 16) + "...");
      await sleep(1000);
    } catch (err: any) {
      console.error("  ✗ Failed to create vault:", err.message || err);
      if (err.logs) console.error("    Logs:", err.logs.slice(-3).join("\n    "));
      skipped++;
      continue;
    }

    // Step 3: Deposit to vault
    const [writerPositionPda] = deriveWriterPositionPda(vaultPda, writer.publicKey);
    try {
      await program.methods
        .depositToVault(v.deposit)
        .accountsStrict({
          writer: writer.publicKey,
          sharedVault: vaultPda,
          writerPosition: writerPositionPda,
          writerUsdcAccount: writerAta,
          vaultUsdcAccount: vaultUsdcPda,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writer])
        .rpc();
      const depositUsd = v.deposit.toNumber() / 1_000_000;
      totalDeposited += depositUsd;
      console.log(`  ✓ Deposited $${depositUsd.toLocaleString()}`);
      await sleep(1000);
    } catch (err: any) {
      console.error("  ✗ Failed to deposit:", err.message || err);
      if (err.logs) console.error("    Logs:", err.logs.slice(-3).join("\n    "));
      continue;
    }

    // Step 4: Mint option tokens from vault
    const strikeNum = v.strike.toNumber() / 1_000_000;
    const depositNum = v.deposit.toNumber() / 1_000_000;
    const isCall = "call" in v.optionType;
    // Calls: 2x strike collateral per contract. Puts: 1x strike per contract.
    const contracts = isCall
      ? Math.floor(depositNum / (strikeNum * 2))
      : Math.floor(depositNum / strikeNum);
    if (contracts <= 0) {
      console.log("  (skipping mint — insufficient deposit for 1 contract)");
      created++;
      continue;
    }

    const premiumPerContract = usdc(strikeNum * 0.05); // 5% of strike
    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const [optionMintPda] = deriveVaultOptionMintPda(vaultPda, writer.publicKey, createdAt);
    const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(vaultPda, writer.publicKey, createdAt);
    const [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
    const [hookState] = deriveHookStatePda(optionMintPda);

    try {
      await program.methods
        .mintFromVault(new BN(contracts), premiumPerContract, createdAt)
        .accountsStrict({
          writer: writer.publicKey,
          sharedVault: vaultPda,
          writerPosition: writerPositionPda,
          market: marketPda,
          protocolState: protocolStatePda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          vaultMintRecord: vaultMintRecordPda,
          transferHookProgram: HOOK_PROGRAM_ID,
          extraAccountMetaList: extraAccountMetaList,
          hookState: hookState,
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();
      totalMinted += contracts;
      console.log(`  ✓ Minted ${contracts} contracts @ $${(premiumPerContract.toNumber() / 1_000_000).toFixed(2)} premium`);
      await sleep(1000);
    } catch (err: any) {
      console.error("  ✗ Failed to mint:", err.message || err);
      if (err.logs) console.error("    Logs:", err.logs.slice(-3).join("\n    "));
    }

    created++;
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n=== Summary ===");
  console.log(`  Created: ${created}/${vaults.length} vaults`);
  console.log(`  Skipped: ${skipped} (already exist or failed)`);
  console.log(`  Total deposited: $${totalDeposited.toLocaleString()} USDC`);
  console.log(`  Total minted: ${totalMinted} contracts`);
  console.log("\n=== Demo vault seeding complete! ===");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  if (err.logs) console.error("Logs:", err.logs.slice(-5).join("\n  "));
  process.exit(1);
});
