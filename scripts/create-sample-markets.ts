// =============================================================================
// scripts/create-sample-markets.ts — Create sample data for tokenized protocol
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
} from "@solana/spl-token";
import BN from "bn.js";

const PYTH_FEEDS: Record<string, PublicKey> = {
  SOL: new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"),
  BTC: new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"),
  ETH: new PublicKey("EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9GvYRk4HY7y44"),
  XAU: new PublicKey("8y3WWjvmSmVGWVKH1rCA7VTRmuU7QbJ9axMK6JUUuCyi"),
  WTI: new PublicKey("JTjCRSsBCz5FNjRiVRBFnBqGwU5QGqJ9hHsqpHoFaJT"),
  AAPL: new PublicKey("5yKHAuiDWKUGRgs3s6mYGdfZjFmTfgHVDBwFBDfMuZJH"),
};

function usdc(amount: number): BN {
  return new BN(Math.round(amount * 1_000_000));
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.butterOptions as Program<ButterOptions>;
  const admin = provider.wallet as anchor.Wallet;
  const payer = (admin as any).payer as Keypair;

  console.log("=== Butter Options — Sample Data Creator (Tokenized) ===");
  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`Admin:   ${admin.publicKey.toBase58()}`);
  console.log("");

  // Step 1: Ensure protocol is initialized
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")], program.programId
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury_v2")], program.programId
  );

  let usdcMint: PublicKey;
  try {
    const ps = await program.account.protocolState.fetch(protocolStatePda);
    usdcMint = ps.usdcMint;
    console.log("✓ Protocol already initialized");
    console.log(`  USDC Mint: ${usdcMint.toBase58()}`);
  } catch {
    console.log("Initializing protocol...");
    usdcMint = await createMint(provider.connection, payer, admin.publicKey, admin.publicKey, 6);
    await program.methods.initializeProtocol().accountsStrict({
      admin: admin.publicKey, protocolState: protocolStatePda, treasury: treasuryPda,
      usdcMint, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    }).rpc();
    console.log(`✓ Protocol initialized. USDC Mint: ${usdcMint.toBase58()}`);
  }

  // Step 2: Ensure admin has USDC
  let adminUsdcAta: PublicKey;
  try {
    adminUsdcAta = await getAssociatedTokenAddress(usdcMint, admin.publicKey);
    await provider.connection.getTokenAccountBalance(adminUsdcAta);
  } catch {
    adminUsdcAta = await createAssociatedTokenAccount(provider.connection, payer, usdcMint, admin.publicKey);
  }
  try {
    await mintTo(provider.connection, payer, usdcMint, adminUsdcAta, admin.publicKey, 1_000_000_000_000);
    console.log("✓ Minted 1M test USDC to admin");
  } catch {
    console.log("  (Mint skipped — not mint authority)");
  }

  const bal = await provider.connection.getTokenAccountBalance(adminUsdcAta);
  console.log(`  Admin USDC balance: ${bal.value.uiAmountString}`);
  console.log("");

  // Step 3: Create markets
  const expiry14d = new BN(Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60);

  const marketsToCreate = [
    { asset: "SOL", strike: usdc(180), type: { call: {} }, typeIdx: 0 },
    { asset: "SOL", strike: usdc(200), type: { call: {} }, typeIdx: 0 },
    { asset: "SOL", strike: usdc(150), type: { put: {} }, typeIdx: 1 },
    { asset: "BTC", strike: usdc(100_000), type: { call: {} }, typeIdx: 0 },
    { asset: "ETH", strike: usdc(3_500), type: { call: {} }, typeIdx: 0 },
    { asset: "XAU", strike: usdc(5_000), type: { call: {} }, typeIdx: 0 },
    { asset: "WTI", strike: usdc(80), type: { call: {} }, typeIdx: 0 },
    { asset: "AAPL", strike: usdc(200), type: { call: {} }, typeIdx: 0 },
  ];

  console.log("--- Creating Markets ---");
  const createdMarkets: { pda: PublicKey; asset: string; strike: BN; isCall: boolean }[] = [];

  for (const mkt of marketsToCreate) {
    const feed = PYTH_FEEDS[mkt.asset] || Keypair.generate().publicKey;
    const [marketPda] = PublicKey.findProgramAddressSync([
      Buffer.from("market"), Buffer.from(mkt.asset),
      mkt.strike.toArrayLike(Buffer, "le", 8),
      expiry14d.toArrayLike(Buffer, "le", 8),
      Buffer.from([mkt.typeIdx]),
    ], program.programId);

    try {
      await program.account.optionsMarket.fetch(marketPda);
      console.log(`  ⊘ ${mkt.asset} $${mkt.strike.toNumber() / 1e6} ${mkt.typeIdx === 0 ? "Call" : "Put"} — exists`);
      createdMarkets.push({ pda: marketPda, asset: mkt.asset, strike: mkt.strike, isCall: mkt.typeIdx === 0 });
      continue;
    } catch {}

    try {
      await program.methods.createMarket(mkt.asset, mkt.strike, expiry14d, mkt.type as any, feed)
        .accountsStrict({
          creator: admin.publicKey, protocolState: protocolStatePda,
          market: marketPda, systemProgram: SystemProgram.programId,
        }).rpc();
      console.log(`  ✓ ${mkt.asset} $${mkt.strike.toNumber() / 1e6} ${mkt.typeIdx === 0 ? "Call" : "Put"} — created`);
      createdMarkets.push({ pda: marketPda, asset: mkt.asset, strike: mkt.strike, isCall: mkt.typeIdx === 0 });
    } catch (e: any) {
      console.log(`  ✗ ${mkt.asset} FAILED: ${e.message?.slice(0, 80)}`);
    }
  }

  console.log("");

  // Step 4: Write tokenized options on 5 markets
  console.log("--- Writing Tokenized Options ---");

  const optionsToWrite = [
    // Collateral: strike × contracts for puts, strike × 2 × contracts for calls
    // Premium: per-contract price × contracts
    { idx: 0, collateral: 3_600, premium: 150, contracts: 10 },   // SOL $180 Call: 10 contracts, $15/contract
    { idx: 1, collateral: 4_000, premium: 120, contracts: 10 },   // SOL $200 Call: 10 contracts, $12/contract
    { idx: 2, collateral: 1_500, premium: 80, contracts: 10 },    // SOL $150 Put: 10 contracts, $8/contract
    { idx: 3, collateral: 200_000, premium: 500, contracts: 1 },  // BTC $100k Call: 1 contract, $500/contract
    { idx: 4, collateral: 70_000, premium: 175, contracts: 10 },  // ETH $3500 Call: 10 contracts, $17.50/contract
  ];

  for (const opt of optionsToWrite) {
    if (opt.idx >= createdMarkets.length) continue;
    const market = createdMarkets[opt.idx];
    const createdAt = new BN(Math.floor(Date.now() / 1000) + opt.idx);

    const [positionPda] = PublicKey.findProgramAddressSync([
      Buffer.from("position"), market.pda.toBuffer(), admin.publicKey.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ], program.programId);
    const [escrowPda] = PublicKey.findProgramAddressSync([
      Buffer.from("escrow"), market.pda.toBuffer(), admin.publicKey.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ], program.programId);
    const [optionMintPda] = PublicKey.findProgramAddressSync([
      Buffer.from("option_mint"), positionPda.toBuffer(),
    ], program.programId);

    // Check if position exists
    try {
      await program.account.optionPosition.fetch(positionPda);
      console.log(`  ⊘ ${market.asset} $${market.strike.toNumber() / 1e6} — position exists`);
      continue;
    } catch {}

    const [purchaseEscrowPda] = PublicKey.findProgramAddressSync([
      Buffer.from("purchase_escrow"), positionPda.toBuffer(),
    ], program.programId);

    try {
      await program.methods.writeOption(
        usdc(opt.collateral), usdc(opt.premium), new BN(opt.contracts), createdAt,
      ).accountsStrict({
        writer: admin.publicKey, protocolState: protocolStatePda,
        market: market.pda, position: positionPda, escrow: escrowPda,
        optionMint: optionMintPda, purchaseEscrow: purchaseEscrowPda,
        writerUsdcAccount: adminUsdcAta, usdcMint,
        systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      }).rpc();

      console.log(`  ✓ ${market.asset} $${market.strike.toNumber() / 1e6} ${market.isCall ? "Call" : "Put"} — written (premium $${opt.premium}, collateral $${opt.collateral})`);
    } catch (e: any) {
      console.log(`  ✗ ${market.asset} write FAILED: ${e.message?.slice(0, 100)}`);
    }
  }

  console.log("");
  console.log("Done! Refresh the frontend to see the data.");
}

describe("create-sample-markets", () => {
  it("creates markets and writes options on devnet", async () => {
    await main();
  });
});
