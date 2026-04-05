// Test script: full lifecycle — create short-expiry market, write, buy, settle, exercise + cancel
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
import {
  Connection, PublicKey, Keypair, SystemProgram, Transaction,
  ComputeBudgetProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress, mintTo,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "butter_options.json"), "utf-8"));
  const rawKey = JSON.parse(fs.readFileSync(path.join(process.env.HOME || "~", ".config/solana/id.json"), "utf-8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(rawKey));
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl, provider) as Program<ButterOptions>;

  const writerPath = path.join(__dirname, ".devnet-writer-keypair.json");
  const writerRaw = JSON.parse(fs.readFileSync(writerPath, "utf-8"));
  const writer = Keypair.fromSecretKey(Uint8Array.from(writerRaw));

  const buyerPubkey = admin.publicKey;

  const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], PROGRAM_ID);
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint;

  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Writer:", writer.publicKey.toBase58());
  console.log("Buyer:", buyerPubkey.toBase58());
  console.log("USDC Mint:", usdcMint.toBase58());

  // =========================================================================
  // PART 1: Create a short-expiry market (5 min from now)
  // =========================================================================
  const now = Math.floor(Date.now() / 1000);
  const expiryTs = new BN(now + 5 * 60); // 5 minutes
  const strikePrice = new BN(180_000_000); // $180
  const fakePythFeed = Keypair.generate().publicKey;

  const [marketPda] = PublicKey.findProgramAddressSync([
    Buffer.from("market"), Buffer.from("SOL"),
    strikePrice.toArrayLike(Buffer, "le", 8), expiryTs.toArrayLike(Buffer, "le", 8),
    Buffer.from([0]),
  ], PROGRAM_ID);

  console.log("\n=== Creating short-expiry SOL $180 Call (expires in 5 min) ===");
  try {
    const tx = await program.methods
      .createMarket("SOL", strikePrice, expiryTs, { call: {} } as any, fakePythFeed, 0)
      .accountsStrict({ creator: admin.publicKey, protocolState: protocolStatePda, market: marketPda, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    console.log("Market created:", marketPda.toBase58(), "tx:", tx);
  } catch (e: any) {
    console.log("Market creation error (may already exist):", e.message?.slice(0, 80));
  }

  // =========================================================================
  // PART 2: Write an option (writer locks collateral)
  // =========================================================================
  const createdAt = new BN(Math.floor(Date.now() / 1000));
  const [positionPda] = PublicKey.findProgramAddressSync([Buffer.from("position"), marketPda.toBuffer(), writer.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)], PROGRAM_ID);
  const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), marketPda.toBuffer(), writer.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)], PROGRAM_ID);
  const [optionMintPda] = PublicKey.findProgramAddressSync([Buffer.from("option_mint"), positionPda.toBuffer()], PROGRAM_ID);
  const [purchaseEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("purchase_escrow"), positionPda.toBuffer()], PROGRAM_ID);
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), optionMintPda.toBuffer()], HOOK_PROGRAM_ID);
  const [hookState] = PublicKey.findProgramAddressSync([Buffer.from("hook-state"), optionMintPda.toBuffer()], HOOK_PROGRAM_ID);
  const writerUsdcAccount = getAssociatedTokenAddressSync(usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);

  console.log("\n=== Writing option (1 contract, $360 collateral, $5 premium) ===");
  const collateral = new BN(360_000_000); // $360
  const premium = new BN(5_000_000); // $5
  const contractSize = new BN(1);

  const writeTx = await program.methods
    .writeOption(collateral, premium, contractSize, createdAt)
    .accountsStrict({
      writer: writer.publicKey, protocolState: protocolStatePda, market: marketPda,
      position: positionPda, escrow: escrowPda, optionMint: optionMintPda,
      purchaseEscrow: purchaseEscrowPda, writerUsdcAccount, usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList, hookState,
      systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID, rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
    }).preInstructions([EXTRA_CU]).signers([writer]).rpc({ commitment: "confirmed" });
  console.log("Option written:", positionPda.toBase58(), "tx:", writeTx);

  // =========================================================================
  // PART 3: Purchase the option (buyer buys 1 contract)
  // =========================================================================
  console.log("\n=== Purchasing option (1 contract) ===");
  const buyerUsdcAccount = getAssociatedTokenAddressSync(usdcMint, buyerPubkey, false, TOKEN_PROGRAM_ID);
  const buyerOptionAccount = getAssociatedTokenAddressSync(optionMintPda, buyerPubkey, false, TOKEN_2022_PROGRAM_ID);
  const createBuyerAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    buyerPubkey, buyerOptionAccount, buyerPubkey, optionMintPda, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // We need buyer to sign, but we don't have their key. Use admin to buy instead.
  // Actually — let's use admin as buyer since we have their key.
  const adminUsdcAta = getAssociatedTokenAddressSync(usdcMint, admin.publicKey, false, TOKEN_PROGRAM_ID);
  const adminOptionAta = getAssociatedTokenAddressSync(optionMintPda, admin.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const createAdminAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    admin.publicKey, adminOptionAta, admin.publicKey, optionMintPda, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // Ensure admin has USDC
  const adminUsdcInfo = await conn.getAccountInfo(adminUsdcAta);
  if (!adminUsdcInfo) {
    console.log("Creating admin USDC ATA + minting...");
    const createAta = createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminUsdcAta, admin.publicKey, usdcMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    await provider.sendAndConfirm(new Transaction().add(createAta));
    await mintTo(conn, admin, usdcMint, adminUsdcAta, admin.publicKey, 100_000_000_000);
  }

  const purchaseTx = await program.methods.purchaseOption(new BN(1)).accountsStrict({
    buyer: admin.publicKey, protocolState: protocolStatePda, market: marketPda,
    position: positionPda, purchaseEscrow: purchaseEscrowPda,
    buyerUsdcAccount: adminUsdcAta, writerUsdcAccount, buyerOptionAccount: adminOptionAta,
    optionMint: optionMintPda, treasury: treasuryPda,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList, hookState,
    systemProgram: SystemProgram.programId, rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
  }).preInstructions([EXTRA_CU, createAdminAtaIx]).rpc({ commitment: "confirmed" });
  console.log("Purchased:", purchaseTx);

  // =========================================================================
  // PART 4: Wait for expiry then settle
  // =========================================================================
  const expiryTime = expiryTs.toNumber();
  const nowSec = Math.floor(Date.now() / 1000);
  const waitSec = expiryTime - nowSec + 5; // +5 for safety
  console.log(`\n=== Waiting ${waitSec}s for market to expire... ===`);
  await sleep(waitSec * 1000);

  console.log("\n=== Settling market at $195 (ITM for $180 Call) ===");
  const settlementPrice = new BN(195_000_000); // $195
  const settleTx = await program.methods
    .settleMarket(settlementPrice)
    .accountsStrict({ admin: admin.publicKey, protocolState: protocolStatePda, market: marketPda })
    .rpc({ commitment: "confirmed" });
  console.log("Settled:", settleTx);

  // =========================================================================
  // PART 5: Simulate exerciseOption
  // =========================================================================
  console.log("\n=== Simulating exerciseOption (admin exercises 1 token) ===");
  const exerciseIx = await program.methods.exerciseOption(new BN(1)).accountsStrict({
    exerciser: admin.publicKey, protocolState: protocolStatePda,
    market: marketPda, position: positionPda,
    escrow: escrowPda, optionMint: optionMintPda,
    exerciserOptionAccount: adminOptionAta, exerciserUsdcAccount: adminUsdcAta,
    writerUsdcAccount, writer: writer.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
  }).instruction();

  const { blockhash: bh1 } = await conn.getLatestBlockhash();
  const msg1 = new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: bh1, instructions: [EXTRA_CU, exerciseIx] }).compileToV0Message();
  const sim1 = await conn.simulateTransaction(new VersionedTransaction(msg1), { sigVerify: false });
  console.log("Error:", JSON.stringify(sim1.value.err));
  console.log("Units:", sim1.value.unitsConsumed);
  if (sim1.value.logs) sim1.value.logs.forEach((l) => console.log("  ", l));

  // Actually execute if simulation passes
  if (!sim1.value.err) {
    console.log("\n=== Executing exerciseOption ===");
    const exTx = await program.methods.exerciseOption(new BN(1)).accountsStrict({
      exerciser: admin.publicKey, protocolState: protocolStatePda,
      market: marketPda, position: positionPda,
      escrow: escrowPda, optionMint: optionMintPda,
      exerciserOptionAccount: adminOptionAta, exerciserUsdcAccount: adminUsdcAta,
      writerUsdcAccount, writer: writer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    }).preInstructions([EXTRA_CU]).rpc({ commitment: "confirmed" });
    console.log("Exercised:", exTx);
  }

  // =========================================================================
  // PART 6: Test cancelOption — write a new option, then cancel it
  // =========================================================================
  console.log("\n=== Testing cancelOption — writing a new option to cancel ===");
  // Create a new market with longer expiry for cancel test
  const cancelExpiry = new BN(now + 60 * 60); // 1 hour
  const cancelStrike = new BN(999_000_000); // $999 — unique
  const [cancelMarketPda] = PublicKey.findProgramAddressSync([
    Buffer.from("market"), Buffer.from("SOL"),
    cancelStrike.toArrayLike(Buffer, "le", 8), cancelExpiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([0]),
  ], PROGRAM_ID);

  try {
    await program.methods
      .createMarket("SOL", cancelStrike, cancelExpiry, { call: {} } as any, fakePythFeed, 0)
      .accountsStrict({ creator: admin.publicKey, protocolState: protocolStatePda, market: cancelMarketPda, systemProgram: SystemProgram.programId })
      .rpc({ commitment: "confirmed" });
    console.log("Cancel-test market created:", cancelMarketPda.toBase58());
  } catch { console.log("Market may already exist"); }

  const cancelCreatedAt = new BN(Math.floor(Date.now() / 1000));
  const [cancelPosPda] = PublicKey.findProgramAddressSync([Buffer.from("position"), cancelMarketPda.toBuffer(), writer.publicKey.toBuffer(), cancelCreatedAt.toArrayLike(Buffer, "le", 8)], PROGRAM_ID);
  const [cancelEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), cancelMarketPda.toBuffer(), writer.publicKey.toBuffer(), cancelCreatedAt.toArrayLike(Buffer, "le", 8)], PROGRAM_ID);
  const [cancelMintPda] = PublicKey.findProgramAddressSync([Buffer.from("option_mint"), cancelPosPda.toBuffer()], PROGRAM_ID);
  const [cancelPurchaseEscrow] = PublicKey.findProgramAddressSync([Buffer.from("purchase_escrow"), cancelPosPda.toBuffer()], PROGRAM_ID);
  const [cancelExtraMeta] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), cancelMintPda.toBuffer()], HOOK_PROGRAM_ID);
  const [cancelHookState] = PublicKey.findProgramAddressSync([Buffer.from("hook-state"), cancelMintPda.toBuffer()], HOOK_PROGRAM_ID);

  console.log("Writing option to cancel...");
  await program.methods
    .writeOption(new BN(1998_000_000), new BN(5_000_000), new BN(1), cancelCreatedAt)
    .accountsStrict({
      writer: writer.publicKey, protocolState: protocolStatePda, market: cancelMarketPda,
      position: cancelPosPda, escrow: cancelEscrowPda, optionMint: cancelMintPda,
      purchaseEscrow: cancelPurchaseEscrow, writerUsdcAccount, usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: cancelExtraMeta, hookState: cancelHookState,
      systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID, rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
    }).preInstructions([EXTRA_CU]).signers([writer]).rpc({ commitment: "confirmed" });
  console.log("Option written for cancel test:", cancelPosPda.toBase58());

  // Simulate cancel
  console.log("\n=== Simulating cancelOption ===");
  const cancelIx = await program.methods.cancelOption().accountsStrict({
    writer: writer.publicKey, protocolState: protocolStatePda, position: cancelPosPda,
    escrow: cancelEscrowPda, purchaseEscrow: cancelPurchaseEscrow,
    optionMint: cancelMintPda, writerUsdcAccount,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
  }).instruction();

  const { blockhash: bh2 } = await conn.getLatestBlockhash();
  const msg2 = new TransactionMessage({ payerKey: writer.publicKey, recentBlockhash: bh2, instructions: [EXTRA_CU, cancelIx] }).compileToV0Message();
  const sim2 = await conn.simulateTransaction(new VersionedTransaction(msg2), { sigVerify: false });
  console.log("Error:", JSON.stringify(sim2.value.err));
  console.log("Units:", sim2.value.unitsConsumed);
  if (sim2.value.logs) sim2.value.logs.forEach((l) => console.log("  ", l));

  // Actually execute if simulation passes
  if (!sim2.value.err) {
    console.log("\n=== Executing cancelOption ===");
    const cxTx = await program.methods.cancelOption().accountsStrict({
      writer: writer.publicKey, protocolState: protocolStatePda, position: cancelPosPda,
      escrow: cancelEscrowPda, purchaseEscrow: cancelPurchaseEscrow,
      optionMint: cancelMintPda, writerUsdcAccount,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    }).preInstructions([EXTRA_CU]).signers([writer]).rpc({ commitment: "confirmed" });
    console.log("Cancelled:", cxTx);
  }

  console.log("\n=== All tests complete! ===");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
