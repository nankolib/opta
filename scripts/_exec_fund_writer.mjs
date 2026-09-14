// LOCAL one-shot — fund the opta-writer wallet for the FULL-BOARD scale-up.
// Mints devnet test USDC (admin 5YRMuuoY is the mint authority) to the writer's
// USDC ATA, and optionally tops up SOL for the cold-board account-rent lock.
// Signs with the admin keypair (WSL-only $HOME/.config/solana/id.json) —
// read in place, never printed. SIMULATE by default; OPTA_FUND_SEND=1 to send.
//
// Sizing (from crank/_probe_fullboard_collateral.ts at current SB spots), with
// SBXAU SCOPED OUT (XAU BX6rrhdd is canonical → single XAU exposure):
//   SB board net collateral (10 SB markets × 20 cells) ≈ $1,535,961
//     ( = $1,615,761 full − $79,800 SBXAU ). BTC alone ≈ $1,293,200.
//   Writer holds ≈ $18,997 USDC → mint $1,650,000 → ATA ≈ $1,668,997
//     (board + ~$133k buffer for spot drift / staging re-posts).
// Also tops up +5 SOL (cold board locks ≈1.5 SOL of recoverable account rent
// across ~200 vaults/mints/orders). Monday's equity mint (~$440k) is SEPARATE —
// do NOT fold it in here. Override amounts via env.
//
// Run in WSL (from repo root):
//   NODE_PATH=/mnt/d/claude\ everything/butter_options/app/node_modules \
//   OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" node scripts/_exec_fund_writer.mjs
//   (add OPTA_FUND_SEND=1 to actually mint+transfer)
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createMintToInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const RPC = process.env.OPTA_RPC_URL || "https://api.devnet.solana.com";
const SEND = process.env.OPTA_FUND_SEND === "1";
const KEYPATH = process.env.ADMIN_KEYPATH || (process.env.HOME ?? process.env.USERPROFILE ?? ".") + "/.config/solana/id.json";
const USDC_MINT = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");
const WRITER = new PublicKey("HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS");
const USDC_AMOUNT = Number(process.env.OPTA_FUND_USDC ?? "1650000");   // human USDC to MINT (board net SBXAU + buffer)
const SOL_TOPUP = Number(process.env.OPTA_FUND_SOL ?? "5");           // human SOL to transfer (0 = skip)
const LPS = 1_000_000_000;
const sol = (l) => (l / LPS).toFixed(6);
const usd = (n) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPATH, "utf8"))));
const c = new Connection(RPC, "confirmed");
const redact = (s) => s.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");

console.log("mode  :", SEND ? "SEND" : "SIMULATE");
console.log("rpc   :", redact(RPC));
console.log("admin :", admin.publicKey.toBase58(), "(must be USDC mint authority)");
console.log("writer:", WRITER.toBase58());

const g = await c.getGenesisHash();
if (g !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") { console.error("ABORT — not devnet:", g); process.exit(1); }

const ata = getAssociatedTokenAddressSync(USDC_MINT, WRITER, true, TOKEN_PROGRAM_ID);
const ataAi = await c.getAccountInfo(ata);
if (!ataAi) { console.error("ABORT — writer USDC ATA does not exist:", ata.toBase58(), "(create it first)"); process.exit(1); }
const usdc0 = Number(Buffer.from(ataAi.data).readBigUInt64LE(64)) / 1e6;
const sol0 = await c.getBalance(WRITER);
const adminSol = await c.getBalance(admin.publicKey);
console.log("\n=== BEFORE ===");
console.log(`writer USDC: ${usd(usdc0)}   writer SOL: ${sol(sol0)}   admin SOL: ${sol(adminSol)}`);
console.log(`plan: MINT ${usd(USDC_AMOUNT)} USDC → writer ATA ${ata.toBase58()}` + (SOL_TOPUP > 0 ? `   +${SOL_TOPUP} SOL top-up` : "   (no SOL top-up)"));

const tx = new Transaction();
tx.add(createMintToInstruction(USDC_MINT, ata, admin.publicKey, BigInt(Math.round(USDC_AMOUNT * 1e6)), [], TOKEN_PROGRAM_ID));
if (SOL_TOPUP > 0) tx.add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: WRITER, lamports: Math.round(SOL_TOPUP * LPS) }));
tx.feePayer = admin.publicKey;
tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
tx.sign(admin);

const sim = await c.simulateTransaction(tx);
console.log("\n=== SIM ===");
console.log("err:", JSON.stringify(sim.value.err), "| units:", sim.value.unitsConsumed);
if (sim.value.err) { (sim.value.logs ?? []).slice(-5).forEach((l) => console.log("  " + l)); process.exit(1); }

if (!SEND) { console.log("\n(SIMULATE only — re-run with OPTA_FUND_SEND=1 to mint+transfer)"); process.exit(0); }
const sig = await c.sendRawTransaction(tx.serialize());
await c.confirmTransaction(sig, "confirmed");
const usdc1 = Number(Buffer.from((await c.getAccountInfo(ata)).data).readBigUInt64LE(64)) / 1e6;
console.log("\n=== AFTER ===  sig:", sig);
console.log(`writer USDC: ${usd(usdc1)}   writer SOL: ${sol(await c.getBalance(WRITER))}`);
