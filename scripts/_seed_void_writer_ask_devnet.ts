// =============================================================================
// scripts/_seed_void_writer_ask_devnet.ts — seed a DEAD-FEED writer-ask vault
// =============================================================================
//
// The settle-smoke shape MINUS the settle step, on the SBXAU (Switchboard gold,
// oracle_source=1) market. Purpose: create a vault that NEVER settles, so after
// the 7-day GRACE_WINDOW it becomes the first live void+reclaim target for the
// wired zero-premium reclaim crank pass.
//
// DEAD-FEED MECHANISM (external to this script): SB gold is quotable 24/7 (PAXG),
// so the ONLY way it dead-feeds is if the sb-oracle crank is PAUSED across the
// on-chain SB settle window (SB_SETTLE_WINDOW_SECS=300 from expiry). Run this
// ONLY while opta-crank has OPTA_SB_CRANK_DISABLED=1 (see the pause runbook).
// Past expiry+300s the SB arm of settle_expiry reverts SwitchboardSettleWindowElapsed
// forever, and the Pyth settle loop skips oracle_source==1 vaults → permanent dead-feed.
//
// Signers: D (deployer / devnet-USDC mint authority) = writer; fresh buyer = taker.
// No settle. No admin-only step. Anti-blind-retry: idempotent create guards; on
// post/fill failure we fetch on-chain state and STOP (no resend).
//
// Run (WSL, crank SB loop PAUSED):
//   RPC_URL=<helius> npx ts-node --transpile-only scripts/_seed_void_writer_ask_devnet.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection, PublicKey, Keypair, SystemProgram, ComputeBudgetProgram,
  Transaction, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, mintTo,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

import { canonicalSeriesMint, settlePotPdas } from "../tests/shared/settle-pdas";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const ASSET = "SBXAU"; // Switchboard gold market (oracle_source=1)
const OT_CALL = 0, ES_AMER = 1;
const CALL = { call: {} }, CUSTOM = { custom: {} }, AMER = { american: {} };
const WRITER_ASK = { writerAsk: {} };

// ---- Locked seed params -----------------------------------------------------
const EXPIRY_OFFSET_S = 180;              // clusterNow + 180
const GRACE_WINDOW_S = 604_800;           // 7 days — state/shared_vault.rs::GRACE_WINDOW
const STRIKE = new BN(100 * 1_000_000);   // $100 (arbitrary — dead-feed vault; strike only sizes cpt/pot)
const DEPOSIT = new BN(10 * 1_000_000);   // $10 nominal pool → mixed vault (pool position for the crank pass)
const QTY = new BN(2);
const PRICE = new BN(2 * 1_000_000);      // $2 / contract

const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const fmt = (b: BN | bigint) => (Number(b.toString()) / 1e6).toFixed(6);
const redact = (s: string) => s.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
const pda = (s: (Buffer | Uint8Array)[], pid = PROGRAM_ID) => PublicKey.findProgramAddressSync(s, pid)[0];
const sigs: Record<string, string> = {};

async function amountOf(conn: Connection, ata: PublicKey): Promise<bigint> {
  const i = await conn.getAccountInfo(ata);
  if (!i || i.data.length < 72) return BigInt(0);
  return Buffer.from(i.data.slice(64, 72)).readBigUInt64LE(0);
}
async function clusterNow(conn: Connection): Promise<number> {
  return (await conn.getBlockTime(await conn.getSlot()))!;
}

const rows: { name: string; expected: string; actual: string; pass: boolean }[] = [];
function assertEq(name: string, expected: bigint | string, actual: bigint | string) {
  const e = expected.toString(), a = actual.toString();
  rows.push({ name, expected: e, actual: a, pass: e === a });
}
function assertTrue(name: string, cond: boolean, detail: string) {
  rows.push({ name, expected: "true", actual: `${cond} (${detail})`, pass: cond });
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

  console.log("=== void-seed writer-ask (SBXAU, devnet) ===");
  console.log("RPC:", redact(rpcUrl), "| D:", D.publicKey.toBase58());

  // ---- SAFETY: refuse to run unless the SB crank is paused (best-effort probe) ----
  // The dead-feed guarantee depends on the sb-oracle crank NOT settling within 300s.
  // We cannot read the VPS env from here, so this is an operator checklist reminder,
  // not an enforced gate:
  console.log("!! PRECONDITION: opta-crank MUST have OPTA_SB_CRANK_DISABLED=1 right now.");
  console.log("!! Keep it paused through expiry+360s (see pause runbook). Proceeding.\n");

  const protocolState = pda([Buffer.from("protocol_v2")]);
  const ps: any = await program.account.protocolState.fetch(protocolState);
  const usdcMint = ps.usdcMint as PublicKey;
  const treasury = ps.treasury as PublicKey;
  const feeBps = ps.feeBps as number;
  const market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
  const mkt: any = await program.account.optionsMarket.fetch(market); // throws if SBXAU market missing
  const oracleSource = (mkt.oracleSource as number) ?? 0;
  assertTrue("market is Switchboard (oracle_source==1)", oracleSource === 1, `oracle_source=${oracleSource}`);

  const now0 = await clusterNow(conn);
  const EXPIRY = new BN(now0 + EXPIRY_OFFSET_S);
  const voidEligibleTs = EXPIRY.toNumber() + GRACE_WINDOW_S;
  const cpt = STRIKE;
  const escrowExpected = cpt.mul(QTY);
  const premium = PRICE.mul(QTY);
  const fee = premium.muln(feeBps).divn(10_000);
  const counterparty = premium.sub(fee);

  const sLE = STRIKE.toArrayLike(Buffer, "le", 8), eLE = EXPIRY.toArrayLike(Buffer, "le", 8);
  const sMint = canonicalSeriesMint(PROGRAM_ID, market, STRIKE, EXPIRY, OT_CALL, ES_AMER);
  const sRecord = pda([Buffer.from("vault_mint_record"), sMint.toBuffer()]);
  const sEaml = pda([Buffer.from("extra-account-metas"), sMint.toBuffer()], HOOK);
  const sHook = pda([Buffer.from("hook-state"), sMint.toBuffer()], HOOK);
  const aVault = pda([Buffer.from("shared_vault_american"), market.toBuffer(), sLE, eLE, Buffer.from([OT_CALL])]);
  const aVaultUsdc = pda([Buffer.from("vault_usdc"), aVault.toBuffer()]);
  const writerPos = pda([Buffer.from("writer_position"), aVault.toBuffer(), D.publicKey.toBuffer()]);
  const settlementPda = pda([Buffer.from("settlement"), Buffer.from(ASSET), eLE]);
  const dOpt = getAssociatedTokenAddressSync(sMint, D.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dUsdc = getAssociatedTokenAddressSync(usdcMint, D.publicKey, false, TOKEN_PROGRAM_ID);
  const { writerAskPot, writerAskPotUsdc } = settlePotPdas(PROGRAM_ID, sMint);
  const writerAskPosition = pda([Buffer.from("writer_ask_position"), sMint.toBuffer(), D.publicKey.toBuffer()]);

  console.log(`spec: SBXAU CALL $${STRIKE.toNumber() / 1e6} American | expiry ${EXPIRY.toString()} (now+${EXPIRY_OFFSET_S}s)`);
  console.log(`  market=${market.toBase58()} oracle_source=${oracleSource}`);
  console.log(`  series mint: ${sMint.toBase58()}`);
  console.log(`  amer vault : ${aVault.toBase58()}`);
  console.log(`  settlement PDA (must stay ABSENT): ${settlementPda.toBase58()}`);
  console.log(`  cpt=$${fmt(cpt)} escrow/pot=$${fmt(escrowExpected)} premium=$${fmt(premium)} fee=$${fmt(fee)} (fee_bps=${feeBps})`);
  console.log(`  >>> VOID-ELIGIBLE AT: ${voidEligibleTs} = ${new Date(voidEligibleTs * 1000).toISOString()} (expiry + 604800s)`);

  await mintTo(conn, D, usdcMint, dUsdc, D.publicKey, Number(escrowExpected.addn(1_000_000).toString())).catch(() => {});
  await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
    D.publicKey, dOpt, D.publicKey, sMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID))).catch(() => {});

  // ---- Step 1: create_series ------------------------------------------------
  console.log("\n[1] create_series");
  if (await conn.getAccountInfo(sMint)) console.log("  series mint exists — skip");
  else {
    sigs.createSeries = await program.methods.createSeries(STRIKE, EXPIRY, CALL, AMER).accountsStrict({
      caller: D.publicKey, market, protocolState, optionMint: sMint, vaultMintRecord: sRecord,
      transferHookProgram: HOOK, extraAccountMetaList: sEaml, hookState: sHook,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    console.log("  tx:", sigs.createSeries);
  }

  // ---- Step 2: create_and_deposit (American CUSTOM, mixed pool) -------------
  console.log("\n[2] create_and_deposit (American CUSTOM, $10 pool)");
  if (await conn.getAccountInfo(aVault)) {
    const v: any = await program.account.sharedVault.fetch(aVault);
    console.log(`  vault exists — total_collateral=${fmt(v.totalCollateral)} — skip`);
  } else {
    sigs.createAndDeposit = await program.methods
      .createAndDeposit(STRIKE, EXPIRY, CALL, CUSTOM, usdcMint, 0, AMER, DEPOSIT).accountsStrict({
        writer: D.publicKey, market, sharedVault: aVault, vaultUsdcAccount: aVaultUsdc, usdcMint,
        writerPosition: writerPos, writerUsdcAccount: dUsdc, protocolState, epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).preInstructions([CU(400_000)]).rpc();
    console.log("  tx:", sigs.createAndDeposit);
  }
  const vAfterDeposit: any = await program.account.sharedVault.fetch(aVault);
  const poolTc0 = BigInt(vAfterDeposit.totalCollateral.toString());
  console.log(`  pool total_collateral=$${fmt(vAfterDeposit.totalCollateral)} total_shares=${vAfterDeposit.totalShares.toString()}`);

  // ---- Step 3: fund ephemeral buyer -----------------------------------------
  console.log("\n[3] fund ephemeral buyer");
  const buyer = Keypair.generate();
  const bUsdc = getAssociatedTokenAddressSync(usdcMint, buyer.publicKey, false, TOKEN_PROGRAM_ID);
  const bOpt = getAssociatedTokenAddressSync(sMint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  {
    const fundTx = new Transaction()
      .add(SystemProgram.transfer({ fromPubkey: D.publicKey, toPubkey: buyer.publicKey, lamports: Math.floor(0.15 * LAMPORTS_PER_SOL) }))
      .add(createAssociatedTokenAccountIdempotentInstruction(D.publicKey, bUsdc, buyer.publicKey, usdcMint, TOKEN_PROGRAM_ID))
      .add(createAssociatedTokenAccountIdempotentInstruction(D.publicKey, bOpt, buyer.publicKey, sMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    sigs.fundBuyer = await provider.sendAndConfirm(fundTx);
  }
  await mintTo(conn, D, usdcMint, bUsdc, D.publicKey, Number(premium.addn(10_000_000).toString()));
  console.log(`  buyer=${buyer.publicKey.toBase58()} SOL=0.15 USDC=$${fmt(await amountOf(conn, bUsdc))}  sig ${sigs.fundBuyer}`);

  // ---- Step 4: post_order(WriterAsk) signed by D ----------------------------
  console.log("\n[4] post_order(WriterAsk)");
  const nonce = new BN(Date.now());
  const waOrder = pda([Buffer.from("resting_order"), sMint.toBuffer(), D.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
  const waEscrow = pda([Buffer.from("resting_order_escrow"), waOrder.toBuffer()]);
  try {
    sigs.postWriterAsk = await program.methods.postOrder(WRITER_ASK, PRICE, QTY, nonce).accountsStrict({
      owner: D.publicKey, sharedVault: aVault, market, vaultMintRecord: sRecord, optionMint: sMint,
      order: waOrder, escrow: waEscrow, protocolState, ownerOptionAccount: dOpt, ownerUsdcAccount: dUsdc,
      usdcMint, transferHookProgram: HOOK, extraAccountMetaList: sEaml, hookState: sHook,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).rpc();
    console.log("  tx:", sigs.postWriterAsk);
  } catch (e: any) {
    console.error("  post_order FAILED — verifying state before any retry");
    console.error("  order exists:", !!(await conn.getAccountInfo(waOrder)), "escrow bal:", (await amountOf(conn, waEscrow)).toString());
    throw e;
  }
  const escrowBal = await amountOf(conn, waEscrow);
  console.log(`  order=${waOrder.toBase58()} escrow USDC=$${fmt(new BN(escrowBal.toString()))} (expected $${fmt(escrowExpected)})`);
  assertEq("post: escrow == cpt×qty", BigInt(escrowExpected.toString()), escrowBal);

  // ---- Step 5: fill_writer_ask signed by buyer ------------------------------
  console.log("\n[5] fill_writer_ask (buyer signs)");
  const buyerProvider = new anchor.AnchorProvider(conn, new anchor.Wallet(buyer), { commitment: "confirmed" });
  const buyerProgram = new Program(idl, buyerProvider) as Program<Opta>;
  const buyerOptPre = await amountOf(conn, bOpt);
  const makerUsdcPre = await amountOf(conn, dUsdc);
  const treasuryPre = await amountOf(conn, treasury);
  try {
    sigs.fillWriterAsk = await buyerProgram.methods.fillWriterAsk(QTY).accountsStrict({
      taker: buyer.publicKey, optionMint: sMint, order: waOrder, maker: D.publicKey, sharedVault: aVault,
      vaultMintRecord: sRecord, escrow: waEscrow, protocolState, treasury,
      takerUsdcAccount: bUsdc, makerUsdcAccount: dUsdc, takerOptionAccount: bOpt,
      writerAskPot, writerAskPotUsdc, writerAskPosition, usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).preInstructions([CU(400_000)]).rpc();
    console.log("  tx:", sigs.fillWriterAsk);
  } catch (e: any) {
    console.error("  fill_writer_ask FAILED — verifying state before any retry");
    console.error("  pot exists:", !!(await conn.getAccountInfo(writerAskPot)), "pot_usdc:", (await amountOf(conn, writerAskPotUsdc)).toString(), "buyer opt:", (await amountOf(conn, bOpt)).toString());
    if (e.logs) console.error(e.logs.slice(-12).join("\n"));
    throw e;
  }

  const buyerOptPost = await amountOf(conn, bOpt);
  const potRec: any = await program.account.writerAskPot.fetch(writerAskPot);
  const potUsdcBal = await amountOf(conn, writerAskPotUsdc);
  const makerUsdcPost = await amountOf(conn, dUsdc);
  const treasuryPost = await amountOf(conn, treasury);
  const vPostFill: any = await program.account.sharedVault.fetch(aVault);

  assertEq("fill: buyer holds qty (mint-on-fill)", BigInt(QTY.toString()), buyerOptPost - buyerOptPre);
  assertEq("fill: pot.total_collateral == cpt×qty", BigInt(escrowExpected.toString()), BigInt(potRec.totalCollateral.toString()));
  assertEq("fill: pot_usdc balance == cpt×qty", BigInt(escrowExpected.toString()), potUsdcBal);
  assertEq("fill: maker USDC += premium−fee", BigInt(counterparty.toString()), makerUsdcPost - makerUsdcPre);
  assertEq("fill: treasury USDC += fee", BigInt(fee.toString()), treasuryPost - treasuryPre);
  assertEq("fill: pool total_collateral untouched (isolation)", poolTc0, BigInt(vPostFill.totalCollateral.toString()));

  // ---- Step 6: SEED-STATE verification (the dead-feed preconditions) ---------
  console.log("\n[6] seed-state verification (dead-feed preconditions)");
  const settlementAcc = await conn.getAccountInfo(settlementPda);
  assertTrue("seed: !is_settled", vPostFill.isSettled === false, `${vPostFill.isSettled}`);
  assertTrue("seed: !voided", vPostFill.voided === false, `${vPostFill.voided}`);
  assertEq("seed: premium_per_share_cumulative == 0", BigInt(0), BigInt(vPostFill.premiumPerShareCumulative.toString()));
  assertTrue("seed: SettlementRecord ABSENT", settlementAcc === null, `${settlementAcc === null ? "absent" : "EXISTS!"}`);
  assertEq("seed: pot == cpt×qty ($158-shape)", BigInt(escrowExpected.toString()), BigInt(potRec.totalCollateral.toString()));
  console.log(`  is_settled=${vPostFill.isSettled} voided=${vPostFill.voided} ppsc=${vPostFill.premiumPerShareCumulative.toString()} settlementRecord=${settlementAcc === null ? "absent" : "EXISTS"} pot=$${fmt(potRec.totalCollateral)}`);

  // ---- Report ---------------------------------------------------------------
  console.log("\n=== ASSERTIONS ===");
  let allPass = true;
  for (const r of rows) { allPass &&= r.pass; console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}  expected=${r.expected} actual=${r.actual}`); }
  console.log("\n=== SIGNATURES ===");
  for (const [k, v] of Object.entries(sigs)) console.log(`  ${k}: ${v}`);
  console.log("\n=== SEED SUMMARY ===");
  console.log(`  vault: ${aVault.toBase58()}`);
  console.log(`  expiry: ${EXPIRY.toString()} (${new Date(EXPIRY.toNumber() * 1000).toISOString()})`);
  console.log(`  VOID-ELIGIBLE AT: ${voidEligibleTs} (${new Date(voidEligibleTs * 1000).toISOString()})`);
  console.log(`  KEEP OPTA_SB_CRANK_DISABLED=1 until at least ${EXPIRY.toNumber() + 360} (expiry+360s), then confirm SettlementRecord still absent before re-enabling.`);
  console.log(allPass ? "\n>>> VOID-SEED: ALL PRECONDITIONS PASS — dead-feed vault seeded" : "\n>>> VOID-SEED: FAILURES — inspect above");
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e?.message ?? e); if (e?.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
