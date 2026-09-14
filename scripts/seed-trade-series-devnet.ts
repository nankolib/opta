// =============================================================================
// scripts/seed-trade-series-devnet.ts — Pass 0.5: seed ONE complete American
// series for the Trade-page build (devnet).
// =============================================================================
//
// Produces one complete, exercisable series the new exchange path can render:
//   1. create_series        — SOL CALL $75 American, expiry 2026-07-31 08:00 UTC
//   2. create_and_deposit   — funded American vault on the SAME spec ($1,000 USDC)
//   3. fill_vault_peg ×2    — qty 1 each → quantity_minted>0, OI, OrderFilled tape
//   4. post_order ×2        — Bid (~22% below peg) + ResaleAsk (just under peg)
//
// Book prices are derived from the REAL peg premium revealed in step 3.
// Single signer = D (deployer = devnet-USDC mint authority). Idempotent guards
// per-step so a flaky-RPC re-run skips what already exists.
//
// Run (WSL):  RPC_URL=<helius> npx ts-node scripts/seed-trade-series-devnet.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection, PublicKey, Keypair, SystemProgram, ComputeBudgetProgram,
  Transaction, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, mintTo,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const ASSET = "SOL";

// ---- Spec (greenlit) --------------------------------------------------------
const STRIKE = new BN(75 * 1_000_000);          // $75.00, 1e6 micro-USDC
const EXPIRY = new BN(1785484800);              // 2026-07-31 08:00:00 UTC (~40 dte)
const DEPOSIT = new BN(1000 * 1_000_000);        // $1,000 collateral
const OT_CALL = 0, ES_AMER = 1;
const CALL = { call: {} }, CUSTOM = { custom: {} }, AMER = { american: {} };

const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const fmt = (b: BN | bigint) => (Number(b.toString()) / 1e6).toFixed(6);
const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const redact = (s: string) => s.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
const pda = (s: (Buffer | Uint8Array)[], pid: PublicKey = PROGRAM_ID) => PublicKey.findProgramAddressSync(s, pid)[0];
const sigs: Record<string, string> = {};

async function amountOf(conn: Connection, ata: PublicKey): Promise<bigint> {
  const i = await conn.getAccountInfo(ata);
  if (!i || i.data.length < 72) return BigInt(0);
  return Buffer.from(i.data.slice(64, 72)).readBigUInt64LE(0);
}

async function main() {
  const rpcUrl = process.env.RPC_URL ?? process.env.OPTA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, { commitment: "confirmed", confirmTransactionInitialTimeout: 90_000 });
  const D = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(
    process.env.OPTA_KEYPAIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config/solana/id.json"), "utf-8"))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(D), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const program = new Program(idl, provider) as Program<Opta>;

  console.log("=== seed-trade-series-devnet ===");
  console.log("RPC:", redact(rpcUrl));
  console.log("D:", D.publicKey.toBase58());

  const protocolState = pda([Buffer.from("protocol_v2")]);
  const ps = await program.account.protocolState.fetch(protocolState);
  const usdcMint = ps.usdcMint as PublicKey;
  const treasury = ps.treasury as PublicKey;
  const feeBps = ps.feeBps as number;
  const market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
  const mkt = await program.account.optionsMarket.fetch(market);
  const volOracle = pda([Buffer.from("vol_oracle"), Buffer.from(mkt.pythFeedId as number[])]);
  const dUsdc = getAssociatedTokenAddressSync(usdcMint, D.publicKey, false, TOKEN_PROGRAM_ID);

  // Derive all spec PDAs.
  const sLE = STRIKE.toArrayLike(Buffer, "le", 8), eLE = EXPIRY.toArrayLike(Buffer, "le", 8);
  const sMint = pda([Buffer.from("vault_option_mint"), market.toBuffer(), sLE, eLE, Buffer.from([OT_CALL]), Buffer.from([ES_AMER])]);
  const sRecord = pda([Buffer.from("vault_mint_record"), sMint.toBuffer()]);
  const sEaml = pda([Buffer.from("extra-account-metas"), sMint.toBuffer()], HOOK);
  const sHook = pda([Buffer.from("hook-state"), sMint.toBuffer()], HOOK);
  const aVault = pda([Buffer.from("shared_vault_american"), market.toBuffer(), sLE, eLE, Buffer.from([OT_CALL])]);
  const aVaultUsdc = pda([Buffer.from("vault_usdc"), aVault.toBuffer()]);
  const writerPos = pda([Buffer.from("writer_position"), aVault.toBuffer(), D.publicKey.toBuffer()]);
  const dOpt = getAssociatedTokenAddressSync(sMint, D.publicKey, false, TOKEN_2022_PROGRAM_ID);

  console.log("\nspec: SOL CALL $75 American exp 2026-07-31T08:00Z");
  console.log("  series mint :", sMint.toBase58());
  console.log("  amer vault  :", aVault.toBase58());
  console.log("  fee_bps     :", feeBps, " treasury:", treasury.toBase58());

  // Ensure D has USDC headroom (D is mint authority).
  await mintTo(conn, D, usdcMint, dUsdc, D.publicKey, 2000 * 1_000_000).catch(() => {});

  // ---- Step 1: create_series -------------------------------------------------
  console.log("\n[1] create_series");
  if (await conn.getAccountInfo(sMint)) {
    console.log("  series mint already exists — skip");
  } else {
    sigs.createSeries = await program.methods.createSeries(STRIKE, EXPIRY, CALL, AMER).accountsStrict({
      caller: D.publicKey, market, protocolState, optionMint: sMint, vaultMintRecord: sRecord,
      transferHookProgram: HOOK, extraAccountMetaList: sEaml, hookState: sHook,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    console.log("  tx:", sigs.createSeries);
  }

  // ---- Step 2: create_and_deposit (American) ---------------------------------
  console.log("\n[2] create_and_deposit (American, $1,000)");
  const existingVault = await conn.getAccountInfo(aVault);
  if (existingVault) {
    const v: any = await program.account.sharedVault.fetch(aVault);
    console.log(`  vault already exists — total_collateral=${fmt(v.totalCollateral as BN)} — skip deposit`);
  } else {
    sigs.createAndDeposit = await program.methods.createAndDeposit(STRIKE, EXPIRY, CALL, CUSTOM, usdcMint, 0, AMER, DEPOSIT)
      .accountsStrict({
        writer: D.publicKey, market, sharedVault: aVault, vaultUsdcAccount: aVaultUsdc, usdcMint,
        writerPosition: writerPos, writerUsdcAccount: dUsdc, protocolState, epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).preInstructions([CU(400_000)]).rpc();
    const v: any = await program.account.sharedVault.fetch(aVault);
    console.log(`  tx: ${sigs.createAndDeposit}  total_collateral=${fmt(v.totalCollateral as BN)}`);
  }

  // ---- Step 3: fill_vault_peg ×2 (qty 1) → reveal real peg --------------------
  console.log("\n[3] fill_vault_peg ×2 (qty 1)");
  await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
    D.publicKey, dOpt, D.publicKey, sMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)));
  const pegPaid: bigint[] = [];
  for (let i = 0; i < 2; i++) {
    const recBefore: any = await program.account.vaultMint.fetch(sRecord);
    if ((recBefore.quantityMinted as BN).gten(i + 1)) {
      console.log(`  fill ${i + 1}: already minted (record.quantity_minted=${(recBefore.quantityMinted as BN).toString()}) — skip`);
      continue;
    }
    const before = await amountOf(conn, dUsdc);
    sigs[`pegFill${i + 1}`] = await program.methods.fillVaultPeg(new BN(1), usdc(1_000_000)).accountsStrict({
      taker: D.publicKey, sharedVault: aVault, vaultMintRecord: sRecord, market, volOracle, protocolState,
      optionMint: sMint, takerOptionAccount: dOpt, takerUsdcAccount: dUsdc, vaultUsdcAccount: aVaultUsdc,
      treasury, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    }).preInstructions([CU(400_000)]).rpc();
    const paid = before - (await amountOf(conn, dUsdc));
    pegPaid.push(paid);
    console.log(`  fill ${i + 1}: tx ${sigs[`pegFill${i + 1}`]}  PAID $${fmt(new BN(paid.toString()))} (incl. fee_bps=${feeBps})`);
  }
  const rec: any = await program.account.vaultMint.fetch(sRecord);
  console.log(`  series record: quantity_minted=${(rec.quantityMinted as BN).toString()} quantity_sold=${(rec.quantitySold as BN).toString()}`);
  const dOptBal = await amountOf(conn, dOpt);
  console.log(`  D holds ${dOptBal} series contracts`);

  // Per-contract peg (last observed fill, qty 1 = full premium incl fee).
  const pegPerContract = pegPaid.length ? pegPaid[pegPaid.length - 1] : BigInt(2_000_000); // fallback $2 if both skipped
  console.log(`  => peg per-contract (paid) ≈ $${fmt(new BN(pegPerContract.toString()))}`);

  // ---- Step 4: post_order Bid (~22% below) + ResaleAsk (just under peg) -------
  console.log("\n[4] post_order — Bid + undercutting ResaleAsk");
  const bidPrice = new BN((pegPerContract * BigInt(78) / BigInt(100)).toString());            // ~22% below peg
  let askPrice = new BN((pegPerContract * BigInt(98) / BigInt(100)).toString());              // just under peg
  if (askPrice.lte(bidPrice)) askPrice = bidPrice.add(usdc(0.01));
  console.log(`  bid=$${fmt(bidPrice)}  ask=$${fmt(askPrice)} (peg≈$${fmt(new BN(pegPerContract.toString()))})`);

  // Bid (nonce 1) — escrows USDC.
  const bidNonce = new BN(1);
  const bidOrder = pda([Buffer.from("resting_order"), sMint.toBuffer(), D.publicKey.toBuffer(), bidNonce.toArrayLike(Buffer, "le", 8)]);
  const bidEscrow = pda([Buffer.from("resting_order_escrow"), bidOrder.toBuffer()]);
  if (await conn.getAccountInfo(bidOrder)) {
    console.log("  bid order already exists — skip");
  } else {
    sigs.postBid = await program.methods.postOrder({ bid: {} }, bidPrice, new BN(1), bidNonce).accountsStrict({
      owner: D.publicKey, sharedVault: aVault, market, vaultMintRecord: sRecord, optionMint: sMint,
      order: bidOrder, escrow: bidEscrow, protocolState, ownerOptionAccount: dOpt, ownerUsdcAccount: dUsdc,
      usdcMint, transferHookProgram: HOOK, extraAccountMetaList: sEaml, hookState: sHook,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).rpc();
    console.log(`  bid tx: ${sigs.postBid}  escrow USDC=$${fmt(new BN((await amountOf(conn, bidEscrow)).toString()))}`);
  }

  // ResaleAsk (nonce 2) — escrows 1 series contract.
  const askNonce = new BN(2);
  const askOrder = pda([Buffer.from("resting_order"), sMint.toBuffer(), D.publicKey.toBuffer(), askNonce.toArrayLike(Buffer, "le", 8)]);
  const askEscrow = pda([Buffer.from("resting_order_escrow"), askOrder.toBuffer()]);
  if (await conn.getAccountInfo(askOrder)) {
    console.log("  ask order already exists — skip");
  } else if (dOptBal < BigInt(1)) {
    console.log("  WARN: D holds 0 contracts — cannot post ResaleAsk (peg fills were skipped?)");
  } else {
    sigs.postAsk = await program.methods.postOrder({ resaleAsk: {} }, askPrice, new BN(1), askNonce).accountsStrict({
      owner: D.publicKey, sharedVault: aVault, market, vaultMintRecord: sRecord, optionMint: sMint,
      order: askOrder, escrow: askEscrow, protocolState, ownerOptionAccount: dOpt, ownerUsdcAccount: dUsdc,
      usdcMint, transferHookProgram: HOOK, extraAccountMetaList: sEaml, hookState: sHook,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).rpc();
    console.log(`  ask tx: ${sigs.postAsk}  escrow contracts=${await amountOf(conn, askEscrow)}`);
  }

  console.log("\n=== tx signatures ===");
  for (const [k, v] of Object.entries(sigs)) console.log(`  ${k}: ${v}`);
  console.log("\n=== seed complete ===");
  console.log("series mint:", sMint.toBase58());
  console.log("amer vault :", aVault.toBase58());
}
main().catch((e) => { console.error("FATAL:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
