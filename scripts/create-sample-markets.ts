// =============================================================================
// scripts/create-sample-markets.ts — Create sample data for tokenized protocol
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
  SOL: new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"),
  BTC: new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"),
  ETH: new PublicKey("EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9GvYRk4HY7y44"),
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

  console.log("=== Butter Options — Full Options Chain Seeder ===");
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

  // Step 2: Ensure admin has USDC — mint 10M for all the collateral we'll need
  let adminUsdcAta: PublicKey;
  try {
    adminUsdcAta = await getAssociatedTokenAddress(usdcMint, admin.publicKey);
    await provider.connection.getTokenAccountBalance(adminUsdcAta);
  } catch {
    adminUsdcAta = await createAssociatedTokenAccount(provider.connection, payer, usdcMint, admin.publicKey);
  }
  try {
    await mintTo(provider.connection, payer, usdcMint, adminUsdcAta, admin.publicKey, 10_000_000_000_000);
    console.log("✓ Minted 10M test USDC to admin");
  } catch {
    console.log("  (Mint skipped — not mint authority)");
  }

  const bal = await provider.connection.getTokenAccountBalance(adminUsdcAta);
  console.log(`  Admin USDC balance: ${bal.value.uiAmountString}`);
  console.log("");

  // Step 3: Build full options chain
  const expiry7d = new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
  const expiry14d = new BN(Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60);

  const assets = [
    { name: "SOL", strikes: [120, 130, 140, 150, 160, 170, 200] },
    { name: "BTC", strikes: [70_000, 80_000, 85_000, 90_000, 100_000] },
    { name: "ETH", strikes: [1_500, 1_700, 1_800, 1_900, 2_000] },
  ];

  const expiries = [
    { label: "7d", bn: expiry7d },
    { label: "14d", bn: expiry14d },
  ];

  const marketsToCreate: { asset: string; strike: BN; expiry: BN; expiryLabel: string; type: any; typeIdx: number }[] = [];
  for (const asset of assets) {
    for (const expiry of expiries) {
      for (const strike of asset.strikes) {
        marketsToCreate.push({ asset: asset.name, strike: usdc(strike), expiry: expiry.bn, expiryLabel: expiry.label, type: { call: {} }, typeIdx: 0 });
        marketsToCreate.push({ asset: asset.name, strike: usdc(strike), expiry: expiry.bn, expiryLabel: expiry.label, type: { put: {} }, typeIdx: 1 });
      }
    }
  }

  console.log(`--- Creating ${marketsToCreate.length} Markets ---`);
  const createdMarkets: { pda: PublicKey; asset: string; strike: BN; isCall: boolean; expiry: BN; expiryLabel: string }[] = [];
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
      console.log(`  [${i + 1}/${marketsToCreate.length}] ⊘ ${mkt.asset} $${strikeNum.toLocaleString()} ${typeLabel} (${mkt.expiryLabel}) — exists`);
      createdMarkets.push({ pda: marketPda, asset: mkt.asset, strike: mkt.strike, isCall: mkt.typeIdx === 0, expiry: mkt.expiry, expiryLabel: mkt.expiryLabel });
      marketsSkipped++;
      continue;
    } catch {}

    try {
      await program.methods.createMarket(mkt.asset, mkt.strike, mkt.expiry, mkt.type as any, feed, 0)
        .accountsStrict({
          creator: admin.publicKey, protocolState: protocolStatePda,
          market: marketPda, systemProgram: SystemProgram.programId,
        }).rpc();
      console.log(`  [${i + 1}/${marketsToCreate.length}] ✓ ${mkt.asset} $${strikeNum.toLocaleString()} ${typeLabel} (${mkt.expiryLabel}) — created`);
      createdMarkets.push({ pda: marketPda, asset: mkt.asset, strike: mkt.strike, isCall: mkt.typeIdx === 0, expiry: mkt.expiry, expiryLabel: mkt.expiryLabel });
      marketsCreated++;
    } catch (e: any) {
      console.log(`  [${i + 1}/${marketsToCreate.length}] ✗ ${mkt.asset} $${strikeNum.toLocaleString()} ${typeLabel} FAILED: ${e.message?.slice(0, 80)}`);
    }

    await delay(500);
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
      console.log(`  [${i + 1}/${createdMarkets.length}] ⊘ ${market.asset} $${strikeNum.toLocaleString()} ${typeLabel} (${market.expiryLabel}) — position exists`);
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

      console.log(`  [${i + 1}/${createdMarkets.length}] ✓ ${market.asset} $${strikeNum.toLocaleString()} ${typeLabel} (${market.expiryLabel}) — written (premium $${premium.toLocaleString()}, collateral $${collateral.toLocaleString()})`);
      optionsWritten++;
    } catch (e: any) {
      console.log(`  [${i + 1}/${createdMarkets.length}] ✗ ${market.asset} $${strikeNum.toLocaleString()} ${typeLabel} write FAILED: ${e.message?.slice(0, 100)}`);
    }

    await delay(500);
  }

  // Summary
  const solCount = assets[0].strikes.length * expiries.length * 2;
  const btcCount = assets[1].strikes.length * expiries.length * 2;
  const ethCount = assets[2].strikes.length * expiries.length * 2;

  console.log("");
  console.log("=== Summary ===");
  console.log(`Markets created: ${marketsCreated} (${marketsSkipped} already existed)`);
  console.log(`Options written: ${optionsWritten} (${optionsSkipped} already existed)`);
  console.log(`Assets: SOL (${solCount} markets), BTC (${btcCount} markets), ETH (${ethCount} markets)`);
  console.log(`Expiries: 7d, 14d`);
  console.log("Ready to trade at butteroptionsapp.vercel.app/trade");
}

describe("create-sample-markets", () => {
  it("creates markets and writes options on devnet", async () => {
    await main();
  });
});
