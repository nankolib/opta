// =============================================================================
// scripts/_smoke_writer_ask_devnet.ts — FIRST live writer-ask settle proof (devnet)
// =============================================================================
//
// Proves the writer-ask arc end-to-end on-chain for the first time:
//   create_series → create_and_deposit (mixed pool) → post_order(WriterAsk)
//   → fill_writer_ask (mint-on-fill to a fresh buyer) → settle_vault sweeps the pot.
//
// SOL (Pyth, price-resolvable — avoids the equity-404 dead feeds), CUSTOM vault,
// short synthetic expiry (clusterNow + 180s), all gates on CLUSTER time.
//
// Signers: D (deployer / devnet-USDC mint authority) = writer + settle caller;
// a fresh ephemeral buyer = taker (funded by D). No admin-only step.
//
// Anti-blind-retry: idempotent create guards; on any tx failure we fetch the
// relevant on-chain state and STOP (no blind resend). settle tolerates the crank
// winning the race — we assert on final state, not on who settled.
//
// Run (WSL):  RPC_URL=<helius> npx ts-node scripts/_smoke_writer_ask_devnet.ts
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
import { settleAllForExpiry } from "../app/src/utils/pythPullPost";
import { hexFromBytes } from "../app/src/utils/format";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const HERMES = process.env.OPTA_HERMES_BASE ?? "https://hermes.pyth.network";
const ASSET = "SOL";
const OT_CALL = 0, ES_AMER = 1;
const CALL = { call: {} }, CUSTOM = { custom: {} }, AMER = { american: {} };
const WRITER_ASK = { writerAsk: {} };

// ---- Locked smoke params ----------------------------------------------------
const EXPIRY_OFFSET_S = 180;      // clusterNow + 180 (margin for tx landing)
const SETTLE_AFTER_S = 75;        // poll to expiry + 75 before settling
const DEPOSIT = new BN(10 * 1_000_000);   // $10 nominal pool (mixed vault → D2a merge)
const QTY = new BN(2);            // writer-ask contracts
const PRICE = new BN(2 * 1_000_000);      // $2 / contract (maker-set limit premium)

const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const fmt = (b: BN | bigint) => (Number(b.toString()) / 1e6).toFixed(6);
const redact = (s: string) => s.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
const pda = (s: (Buffer | Uint8Array)[], pid = PROGRAM_ID) => PublicKey.findProgramAddressSync(s, pid)[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sigs: Record<string, string> = {};

async function amountOf(conn: Connection, ata: PublicKey): Promise<bigint> {
  const i = await conn.getAccountInfo(ata);
  if (!i || i.data.length < 72) return BigInt(0);
  return Buffer.from(i.data.slice(64, 72)).readBigUInt64LE(0);
}
async function clusterNow(conn: Connection): Promise<number> {
  return (await conn.getBlockTime(await conn.getSlot()))!;
}
async function hermesSpotUsd(feedHex: string): Promise<number | null> {
  try {
    const r = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=0x${feedHex}`);
    const j: any = await r.json();
    const p = j.parsed?.[0]?.price;
    return p ? Number(p.price) * Math.pow(10, p.expo) : null;
  } catch { return null; }
}

// Assertion table
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

  console.log("=== writer-ask live smoke (devnet) ===");
  console.log("RPC:", redact(rpcUrl), "| D:", D.publicKey.toBase58());

  // ---- Protocol + market + spec PDAs ----------------------------------------
  const protocolState = pda([Buffer.from("protocol_v2")]);
  const ps: any = await program.account.protocolState.fetch(protocolState);
  const usdcMint = ps.usdcMint as PublicKey;
  const treasury = ps.treasury as PublicKey;
  const feeBps = ps.feeBps as number;
  const market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
  const mkt: any = await program.account.optionsMarket.fetch(market);
  const feedHex = hexFromBytes(mkt.pythFeedId as number[]);

  const now0 = await clusterNow(conn);
  const EXPIRY = new BN(now0 + EXPIRY_OFFSET_S);
  const spot = await hermesSpotUsd(feedHex);
  const strikeDollars = spot ? Math.max(1, Math.round(spot)) : 78; // near-spot; fallback $78
  const STRIKE = new BN(strikeDollars * 1_000_000);
  const cpt = STRIKE;                         // required_collateral_per_contract == strike
  const escrowExpected = cpt.mul(QTY);        // strike × qty
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
  const dOpt = getAssociatedTokenAddressSync(sMint, D.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dUsdc = getAssociatedTokenAddressSync(usdcMint, D.publicKey, false, TOKEN_PROGRAM_ID);
  const { writerAskPot, writerAskPotUsdc } = settlePotPdas(PROGRAM_ID, sMint);
  const writerAskPosition = pda([Buffer.from("writer_ask_position"), sMint.toBuffer(), D.publicKey.toBuffer()]);

  console.log(`spec: SOL CALL $${strikeDollars} American | expiry ${EXPIRY.toString()} (now+${EXPIRY_OFFSET_S}s) | spot≈$${spot?.toFixed(2) ?? "?"}`);
  console.log(`  series mint: ${sMint.toBase58()}`);
  console.log(`  amer vault : ${aVault.toBase58()}`);
  console.log(`  cpt=$${fmt(cpt)} escrowExpected=$${fmt(escrowExpected)} premium=$${fmt(premium)} fee=$${fmt(fee)} counterparty=$${fmt(counterparty)} (fee_bps=${feeBps})`);

  // D USDC headroom (D is mint authority) — needs escrowExpected + slack.
  await mintTo(conn, D, usdcMint, dUsdc, D.publicKey, Number(escrowExpected.addn(1_000_000).toString())).catch(() => {});
  // D series ATA (unused by WriterAsk arm but passed as owner_option_account).
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
    const pot = await conn.getAccountInfo(writerAskPot);
    console.error("  pot exists:", !!pot, "pot_usdc bal:", (await amountOf(conn, writerAskPotUsdc)).toString(), "buyer opt:", (await amountOf(conn, bOpt)).toString());
    if (e.logs) console.error(e.logs.slice(-12).join("\n"));
    throw e;
  }

  // Post-fill assertions (mirror writer-ask-fill bankrun checks)
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
  console.log(`  buyer opt +${buyerOptPost - buyerOptPre} | pot=$${fmt(potRec.totalCollateral)} | maker +$${fmt(new BN((makerUsdcPost - makerUsdcPre).toString()))} | treasury +$${fmt(new BN((treasuryPost - treasuryPre).toString()))}`);

  // Pre-settle snapshot for the merge math.
  const tsPre = BigInt(vPostFill.totalShares.toString());
  const tcPre = BigInt(vPostFill.totalCollateral.toString());
  const swept = BigInt(escrowExpected.toString());
  const equivExpected = swept === BigInt(0) ? BigInt(0) : (tcPre === BigInt(0) ? swept : (swept * tsPre) / tcPre);
  const vaultUsdcPre = await amountOf(conn, aVaultUsdc);
  const potUsdcPre = await amountOf(conn, writerAskPotUsdc);

  // ---- Step 6: poll to expiry+75, then settle (race-safe) -------------------
  console.log(`\n[6] poll to expiry+${SETTLE_AFTER_S}, then settle`);
  while ((await clusterNow(conn)) < EXPIRY.toNumber() + SETTLE_AFTER_S) {
    const rem = EXPIRY.toNumber() + SETTLE_AFTER_S - (await clusterNow(conn));
    console.log(`  waiting ${rem}s ...`);
    await sleep(Math.min(rem, 20) * 1000);
  }
  const preSettled: any = await program.account.sharedVault.fetch(aVault);
  if (preSettled.isSettled) {
    console.log("  vault ALREADY settled (crank won the race) — asserting on final state");
  } else {
    try {
      const r = await settleAllForExpiry(program, provider.wallet as any, ASSET, EXPIRY.toNumber(), feedHex, [aVault], HERMES);
      sigs.settle = r.atomicSig ?? "(resumed/crank)";
      console.log("  settle:", JSON.stringify({ atomicSig: r.atomicSig, vaultSigs: (r as any).vaultSigs?.length, vaultsFinalized: (r as any).vaultsFinalized }));
    } catch (e: any) {
      const chk: any = await program.account.sharedVault.fetch(aVault);
      if (chk.isSettled) console.log("  settle threw but vault IS settled (race) — proceeding");
      else { console.error("  settle FAILED and vault NOT settled:", e.message ?? e); throw e; }
    }
  }

  // ---- Step 7: post-settle assertions ---------------------------------------
  console.log("\n[7] post-settle assertions");
  const vFinal: any = await program.account.sharedVault.fetch(aVault);
  const vaultUsdcPost = await amountOf(conn, aVaultUsdc);
  const potUsdcPost = await amountOf(conn, writerAskPotUsdc);

  assertTrue("settle: is_settled", vFinal.isSettled === true, `${vFinal.isSettled}`);
  assertEq("settle: writer_ask_collateral_swept == cpt×qty", swept, BigInt(vFinal.writerAskCollateralSwept.toString()));
  assertEq("settle: writer_ask_equiv_shares == expected merge", equivExpected, BigInt(vFinal.writerAskEquivShares.toString()));
  assertEq("settle: total_shares grew by equiv", tsPre + equivExpected, BigInt(vFinal.totalShares.toString()));
  assertEq("settle: pot_usdc drained to 0", BigInt(0), potUsdcPost);
  assertEq("settle: vault_usdc += swept", vaultUsdcPre + swept, vaultUsdcPost);
  console.log(`  pot_usdc ${potUsdcPre}→${potUsdcPost} | vault_usdc ${vaultUsdcPre}→${vaultUsdcPost} (+${vaultUsdcPost - vaultUsdcPre}) | total_shares ${tsPre}→${vFinal.totalShares.toString()} | equiv=${vFinal.writerAskEquivShares.toString()}`);

  // ---- Report ---------------------------------------------------------------
  console.log("\n=== ASSERTIONS ===");
  let allPass = true;
  for (const r of rows) { allPass &&= r.pass; console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}  expected=${r.expected} actual=${r.actual}`); }
  console.log("\n=== SIGNATURES ===");
  for (const [k, v] of Object.entries(sigs)) console.log(`  ${k}: ${v}`);
  console.log(allPass ? "\n>>> WRITER-ASK LIVE SMOKE: ALL ASSERTIONS PASS" : "\n>>> WRITER-ASK LIVE SMOKE: FAILURES — inspect above");
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e?.message ?? e); if (e?.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
