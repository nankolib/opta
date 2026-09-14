// =============================================================================
// scripts/_smoke_epoch_series_write.ts — epoch-write→series rewire live gate
// =============================================================================
// Drives the new epoch-write path (create_series + 0-pool create_shared_vault +
// post_order WriterAsk) via the SAME FE builders useWriteSubmit now calls, with
// throwaway wallets on a FRESH OFF-GRID spec. Then: buy (fungible mint to buyer),
// 2nd-writer fungibility (series/vault reused), cancel (USDC refund).
// D (admin) is faucet/USDC-mint ONLY. Void seed vault Ad5zz… never touched.
//   RPC_URL=<helius> TS_NODE_COMPILER_OPTIONS='{"target":"es2020","lib":["es2020","dom"]}' \
//     NODE_OPTIONS=--dns-result-order=ipv4first npx ts-node scripts/_smoke_epoch_series_write.ts
// =============================================================================
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection, PublicKey, Keypair, SystemProgram, ComputeBudgetProgram, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, mintTo,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";
import {
  buildCreateSeriesIx, buildCreateSharedVaultIx, postSeriesOrder, fillWriterAsk, cancelOrder,
  type SeriesRef, type FillableOrder,
} from "../app/src/pages/trade/orderFlows";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const VOID_SEED_VAULT = "Ad5zz684isTKpt8QjCUmFxozkL4RLPuGK8aXMe4yy49S";
const ASSET = "SOL", OT_CALL = 0;
const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const pda = (s: (Buffer | Uint8Array)[], pid = PROGRAM_ID) => PublicKey.findProgramAddressSync(s, pid)[0];
const fmt = (b: BN | bigint) => (Number(b.toString()) / 1e6).toFixed(6);
const redact = (s: string) => s.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
const rows: { name: string; ok: boolean; detail: string }[] = [];
const A = (name: string, ok: boolean, detail = "") => rows.push({ name, ok, detail });

async function amountOf(conn: Connection, ata: PublicKey): Promise<bigint> {
  const i = await conn.getAccountInfo(ata); if (!i || i.data.length < 72) return 0n;
  return Buffer.from(i.data.slice(64, 72)).readBigUInt64LE(0);
}
function nextFriday8(afterSec: number): number {
  const d = new Date(afterSec * 1000); d.setUTCHours(8, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
  let ts = Math.floor(d.getTime() / 1000);
  while (ts <= afterSec) ts += 7 * 86400;
  return ts;
}
function progFor(conn: Connection, idl: any, kp: Keypair): Program<Opta> {
  return new Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" })) as Program<Opta>;
}
const canonMint = (market: PublicKey, sLE: Buffer, eLE: Buffer, optIdx: number) =>
  pda([Buffer.from("vault_option_mint"), market.toBuffer(), sLE, eLE, Buffer.from([optIdx]), Buffer.from([1])]);
const amerVault = (market: PublicKey, sLE: Buffer, eLE: Buffer, optIdx: number) =>
  pda([Buffer.from("shared_vault_american"), market.toBuffer(), sLE, eLE, Buffer.from([optIdx])]);

async function main() {
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, { commitment: "confirmed", confirmTransactionInitialTimeout: 90_000 });
  const D = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(
    process.env.OPTA_KEYPAIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config/solana/id.json"), "utf-8"))));
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const dProgram = progFor(conn, idl, D);
  console.log("=== epoch-write→series live gate ===\nRPC:", redact(rpcUrl), "| D(faucet):", D.publicKey.toBase58());

  const protocolState = pda([Buffer.from("protocol_v2")]);
  const ps: any = await dProgram.account.protocolState.fetch(protocolState);
  const usdcMint = ps.usdcMint as PublicKey;
  const market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
  const epochConfig = pda([Buffer.from("epoch_config")]);

  const now = Math.floor(Date.now() / 1000);
  const E1 = nextFriday8(now + 2 * 86400);       // valid epoch slot, > min-duration
  const E2 = E1 + 7 * 86400;                       // ladder: next Friday
  const STRIKE_D = 83;                             // OFF-GRID (SOL step=10) → no collision
  const STRIKE = new BN(STRIKE_D * 1_000_000);
  const s1LE = STRIKE.toArrayLike(Buffer, "le", 8);
  const e1LE = new BN(E1).toArrayLike(Buffer, "le", 8), e2LE = new BN(E2).toArrayLike(Buffer, "le", 8);
  const QTY = 1, PRICE = new BN(2_000_000);        // $2 ask
  const collateral = STRIKE.muln(QTY);             // strike × qty = $83 writer-ask escrow

  const mint1 = canonMint(market, s1LE, e1LE, OT_CALL), vault1 = amerVault(market, s1LE, e1LE, OT_CALL);
  const rec1 = pda([Buffer.from("vault_mint_record"), mint1.toBuffer()]);
  const mint2 = canonMint(market, s1LE, e2LE, OT_CALL), vault2 = amerVault(market, s1LE, e2LE, OT_CALL);
  if ([vault1, mint1, vault2, mint2].some((k) => k.toBase58() === VOID_SEED_VAULT)) throw new Error("ABORT: void vault collision");
  console.log(`fresh: SOL $${STRIKE_D} CALL Amer | E1=${E1}(${new Date(E1 * 1e3).toISOString().slice(0, 10)}) E2=${E2} | mint1=${mint1.toBase58().slice(0, 8)} vault1=${vault1.toBase58().slice(0, 8)}`);

  // ---- throwaway actors (D funds SOL + USDC) --------------------------------
  const W1 = Keypair.generate(), T = Keypair.generate(), W2 = Keypair.generate();
  const w1p = progFor(conn, idl, W1), tp = progFor(conn, idl, T), w2p = progFor(conn, idl, W2);
  const ataOf = (owner: PublicKey) => getAssociatedTokenAddressSync(usdcMint, owner, false, TOKEN_PROGRAM_ID);
  const fundTx = new Transaction();
  for (const k of [W1, T, W2]) {
    fundTx.add(SystemProgram.transfer({ fromPubkey: D.publicKey, toPubkey: k.publicKey, lamports: Math.floor(0.35 * LAMPORTS_PER_SOL) }));
    fundTx.add(createAssociatedTokenAccountIdempotentInstruction(D.publicKey, ataOf(k.publicKey), k.publicKey, usdcMint, TOKEN_PROGRAM_ID));
  }
  await dProgram.provider.sendAndConfirm!(fundTx);
  for (const k of [W1, T, W2]) await mintTo(conn, D, usdcMint, ataOf(k.publicKey), D.publicKey, 300 * 1_000_000);
  console.log(`funded W1/T/W2 (0.35 SOL + $300 each)`);

  const ref1: SeriesRef = { asset: ASSET, vault: vault1.toBase58(), optionMint: mint1.toBase58() };
  const optType = { call: {} };

  // ========================================================================
  // 1. W1 write E1: ensure infra (create_series + 0-pool vault) → post WriterAsk
  // ========================================================================
  console.log("\n[1] W1 write E1 — infra + WriterAsk");
  const seriesIx = await buildCreateSeriesIx(w1p as any, W1.publicKey, market, protocolState, mint1, rec1, STRIKE, new BN(E1), optType);
  const vaultIx = await buildCreateSharedVaultIx(w1p as any, W1.publicKey, market, protocolState, vault1, usdcMint, epochConfig, STRIKE, new BN(E1), optType);
  await w1p.provider.sendAndConfirm!(new Transaction().add(CU(600_000), seriesIx, vaultIx));
  A("1a create_series → canonical mint exists", !!(await conn.getAccountInfo(mint1)), mint1.toBase58());
  const rec1acc: any = await dProgram.account.vaultMint.fetch(rec1).catch(() => null);
  A("1b series record: writer==default (canonical)", !!rec1acc && (rec1acc.writer as PublicKey).equals(PublicKey.default), `writer=${rec1acc?.writer?.toBase58?.().slice(0, 8)}`);
  const v1: any = await dProgram.account.sharedVault.fetch(vault1);
  A("1c 0-pool vault created (total_collateral==0)", v1.totalCollateral.toString() === "0", `tc=${v1.totalCollateral}`);
  const nonce1 = new BN(now);
  await postSeriesOrder(w1p as any, ref1, "writerAsk", PRICE, QTY, nonce1);
  const order1 = pda([Buffer.from("resting_order"), mint1.toBuffer(), W1.publicKey.toBuffer(), nonce1.toArrayLike(Buffer, "le", 8)]);
  const esc1 = pda([Buffer.from("resting_order_escrow"), order1.toBuffer()]);
  const o1: any = await dProgram.account.restingOrder.fetch(order1).catch(() => null);
  A("1d WriterAsk posted (kind=writerAsk)", !!o1 && !!o1.kind?.writerAsk, `kind=${o1 && Object.keys(o1.kind)[0]}`);
  A("1e WriterAsk escrow == strike×qty", (await amountOf(conn, esc1)) === BigInt(collateral.toString()), `$${fmt(await amountOf(conn, esc1))}`);

  // ========================================================================
  // 2. Ladder — E2 gets its OWN series (distinct mint)
  // ========================================================================
  console.log("\n[2] ladder — E2 distinct series");
  const rec2 = pda([Buffer.from("vault_mint_record"), mint2.toBuffer()]);
  const s2ix = await buildCreateSeriesIx(w1p as any, W1.publicKey, market, protocolState, mint2, rec2, STRIKE, new BN(E2), optType);
  const v2ix = await buildCreateSharedVaultIx(w1p as any, W1.publicKey, market, protocolState, vault2, usdcMint, epochConfig, STRIKE, new BN(E2), optType);
  await w1p.provider.sendAndConfirm!(new Transaction().add(CU(600_000), s2ix, v2ix));
  A("2a E2 series distinct from E1", mint2.toBase58() !== mint1.toBase58() && !!(await conn.getAccountInfo(mint2)), mint2.toBase58().slice(0, 8));

  // ========================================================================
  // 3. Buy from T → fungible series minted to buyer
  // ========================================================================
  console.log("\n[3] T buys E1 WriterAsk → fungible mint");
  const tOpt = getAssociatedTokenAddressSync(mint1, T.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const order1Fill: FillableOrder = { pubkey: order1.toBase58(), owner: W1.publicKey.toBase58(), optionMint: mint1.toBase58(), vault: vault1.toBase58(), kind: "writerAsk" };
  await fillWriterAsk(tp as any, order1Fill, QTY);
  A("3a buyer holds fungible series (mint-on-fill)", (await amountOf(conn, tOpt)) === BigInt(QTY), `bal=${await amountOf(conn, tOpt)}`);

  // ========================================================================
  // 4. 2nd writer W2, SAME spec (E1) → series/vault SKIP, only new WriterAsk
  // ========================================================================
  console.log("\n[4] W2 writes SAME spec E1 — fungibility (no re-create)");
  const rec1Exists = !!(await conn.getAccountInfo(rec1)), vault1Exists = !!(await conn.getAccountInfo(vault1));
  A("4a series+vault already exist → infra skipped", rec1Exists && vault1Exists, `rec=${rec1Exists} vault=${vault1Exists}`);
  const nonce2 = new BN(now + 1);
  await postSeriesOrder(w2p as any, ref1, "writerAsk", new BN(3_000_000), QTY, nonce2); // W2 at $3
  const order2 = pda([Buffer.from("resting_order"), mint1.toBuffer(), W2.publicKey.toBuffer(), nonce2.toArrayLike(Buffer, "le", 8)]);
  const o2: any = await dProgram.account.restingOrder.fetch(order2).catch(() => null);
  A("4b W2 WriterAsk on the SAME canonical mint (fungible)", !!o2 && (o2.optionMint as PublicKey).equals(mint1), `mint=${o2?.optionMint?.toBase58?.().slice(0, 8)}`);

  // ========================================================================
  // 5. Cancel W2's unfilled WriterAsk → USDC refunded
  // ========================================================================
  console.log("\n[5] W2 cancels → USDC refund");
  const w2UsdcBefore = await amountOf(conn, ataOf(W2.publicKey));
  await cancelOrder(w2p as any, { pubkey: order2.toBase58(), owner: W2.publicKey.toBase58(), optionMint: mint1.toBase58(), vault: vault1.toBase58(), kind: "writerAsk" });
  A("5a cancel refunds strike×qty USDC", (await amountOf(conn, ataOf(W2.publicKey))) - w2UsdcBefore === BigInt(collateral.toString()), `+$${fmt((await amountOf(conn, ataOf(W2.publicKey))) - w2UsdcBefore)}`);
  A("5b order closed", !(await conn.getAccountInfo(order2)), "gone");

  // ---- report ----
  console.log("\n=== ASSERTIONS ===");
  let allPass = true;
  for (const r of rows) { allPass &&= r.ok; console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.name}  ${r.detail}`); }
  console.log(`\n  void seed vault (untouched): ${VOID_SEED_VAULT}`);
  console.log(allPass ? "\n>>> EPOCH-SERIES WRITE: ALL PASS" : "\n>>> EPOCH-SERIES WRITE: FAILURES");
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e?.message ?? e); if (e?.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
