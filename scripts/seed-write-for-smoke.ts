// =============================================================================
// scripts/seed-write-for-smoke.ts — Seed a fresh writer-owned vaultMint
// =============================================================================
//
// Pre-Step-2 (of the secondary listing arc) setup. Creates a Custom SharedVault
// from the writer keypair (scripts/.devnet-writer-keypair.json — separate
// persistent wallet, NOT the operator) with 5 SOL CALL contracts at $50 strike,
// $1 premium each, expiring in 1 day. After this script:
//   - There exists a vaultMint with writer = the writer keypair
//   - The vaultMint has 5 unsold contracts available
//   - The parent vault is unsettled and not expiring within 10 min
// — exactly the criteria buy-for-smoke needs.
//
// Idempotent: re-running while a usable writer-owned vaultMint already exists
// is a no-op (early-exits at step 0).
//
// Run: npx ts-node scripts/seed-write-for-smoke.ts
// Required env: RPC_URL (Helius devnet)
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
  Transaction,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  mintTo,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

import { safeFetchAll } from "../app/src/hooks/useFetchAccounts";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

// SOL Pyth Pull mainnet feed_id, from scripts/pyth-feed-ids.csv (Crypto.SOL/USD).
const SOL_PYTH_FEED_ID_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const ASSET = "SOL";
const ASSET_CLASS = 0; // crypto
const STRIKE_USD = 50;
const PREMIUM_PER_CONTRACT_USD = 1;
const QUANTITY = new BN(5);
const COLLATERAL_PER_CONTRACT_USD = STRIKE_USD * 2; // call → 2× strike
const TOTAL_COLLATERAL_USD = COLLATERAL_PER_CONTRACT_USD * 5; // = $500 USDC

const WRITER_MIN_SOL = 0.1;
const WRITER_FUND_SOL = 0.5;
const WRITER_MIN_USDC_USD = 1_000;
const WRITER_FUND_USDC_USD = 1_000;

const usdc = (n: number) => new BN(Math.round(n * 1_000_000));

function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

async function readTokenAmount(
  conn: Connection,
  ata: PublicKey,
): Promise<bigint | null> {
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length < 72) return null;
  return Buffer.from(info.data.slice(64, 72)).readBigUInt64LE(0);
}

async function main() {
  const rpcUrl =
    process.env.RPC_URL ?? process.env.OPTA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });

  // Operator (admin = provider wallet)
  const operatorKeypairPath =
    process.env.OPTA_KEYPAIR ??
    path.join(process.env.HOME ?? "/home/nanko", ".config/solana/id.json");
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(operatorKeypairPath, "utf-8"))),
  );

  // Writer (separate persistent wallet, on disk per Apr 3 seed-devnet run)
  const writerKeypairPath = path.join(
    __dirname,
    ".devnet-writer-keypair.json",
  );
  if (!fs.existsSync(writerKeypairPath)) {
    console.error(`FATAL: writer keypair not found at ${writerKeypairPath}`);
    process.exit(1);
  }
  const writer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(writerKeypairPath, "utf-8"))),
  );

  const wallet = new anchor.Wallet(operator);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "target", "idl", "opta.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider) as Program<Opta>;

  console.log("=== seed-write-for-smoke ===");
  console.log("Operator (admin):", operator.publicKey.toBase58());
  console.log("Writer          :", writer.publicKey.toBase58());
  console.log("RPC:", rpcUrl.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>"));

  // ---- [0/7] Idempotency: skip if a usable writer-owned vaultMint exists ---
  console.log(
    "\n[0/7] Idempotency check: scanning for existing usable vaultMints...",
  );
  const existingMints = await safeFetchAll<any>(program, "vaultMint");
  const existingVaults = await safeFetchAll<any>(program, "sharedVault");
  const vaultByPda = new Map<string, any>();
  for (const v of existingVaults) vaultByPda.set(v.publicKey.toBase58(), v.account);

  const now = Math.floor(Date.now() / 1000);
  for (const m of existingMints) {
    const writerKey = (m.account.writer as PublicKey).toBase58();
    if (writerKey !== writer.publicKey.toBase58()) continue;
    const vaultPda = m.account.vault as PublicKey;
    const vaultAccount = vaultByPda.get(vaultPda.toBase58());
    if (!vaultAccount) continue;
    if (vaultAccount.isSettled) continue;
    const expiry =
      typeof vaultAccount.expiry === "number"
        ? vaultAccount.expiry
        : (vaultAccount.expiry as BN).toNumber();
    if (expiry <= now + 600) continue;
    const minted = m.account.quantityMinted as BN;
    const sold = m.account.quantitySold as BN;
    const available = minted.sub(sold);
    if (available.lt(new BN(2))) continue;

    console.log(`  ✓ Found existing usable vaultMint: ${m.publicKey.toBase58()}`);
    console.log(
      `    option_mint: ${(m.account.optionMint as PublicKey).toBase58()}`,
    );
    console.log(`    available  : ${available.toString()}`);
    console.log(`    expiry     : ${expiry} (${expiry - now}s from now)`);
    console.log(
      "\nNothing to do — buy-for-smoke can proceed against this vaultMint.",
    );
    process.exit(0);
  }
  console.log("  no usable existing vaultMint. Proceeding with fresh seed...");

  // ---- [1/7] Protocol state read --------------------------------------------
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    PROGRAM_ID,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint as PublicKey;
  console.log("\n[1/7] Protocol state:");
  console.log("  usdc_mint:", usdcMint.toBase58());
  console.log("  fee_bps  :", protocolState.feeBps);

  // ---- [2/7] Writer SOL balance + top-up if needed --------------------------
  console.log("\n[2/7] Writer SOL balance:");
  const writerSolBal = await conn.getBalance(writer.publicKey);
  console.log(`  ${(writerSolBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (writerSolBal < WRITER_MIN_SOL * LAMPORTS_PER_SOL) {
    console.log(
      `  funding writer with ${WRITER_FUND_SOL} SOL from operator...`,
    );
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: writer.publicKey,
        lamports: Math.round(WRITER_FUND_SOL * LAMPORTS_PER_SOL),
      }),
    );
    await provider.sendAndConfirm(fundTx);
    const newBal = await conn.getBalance(writer.publicKey);
    console.log(`  ✓ writer SOL: ${(newBal / LAMPORTS_PER_SOL).toFixed(4)}`);
  }

  // ---- [3/7] Writer USDC ATA + balance + top-up -----------------------------
  console.log("\n[3/7] Writer USDC balance:");
  const writerUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    writer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const usdcAtaExists = (await conn.getAccountInfo(writerUsdcAta)) !== null;
  if (!usdcAtaExists) {
    console.log("  creating writer USDC ATA...");
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey,
        writerUsdcAta,
        writer.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await provider.sendAndConfirm(ataTx);
  }
  const writerUsdcBal = await readTokenAmount(conn, writerUsdcAta);
  const writerUsdcUsd = writerUsdcBal ? Number(writerUsdcBal) / 1_000_000 : 0;
  console.log(`  ${writerUsdcUsd.toFixed(2)} USDC`);
  if (writerUsdcUsd < WRITER_MIN_USDC_USD) {
    console.log(
      `  minting ${WRITER_FUND_USDC_USD} USDC to writer (operator has mint authority)...`,
    );
    await mintTo(
      conn,
      operator,
      usdcMint,
      writerUsdcAta,
      operator.publicKey,
      WRITER_FUND_USDC_USD * 1_000_000,
    );
    const newBal = await readTokenAmount(conn, writerUsdcAta);
    console.log(`  ✓ writer USDC: ${(Number(newBal!) / 1_000_000).toFixed(2)}`);
  }

  // ---- [4/7] Find or create SOL market --------------------------------------
  console.log("\n[4/7] SOL market:");
  const allMarkets = await safeFetchAll<any>(program, "optionsMarket");
  const solMarket = allMarkets.find(
    (m) => (m.account.assetName as string) === ASSET,
  );
  let marketPda: PublicKey;
  if (solMarket) {
    marketPda = solMarket.publicKey;
    const onchainFeedHex = Buffer.from(
      solMarket.account.pythFeedId as number[],
    ).toString("hex");
    console.log(`  ✓ existing SOL market: ${marketPda.toBase58()}`);
    console.log(`    on-chain pyth_feed_id: ${onchainFeedHex}`);
    if (onchainFeedHex !== SOL_PYTH_FEED_ID_HEX) {
      console.warn(
        `    WARN: on-chain feed_id differs from expected mainnet ` +
          `(${SOL_PYTH_FEED_ID_HEX}). Settlement may fail; reusing anyway.`,
      );
    }
  } else {
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(ASSET)],
      PROGRAM_ID,
    );
    console.log(`  no SOL market found; creating at ${marketPda.toBase58()}`);
    const feedIdBytes = Array.from(hexToBytes(SOL_PYTH_FEED_ID_HEX));
    if (feedIdBytes.length !== 32) {
      console.error(
        `FATAL: expected 32-byte feed_id, got ${feedIdBytes.length}`,
      );
      process.exit(1);
    }
    await program.methods
      .createMarket(ASSET, feedIdBytes, ASSET_CLASS)
      .accountsStrict({
        creator: operator.publicKey,
        protocolState: protocolStatePda,
        market: marketPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  ✓ SOL market created");
  }

  // ---- [5/7] Create Custom SharedVault --------------------------------------
  const strike = usdc(STRIKE_USD);
  const expiry = new BN(now + 86400);
  const optionType = { call: {} } as any;
  const optionTypeIdx = 0;

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("shared_vault"),
      marketPda.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([optionTypeIdx]),
    ],
    PROGRAM_ID,
  );
  const [vaultUsdcPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_usdc"), vaultPda.toBuffer()],
    PROGRAM_ID,
  );
  const [writerPositionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("writer_position"),
      vaultPda.toBuffer(),
      writer.publicKey.toBuffer(),
    ],
    PROGRAM_ID,
  );

  console.log("\n[5/7] Creating Custom SharedVault:");
  console.log(`  asset      : ${ASSET}`);
  console.log(`  strike     : $${STRIKE_USD} (= ${strike.toString()})`);
  console.log(
    `  expiry     : ${expiry.toString()} (${expiry.toNumber() - now}s from now)`,
  );
  console.log(`  type       : Call (Custom)`);
  console.log(`  vault PDA  : ${vaultPda.toBase58()}`);
  console.log(`  vault_usdc : ${vaultUsdcPda.toBase58()}`);
  console.log(`  writer pos : ${writerPositionPda.toBase58()}`);

  const existingVault = await conn.getAccountInfo(vaultPda);
  if (existingVault) {
    console.log("  vault PDA already exists at this address — re-using.");
  } else {
    await program.methods
      .createSharedVault(
        strike,
        expiry,
        optionType,
        { custom: {} } as any,
        usdcMint,
      )
      .accountsStrict({
        creator: writer.publicKey,
        market: marketPda,
        sharedVault: vaultPda,
        vaultUsdcAccount: vaultUsdcPda,
        usdcMint,
        protocolState: protocolStatePda,
        epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([writer])
      .rpc();
    console.log("  ✓ vault created (writer signed as creator)");
  }

  // ---- [6/7] Deposit collateral ---------------------------------------------
  const deposit = usdc(TOTAL_COLLATERAL_USD);
  console.log("\n[6/7] Depositing collateral:");
  console.log(`  amount: $${TOTAL_COLLATERAL_USD} (= ${deposit.toString()})`);
  await program.methods
    .depositToVault(deposit)
    .accountsStrict({
      writer: writer.publicKey,
      sharedVault: vaultPda,
      writerPosition: writerPositionPda,
      writerUsdcAccount: writerUsdcAta,
      vaultUsdcAccount: vaultUsdcPda,
      protocolState: protocolStatePda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([writer])
    .rpc();
  console.log("  ✓ deposited");

  // ---- [7/7] Mint contracts -------------------------------------------------
  const premiumPerContract = usdc(PREMIUM_PER_CONTRACT_USD);
  const createdAt = new BN(Math.floor(Date.now() / 1000));
  const [optionMintPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_option_mint"),
      vaultPda.toBuffer(),
      writer.publicKey.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
  const [purchaseEscrowPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_purchase_escrow"),
      vaultPda.toBuffer(),
      writer.publicKey.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
  const [vaultMintRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mint_record"), optionMintPda.toBuffer()],
    PROGRAM_ID,
  );
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), optionMintPda.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  const [hookState] = PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), optionMintPda.toBuffer()],
    HOOK_PROGRAM_ID,
  );

  console.log("\n[7/7] Minting contracts:");
  console.log(`  quantity         : ${QUANTITY.toString()}`);
  console.log(
    `  premium/contract : $${PREMIUM_PER_CONTRACT_USD} (= ${premiumPerContract.toString()})`,
  );
  console.log(`  option_mint      : ${optionMintPda.toBase58()}`);
  console.log(`  purchase_escrow  : ${purchaseEscrowPda.toBase58()}`);
  console.log(`  vaultMint PDA    : ${vaultMintRecordPda.toBase58()}`);
  console.log(`  extra_meta_list  : ${extraAccountMetaList.toBase58()}`);
  console.log(`  hook_state       : ${hookState.toBase58()}`);

  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
  await program.methods
    .mintFromVault(QUANTITY, premiumPerContract, createdAt)
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
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([cuIx])
    .signers([writer])
    .rpc();
  console.log("  ✓ minted.");

  console.log(`\n=== seed-write-for-smoke complete ===`);
  console.log(`vaultMint PDA   : ${vaultMintRecordPda.toBase58()}`);
  console.log(`option_mint     : ${optionMintPda.toBase58()}`);
  console.log(`writer          : ${writer.publicKey.toBase58()}`);
  console.log(`available qty   : ${QUANTITY.toString()}`);
  console.log(
    `buy-for-smoke can now find this vaultMint and purchase from it.`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
