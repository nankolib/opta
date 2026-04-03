// =============================================================================
// scripts/seed-devnet.ts — Create sample markets + write options on devnet
// =============================================================================
// Usage: npx ts-node scripts/seed-devnet.ts
// Requires: solana config set --url devnet (already done)
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount as createTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getMint,
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
  return new BN(amount * 1_000_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// PDA derivation helpers
// =============================================================================
function deriveProtocolStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
}

function deriveTreasuryPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], PROGRAM_ID);
}

function deriveMarketPda(
  assetName: string,
  strike: BN,
  expiry: BN,
  optionTypeIndex: number,
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

function derivePositionPda(
  marketPda: PublicKey,
  writerPubkey: PublicKey,
  createdAt: BN,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      marketPda.toBuffer(),
      writerPubkey.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
}

function deriveEscrowPda(
  marketPda: PublicKey,
  writerPubkey: PublicKey,
  createdAt: BN,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      marketPda.toBuffer(),
      writerPubkey.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
}

function deriveOptionMintPda(positionPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("option_mint"), positionPda.toBuffer()],
    PROGRAM_ID,
  );
}

function derivePurchaseEscrowPda(positionPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("purchase_escrow"), positionPda.toBuffer()],
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
// Main
// =============================================================================
async function main() {
  console.log("=== Butter Options Devnet Seeder ===\n");

  // ---------------------------------------------------------------------------
  // 1. Setup provider & program
  // ---------------------------------------------------------------------------
  const connection = new Connection("https://api.devnet.solana.com", {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });

  // Load wallet from default Solana CLI keypair
  const keypairPath = path.join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".config/solana/id.json",
  );
  const rawKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(rawKey));
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  // Load program from IDL
  const idlPath = path.join(__dirname, "..", "target", "idl", "butter_options.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider) as Program<ButterOptions>;

  const admin = payer;
  console.log("Wallet:", admin.publicKey.toBase58());
  const balance = await connection.getBalance(admin.publicKey);
  console.log("Balance:", (balance / LAMPORTS_PER_SOL).toFixed(4), "SOL\n");

  const [protocolStatePda] = deriveProtocolStatePda();
  const [treasuryPda] = deriveTreasuryPda();

  // ---------------------------------------------------------------------------
  // 2. Create a devnet USDC-like mint (or reuse existing from protocol state)
  // ---------------------------------------------------------------------------
  let usdcMint: PublicKey;
  let protocolInitialized = false;

  try {
    const protocolState = await program.account.protocolState.fetch(protocolStatePda);
    usdcMint = protocolState.usdcMint;
    protocolInitialized = true;
    console.log("Protocol already initialized.");
    console.log("  USDC mint:", usdcMint.toBase58());
    console.log("  Admin:", protocolState.admin.toBase58());
    console.log("  Fee BPS:", protocolState.feeBps);
    console.log("  Total markets:", protocolState.totalMarkets.toString());
    console.log();
  } catch {
    console.log("Protocol not yet initialized. Creating USDC mint...");
    usdcMint = await createMint(connection, payer, admin.publicKey, admin.publicKey, 6);
    console.log("  Created USDC mint:", usdcMint.toBase58());

    // Initialize protocol
    console.log("  Initializing protocol...");
    const tx = await program.methods
      .initializeProtocol()
      .accountsStrict({
        admin: admin.publicKey,
        protocolState: protocolStatePda,
        treasury: treasuryPda,
        usdcMint: usdcMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("  Protocol initialized:", tx);
    console.log();
  }

  // ---------------------------------------------------------------------------
  // 3. Create writer keypair + fund with SOL and USDC
  // ---------------------------------------------------------------------------
  // Use a deterministic seed so we can find the writer again
  const writerPath = path.join(__dirname, ".devnet-writer-keypair.json");
  let writer: Keypair;
  if (fs.existsSync(writerPath)) {
    const rawWriter = JSON.parse(fs.readFileSync(writerPath, "utf-8"));
    writer = Keypair.fromSecretKey(Uint8Array.from(rawWriter));
    console.log("Loaded existing writer:", writer.publicKey.toBase58());
  } else {
    writer = Keypair.generate();
    fs.writeFileSync(writerPath, JSON.stringify(Array.from(writer.secretKey)));
    console.log("Created new writer:", writer.publicKey.toBase58());
  }

  // Fund writer with SOL if needed
  const writerBalance = await connection.getBalance(writer.publicKey);
  if (writerBalance < 0.5 * LAMPORTS_PER_SOL) {
    console.log("Funding writer with SOL...");
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: writer.publicKey,
        lamports: LAMPORTS_PER_SOL,
      }),
    );
    await provider.sendAndConfirm(fundTx);
    console.log("  Sent 1 SOL to writer");
  }

  // Create writer USDC account + mint USDC
  let writerUsdcAccount: PublicKey;
  const writerAta = getAssociatedTokenAddressSync(usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);
  const writerAtaInfo = await connection.getAccountInfo(writerAta);
  if (!writerAtaInfo) {
    console.log("Creating writer USDC account...");
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        writerAta,
        writer.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID,
      ),
    );
    await provider.sendAndConfirm(createAtaTx);
  }
  writerUsdcAccount = writerAta;

  // Mint USDC to writer (1,000,000 USDC — it's devnet, it's free!)
  const writerUsdcInfo = await getAccount(connection, writerUsdcAccount);
  if (writerUsdcInfo.amount < BigInt(500_000_000_000)) {
    console.log("Minting 1,000,000 USDC to writer...");
    await mintTo(connection, payer, usdcMint, writerUsdcAccount, admin.publicKey, 1_000_000_000_000);
  }
  console.log();

  // ---------------------------------------------------------------------------
  // 4. Create markets
  // ---------------------------------------------------------------------------
  const fakePythFeed = Keypair.generate().publicKey;
  const now = Math.floor(Date.now() / 1000);
  const expiry14d = new BN(now + 14 * 24 * 60 * 60);

  const markets = [
    { asset: "SOL", strike: usdc(180), expiry: expiry14d, optionType: { call: {} }, typeIndex: 0, assetClass: 0, label: "SOL $180 Call" },
    { asset: "SOL", strike: usdc(200), expiry: expiry14d, optionType: { call: {} }, typeIndex: 0, assetClass: 0, label: "SOL $200 Call" },
    { asset: "SOL", strike: usdc(150), expiry: expiry14d, optionType: { put: {} }, typeIndex: 1, assetClass: 0, label: "SOL $150 Put" },
    { asset: "BTC", strike: usdc(100_000), expiry: expiry14d, optionType: { call: {} }, typeIndex: 0, assetClass: 0, label: "BTC $100K Call" },
    { asset: "ETH", strike: usdc(3_500), expiry: expiry14d, optionType: { call: {} }, typeIndex: 0, assetClass: 0, label: "ETH $3500 Call" },
    { asset: "XAU", strike: usdc(3_000), expiry: expiry14d, optionType: { call: {} }, typeIndex: 0, assetClass: 1, label: "XAU $3000 Call" },
  ];

  const marketPdas: PublicKey[] = [];

  console.log("--- Creating Markets ---");
  for (const m of markets) {
    const [marketPda] = deriveMarketPda(m.asset, m.strike, m.expiry, m.typeIndex);
    marketPdas.push(marketPda);

    // Check if market already exists
    try {
      await program.account.optionsMarket.fetch(marketPda);
      console.log(`  [exists] ${m.label} — ${marketPda.toBase58()}`);
      continue;
    } catch {
      // Does not exist, create it
    }

    try {
      const tx = await program.methods
        .createMarket(m.asset, m.strike, m.expiry, m.optionType as any, fakePythFeed, m.assetClass)
        .accountsStrict({
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`  [created] ${m.label} — ${marketPda.toBase58()}`);
      await sleep(500); // Rate limit for devnet
    } catch (err: any) {
      console.error(`  [FAILED] ${m.label}: ${err.message || err}`);
    }
  }
  console.log();

  // ---------------------------------------------------------------------------
  // 5. Write options on first 4 markets
  // ---------------------------------------------------------------------------
  console.log("--- Writing Options ---");

  const optionConfigs = [
    { marketIdx: 0, collateral: usdc(360), premium: usdc(5), contracts: new BN(1), label: "SOL $180 Call" },
    { marketIdx: 1, collateral: usdc(400), premium: usdc(5), contracts: new BN(1), label: "SOL $200 Call" },
    { marketIdx: 2, collateral: usdc(300), premium: usdc(5), contracts: new BN(1), label: "SOL $150 Put" },
    { marketIdx: 3, collateral: usdc(200_000), premium: usdc(500), contracts: new BN(1), label: "BTC $100K Call" },
  ];

  for (const opt of optionConfigs) {
    const marketPda = marketPdas[opt.marketIdx];
    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const [positionPda] = derivePositionPda(marketPda, writer.publicKey, createdAt);
    const [escrowPda] = deriveEscrowPda(marketPda, writer.publicKey, createdAt);
    const [optionMintPda] = deriveOptionMintPda(positionPda);
    const [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);
    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
    const [hookState] = deriveHookStatePda(optionMintPda);

    try {
      const tx = await program.methods
        .writeOption(opt.collateral, opt.premium, opt.contracts, createdAt)
        .accountsStrict({
          writer: writer.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          position: positionPda,
          escrow: escrowPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
          usdcMint: usdcMint,
          transferHookProgram: HOOK_PROGRAM_ID,
          extraAccountMetaList: extraAccountMetaList,
          hookState: hookState,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      console.log(`  [written] ${opt.label}`);
      console.log(`    Position: ${positionPda.toBase58()}`);
      console.log(`    Option Mint: ${optionMintPda.toBase58()}`);
      console.log(`    Tx: ${tx}`);

      // Verify Token-2022 mint metadata
      await sleep(2000); // Wait for confirmation
      try {
        const mintInfo = await getMint(connection, optionMintPda, "confirmed", TOKEN_2022_PROGRAM_ID);
        console.log(`    Mint supply: ${mintInfo.supply.toString()}`);
      } catch (e: any) {
        console.log(`    (could not fetch mint info: ${e.message})`);
      }

      console.log();
      await sleep(1000); // Rate limit for devnet
    } catch (err: any) {
      console.error(`  [FAILED] ${opt.label}: ${err.message || err}`);
      if (err.logs) {
        console.error("  Logs:", err.logs.slice(-5).join("\n    "));
      }
      console.log();
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Verify: fetch all markets and positions
  // ---------------------------------------------------------------------------
  console.log("--- Verification ---");

  // Fetch markets we just created (by PDA) rather than .all() which may hit old layout accounts
  console.log("Markets created this session:");
  for (let i = 0; i < markets.length; i++) {
    try {
      const data = await program.account.optionsMarket.fetch(marketPdas[i]);
      const typeStr = (data.optionType as any).call ? "Call" : "Put";
      const strikeUsd = (data.strikePrice.toNumber() / 1_000_000).toFixed(0);
      const expiryDate = new Date(data.expiryTimestamp.toNumber() * 1000).toISOString().split("T")[0];
      console.log(
        `  ${data.assetName} $${strikeUsd} ${typeStr} — expires ${expiryDate} — settled: ${data.isSettled}`,
      );
    } catch {
      console.log(`  [could not fetch market ${i}]`);
    }
  }
  console.log();

  // Fetch positions - use try/catch for .all() in case old layout accounts exist
  try {
    const allPositions = await program.account.optionPosition.all();
    console.log(`Total positions on-chain: ${allPositions.length}`);
    for (const p of allPositions) {
      const data = p.account;
      console.log(
        `  Position: ${p.publicKey.toBase58().slice(0, 12)}... — supply: ${data.totalSupply.toString()}, sold: ${data.tokensSold.toString()}, collateral: ${(data.collateralAmount.toNumber() / 1_000_000).toFixed(2)} USDC`,
      );
    }
  } catch {
    console.log("  (could not fetch all positions — old layout accounts may exist)");
  }

  console.log("\n=== Devnet seeding complete! ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
