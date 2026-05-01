// =============================================================================
// scripts/smoke-full-loop.ts — Full V2 secondary listing arc smoke (orchestrator)
// =============================================================================
//
// One-shot script that sets up the demo state for the crank to consume:
//   Step 1: Writer creates a fresh 10-min-expiry SOL CALL Custom vault
//   Step 2: Writer deposits $500 collateral and mints 5 contracts at $1 premium
//   Step 3: Operator buys 2 contracts (primary-market path)
//   Step 4: Operator lists 1 contract at $1 (secondary-market path)
//
// After this script: vault has 10 minutes left, listing is live, escrow
// holds 1 token, operator ATA holds 1 token. The crank — started separately
// per the printed instructions — settles + auto-cancels + auto-finalizes
// the vault on its first post-expiry tick.
//
// State dump: scripts/.last-smoke-loop-state.json (gitignored). Consumed
// by scripts/smoke-full-loop-verify.ts after the crank completes.
//
// Run: npx ts-node scripts/smoke-full-loop.ts
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
const ASSET_CLASS = 0;
const STRIKE_USD = 50;
const PREMIUM_PER_CONTRACT_USD = 1;
const MINT_QUANTITY = new BN(5);
const COLLATERAL_PER_CONTRACT_USD = STRIKE_USD * 2; // CALL → 2× strike
const TOTAL_COLLATERAL_USD = COLLATERAL_PER_CONTRACT_USD * 5; // = $500

const OPERATOR_BUY_QTY = new BN(2);
const OPERATOR_LIST_QTY = new BN(1);
const OPERATOR_LIST_PRICE = new BN(1_000_000); // $1 per contract

const EXPIRY_OFFSET_S = 600; // 10 minutes

const WRITER_MIN_SOL = 0.1;
const WRITER_FUND_SOL = 0.5;
const WRITER_MIN_USDC_USD = 1_000;
const WRITER_FUND_USDC_USD = 1_000;

const STATE_JSON_PATH = path.join(__dirname, ".last-smoke-loop-state.json");

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

  // ---- 1. Connect ----------------------------------------------------------
  const operatorKeypairPath =
    process.env.OPTA_KEYPAIR ??
    path.join(process.env.HOME ?? "/home/nanko", ".config/solana/id.json");
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(operatorKeypairPath, "utf-8"))),
  );

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

  console.log("=== smoke-full-loop ===");
  console.log("Operator:", operator.publicKey.toBase58());
  console.log("Writer  :", writer.publicKey.toBase58());
  console.log("RPC:", rpcUrl.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>"));

  // ---- 2. Pre-flight -------------------------------------------------------
  console.log("\n[Pre-flight]");
  const allListings = await safeFetchAll<any>(program, "vaultResaleListing");
  if (allListings.length > 0) {
    console.error(
      `FATAL: ${allListings.length} existing listing(s) on chain — ambiguous initial state.`,
    );
    console.error(
      "Cancel them first (cancel_v2_resale or wait for crank's auto_cancel_listings) and re-run.",
    );
    for (const l of allListings) {
      console.error(`  - ${l.publicKey.toBase58()} (seller=${(l.account.seller as PublicKey).toBase58()})`);
    }
    process.exit(1);
  }
  const allVaults = await safeFetchAll<any>(program, "sharedVault");
  const unsettledCount = allVaults.filter((v) => !v.account.isSettled).length;
  console.log(
    `  ${allListings.length} listings (clean), ${allVaults.length} vaults total (${unsettledCount} unsettled)`,
  );

  // ---- 3. Protocol state ---------------------------------------------------
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    PROGRAM_ID,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint as PublicKey;
  const treasury = protocolState.treasury as PublicKey;
  const feeBps = protocolState.feeBps as number;
  console.log(`  usdc_mint: ${usdcMint.toBase58()}`);
  console.log(`  treasury : ${treasury.toBase58()}`);
  console.log(`  fee_bps  : ${feeBps}`);

  // ---- 4. Top up writer SOL/USDC if needed --------------------------------
  console.log("\n[Writer balances + top-ups]");
  const writerSolBal = await conn.getBalance(writer.publicKey);
  console.log(`  SOL : ${(writerSolBal / LAMPORTS_PER_SOL).toFixed(4)}`);
  if (writerSolBal < WRITER_MIN_SOL * LAMPORTS_PER_SOL) {
    console.log(`  funding writer ${WRITER_FUND_SOL} SOL...`);
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: writer.publicKey,
        lamports: Math.round(WRITER_FUND_SOL * LAMPORTS_PER_SOL),
      }),
    );
    await provider.sendAndConfirm(fundTx);
  }

  const writerUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    writer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  if (!(await conn.getAccountInfo(writerUsdcAta))) {
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
  const writerUsdcBal = (await readTokenAmount(conn, writerUsdcAta)) ?? BigInt(0);
  console.log(`  USDC: ${(Number(writerUsdcBal) / 1e6).toFixed(2)}`);
  if (Number(writerUsdcBal) / 1e6 < WRITER_MIN_USDC_USD) {
    console.log(`  minting ${WRITER_FUND_USDC_USD} USDC to writer...`);
    await mintTo(
      conn,
      operator,
      usdcMint,
      writerUsdcAta,
      operator.publicKey,
      WRITER_FUND_USDC_USD * 1_000_000,
    );
  }

  // ---- 5. Find or create SOL market ---------------------------------------
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(ASSET)],
    PROGRAM_ID,
  );
  const marketInfo = await conn.getAccountInfo(marketPda);
  if (!marketInfo) {
    console.log(`\n[Step 0] SOL market missing — creating at ${marketPda.toBase58()}`);
    const feedIdBytes = Array.from(hexToBytes(SOL_PYTH_FEED_ID_HEX));
    await program.methods
      .createMarket(ASSET, feedIdBytes, ASSET_CLASS)
      .accountsStrict({
        creator: operator.publicKey,
        protocolState: protocolStatePda,
        market: marketPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  } else {
    console.log(`\n[Step 0] SOL market exists at ${marketPda.toBase58()}`);
  }

  // ---- 6. Step 1: Create Custom SharedVault, expiry = now + 600 -----------
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + EXPIRY_OFFSET_S;
  const strike = usdc(STRIKE_USD);
  const optionType = { call: {} } as any;
  const optionTypeIdx = 0;

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("shared_vault"),
      marketPda.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8),
      new BN(expiry).toArrayLike(Buffer, "le", 8),
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

  console.log(`\n[Step 1] Create Custom SharedVault`);
  console.log(`  asset      : ${ASSET}`);
  console.log(`  strike     : $${STRIKE_USD}`);
  console.log(`  expiry     : ${expiry} (${EXPIRY_OFFSET_S}s from now)`);
  console.log(`  vault PDA  : ${vaultPda.toBase58()}`);
  await program.methods
    .createSharedVault(strike, new BN(expiry), optionType, { custom: {} } as any, usdcMint)
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
  console.log(`  ✓ vault created`);

  // ---- 7. Step 2: Deposit + mint -----------------------------------------
  const deposit = usdc(TOTAL_COLLATERAL_USD);
  console.log(`\n[Step 2] Writer deposits $${TOTAL_COLLATERAL_USD} + mints ${MINT_QUANTITY} contracts`);
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
  console.log(`  ✓ deposited`);

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

  await program.methods
    .mintFromVault(MINT_QUANTITY, premiumPerContract, createdAt)
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
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .signers([writer])
    .rpc();
  console.log(`  ✓ minted ${MINT_QUANTITY} contracts`);
  console.log(`  option_mint   : ${optionMintPda.toBase58()}`);
  console.log(`  vaultMint PDA : ${vaultMintRecordPda.toBase58()}`);

  // ---- 8. Step 3: Operator buys 2 -----------------------------------------
  const operatorOptionAta = getAssociatedTokenAddressSync(
    optionMintPda,
    operator.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const operatorUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    operator.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const ataIxs: any[] = [];
  if (!(await conn.getAccountInfo(operatorOptionAta))) {
    ataIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey,
        operatorOptionAta,
        operator.publicKey,
        optionMintPda,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  if (!(await conn.getAccountInfo(operatorUsdcAta))) {
    ataIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey,
        operatorUsdcAta,
        operator.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  if (ataIxs.length > 0) {
    const ataTx = new Transaction().add(...ataIxs);
    await provider.sendAndConfirm(ataTx);
    console.log(`  pre-created ${ataIxs.length} operator ATA(s)`);
  }

  console.log(`\n[Step 3] Operator buys ${OPERATOR_BUY_QTY} contracts`);
  const buyTotalPrice = OPERATOR_BUY_QTY.mul(premiumPerContract);
  await program.methods
    .purchaseFromVault(OPERATOR_BUY_QTY, buyTotalPrice)
    .accountsStrict({
      buyer: operator.publicKey,
      sharedVault: vaultPda,
      writerPosition: writerPositionPda,
      vaultMintRecord: vaultMintRecordPda,
      protocolState: protocolStatePda,
      market: marketPda,
      optionMint: optionMintPda,
      purchaseEscrow: purchaseEscrowPda,
      buyerOptionAccount: operatorOptionAta,
      buyerUsdcAccount: operatorUsdcAta,
      vaultUsdcAccount: vaultUsdcPda,
      treasury,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .rpc();

  const postBuyOption = await readTokenAmount(conn, operatorOptionAta);
  console.log(`  ✓ bought. operator option balance: ${postBuyOption}`);
  if (postBuyOption !== BigInt(2)) {
    console.error(`FATAL: expected operator option = 2, got ${postBuyOption}`);
    process.exit(1);
  }

  // ---- 9. Step 4: Operator lists 1 ----------------------------------------
  const [listingPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_resale_listing"),
      optionMintPda.toBuffer(),
      operator.publicKey.toBuffer(),
    ],
    PROGRAM_ID,
  );
  const [resaleEscrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_resale_escrow"), listingPda.toBuffer()],
    PROGRAM_ID,
  );

  console.log(`\n[Step 4] Operator lists ${OPERATOR_LIST_QTY} contract at $${OPERATOR_LIST_PRICE.toNumber() / 1e6}`);
  await program.methods
    .listV2ForResale(OPERATOR_LIST_PRICE, OPERATOR_LIST_QTY)
    .accountsStrict({
      seller: operator.publicKey,
      sharedVault: vaultPda,
      market: marketPda,
      vaultMintRecord: vaultMintRecordPda,
      optionMint: optionMintPda,
      sellerOptionAccount: operatorOptionAta,
      listing: listingPda,
      resaleEscrow: resaleEscrowPda,
      protocolState: protocolStatePda,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .rpc();

  const postListOperatorOption = await readTokenAmount(conn, operatorOptionAta);
  const postListEscrow = await readTokenAmount(conn, resaleEscrowPda);
  console.log(`  ✓ listed. operator ATA: ${postListOperatorOption}, escrow: ${postListEscrow}`);

  // ---- 10. Capture pre-test snapshots + dump state JSON -------------------
  const preTestOperatorUsdc = (await readTokenAmount(conn, operatorUsdcAta)) ?? BigInt(0);
  const preTestWriterUsdc = (await readTokenAmount(conn, writerUsdcAta)) ?? BigInt(0);
  const preTestTreasuryUsdc = (await readTokenAmount(conn, treasury)) ?? BigInt(0);

  const state = {
    schema: "smoke-full-loop-v1",
    timestamp: now,
    rpcUrl,
    writer: writer.publicKey.toBase58(),
    operator: operator.publicKey.toBase58(),
    marketPda: marketPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    vaultUsdcPda: vaultUsdcPda.toBase58(),
    vaultMintRecordPda: vaultMintRecordPda.toBase58(),
    optionMintPda: optionMintPda.toBase58(),
    purchaseEscrowPda: purchaseEscrowPda.toBase58(),
    writerPositionPda: writerPositionPda.toBase58(),
    listingPda: listingPda.toBase58(),
    resaleEscrowPda: resaleEscrowPda.toBase58(),
    operatorOptionAta: operatorOptionAta.toBase58(),
    operatorUsdcAta: operatorUsdcAta.toBase58(),
    writerUsdcAta: writerUsdcAta.toBase58(),
    treasuryPda: treasury.toBase58(),
    usdcMint: usdcMint.toBase58(),
    feeBps,
    strike: strike.toString(),
    expiry,
    premiumPerContract: premiumPerContract.toString(),
    qtyMinted: MINT_QUANTITY.toNumber(),
    qtyOperatorBought: OPERATOR_BUY_QTY.toNumber(),
    qtyListed: OPERATOR_LIST_QTY.toNumber(),
    listPricePerContract: OPERATOR_LIST_PRICE.toString(),
    preTestOperatorUsdc: preTestOperatorUsdc.toString(),
    preTestWriterUsdc: preTestWriterUsdc.toString(),
    preTestTreasuryUsdc: preTestTreasuryUsdc.toString(),
  };
  fs.writeFileSync(STATE_JSON_PATH, JSON.stringify(state, null, 2));
  console.log(`\n  state dumped to ${STATE_JSON_PATH}`);

  // ---- 11. Print crank command --------------------------------------------
  const expiryDate = new Date(expiry * 1000).toISOString();
  const secsFromNow = expiry - Math.floor(Date.now() / 1000);
  const sep = "=".repeat(60);
  console.log("\n" + sep);
  console.log("SETUP COMPLETE. WAITING FOR EXPIRY + CRANK.");
  console.log(sep);
  console.log(`Vault expires at: ${expiryDate} (${secsFromNow}s from now)`);
  console.log(`Listing PDA: ${listingPda.toBase58()}`);
  console.log(`Operator option balance: 1 (in ATA), 1 (in listing escrow)`);
  console.log(`Writer mint inventory: 3 unsold contracts in purchase_escrow`);
  console.log(``);
  console.log(`START THE CRANK in a separate WSL shell:`);
  console.log(
    `wsl -- bash -lc "cd '/mnt/d/claude everything/butter_options/crank' && export OPTA_RPC_URL='${rpcUrl}' && export OPTA_CRANK_TICK_MS=30000 && npm start"`,
  );
  console.log(``);
  console.log(`THEN WATCH for these log lines (in this order, on the same vault):`);
  console.log(`  1. "settle posted" — Phase 1 (Pyth Pull settle_expiry)`);
  console.log(`  2. "settle vault batch" — Phase 1 settle_vault flips is_settled`);
  console.log(`  3. "auto-cancel pass" with listingsTotal: 1 — drains your listing`);
  console.log(`  4. "holder finalize" — burns operator's 2 tokens + pays out`);
  console.log(`  5. "writer finalize" — pays writer collateral + premium`);
  console.log(`  6. "vault marked fully finalized" — cache locks it`);
  console.log(``);
  console.log(`STOP THE CRANK after step 6 fires (Ctrl+C). Then run:`);
  console.log(
    `wsl -- bash -lc "cd '/mnt/d/claude everything/butter_options' && export RPC_URL='${rpcUrl}' && npx ts-node scripts/smoke-full-loop-verify.ts"`,
  );
  console.log(sep);

  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
