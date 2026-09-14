// NOTE 2026-05-21: signature brought to Pass-1 compliance during Stage C schema work. End-to-end runnability NOT verified — has been broken against deployed program since ~2026-04. Revive cautiously.
// =============================================================================
// scripts/test-write-race.ts — Smoke test for the 3-stage Write orchestrator
// =============================================================================
//
// Runs ONE full Write flow (createSharedVault → depositToVault → mintFromVault)
// against devnet using SOL $80 PUT, 1 contract, next-Friday 08:00 UTC expiry.
// After each stage's tx confirms, runs the on-chain landed-check that the
// frontend's submitStageWithRecovery helper relies on — independently of the
// helper itself, to validate the underlying chain contract:
//
//   Stage 1: SharedVault PDA exists.
//   Stage 2: WriterPosition.depositedCollateral increased by collateralBN.
//   Stage 3: VaultMint PDA exists.
//
// Exits 0 on full success, 1 on any stage failure with a clear error.
//
// We do NOT artificially trigger the wallet-replay race; the recovery branch
// is exercised naturally if it fires. Either way, a green run confirms the
// happy path is intact and the on-chain artifacts the helper checks for are
// present where expected.
//
// Run: RPC_URL=https://api.devnet.solana.com npx ts-node scripts/test-write-race.ts
// Required env: RPC_URL (devnet RPC). Optional: OPTA_KEYPAIR (defaults to
//   ~/.config/solana/id.json on Linux/WSL).
// Pre-reqs: writer wallet must hold ≥ $80 USDC and ≥ 0.02 SOL.
//   SOL market must exist on devnet — run scripts/seed-demo-fresh.ts if not.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection,
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
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

// =============================================================================
// Constants — match programs/opta + frontend
// =============================================================================
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const EXTRA_CU_400K = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const EXTRA_CU_800K = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

// Test scenario — chosen for minimum collateral on existing devnet markets.
const TEST_ASSET = "SOL";
const TEST_STRIKE_USD = 80;
const TEST_SIDE: "call" | "put" = "put";
const TEST_TYPE_IDX = (TEST_SIDE as string) === "call" ? 0 : 1;
const TEST_CONTRACTS = 1;

// Pre-flight gates — bail with a clear error if writer is short.
const MIN_USDC_HUMAN = 80; // 1 contract * $80 strike
const MIN_LAMPORTS = 20_000_000; // 0.02 SOL

// =============================================================================
// Helpers
// =============================================================================
const usdc = (n: number): BN => new BN(Math.round(n * 1_000_000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deriveProtocolStatePda() {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
}
function deriveEpochConfigPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("epoch_config")], PROGRAM_ID);
}
function deriveMarketPda(asset: string) {
  // Single-seed market PDA (post-Stage-2 — strike/expiry/side moved to SharedVault).
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(asset)],
    PROGRAM_ID,
  );
}
function deriveSharedVaultPda(market: PublicKey, strike: BN, expiry: BN, typeIdx: number) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("shared_vault"),
      market.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([typeIdx]),
    ],
    PROGRAM_ID,
  );
}
function deriveVaultUsdcPda(vault: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_usdc"), vault.toBuffer()],
    PROGRAM_ID,
  );
}
function deriveWriterPositionPda(vault: PublicKey, writer: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("writer_position"), vault.toBuffer(), writer.toBuffer()],
    PROGRAM_ID,
  );
}
function deriveVaultOptionMintPda(vault: PublicKey, writer: PublicKey, createdAt: BN) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_option_mint"),
      vault.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
}
function deriveVaultPurchaseEscrowPda(vault: PublicKey, writer: PublicKey, createdAt: BN) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_purchase_escrow"),
      vault.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
}
function deriveVaultMintRecordPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mint_record"), mint.toBuffer()],
    PROGRAM_ID,
  );
}
function deriveExtraMetaListPda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
}
function deriveHookStatePda(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), mint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
}

/** Next Friday 08:00 UTC, at least 1 day away. Mirrors frontend epoch derivation. */
function nextFridayExpiry(): BN {
  const now = new Date();
  let daysUntil = (5 - now.getUTCDay() + 7) % 7;
  if (daysUntil === 0) {
    const todayAt8 = new Date(now);
    todayAt8.setUTCHours(8, 0, 0, 0);
    if (now >= todayAt8) daysUntil = 7;
  }
  if (daysUntil * 86400 < 86400 + 30) daysUntil += 7;
  const friday = new Date(now);
  friday.setUTCDate(friday.getUTCDate() + daysUntil);
  friday.setUTCHours(8, 0, 0, 0);
  return new BN(Math.floor(friday.getTime() / 1000));
}

/** Read Token-2022/Token-Program u64 amount field at offset 64..72 of an ATA. */
async function readTokenAmount(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length < 72) return BigInt(0);
  return Buffer.from(info.data.slice(64, 72)).readBigUInt64LE(0);
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  const t0 = Date.now();
  console.log("=== test-write-race ===\n");

  // ---- Provider / program setup ----
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error("FATAL: RPC_URL env var is required (e.g. https://api.devnet.solana.com)");
    process.exit(1);
  }
  const conn = new Connection(rpcUrl, { commitment: "confirmed" });

  const keypairPath =
    process.env.OPTA_KEYPAIR ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config/solana/id.json");
  if (!fs.existsSync(keypairPath)) {
    console.error(`FATAL: keypair not found at ${keypairPath}`);
    console.error(`Set OPTA_KEYPAIR or place the wallet at ~/.config/solana/id.json`);
    process.exit(1);
  }
  const writer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))),
  );
  const wallet = new anchor.Wallet(writer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "target", "idl", "opta.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider) as Program<Opta>;

  console.log(`RPC:    ${rpcUrl}`);
  console.log(`Writer: ${writer.publicKey.toBase58()}\n`);

  // ---- Pre-flight balance gates ----
  const solLamports = await conn.getBalance(writer.publicKey);
  console.log(`SOL balance:  ${(solLamports / 1e9).toFixed(4)} SOL`);
  if (solLamports < MIN_LAMPORTS) {
    console.error(`FATAL: insufficient SOL (need ≥ 0.02 SOL for fees + rent)`);
    console.error(`Faucet: solana airdrop 1 ${writer.publicKey.toBase58()} --url ${rpcUrl}`);
    process.exit(1);
  }

  const [protocolStatePda] = deriveProtocolStatePda();
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint;
  const writerAta = getAssociatedTokenAddressSync(usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);
  const usdcRaw = await readTokenAmount(conn, writerAta);
  const usdcHuman = Number(usdcRaw) / 1_000_000;
  console.log(`USDC balance: $${usdcHuman.toLocaleString()} (mint ${usdcMint.toBase58()})`);
  if (usdcHuman < MIN_USDC_HUMAN) {
    console.error(`FATAL: insufficient USDC (need ≥ $${MIN_USDC_HUMAN})`);
    console.error(`Use the "Get devnet USDC" button in the app to top up.`);
    process.exit(1);
  }

  // ---- Resolve test scenario PDAs ----
  const [marketPda] = deriveMarketPda(TEST_ASSET);
  try {
    await program.account.optionsMarket.fetch(marketPda);
  } catch {
    console.error(`FATAL: ${TEST_ASSET} market not found at ${marketPda.toBase58()}`);
    console.error(`Run scripts/seed-demo-fresh.ts to create it.`);
    process.exit(1);
  }

  const expiryBN = nextFridayExpiry();
  const strikeBN = usdc(TEST_STRIKE_USD);
  const collateralBN = usdc(TEST_STRIKE_USD * TEST_CONTRACTS);
  const contractsBN = new BN(TEST_CONTRACTS);
  const premiumBN = usdc(TEST_STRIKE_USD * 0.05); // 5% of strike, well above PremiumTooLow floor
  const createdAt = new BN(Math.floor(Date.now() / 1000));

  const [sharedVaultPda] = deriveSharedVaultPda(marketPda, strikeBN, expiryBN, TEST_TYPE_IDX);
  const [vaultUsdcPda] = deriveVaultUsdcPda(sharedVaultPda);
  const [writerPositionPda] = deriveWriterPositionPda(sharedVaultPda, writer.publicKey);
  const [optionMintPda] = deriveVaultOptionMintPda(sharedVaultPda, writer.publicKey, createdAt);
  const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(sharedVaultPda, writer.publicKey, createdAt);
  const [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
  const [extraMeta] = deriveExtraMetaListPda(optionMintPda);
  const [hookState] = deriveHookStatePda(optionMintPda);
  const [epochConfigPda] = deriveEpochConfigPda();

  console.log(`\nScenario: ${TEST_ASSET} $${TEST_STRIKE_USD} ${TEST_SIDE.toUpperCase()}, ${TEST_CONTRACTS} contract`);
  console.log(`Expiry:   ${new Date(expiryBN.toNumber() * 1000).toISOString()}`);
  console.log(`Vault:    ${sharedVaultPda.toBase58()}`);
  console.log(`Position: ${writerPositionPda.toBase58()}`);
  console.log(`Mint:     ${optionMintPda.toBase58()}`);
  console.log(`Record:   ${vaultMintRecordPda.toBase58()}\n`);

  // ---- STAGE 1 — createSharedVault (skip if vault exists) ----
  console.log("--- Stage 1: createSharedVault ---");
  let stage1Skipped = false;
  try {
    await program.account.sharedVault.fetch(sharedVaultPda);
    console.log("  SharedVault already exists → skipping create (idempotent path)");
    stage1Skipped = true;
  } catch {
    // not yet created
  }
  if (!stage1Skipped) {
    try {
      const sig = await program.methods
        .createSharedVault(
          strikeBN,
          expiryBN,
          { put: {} } as any, // TEST_SIDE === "put" — change to { call: {} } if TEST_SIDE flips
          { epoch: {} } as any,
          usdcMint,
          0,                       // carry_rate_bps: no-dividend default
          { european: {} } as any, // exercise_style: legacy smoke = European
        )
        .accountsStrict({
          creator: writer.publicKey,
          market: marketPda,
          sharedVault: sharedVaultPda,
          vaultUsdcAccount: vaultUsdcPda,
          usdcMint,
          protocolState: protocolStatePda,
          epochConfig: epochConfigPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([EXTRA_CU_400K])
        .signers([writer])
        .rpc({ commitment: "confirmed" });
      console.log(`  tx: ${sig}`);
    } catch (err: any) {
      console.error(`  ✗ Stage 1 send failed: ${err.message ?? err}`);
      process.exit(1);
    }
    await sleep(1000);
    // Landed-check: SharedVault PDA now exists. (Same check the helper would
    // run on the recovery branch — see useWriteSubmit.ts submitStageWithRecovery.)
    try {
      await program.account.sharedVault.fetch(sharedVaultPda);
      console.log(`  ✓ landed-check: SharedVault exists`);
    } catch {
      console.error(`  ✗ landed-check failed: SharedVault still does not exist`);
      process.exit(1);
    }
  }

  // ---- STAGE 2 — depositToVault ----
  console.log("\n--- Stage 2: depositToVault ---");
  // Snapshot deposited_collateral BEFORE sending — landed-check confirms THIS
  // deposit landed by checking `after >= snapshot + collateralBN`.
  let depositSnapshot: BN = new BN(0);
  try {
    const existing = await program.account.writerPosition.fetch(writerPositionPda);
    depositSnapshot = existing.depositedCollateral as BN;
    console.log(`  pre-snapshot: depositedCollateral = $${depositSnapshot.toNumber() / 1e6}`);
  } catch {
    console.log("  pre-snapshot: WriterPosition does not exist yet → snapshot = $0");
  }
  try {
    const sig = await program.methods
      .depositToVault(collateralBN)
      .accountsStrict({
        writer: writer.publicKey,
        sharedVault: sharedVaultPda,
        writerPosition: writerPositionPda,
        writerUsdcAccount: writerAta,
        vaultUsdcAccount: vaultUsdcPda,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([EXTRA_CU_400K])
      .signers([writer])
      .rpc({ commitment: "confirmed" });
    console.log(`  tx: ${sig}`);
  } catch (err: any) {
    console.error(`  ✗ Stage 2 send failed: ${err.message ?? err}`);
    process.exit(1);
  }
  await sleep(1000);
  // Landed-check: WriterPosition.depositedCollateral increased by ≥ collateralBN.
  // gte (not eq) tolerates a same-writer concurrent deposit racing in.
  try {
    const after = await program.account.writerPosition.fetch(writerPositionPda);
    const afterBN = after.depositedCollateral as BN;
    const expected = depositSnapshot.add(collateralBN);
    if (!afterBN.gte(expected)) {
      console.error(`  ✗ landed-check failed: depositedCollateral $${afterBN.toNumber() / 1e6} < expected $${expected.toNumber() / 1e6}`);
      process.exit(1);
    }
    console.log(`  ✓ landed-check: depositedCollateral = $${afterBN.toNumber() / 1e6} (Δ +$${collateralBN.toNumber() / 1e6})`);
  } catch (err: any) {
    console.error(`  ✗ landed-check failed: WriterPosition not fetchable: ${err.message ?? err}`);
    process.exit(1);
  }

  // ---- STAGE 3 — mintFromVault ----
  console.log("\n--- Stage 3: mintFromVault ---");
  try {
    const sig = await program.methods
      .mintFromVault(contractsBN, premiumBN, createdAt)
      .accountsStrict({
        writer: writer.publicKey,
        sharedVault: sharedVaultPda,
        writerPosition: writerPositionPda,
        market: marketPda,
        protocolState: protocolStatePda,
        optionMint: optionMintPda,
        purchaseEscrow: purchaseEscrowPda,
        vaultMintRecord: vaultMintRecordPda,
        transferHookProgram: HOOK_PROGRAM_ID,
        extraAccountMetaList: extraMeta,
        hookState,
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([EXTRA_CU_800K])
      .signers([writer])
      .rpc({ commitment: "confirmed" });
    console.log(`  tx: ${sig}`);
  } catch (err: any) {
    console.error(`  ✗ Stage 3 send failed: ${err.message ?? err}`);
    process.exit(1);
  }
  await sleep(1000);
  // Landed-check: VaultMint PDA exists. The PDA's seeds include the per-call
  // `createdAt` nonce, so existence cannot be confused with any prior session.
  try {
    const record = await program.account.vaultMint.fetch(vaultMintRecordPda);
    console.log(`  ✓ landed-check: VaultMint exists`);
    console.log(`    quantityMinted: ${(record.quantityMinted as BN).toString()}`);
    console.log(`    premiumPerContract: $${(record.premiumPerContract as BN).toNumber() / 1e6}`);
  } catch {
    console.error(`  ✗ landed-check failed: VaultMint does not exist at ${vaultMintRecordPda.toBase58()}`);
    process.exit(1);
  }

  // ---- Summary ----
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const finalPosition = await program.account.writerPosition.fetch(writerPositionPda);
  const finalVault = await program.account.sharedVault.fetch(sharedVaultPda);
  console.log("\n=== Summary ===");
  console.log(`  All 3 stages landed.`);
  console.log(`  Vault:        ${sharedVaultPda.toBase58()}`);
  console.log(`  Position:     deposited $${(finalPosition.depositedCollateral as BN).toNumber() / 1e6}, ` +
    `optionsMinted ${(finalPosition.optionsMinted as BN).toString()}`);
  console.log(`  Vault total:  $${(finalVault.totalCollateral as BN).toNumber() / 1e6} collateral, ` +
    `${(finalVault.totalOptionsMinted as BN).toString()} options minted`);
  console.log(`  Runtime:      ${elapsed}s`);
  console.log(`\nGreen.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nUNCAUGHT:", err);
  process.exit(1);
});
