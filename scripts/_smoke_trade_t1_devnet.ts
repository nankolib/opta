// =============================================================================
// scripts/_smoke_trade_t1_devnet.ts — Slice T1 FE-builder live gate (devnet)
// =============================================================================
//
// Exercises the FOUR trade-page v1 ticket builders exactly as the frontend would,
// by importing the pure builders from app/src and driving them with throwaway
// Keypair providers (never the admin key as the actor):
//   Item 1  fillWriterAsk   (app/src/pages/trade/orderFlows.ts)
//   Item 2  postSeriesOrder("writerAsk")
//   Item 3  cancelOrder      (Bid / ResaleAsk / WriterAsk refund paths)
//   Item 4  market-buy kind-branch (OrderTicket routing logic, replicated)
//   Item 5  parseRestingOrder collateralPerContract (154-byte decode)
// + regression: pegFill (fill_vault_peg), post bid, resaleAsk.
// + oracle diff: the FE-built fill_writer_ask tx account list vs the canonical
//   scripts/_smoke_writer_ask_devnet.ts ordering.
//
// D (admin / devnet-USDC mint authority) is used ONLY as a faucet (mint USDC +
// send gas) and to create the fresh series/vault fixture — NOT to sign any of the
// builders under test. All post/fill/cancel calls are signed by W (writer) and
// T (taker) throwaway keypairs.
//
// FRESH series only (expiry = now + 1h). Does NOT touch the July-8 void seed
// vault Ad5zz684isTKpt8QjCUmFxozkL4RLPuGK8aXMe4yy49S or its mint.
//
// Run (WSL):  RPC_URL=<helius-devnet> npx ts-node scripts/_smoke_trade_t1_devnet.ts
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

import { canonicalSeriesMint } from "../tests/shared/settle-pdas";
import { hexFromBytes } from "../app/src/utils/format";
// ---- The FE builders + read layer UNDER TEST (imported, not reimplemented) ---
import {
  postSeriesOrder, fillWriterAsk, cancelOrder, pegFill, fillSeriesOrder,
  type SeriesRef, type FillableOrder,
} from "../app/src/pages/trade/orderFlows";
import { fetchBook, parseRestingOrder } from "../app/src/utils/exchangeData";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const HERMES = process.env.OPTA_HERMES_BASE ?? "https://hermes.pyth.network";
const VOID_SEED_VAULT = "Ad5zz684isTKpt8QjCUmFxozkL4RLPuGK8aXMe4yy49S"; // must stay pristine
const ASSET = "SOL";
const OT_CALL = 0, ES_AMER = 1;
const CALL = { call: {} }, CUSTOM = { custom: {} }, AMER = { american: {} };
const WRITER_ASK = { writerAsk: {} };

const EXPIRY_OFFSET_S = 3600;          // now + 1h — nothing expires mid-test; no settle
const QTY = new BN(1);
const PRICE = new BN(2 * 1_000_000);   // $2/contract writer-ask premium

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
function progFor(conn: Connection, idl: any, kp: Keypair): Program<Opta> {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" });
  return new Program(idl, provider) as Program<Opta>;
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
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const dProgram = progFor(conn, idl, D);

  console.log("=== Slice T1 FE-builder live gate (devnet) ===");
  console.log("RPC:", redact(rpcUrl), "| D(faucet only):", D.publicKey.toBase58());

  // ---- Protocol + market + fresh-series PDAs --------------------------------
  const protocolState = pda([Buffer.from("protocol_v2")]);
  const ps: any = await dProgram.account.protocolState.fetch(protocolState);
  const usdcMint = ps.usdcMint as PublicKey;
  const treasury = ps.treasury as PublicKey;
  const feeBps = ps.feeBps as number;
  const market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
  const mkt: any = await dProgram.account.optionsMarket.fetch(market);
  const feedHex = hexFromBytes(mkt.pythFeedId as number[]);

  const now0 = await clusterNow(conn);
  const EXPIRY = new BN(now0 + EXPIRY_OFFSET_S);
  const spot = await hermesSpotUsd(feedHex);
  const strikeDollars = spot ? Math.max(1, Math.round(spot)) : 180;
  const STRIKE = new BN(strikeDollars * 1_000_000);
  const cpt = STRIKE;                       // required_collateral_per_contract == strike
  const escrowExpected = cpt.mul(QTY);      // strike × qty (writer-ask collateral)
  const poolDeposit = STRIKE.muln(3);       // pool must cover the peg mint (≥ strike free) for the regression pegFill
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

  // SAFETY: never operate on the July-8 void seed vault.
  if (aVault.toBase58() === VOID_SEED_VAULT || sMint.toBase58() === VOID_SEED_VAULT) {
    throw new Error("ABORT: fresh series collided with the void seed vault — refusing to touch it");
  }
  console.log(`fresh spec: SOL CALL $${strikeDollars} American | expiry ${EXPIRY.toString()} (now+${EXPIRY_OFFSET_S}s) | spot≈$${spot?.toFixed(2) ?? "?"}`);
  console.log(`  series mint: ${sMint.toBase58()}\n  amer vault : ${aVault.toBase58()}`);
  console.log(`  cpt=$${fmt(cpt)} escrow(cpt×qty)=$${fmt(escrowExpected)} premium=$${fmt(premium)} fee=$${fmt(fee)} (fee_bps=${feeBps})`);

  // ---- Throwaway actors W (writer) + T (taker) ------------------------------
  const W = Keypair.generate();
  const T = Keypair.generate();
  const wProgram = progFor(conn, idl, W);
  const tProgram = progFor(conn, idl, T);
  const wUsdc = getAssociatedTokenAddressSync(usdcMint, W.publicKey, false, TOKEN_PROGRAM_ID);
  const tUsdc = getAssociatedTokenAddressSync(usdcMint, T.publicKey, false, TOKEN_PROGRAM_ID);
  const wOpt = getAssociatedTokenAddressSync(sMint, W.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const tOpt = getAssociatedTokenAddressSync(sMint, T.publicKey, false, TOKEN_2022_PROGRAM_ID);

  console.log(`\n[fund] W=${W.publicKey.toBase58()} T=${T.publicKey.toBase58()} (D is USDC mint authority)`);
  // Gas + ATAs.
  await dProgram.provider.sendAndConfirm!(new Transaction()
    .add(SystemProgram.transfer({ fromPubkey: D.publicKey, toPubkey: W.publicKey, lamports: Math.floor(0.3 * LAMPORTS_PER_SOL) }))
    .add(SystemProgram.transfer({ fromPubkey: D.publicKey, toPubkey: T.publicKey, lamports: Math.floor(0.3 * LAMPORTS_PER_SOL) }))
    .add(createAssociatedTokenAccountIdempotentInstruction(D.publicKey, wUsdc, W.publicKey, usdcMint, TOKEN_PROGRAM_ID))
    .add(createAssociatedTokenAccountIdempotentInstruction(D.publicKey, tUsdc, T.publicKey, usdcMint, TOKEN_PROGRAM_ID)));
  // USDC: W needs pool + 2× writer-ask collateral; T needs premiums + bid escrow.
  const wFund = escrowExpected.muln(2).add(poolDeposit).addn(5_000_000);
  const tFund = new BN(strikeDollars * 4 * 1_000_000).addn(50_000_000);
  await mintTo(conn, D, usdcMint, wUsdc, D.publicKey, Number(wFund.toString()));
  await mintTo(conn, D, usdcMint, tUsdc, D.publicKey, Number(tFund.toString()));
  console.log(`  W USDC=$${fmt(await amountOf(conn, wUsdc))}  T USDC=$${fmt(await amountOf(conn, tUsdc))}`);

  const ref: SeriesRef = { asset: ASSET, vault: aVault.toBase58(), optionMint: sMint.toBase58() };

  // ---- Fixture: create_series + create_and_deposit (W signs; not a T1 builder)
  console.log("\n[fixture] create_series + create_and_deposit (W)");
  if (!(await conn.getAccountInfo(sMint))) {
    sigs.createSeries = await wProgram.methods.createSeries(STRIKE, EXPIRY, CALL, AMER).accountsStrict({
      caller: W.publicKey, market, protocolState, optionMint: sMint, vaultMintRecord: sRecord,
      transferHookProgram: HOOK, extraAccountMetaList: sEaml, hookState: sHook,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    console.log("  createSeries:", sigs.createSeries);
  } else console.log("  series mint exists — skip");
  const writerPos = pda([Buffer.from("writer_position"), aVault.toBuffer(), W.publicKey.toBuffer()]);
  if (!(await conn.getAccountInfo(aVault))) {
    sigs.createAndDeposit = await wProgram.methods
      .createAndDeposit(STRIKE, EXPIRY, CALL, CUSTOM, usdcMint, 0, AMER, poolDeposit).accountsStrict({
        writer: W.publicKey, market, sharedVault: aVault, vaultUsdcAccount: aVaultUsdc, usdcMint,
        writerPosition: writerPos, writerUsdcAccount: wUsdc, protocolState, epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).preInstructions([CU(400_000)]).rpc();
    console.log("  createAndDeposit:", sigs.createAndDeposit);
  } else console.log("  vault exists — skip");
  const vAfterDeposit: any = await dProgram.account.sharedVault.fetch(aVault);
  const poolTc0 = BigInt(vAfterDeposit.totalCollateral.toString());
  console.log(`  pool total_collateral=$${fmt(vAfterDeposit.totalCollateral)}`);

  // =========================================================================
  // Item 2 — postSeriesOrder("writerAsk") via the FE builder (W signs)
  // =========================================================================
  console.log("\n[Item 2] postSeriesOrder('writerAsk')  (FE builder, W)");
  const nonce1 = new BN(Date.now());
  sigs.postWriterAsk = await postSeriesOrder(wProgram as any, ref, "writerAsk", PRICE, QTY.toNumber(), nonce1);
  const waOrder1 = pda([Buffer.from("resting_order"), sMint.toBuffer(), W.publicKey.toBuffer(), nonce1.toArrayLike(Buffer, "le", 8)]);
  const waEscrow1 = pda([Buffer.from("resting_order_escrow"), waOrder1.toBuffer()]);
  console.log("  tx:", sigs.postWriterAsk, "\n  order:", waOrder1.toBase58());
  assertEq("Item2 post: escrow USDC == cpt×qty", BigInt(escrowExpected.toString()), await amountOf(conn, waEscrow1));

  // ---- Item 5 — parseRestingOrder decodes collateral_per_contract (@146..154)
  const rawWa = await conn.getAccountInfo(waOrder1);
  const parsed = parseRestingOrder(waOrder1, Buffer.from(rawWa!.data));
  assertTrue("Item5 parse: order is 154-byte layout", rawWa!.data.length === 154, `len=${rawWa!.data.length}`);
  assertEq("Item5 parse: collateralPerContract == strike", BigInt(strikeDollars), BigInt(Math.round(parsed!.collateralPerContract)));
  assertEq("Item5 parse: kind == writerAsk", "writerAsk", parsed!.kind);

  // =========================================================================
  // Item 4 — market-buy kind-branch (OrderTicket routing logic, replicated)
  // =========================================================================
  console.log("\n[Item 4] market-buy kind-branch on the live book");
  const book1 = await fetchBook(conn, PROGRAM_ID);
  const asks1 = book1.filter((o) => o.optionMint === sMint.toBase58() && o.kind !== "bid").sort((a, b) => a.price - b.price);
  const chosen = asks1[0];
  const route = chosen?.kind === "writerAsk" ? "fillWriterAsk" : "fillOrder";
  assertTrue("Item4 route: cheapest ask is the writerAsk", chosen?.kind === "writerAsk", `kind=${chosen?.kind}`);
  assertEq("Item4 route: writerAsk → fillWriterAsk", "fillWriterAsk", route);

  // =========================================================================
  // Item 1 — fillWriterAsk via the FE builder (T signs)
  // =========================================================================
  console.log("\n[Item 1] fillWriterAsk  (FE builder, T)");
  const order1: FillableOrder = { pubkey: waOrder1.toBase58(), owner: W.publicKey.toBase58(), optionMint: sMint.toBase58(), vault: aVault.toBase58(), kind: "writerAsk" };
  const writerAskPot = pda([Buffer.from("writer_ask_pot"), sMint.toBuffer()]);
  const writerAskPotUsdc = pda([Buffer.from("writer_ask_pot_usdc"), sMint.toBuffer()]);
  const tOptPre = await amountOf(conn, tOpt);
  const wUsdcPre = await amountOf(conn, wUsdc);
  const treasuryPre = await amountOf(conn, treasury);
  sigs.fillWriterAsk = await fillWriterAsk(tProgram as any, order1, QTY.toNumber());
  console.log("  tx:", sigs.fillWriterAsk);

  const tOptPost = await amountOf(conn, tOpt);
  const potRec: any = await dProgram.account.writerAskPot.fetch(writerAskPot);
  const potUsdcBal = await amountOf(conn, writerAskPotUsdc);
  const wUsdcPost = await amountOf(conn, wUsdc);
  const treasuryPost = await amountOf(conn, treasury);
  const vPostFill: any = await dProgram.account.sharedVault.fetch(aVault);
  assertEq("Item1 fill: taker holds qty (mint-on-fill)", BigInt(QTY.toString()), tOptPost - tOptPre);
  assertEq("Item1 fill: pot.total_collateral == cpt×qty", BigInt(escrowExpected.toString()), BigInt(potRec.totalCollateral.toString()));
  assertEq("Item1 fill: pot_usdc == cpt×qty", BigInt(escrowExpected.toString()), potUsdcBal);
  assertEq("Item1 fill: maker(W) USDC += premium−fee", BigInt(counterparty.toString()), wUsdcPost - wUsdcPre);
  assertEq("Item1 fill: treasury USDC += fee", BigInt(fee.toString()), treasuryPost - treasuryPre);
  assertEq("Item1 fill: pool total_collateral untouched (isolation)", poolTc0, BigInt(vPostFill.totalCollateral.toString()));

  // ---- Oracle diff: FE-built fill_writer_ask account list vs the smoke ordering
  const expectedFillAccts = [
    T.publicKey, sMint, waOrder1, W.publicKey, aVault, sRecord, waEscrow1, protocolState, treasury,
    tUsdc, wUsdc, tOpt, writerAskPot, writerAskPotUsdc,
    pda([Buffer.from("writer_ask_position"), sMint.toBuffer(), W.publicKey.toBuffer()]),
    usdcMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, SystemProgram.programId,
  ].map((k) => k.toBase58());
  const feTx = await conn.getTransaction(sigs.fillWriterAsk, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const msg: any = feTx!.transaction.message;
  const keys: PublicKey[] = (msg.staticAccountKeys ?? msg.accountKeys).map((k: any) => new PublicKey(k));
  const disc = Buffer.from([41, 218, 166, 1, 94, 165, 145, 8]); // fill_writer_ask
  const ixs = msg.compiledInstructions ?? msg.instructions;
  let feFillAccts: string[] = [];
  for (const ix of ixs) {
    const dataBuf = Buffer.from(ix.data, ix.data instanceof Uint8Array ? undefined : "base64");
    const acctIdx = ix.accountKeyIndexes ?? ix.accounts;
    if (dataBuf.length >= 8 && dataBuf.subarray(0, 8).equals(disc)) {
      feFillAccts = acctIdx.map((i: number) => keys[i].toBase58());
      break;
    }
  }
  const diffOk = feFillAccts.length === expectedFillAccts.length && feFillAccts.every((k, i) => k === expectedFillAccts[i]);
  assertTrue("Oracle diff: FE fill_writer_ask account list == smoke ordering (19)", diffOk,
    diffOk ? "19/19 in order" : `fe=${feFillAccts.length} exp=${expectedFillAccts.length} firstMismatch=${feFillAccts.findIndex((k, i) => k !== expectedFillAccts[i])}`);

  // =========================================================================
  // Item 3 — cancelOrder per kind (FE builder)
  // =========================================================================
  console.log("\n[Item 3] cancelOrder — Bid / ResaleAsk / WriterAsk");

  // (a) Bid: T posts a bid, then cancels → USDC refunded.
  const bidNonce = new BN(Date.now() + 1);
  const bidPrice = new BN(1 * 1_000_000);
  await postSeriesOrder(tProgram as any, ref, "bid", bidPrice, QTY.toNumber(), bidNonce);
  const bidOrder = pda([Buffer.from("resting_order"), sMint.toBuffer(), T.publicKey.toBuffer(), bidNonce.toArrayLike(Buffer, "le", 8)]);
  const tUsdcBeforeCancelBid = await amountOf(conn, tUsdc);
  sigs.cancelBid = await cancelOrder(tProgram as any, { pubkey: bidOrder.toBase58(), owner: T.publicKey.toBase58(), optionMint: sMint.toBase58(), vault: aVault.toBase58(), kind: "bid" });
  assertEq("Item3 cancel Bid: USDC refunded (price×qty)", BigInt(bidPrice.mul(QTY).toString()), (await amountOf(conn, tUsdc)) - tUsdcBeforeCancelBid);
  assertTrue("Item3 cancel Bid: order closed", !(await conn.getAccountInfo(bidOrder)), "account gone");

  // (b) ResaleAsk: T holds QTY contracts (from Item 1) → posts resaleAsk, then cancels → contracts refunded.
  const raNonce = new BN(Date.now() + 2);
  await postSeriesOrder(tProgram as any, ref, "resaleAsk", new BN(3 * 1_000_000), QTY.toNumber(), raNonce);
  const raOrder = pda([Buffer.from("resting_order"), sMint.toBuffer(), T.publicKey.toBuffer(), raNonce.toArrayLike(Buffer, "le", 8)]);
  const tOptBeforeCancelRa = await amountOf(conn, tOpt);
  sigs.cancelResale = await cancelOrder(tProgram as any, { pubkey: raOrder.toBase58(), owner: T.publicKey.toBase58(), optionMint: sMint.toBase58(), vault: aVault.toBase58(), kind: "resaleAsk" });
  assertEq("Item3 cancel ResaleAsk: contracts refunded", BigInt(QTY.toString()), (await amountOf(conn, tOpt)) - tOptBeforeCancelRa);
  assertTrue("Item3 cancel ResaleAsk: order closed", !(await conn.getAccountInfo(raOrder)), "account gone");

  // (c) WriterAsk: W posts a 2nd writer-ask, then cancels → USDC collateral refunded.
  const waNonce2 = new BN(Date.now() + 3);
  await postSeriesOrder(wProgram as any, ref, "writerAsk", PRICE, QTY.toNumber(), waNonce2);
  const waOrder2 = pda([Buffer.from("resting_order"), sMint.toBuffer(), W.publicKey.toBuffer(), waNonce2.toArrayLike(Buffer, "le", 8)]);
  const wUsdcBeforeCancelWa = await amountOf(conn, wUsdc);
  sigs.cancelWriterAsk = await cancelOrder(wProgram as any, { pubkey: waOrder2.toBase58(), owner: W.publicKey.toBase58(), optionMint: sMint.toBase58(), vault: aVault.toBase58(), kind: "writerAsk" });
  assertEq("Item3 cancel WriterAsk: USDC collateral refunded (cpt×qty)", BigInt(escrowExpected.toString()), (await amountOf(conn, wUsdc)) - wUsdcBeforeCancelWa);
  assertTrue("Item3 cancel WriterAsk: order closed", !(await conn.getAccountInfo(waOrder2)), "account gone");

  // =========================================================================
  // Regression — unchanged builders: pegFill, bid post, resaleAsk + fill_order
  // =========================================================================
  console.log("\n[regression] pegFill (fill_vault_peg) + post bid + resaleAsk/fill_order");
  // Recorded (non-fatal) so a fixture hiccup never hides the T1 report above.
  try {
    const tOptBeforePeg = await amountOf(conn, tOpt);
    sigs.pegBuy = await pegFill(tProgram as any, ref, QTY.toNumber(), new BN(strikeDollars * 1_000_000)); // generous max premium
    assertEq("Regression pegFill: taker +qty via vault peg", BigInt(QTY.toString()), (await amountOf(conn, tOpt)) - tOptBeforePeg);
  } catch (e: any) { assertTrue("Regression pegFill: taker +qty via vault peg", false, (e?.message ?? String(e)).slice(0, 80)); }

  try {
    const regBidNonce = new BN(Date.now() + 4);
    await postSeriesOrder(tProgram as any, ref, "bid", new BN(1 * 1_000_000), QTY.toNumber(), regBidNonce);
    const regBid = pda([Buffer.from("resting_order"), sMint.toBuffer(), T.publicKey.toBuffer(), regBidNonce.toArrayLike(Buffer, "le", 8)]);
    assertTrue("Regression post bid: order created", !!(await conn.getAccountInfo(regBid)), "bid resting");
    await cancelOrder(tProgram as any, { pubkey: regBid.toBase58(), owner: T.publicKey.toBase58(), optionMint: sMint.toBase58(), vault: aVault.toBase58(), kind: "bid" }).catch(() => {});
  } catch (e: any) { assertTrue("Regression post bid: order created", false, (e?.message ?? String(e)).slice(0, 80)); }

  try {
    // ResaleAsk + fill_order: T posts a resaleAsk on held contracts; W buys via fill_order.
    const regRaNonce = new BN(Date.now() + 5);
    await postSeriesOrder(tProgram as any, ref, "resaleAsk", new BN(2 * 1_000_000), QTY.toNumber(), regRaNonce);
    const regRa = pda([Buffer.from("resting_order"), sMint.toBuffer(), T.publicKey.toBuffer(), regRaNonce.toArrayLike(Buffer, "le", 8)]);
    const wOptPre = await amountOf(conn, wOpt);
    sigs.regFillOrder = await fillSeriesOrder(wProgram as any, { pubkey: regRa.toBase58(), owner: T.publicKey.toBase58(), optionMint: sMint.toBase58(), vault: aVault.toBase58(), kind: "resaleAsk" }, QTY.toNumber());
    assertEq("Regression fill_order: buyer(W) +qty from resaleAsk", BigInt(QTY.toString()), (await amountOf(conn, wOpt)) - wOptPre);
  } catch (e: any) { assertTrue("Regression fill_order: buyer(W) +qty from resaleAsk", false, (e?.message ?? String(e)).slice(0, 80)); }

  // ---- Report --------------------------------------------------------------
  console.log("\n=== ASSERTIONS ===");
  let allPass = true;
  for (const r of rows) { allPass &&= r.pass; console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name}  expected=${r.expected} actual=${r.actual}`); }
  console.log("\n=== SIGNATURES ===");
  for (const [k, v] of Object.entries(sigs)) console.log(`  ${k}: ${v}`);
  console.log(`\n  fresh vault (safe to abandon): ${aVault.toBase58()}`);
  console.log(`  void seed vault (untouched): ${VOID_SEED_VAULT}`);
  console.log(allPass ? "\n>>> SLICE T1 LIVE GATE: ALL ASSERTIONS PASS" : "\n>>> SLICE T1 LIVE GATE: FAILURES — inspect above");
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e?.message ?? e); if (e?.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
