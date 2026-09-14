// =============================================================================
// scripts/smoke-book-devnet.ts — Phase 1 limit-book post-deploy smoke (devnet)
// =============================================================================
//
// Exercises the freshly-deployed RestingOrder book end to end against devnet,
// plus the EUR-mint premium-verbatim regression canary (Verify 2). Fresh vault
// per run (expiry = now + 2h) so every PDA downstream is new — no idempotency
// fights, leaves dust vaults (acceptable on devnet).
//
// Roles (D pays every tx fee + is the devnet-USDC mint authority):
//   D  deployer/operator — writer (create vault, deposit, mint), funder.
//   A  seller/holder (scripts/.devnet-writer-keypair.json) — purchases contracts,
//      posts a ResaleAsk, cancels the remainder, and is the TAKER that fills C's bid.
//   B  taker (fresh) — partially fills A's ask.
//   C  bidder (fresh) — posts a Bid; receives contracts when A fills it (A funds
//      C's option ATA — the taker-funded idempotent pre-create nuance).
//
// Steps:
//   2  EUR mint → assert VaultMint.premium_per_contract stored verbatim  [VERIFY 2]
//   3b post_order ResaleAsk (A) → assert RestingOrder fields + escrow balance
//   3c partial fill_order (B) → assert decrement + maker proceeds + fee→treasury + OrderFilled log
//   3d cancel_order remainder (A) → assert escrow returned + both PDAs closed + rent→owner
//   3e post_order Bid (C) + fill (A delivers; A funds C's ATA) → assert USDC legs + closes
//   3f sweep: NOT smoked (needs a real expiry wait) — covered by bankrun.
//
// Run: RPC_URL=<helius> npx ts-node scripts/smoke-book-devnet.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection, PublicKey, Keypair, SystemProgram, ComputeBudgetProgram,
  Transaction, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, mintTo,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const ASSET = "SOL";

const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const redact = (s: string) => s.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const sigs: Record<string, string> = {};
let allPass = true;
function check(name: string, pass: boolean, detail = "") {
  if (!pass) allPass = false;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ` (${detail})` : ""}`);
}

async function readAmount(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length < 72) return BigInt(0);
  return Buffer.from(info.data.slice(64, 72)).readBigUInt64LE(0);
}

async function main() {
  const rpcUrl = process.env.RPC_URL ?? process.env.OPTA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, { commitment: "confirmed", confirmTransactionInitialTimeout: 90_000 });

  const opPath = process.env.OPTA_KEYPAIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config/solana/id.json");
  const D = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(opPath, "utf-8"))));
  const aPath = path.join(__dirname, ".devnet-writer-keypair.json");
  if (!fs.existsSync(aPath)) { console.error(`FATAL: writer keypair not found at ${aPath}`); process.exit(1); }
  const A = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(aPath, "utf-8"))));
  const B = Keypair.generate();
  const C = Keypair.generate();

  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(D), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const program = new Program(idl, provider) as Program<Opta>;

  console.log("=== smoke-book-devnet ===");
  console.log("RPC:", redact(rpcUrl));
  console.log("D (writer/operator):", D.publicKey.toBase58());
  console.log("A (seller/holder)  :", A.publicKey.toBase58());
  console.log("B (taker)          :", B.publicKey.toBase58());
  console.log("C (bidder)         :", C.publicKey.toBase58());

  // ---- Protocol state -------------------------------------------------------
  const protocolStatePda = pda([Buffer.from("protocol_v2")]);
  const ps = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = ps.usdcMint as PublicKey;
  const treasury = ps.treasury as PublicKey;
  const feeBps = ps.feeBps as number;
  const marketPda = pda([Buffer.from("market"), Buffer.from(ASSET)]);
  const market = await program.account.optionsMarket.fetch(marketPda);
  const volOracle = pda([Buffer.from("vol_oracle"), Buffer.from(market.pythFeedId as number[])]);
  console.log(`protocol: usdc=${usdcMint.toBase58()} treasury=${treasury.toBase58()} fee_bps=${feeBps}`);

  // ---- Funding helpers ------------------------------------------------------
  async function fundSol(to: PublicKey, sol: number) {
    if ((await conn.getBalance(to)) >= sol * LAMPORTS_PER_SOL) return;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: D.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
    await provider.sendAndConfirm(tx);
  }
  async function ensureUsdc(owner: PublicKey, fundUsd: number): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(usdcMint, owner, false, TOKEN_PROGRAM_ID);
    if (!(await conn.getAccountInfo(ata))) {
      await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
        D.publicKey, ata, owner, usdcMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)));
    }
    if (Number(await readAmount(conn, ata)) < fundUsd * 1_000_000) {
      await mintTo(conn, D, usdcMint, ata, D.publicKey, fundUsd * 1_000_000);
    }
    return ata;
  }
  const optAta = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

  console.log("\n[fund] D/A/B/C SOL + USDC ...");
  await fundSol(A.publicKey, 0.3); await fundSol(B.publicKey, 0.2); await fundSol(C.publicKey, 0.2);
  const dUsdc = await ensureUsdc(D.publicKey, 2500);
  const aUsdc = await ensureUsdc(A.publicKey, 100);
  const bUsdc = await ensureUsdc(B.publicKey, 100);
  const cUsdc = await ensureUsdc(C.publicKey, 100);

  // ---- Create EUR vault → deposit → mint (Verify 2) -------------------------
  const strike = usdc(10);
  const expiry = new BN(Math.floor(Date.now() / 1000) + 7200);
  const createdAt = new BN(Math.floor(Date.now() / 1000));
  const PREMIUM = usdc(1); // EUR: stored verbatim

  const vault = pda([Buffer.from("shared_vault"), marketPda.toBuffer(), strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
  const vaultUsdc = pda([Buffer.from("vault_usdc"), vault.toBuffer()]);
  const writerPos = pda([Buffer.from("writer_position"), vault.toBuffer(), D.publicKey.toBuffer()]);
  const optionMint = pda([Buffer.from("vault_option_mint"), vault.toBuffer(), D.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)]);
  const purchaseEscrow = pda([Buffer.from("vault_purchase_escrow"), vault.toBuffer(), D.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)]);
  const vaultMintRecord = pda([Buffer.from("vault_mint_record"), optionMint.toBuffer()]);
  const extraMetas = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), optionMint.toBuffer()], HOOK_PROGRAM_ID)[0];
  const hookState = PublicKey.findProgramAddressSync([Buffer.from("hook-state"), optionMint.toBuffer()], HOOK_PROGRAM_ID)[0];

  console.log("\n[2] create EUR vault → deposit → mint (Verify 2: premium verbatim)");
  sigs.createVault = await program.methods.createSharedVault(strike, expiry, { call: {} }, { custom: {} }, usdcMint, 0, { european: {} })
    .accountsStrict({ creator: D.publicKey, market: marketPda, sharedVault: vault, vaultUsdcAccount: vaultUsdc, usdcMint, protocolState: protocolStatePda, epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .preInstructions([CU(400_000)]).rpc();
  sigs.deposit = await program.methods.depositToVault(usdc(2000)).accountsStrict({ writer: D.publicKey, sharedVault: vault, writerPosition: writerPos, writerUsdcAccount: dUsdc, vaultUsdcAccount: vaultUsdc, protocolState: protocolStatePda, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
  sigs.mint = await program.methods.mintFromVault(new BN(5), PREMIUM, createdAt).accountsStrict({
    writer: D.publicKey, sharedVault: vault, writerPosition: writerPos, market: marketPda, volOracle, protocolState: protocolStatePda,
    optionMint, purchaseEscrow, vaultMintRecord, transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState,
    systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
  }).preInstructions([CU(800_000)]).rpc();
  const vm = await program.account.vaultMint.fetch(vaultMintRecord);
  check("Verify 2 — EUR premium stored verbatim", (vm.premiumPerContract as BN).eq(PREMIUM), `stored=${(vm.premiumPerContract as BN).toString()} expected=${PREMIUM.toString()}`);
  console.log(`  optionMint=${optionMint.toBase58()} mint tx=${sigs.mint}`);

  // ---- A purchases 5 contracts ---------------------------------------------
  const aOpt = optAta(A.publicKey, optionMint);
  await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(D.publicKey, aOpt, A.publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)));
  sigs.purchase = await program.methods.purchaseFromVault(new BN(5), usdc(100)).accountsStrict({
    buyer: A.publicKey, sharedVault: vault, writerPosition: writerPos, vaultMintRecord, protocolState: protocolStatePda, market: marketPda,
    optionMint, purchaseEscrow, buyerOptionAccount: aOpt, buyerUsdcAccount: aUsdc, vaultUsdcAccount: vaultUsdc, treasury,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState, systemProgram: SystemProgram.programId,
  }).preInstructions([CU(400_000)]).signers([A]).rpc();
  check("A holds 5 contracts after purchase", (await readAmount(conn, aOpt)) === BigInt(5), `bal=${await readAmount(conn, aOpt)}`);

  // ---- 3b: post_order ResaleAsk (A), qty 4 @ $2 -----------------------------
  console.log("\n[3b] post_order ResaleAsk (A) qty 4 @ $2");
  const askNonce = new BN(1);
  const askOrder = pda([Buffer.from("resting_order"), optionMint.toBuffer(), A.publicKey.toBuffer(), askNonce.toArrayLike(Buffer, "le", 8)]);
  const askEscrow = pda([Buffer.from("resting_order_escrow"), askOrder.toBuffer()]);
  const ASK_PRICE = usdc(2);
  sigs.postAsk = await program.methods.postOrder({ resaleAsk: {} }, ASK_PRICE, new BN(4), askNonce).accountsStrict({
    owner: A.publicKey, sharedVault: vault, market: marketPda, vaultMintRecord, optionMint, order: askOrder, escrow: askEscrow, protocolState: protocolStatePda,
    ownerOptionAccount: aOpt, ownerUsdcAccount: aUsdc, usdcMint, transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
  }).preInstructions([CU(400_000)]).signers([A]).rpc();
  const ao = await program.account.restingOrder.fetch(askOrder);
  check("ask RestingOrder fields", (ao.owner as PublicKey).equals(A.publicKey) && (ao.quantityRemaining as BN).eqn(4) && (ao.pricePerContract as BN).eq(ASK_PRICE) && "resaleAsk" in (ao.kind as any), `qty=${(ao.quantityRemaining as BN).toString()}`);
  check("ask escrow holds 4 contracts", (await readAmount(conn, askEscrow)) === BigInt(4), `bal=${await readAmount(conn, askEscrow)}`);

  // ---- 3c: partial fill (B) qty 1 -------------------------------------------
  console.log("\n[3c] partial fill_order (B) qty 1");
  const bOpt = optAta(B.publicKey, optionMint);
  const preSellerUsdc = await readAmount(conn, aUsdc);
  const preTre = await readAmount(conn, treasury);
  const fillAtaIx = createAssociatedTokenAccountIdempotentInstruction(D.publicKey, bOpt, B.publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  sigs.fillAsk = await program.methods.fillOrder(new BN(1)).accountsStrict({
    taker: B.publicKey, optionMint, order: askOrder, maker: A.publicKey, sharedVault: vault, escrow: askEscrow, protocolState: protocolStatePda, treasury,
    takerUsdcAccount: bUsdc, makerUsdcAccount: aUsdc, takerOptionAccount: bOpt, makerOptionAccount: aOpt,
    transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).preInstructions([CU(400_000), fillAtaIx]).signers([B]).rpc();
  const fee1 = ASK_PRICE.muln(1).muln(feeBps).divn(10_000);
  const ao2 = await program.account.restingOrder.fetch(askOrder);
  check("ask remaining decremented to 3", (ao2.quantityRemaining as BN).eqn(3));
  check("B received 1 contract", (await readAmount(conn, bOpt)) === BigInt(1));
  check("maker (A) USDC += total − fee", (await readAmount(conn, aUsdc)) - preSellerUsdc === BigInt(ASK_PRICE.sub(fee1).toString()), `delta=${(await readAmount(conn, aUsdc)) - preSellerUsdc}`);
  check("fee → treasury", (await readAmount(conn, treasury)) - preTre === BigInt(fee1.toString()), `delta=${(await readAmount(conn, treasury)) - preTre}`);
  const ftx = await conn.getTransaction(sigs.fillAsk, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  let sawFilled = false;
  for (const l of ftx?.meta?.logMessages ?? []) {
    if (!l.startsWith("Program data: ")) continue;
    try { if ((program.coder as any).events.decode(l.slice(14))?.name === "orderFilled") sawFilled = true; } catch {}
  }
  check("OrderFilled event in tx logs", sawFilled);

  // ---- 3d: cancel remainder (A) ---------------------------------------------
  console.log("\n[3d] cancel_order remainder (A)");
  const preAopt = await readAmount(conn, aOpt);
  const preArent = await conn.getBalance(A.publicKey);
  sigs.cancelAsk = await program.methods.cancelOrder().accountsStrict({
    owner: A.publicKey, optionMint, order: askOrder, escrow: askEscrow, protocolState: protocolStatePda, ownerOptionAccount: aOpt, ownerUsdcAccount: aUsdc,
    transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).preInstructions([CU(400_000)]).signers([A]).rpc();
  check("cancel returned 3 contracts to A", (await readAmount(conn, aOpt)) - preAopt === BigInt(3), `delta=${(await readAmount(conn, aOpt)) - preAopt}`);
  check("ask order PDA closed", (await conn.getAccountInfo(askOrder)) === null);
  check("ask escrow PDA closed", (await conn.getAccountInfo(askEscrow)) === null);
  check("rent → owner A (SOL increased)", (await conn.getBalance(A.publicKey)) > preArent);

  // ---- 3e: post Bid (C) + fill (A delivers; A funds C's ATA) -----------------
  console.log("\n[3e] post_order Bid (C) qty 2 @ $1 + fill (A delivers)");
  const bidNonce = new BN(1);
  const bidOrder = pda([Buffer.from("resting_order"), optionMint.toBuffer(), C.publicKey.toBuffer(), bidNonce.toArrayLike(Buffer, "le", 8)]);
  const bidEscrow = pda([Buffer.from("resting_order_escrow"), bidOrder.toBuffer()]);
  const BID_PRICE = usdc(1);
  const cOpt = optAta(C.publicKey, optionMint);
  sigs.postBid = await program.methods.postOrder({ bid: {} }, BID_PRICE, new BN(2), bidNonce).accountsStrict({
    owner: C.publicKey, sharedVault: vault, market: marketPda, vaultMintRecord, optionMint, order: bidOrder, escrow: bidEscrow, protocolState: protocolStatePda,
    ownerOptionAccount: cOpt /*unused on bid*/, ownerUsdcAccount: cUsdc, usdcMint, transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
  }).preInstructions([CU(400_000)]).signers([C]).rpc();
  check("bid escrow holds price×qty USDC", (await readAmount(conn, bidEscrow)) === BigInt(BID_PRICE.muln(2).toString()), `bal=${await readAmount(conn, bidEscrow)}`);

  const preTakerUsdc = await readAmount(conn, aUsdc);
  const preTre2 = await readAmount(conn, treasury);
  // Taker (A) funds the bidder's (C) option ATA — idempotent create, payer = A.
  const bidderAtaIx = createAssociatedTokenAccountIdempotentInstruction(A.publicKey, cOpt, C.publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  sigs.fillBid = await program.methods.fillOrder(new BN(2)).accountsStrict({
    taker: A.publicKey, optionMint, order: bidOrder, maker: C.publicKey, sharedVault: vault, escrow: bidEscrow, protocolState: protocolStatePda, treasury,
    takerUsdcAccount: aUsdc, makerUsdcAccount: cUsdc, takerOptionAccount: aOpt, makerOptionAccount: cOpt,
    transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).preInstructions([CU(400_000), bidderAtaIx]).signers([A]).rpc();
  const total2 = BID_PRICE.muln(2);
  const fee2 = total2.muln(feeBps).divn(10_000);
  check("bidder C received 2 contracts", (await readAmount(conn, cOpt)) === BigInt(2), `bal=${await readAmount(conn, cOpt)}`);
  check("taker (A) USDC += total − fee", (await readAmount(conn, aUsdc)) - preTakerUsdc === BigInt(total2.sub(fee2).toString()), `delta=${(await readAmount(conn, aUsdc)) - preTakerUsdc}`);
  check("fee → treasury", (await readAmount(conn, treasury)) - preTre2 === BigInt(fee2.toString()), `delta=${(await readAmount(conn, treasury)) - preTre2}`);
  check("bid order PDA closed on full fill", (await conn.getAccountInfo(bidOrder)) === null);
  check("bid escrow PDA closed on full fill", (await conn.getAccountInfo(bidEscrow)) === null);

  // ---- 3f: sweep NOT smoked (needs real expiry wait; covered by bankrun) -----
  console.log("\n[3f] sweep_expired_orders — NOT smoked on devnet (needs real expiry wait); covered by bankrun.");

  console.log("\n=== tx signatures ===");
  for (const [k, v] of Object.entries(sigs)) console.log(`  ${k}: ${v}`);
  console.log(`\n=== ${allPass ? "ALL ASSERTIONS PASSED" : "FAILURES PRESENT"} ===`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
