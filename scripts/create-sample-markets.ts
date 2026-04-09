// =============================================================================
// scripts/create-sample-markets.ts — Seed devnet with 9 assets × 7 strikes × 2 types × 2 expiries
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
import { Keypair, PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";

const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

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

const PYTH_FEEDS: Record<string, PublicKey> = {
  // Crypto
  SOL: new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"),
  BTC: new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"),
  ETH: new PublicKey("EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9GvYRk4HY7y44"),
  // Commodities
  XAU: new PublicKey("8y3WWjvmSmVGWVKH1rCA7VTRmuU7QbJ9axMK6JUUuCyi"),
  WTI: new PublicKey("JTjCRSsBCz5FNjRiVRBFnBqGwU5QGqJ9hHsqpHoFaJT"),
  XAG: new PublicKey("9ErnFgqkWMBgWkN9bMBRNbKfGJHBZ1dAzaRBviCrgDR8"),
  // Equities
  AAPL: new PublicKey("5yKHAuiDWKUGRgs3s6mYGdfZjFmTfgHVDBwFBDfMuZJH"),
  TSLA: new PublicKey("3Mnn2fX6rQyUsyELYms1sBJyChWofzSNRoqYzvgMVz5E"),
  NVDA: new PublicKey("8NHiU8hRFVUMfWBoNTo3GmJYk3YzGKxq7mdDPnMf8B93"),
};

function usdc(amount: number): BN {
  return new BN(Math.round(amount * 1_000_000));
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.butterOptions as Program<ButterOptions>;
  const admin = provider.wallet as anchor.Wallet;
  const payer = (admin as any).payer as Keypair;

  console.log("=== Butter Options — Full 9-Asset Options Chain Seeder ===");
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

  // Step 2: Ensure admin has USDC — mint 10M
  let adminUsdcAta: PublicKey;
  try {
    adminUsdcAta = await getAssociatedTokenAddress(usdcMint, admin.publicKey);
    await provider.connection.getTokenAccountBalance(adminUsdcAta);
  } catch {
    adminUsdcAta = await createAssociatedTokenAccount(provider.connection, payer, usdcMint, admin.publicKey);
  }
  try {
    await mintTo(provider.connection, payer, usdcMint, adminUsdcAta, admin.publicKey, 10_000_000_000_000); // 10M USDC
    console.log("✓ Minted 10M test USDC to admin");
  } catch {
    console.log("  (Mint skipped — not mint authority)");
  }

  const bal = await provider.connection.getTokenAccountBalance(adminUsdcAta);
  console.log(`  Admin USDC balance: ${bal.value.uiAmountString}`);
  console.log("");

  // Step 3: Build full options chain — exact midnight UTC expiries
  const now = new Date();
  const exp7d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7, 0, 0, 0));
  const expiry7d = new BN(Math.floor(exp7d.getTime() / 1000));
  const exp14d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 14, 0, 0, 0));
  const expiry14d = new BN(Math.floor(exp14d.getTime() / 1000));

  console.log(`Expiry 7d:  ${exp7d.toISOString()} (${expiry7d.toString()})`);
  console.log(`Expiry 14d: ${exp14d.toISOString()} (${expiry14d.toString()})`);
  console.log("");

  const assets = [
    // Crypto
    { name: "SOL",  category: "CRYPTO",      strikes: [50, 60, 70, 80, 90, 100, 120] },
    { name: "BTC",  category: "CRYPTO",      strikes: [50_000, 60_000, 65_000, 70_000, 75_000, 80_000, 90_000] },
    { name: "ETH",  category: "CRYPTO",      strikes: [1_500, 1_800, 2_000, 2_200, 2_400, 2_800, 3_500] },
    // Commodities
    { name: "XAU",  category: "COMMODITIES", strikes: [3_800, 4_200, 4_400, 4_650, 4_800, 5_200, 5_600] },
    { name: "WTI",  category: "COMMODITIES", strikes: [75, 85, 90, 97, 105, 115, 130] },
    { name: "XAG",  category: "COMMODITIES", strikes: [26, 30, 32, 34, 36, 40, 45] },
    // Equities
    { name: "AAPL", category: "EQUITIES",    strikes: [220, 235, 250, 260, 270, 285, 300] },
    { name: "TSLA", category: "EQUITIES",    strikes: [180, 210, 230, 245, 260, 280, 320] },
    { name: "NVDA", category: "EQUITIES",    strikes: [100, 115, 125, 135, 145, 160, 180] },
  ];

  const expiries = [
    { label: "7d", bn: expiry7d },
    { label: "14d", bn: expiry14d },
  ];

  const marketsToCreate: { asset: string; category: string; strike: BN; expiry: BN; expiryLabel: string; type: any; typeIdx: number }[] = [];
  for (const asset of assets) {
    for (const expiry of expiries) {
      for (const strike of asset.strikes) {
        marketsToCreate.push({ asset: asset.name, category: asset.category, strike: usdc(strike), expiry: expiry.bn, expiryLabel: expiry.label, type: { call: {} }, typeIdx: 0 });
        marketsToCreate.push({ asset: asset.name, category: asset.category, strike: usdc(strike), expiry: expiry.bn, expiryLabel: expiry.label, type: { put: {} }, typeIdx: 1 });
      }
    }
  }

  console.log(`--- Creating ${marketsToCreate.length} Markets (9 assets × 7 strikes × 2 types × 2 expiries) ---`);
  const createdMarkets: { pda: PublicKey; asset: string; category: string; strike: BN; isCall: boolean; expiry: BN; expiryLabel: string }[] = [];
  let marketsCreated = 0;
  let marketsSkipped = 0;

  for (let i = 0; i < marketsToCreate.length; i++) {
    const mkt = marketsToCreate[i];
    const strikeNum = mkt.strike.toNumber() / 1e6;
    const typeLabel = mkt.typeIdx === 0 ? "Call" : "Put";
    const feed = PYTH_FEEDS[mkt.asset] || Keypair.generate().publicKey;

    const [marketPda] = PublicKey.findProgramAddressSync([
      Buffer.from("market"), Buffer.from(mkt.asset),
      mkt.strike.toArrayLike(Buffer, "le", 8),
      mkt.expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([mkt.typeIdx]),
    ], program.programId);

    try {
      await program.account.optionsMarket.fetch(marketPda);
      console.log(`  [${mkt.category} ${i + 1}/${marketsToCreate.length}] ⊘ ${mkt.asset} $${strikeNum.toLocaleString()} ${typeLabel} (${mkt.expiryLabel}) — exists`);
      createdMarkets.push({ pda: marketPda, asset: mkt.asset, category: mkt.category, strike: mkt.strike, isCall: mkt.typeIdx === 0, expiry: mkt.expiry, expiryLabel: mkt.expiryLabel });
      marketsSkipped++;
      continue;
    } catch {}

    try {
      await program.methods.createMarket(mkt.asset, mkt.strike, mkt.expiry, mkt.type as any, feed, 0)
        .accountsStrict({
          creator: admin.publicKey, protocolState: protocolStatePda,
          market: marketPda, systemProgram: SystemProgram.programId,
        }).rpc();
      console.log(`  [${mkt.category} ${i + 1}/${marketsToCreate.length}] ✓ ${mkt.asset} $${strikeNum.toLocaleString()} ${typeLabel} (${mkt.expiryLabel}) — created`);
      createdMarkets.push({ pda: marketPda, asset: mkt.asset, category: mkt.category, strike: mkt.strike, isCall: mkt.typeIdx === 0, expiry: mkt.expiry, expiryLabel: mkt.expiryLabel });
      marketsCreated++;
    } catch (e: any) {
      console.log(`  [${mkt.category} ${i + 1}/${marketsToCreate.length}] ✗ ${mkt.asset} $${strikeNum.toLocaleString()} ${typeLabel} FAILED: ${e.message?.slice(0, 80)}`);
    }

    await delay(400);
  }

  console.log("");
  console.log(`Markets: ${marketsCreated} created, ${marketsSkipped} already existed`);
  console.log("");

  // Step 4: Write one option position on each market
  console.log(`--- Writing Options on ${createdMarkets.length} Markets ---`);
  let optionsWritten = 0;
  let optionsSkipped = 0;
  const baseTimestamp = Math.floor(Date.now() / 1000);

  for (let i = 0; i < createdMarkets.length; i++) {
    const market = createdMarkets[i];
    const strikeNum = market.strike.toNumber() / 1e6;
    const typeLabel = market.isCall ? "Call" : "Put";
    const contracts = 10;

    // Collateral: calls need 2x strike × contracts, puts need 1x strike × contracts
    const collateral = market.isCall ? strikeNum * 2 * contracts : strikeNum * contracts;

    // Premium: 5% of strike × contracts
    const premium = strikeNum * 0.05 * contracts;

    // Unique createdAt per position to avoid PDA collisions
    const createdAt = new BN(baseTimestamp + i);

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
    const [purchaseEscrowPda] = PublicKey.findProgramAddressSync([
      Buffer.from("purchase_escrow"), positionPda.toBuffer(),
    ], program.programId);

    // Skip if position already exists
    try {
      await program.account.optionPosition.fetch(positionPda);
      console.log(`  [${market.category} ${i + 1}/${createdMarkets.length}] ⊘ ${market.asset} $${strikeNum.toLocaleString()} ${typeLabel} (${market.expiryLabel}) — position exists`);
      optionsSkipped++;
      continue;
    } catch {}

    try {
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);
      const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

      await program.methods.writeOption(
        usdc(collateral), usdc(premium), new BN(contracts), createdAt,
      ).accountsStrict({
        writer: admin.publicKey, protocolState: protocolStatePda,
        market: market.pda, position: positionPda, escrow: escrowPda,
        optionMint: optionMintPda, purchaseEscrow: purchaseEscrowPda,
        writerUsdcAccount: adminUsdcAta, usdcMint,
        transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList, hookState,
        systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      }).preInstructions([EXTRA_CU]).rpc();

      console.log(`  [${market.category} ${i + 1}/${createdMarkets.length}] ✓ ${market.asset} $${strikeNum.toLocaleString()} ${typeLabel} (${market.expiryLabel}) — written (premium $${premium.toLocaleString()}, collateral $${collateral.toLocaleString()})`);
      optionsWritten++;
    } catch (e: any) {
      console.log(`  [${market.category} ${i + 1}/${createdMarkets.length}] ✗ ${market.asset} $${strikeNum.toLocaleString()} ${typeLabel} write FAILED: ${e.message?.slice(0, 100)}`);
    }

    await delay(400);
  }

  // Summary
  console.log("");
  console.log("=== SEED COMPLETE ===");
  console.log(`Crypto:       SOL (28), BTC (28), ETH (28)`);
  console.log(`Commodities:  XAU (28), WTI (28), XAG (28)`);
  console.log(`Equities:     AAPL (28), TSLA (28), NVDA (28)`);
  console.log(`Total markets: ${marketsCreated + marketsSkipped}`);
  console.log(`Total options: ${optionsWritten + optionsSkipped}`);
  console.log(`Expiries: 7d (${exp7d.toISOString().slice(0, 10)}), 14d (${exp14d.toISOString().slice(0, 10)})`);
  console.log(`Markets created: ${marketsCreated} (${marketsSkipped} already existed)`);
  console.log(`Options written: ${optionsWritten} (${optionsSkipped} already existed)`);
}

describe("create-sample-markets", () => {
  it("creates markets and writes options on devnet", async () => {
    await main();
  });
});
