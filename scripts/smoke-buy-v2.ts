// =============================================================================
// scripts/smoke-buy-v2.ts — Devnet smoke test for buy_v2_resale
// =============================================================================
//
// Buyer = the writer keypair (8Xh9UpbjXft1...). Seller = operator wallet
// (5YRMuuoY..., creator of the live listing FcYrf34f...). Buys 1 contract
// at the listing's exact price (no slippage room — smoke is deterministic).
// On full fill (qty 1 of 1), listing + escrow auto-close.
//
// Asserts: listing closed, escrow closed, buyer +1 option, buyer -$1 USDC,
// seller +$0.995, treasury +$0.005.
//
// Run: npx ts-node scripts/smoke-buy-v2.ts
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
  TransactionMessage,
  VersionedTransaction,
  Transaction,
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

const BUY_QUANTITY = new BN(1);

// Defensive top-up thresholds (same shape as seed-write-for-smoke).
const BUYER_MIN_SOL = 0.05;
const BUYER_FUND_SOL = 0.2;
const BUYER_MIN_USDC_USD = 10;
const BUYER_FUND_USDC_USD = 100;

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

  // Operator (admin = provider wallet, also the seller of the live listing)
  const operatorKeypairPath =
    process.env.OPTA_KEYPAIR ??
    path.join(process.env.HOME ?? "/home/nanko", ".config/solana/id.json");
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(operatorKeypairPath, "utf-8"))),
  );

  // Writer keypair — used as the BUYER for this smoke (different wallet
  // from the listing's seller, which is the operator).
  const writerKeypairPath = path.join(__dirname, ".devnet-writer-keypair.json");
  if (!fs.existsSync(writerKeypairPath)) {
    console.error(`FATAL: writer keypair not found at ${writerKeypairPath}`);
    process.exit(1);
  }
  const buyer = Keypair.fromSecretKey(
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

  console.log("=== smoke-buy-v2 ===");
  console.log("Operator (seller of live listing):", operator.publicKey.toBase58());
  console.log("Buyer (writer keypair)           :", buyer.publicKey.toBase58());
  console.log("RPC:", rpcUrl.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>"));

  // ---- [1/5] Find a listing where seller != buyer --------------------------
  console.log("\n[1/5] Scanning VaultResaleListing for buyable listings...");
  const allListings = await safeFetchAll<any>(program, "vaultResaleListing");
  const buyableListings = allListings.filter(
    (d) => !(d.account.seller as PublicKey).equals(buyer.publicKey),
  );
  console.log(
    `  found ${buyableListings.length} buyable listing(s) (out of ${allListings.length} total)`,
  );

  if (buyableListings.length === 0) {
    console.log("  no listings to buy. Treating as a clean no-op state.");
    process.exit(0);
  }

  const target = buyableListings[0];
  const listingPda = target.publicKey;
  const seller = target.account.seller as PublicKey;
  const optionMint = target.account.optionMint as PublicKey;
  const vaultPda = target.account.vault as PublicKey;
  const pricePerContract = target.account.pricePerContract as BN;
  const listedQty = target.account.listedQuantity as BN;
  console.log(`  picked listing      : ${listingPda.toBase58()}`);
  console.log(`  seller              : ${seller.toBase58()}`);
  console.log(`  option_mint         : ${optionMint.toBase58()}`);
  console.log(`  price/contract      : ${pricePerContract.toString()}`);
  console.log(`  listed_qty          : ${listedQty.toString()}`);

  const totalPrice = pricePerContract.mul(BUY_QUANTITY);

  // ---- [2/5] Fetch protocol state for treasury + fee_bps + USDC mint -------
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    PROGRAM_ID,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint as PublicKey;
  const treasury = protocolState.treasury as PublicKey;
  const feeBps = protocolState.feeBps as number;
  const expectedFee = totalPrice.muln(feeBps).divn(10_000);
  const expectedSellerShare = totalPrice.sub(expectedFee);
  console.log(
    `\n[2/5] Protocol state: usdc_mint=${usdcMint.toBase58()} treasury=${treasury.toBase58()} fee_bps=${feeBps}`,
  );
  console.log(
    `  expected fee: ${expectedFee.toString()}, seller_share: ${expectedSellerShare.toString()}`,
  );

  // ---- [3/5] Top up buyer SOL + USDC + pre-create option ATA ---------------
  console.log("\n[3/5] Buyer balances + ATA pre-create:");
  const buyerSolBal = await conn.getBalance(buyer.publicKey);
  console.log(`  SOL: ${(buyerSolBal / LAMPORTS_PER_SOL).toFixed(4)}`);
  if (buyerSolBal < BUYER_MIN_SOL * LAMPORTS_PER_SOL) {
    console.log(`  funding buyer ${BUYER_FUND_SOL} SOL...`);
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: buyer.publicKey,
        lamports: Math.round(BUYER_FUND_SOL * LAMPORTS_PER_SOL),
      }),
    );
    await provider.sendAndConfirm(fundTx);
  }

  const buyerUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    buyer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  if (!(await conn.getAccountInfo(buyerUsdcAta))) {
    console.log("  creating buyer USDC ATA...");
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey,
        buyerUsdcAta,
        buyer.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await provider.sendAndConfirm(ataTx);
  }
  const buyerUsdcBal = (await readTokenAmount(conn, buyerUsdcAta)) ?? BigInt(0);
  console.log(`  USDC: ${(Number(buyerUsdcBal) / 1_000_000).toFixed(6)}`);
  if (Number(buyerUsdcBal) / 1_000_000 < BUYER_MIN_USDC_USD) {
    console.log(`  minting ${BUYER_FUND_USDC_USD} USDC to buyer...`);
    await mintTo(
      conn,
      operator,
      usdcMint,
      buyerUsdcAta,
      operator.publicKey,
      BUYER_FUND_USDC_USD * 1_000_000,
    );
  }

  const buyerOptionAta = getAssociatedTokenAddressSync(
    optionMint,
    buyer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  if (!(await conn.getAccountInfo(buyerOptionAta))) {
    console.log("  creating buyer option ATA (Token-2022)...");
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey,
        buyerOptionAta,
        buyer.publicKey,
        optionMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    await provider.sendAndConfirm(ataTx);
  }
  console.log(`  buyer option ATA: ${buyerOptionAta.toBase58()}`);

  // ---- [4/5] Derive remaining PDAs + capture pre-state ---------------------
  console.log("\n[4/5] Deriving PDAs + capturing pre-state...");
  const [resaleEscrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_resale_escrow"), listingPda.toBuffer()],
    PROGRAM_ID,
  );
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), optionMint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  const [hookState] = PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), optionMint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  const sellerUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    seller,
    false,
    TOKEN_PROGRAM_ID,
  );

  const vaultAccount = await program.account.sharedVault.fetch(vaultPda);
  const marketPda = vaultAccount.market as PublicKey;
  const [vaultMintRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mint_record"), optionMint.toBuffer()],
    PROGRAM_ID,
  );

  console.log("  resale_escrow   :", resaleEscrowPda.toBase58());
  console.log("  extra_meta_list :", extraAccountMetaList.toBase58());
  console.log("  hook_state      :", hookState.toBase58());
  console.log("  seller USDC ATA :", sellerUsdcAta.toBase58());
  console.log("  treasury (USDC) :", treasury.toBase58());
  console.log("  market PDA      :", marketPda.toBase58());
  console.log("  vaultMint PDA   :", vaultMintRecordPda.toBase58());

  const preBuyerOption = (await readTokenAmount(conn, buyerOptionAta)) ?? BigInt(0);
  const preBuyerUsdc = (await readTokenAmount(conn, buyerUsdcAta)) ?? BigInt(0);
  const preSellerUsdc = (await readTokenAmount(conn, sellerUsdcAta)) ?? BigInt(0);
  const preTreasuryUsdc = (await readTokenAmount(conn, treasury)) ?? BigInt(0);
  const preEscrowExists = (await conn.getAccountInfo(resaleEscrowPda)) !== null;
  const preEscrowBal = preEscrowExists
    ? await readTokenAmount(conn, resaleEscrowPda)
    : null;

  console.log("\n  Pre-state:");
  console.log(`    buyer option   : ${preBuyerOption.toString()}`);
  console.log(`    buyer USDC     : ${preBuyerUsdc.toString()}`);
  console.log(`    seller USDC    : ${preSellerUsdc.toString()}`);
  console.log(`    treasury USDC  : ${preTreasuryUsdc.toString()}`);
  console.log(`    escrow exists  : ${preEscrowExists}`);
  console.log(`    escrow balance : ${preEscrowBal?.toString() ?? "(n/a)"}`);

  // ---- [5/5] Send buy_v2_resale --------------------------------------------
  console.log(
    `\n[5/5] Sending buy_v2_resale (qty=${BUY_QUANTITY.toString()}, max_total_price=${totalPrice.toString()})...`,
  );
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
  const buyIx = await program.methods
    .buyV2Resale(BUY_QUANTITY, totalPrice)
    .accountsStrict({
      buyer: buyer.publicKey,
      sharedVault: vaultPda,
      market: marketPda,
      vaultMintRecord: vaultMintRecordPda,
      listing: listingPda,
      seller,
      optionMint,
      resaleEscrow: resaleEscrowPda,
      buyerOptionAccount: buyerOptionAta,
      buyerUsdcAccount: buyerUsdcAta,
      sellerUsdcAccount: sellerUsdcAta,
      treasury,
      protocolState: protocolStatePda,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: operator.publicKey, // operator pays tx fee
    recentBlockhash: blockhash,
    instructions: [cuIx, buyIx],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([operator, buyer]); // both sign — buyer is program-required signer
  const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
  console.log("  tx:", sig);
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  console.log("  confirmed.");

  // ---- Post-state + assertions ---------------------------------------------
  console.log("\nPost-state:");
  const postBuyerOption = (await readTokenAmount(conn, buyerOptionAta)) ?? BigInt(0);
  const postBuyerUsdc = (await readTokenAmount(conn, buyerUsdcAta)) ?? BigInt(0);
  const postSellerUsdc = (await readTokenAmount(conn, sellerUsdcAta)) ?? BigInt(0);
  const postTreasuryUsdc = (await readTokenAmount(conn, treasury)) ?? BigInt(0);
  const postListing = await conn.getAccountInfo(listingPda);
  const postEscrow = await conn.getAccountInfo(resaleEscrowPda);

  console.log(`  buyer option    : ${postBuyerOption.toString()}`);
  console.log(`  buyer USDC      : ${postBuyerUsdc.toString()}`);
  console.log(`  seller USDC     : ${postSellerUsdc.toString()}`);
  console.log(`  treasury USDC   : ${postTreasuryUsdc.toString()}`);
  console.log(`  listing exists? : ${postListing !== null}`);
  console.log(`  escrow exists?  : ${postEscrow !== null}`);

  console.log("\n=== Assertions ===");
  const buyerOptionDelta = postBuyerOption - preBuyerOption;
  const buyerUsdcDelta = preBuyerUsdc - postBuyerUsdc;
  const sellerUsdcDelta = postSellerUsdc - preSellerUsdc;
  const treasuryUsdcDelta = postTreasuryUsdc - preTreasuryUsdc;
  const expectedFeeBig = BigInt(expectedFee.toString());
  const expectedSellerShareBig = BigInt(expectedSellerShare.toString());
  const expectedTotalBig = BigInt(totalPrice.toString());

  const checks: Array<{ name: string; pass: boolean; detail?: string }> = [
    { name: "listing closed   ", pass: postListing === null },
    { name: "escrow closed    ", pass: postEscrow === null },
    {
      name: "buyer option +1  ",
      pass: buyerOptionDelta === BigInt(1),
      detail: `delta=${buyerOptionDelta}`,
    },
    {
      name: `buyer USDC -${expectedTotalBig}`.padEnd(17, " "),
      pass: buyerUsdcDelta === expectedTotalBig,
      detail: `delta=${buyerUsdcDelta}`,
    },
    {
      name: `seller USDC +${expectedSellerShareBig}`.padEnd(17, " "),
      pass: sellerUsdcDelta === expectedSellerShareBig,
      detail: `delta=${sellerUsdcDelta}`,
    },
    {
      name: `treasury USDC +${expectedFeeBig}`.padEnd(17, " "),
      pass: treasuryUsdcDelta === expectedFeeBig,
      detail: `delta=${treasuryUsdcDelta}`,
    },
  ];
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? "PASS" : "FAIL";
    console.log(`  ${c.name}: ${tag}${c.detail ? ` (${c.detail})` : ""}`);
    if (!c.pass) allPass = false;
  }

  if (!allPass) {
    console.log("\nFAIL: one or more assertions did not pass.");
    process.exit(1);
  }
  console.log("\n=== smoke-buy-v2 complete (all assertions passed) ===");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
