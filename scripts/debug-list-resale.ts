// Debug script: simulate list_for_resale to see exact error logs
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection, PublicKey, Keypair, SystemProgram,
  ComputeBudgetProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, getAccount,
  createAssociatedTokenAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

async function main() {
  const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const rawKey = JSON.parse(fs.readFileSync(path.join(process.env.HOME || "~", ".config/solana/id.json"), "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(rawKey));
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl, provider) as Program<Opta>;

  // Use the loaded wallet as the seller
  const sellerPubkey = wallet.publicKey;

  console.log("=== Debug list_for_resale ===\n");

  // Fetch all positions, find ones the user might hold tokens for
  const crypto = await import("crypto");
  function getDiscriminator(name: string): Buffer {
    return Buffer.from(crypto.createHash("sha256").update("account:" + name).digest().slice(0, 8));
  }
  function bs58Encode(bytes: Buffer): string {
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const digits = [0];
    for (const byte of bytes) {
      let carry = byte;
      for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let str = "";
    for (const byte of bytes) { if (byte !== 0) break; str += "1"; }
    for (let i = digits.length - 1; i >= 0; i--) str += ALPHABET[digits[i]];
    return str;
  }
  async function safeFetchAll(accountName: string, displayName: string) {
    const disc = getDiscriminator(displayName);
    const raw = await conn.getProgramAccounts(PROGRAM_ID, {
      filters: [{ memcmp: { offset: 0, bytes: bs58Encode(disc) } }],
    });
    const results: { publicKey: PublicKey; account: any }[] = [];
    for (const r of raw) {
      try {
        const account = program.coder.accounts.decode(accountName, r.account.data);
        results.push({ publicKey: r.pubkey, account });
      } catch { /* skip old format */ }
    }
    return results;
  }

  const allPositions = await safeFetchAll("optionPosition", "OptionPosition");
  const allMarkets = await safeFetchAll("optionsMarket", "OptionsMarket");
  const marketMap = new Map<string, any>();
  allMarkets.forEach((m) => marketMap.set(m.publicKey.toBase58(), m.account));

  // Find positions where the user holds option tokens (check Token-2022 ATAs)
  console.log("Scanning for positions where seller holds option tokens...\n");
  let target: any = null;

  for (const p of allPositions) {
    if (p.account.isCancelled || p.account.isExercised || p.account.isExpired || p.account.isListedForResale) continue;
    const mkt = marketMap.get(p.account.market.toBase58());
    if (!mkt) continue;

    const optionMint = p.account.optionMint;
    const sellerAta = getAssociatedTokenAddressSync(optionMint, sellerPubkey, false, TOKEN_2022_PROGRAM_ID);

    try {
      const ataInfo = await conn.getAccountInfo(sellerAta);
      if (ataInfo && ataInfo.data.length >= 72) {
        const balance = BigInt(Buffer.from(ataInfo.data.slice(64, 72)).readBigUInt64LE(0));
        if (balance > BigInt(0)) {
          const isCall = (mkt.optionType as any).call !== undefined;
          const strike = (mkt.strikePrice.toNumber() / 1e6).toFixed(0);
          console.log(`FOUND: ${mkt.assetName} $${strike} ${isCall ? "Call" : "Put"} — balance: ${balance} tokens`);
          console.log(`  Position: ${p.publicKey.toBase58()}`);
          console.log(`  Option mint: ${optionMint.toBase58()}`);
          console.log(`  Seller ATA: ${sellerAta.toBase58()}`);
          if (!target) target = { position: p, market: mkt };
        }
      }
    } catch { /* ATA doesn't exist */ }
  }

  if (!target) {
    console.log("\nNo positions found where seller holds option tokens.");
    console.log("The user may not have successfully purchased any options yet.");

    // Fall back: just pick an active SOL $180 Call and simulate anyway
    console.log("\nFalling back to simulating with SOL $180 Call (even though seller has no tokens)...");
    for (const p of allPositions) {
      const mkt = marketMap.get(p.account.market.toBase58());
      if (!mkt) continue;
      if (mkt.assetName === "SOL" && mkt.strikePrice.toNumber() === 180_000_000 && (mkt.optionType as any).call !== undefined) {
        if (!p.account.isCancelled && !p.account.isExercised && !p.account.isExpired && !p.account.isListedForResale) {
          target = { position: p, market: mkt };
          break;
        }
      }
    }
  }

  if (!target) {
    console.log("ERROR: No suitable position found at all!");
    return;
  }

  const pos = target.position;
  const optionMint = pos.account.optionMint;
  console.log("\n=== Target position ===");
  console.log("Position:", pos.publicKey.toBase58());
  console.log("Option mint:", optionMint.toBase58());
  console.log("Writer:", pos.account.writer.toBase58());
  console.log("Listed for resale?", pos.account.isListedForResale);

  // Derive all accounts
  const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
  const sellerOptionAccount = getAssociatedTokenAddressSync(optionMint, sellerPubkey, false, TOKEN_2022_PROGRAM_ID);
  const [resaleEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("resale_escrow"), pos.publicKey.toBuffer()], PROGRAM_ID);
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), optionMint.toBuffer()], HOOK_PROGRAM_ID);
  const [hookState] = PublicKey.findProgramAddressSync([Buffer.from("hook-state"), optionMint.toBuffer()], HOOK_PROGRAM_ID);

  console.log("\n=== Account checks ===");
  const checks = [
    { name: "Seller Option ATA (T22)", key: sellerOptionAccount },
    { name: "Resale Escrow PDA", key: resaleEscrowPda },
    { name: "Extra Account Meta List", key: extraAccountMetaList },
    { name: "Hook State", key: hookState },
    { name: "Protocol State", key: protocolStatePda },
    { name: "Option Mint", key: optionMint },
  ];
  for (const c of checks) {
    const info = await conn.getAccountInfo(c.key);
    console.log(`${c.name}: ${c.key.toBase58()} — ${info ? `EXISTS (owner: ${info.owner.toBase58().slice(0, 16)}..., ${info.data.length} bytes)` : "DOES NOT EXIST"}`);
  }

  // Check seller option token balance
  const sellerAtaInfo = await conn.getAccountInfo(sellerOptionAccount);
  if (sellerAtaInfo && sellerAtaInfo.data.length >= 72) {
    const balance = BigInt(Buffer.from(sellerAtaInfo.data.slice(64, 72)).readBigUInt64LE(0));
    console.log(`\nSeller option token balance: ${balance}`);
  } else {
    console.log("\nSeller option ATA does not exist or has no data!");
  }

  // Build the transaction
  const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

  // Pre-instruction: create seller ATA if needed (same as frontend fix)
  const createSellerAtaIx = createAssociatedTokenAccountInstruction(
    sellerPubkey, sellerOptionAccount, sellerPubkey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const resalePremium = new BN(5_000_000); // $5 asking price
  const tokenAmount = new BN(1);

  const listIx = await program.methods
    .listForResale(resalePremium, tokenAmount)
    .accountsStrict({
      seller: sellerPubkey,
      protocolState: protocolStatePda,
      position: pos.publicKey,
      sellerOptionAccount,
      resaleEscrow: resaleEscrowPda,
      optionMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
    })
    .instruction();

  console.log("\n=== Instruction account keys ===");
  listIx.keys.forEach((k, i) => {
    console.log(`  [${i}] ${k.pubkey.toBase58()} ${k.isSigner ? "SIGNER" : ""} ${k.isWritable ? "WRITABLE" : "READONLY"}`);
  });

  const { blockhash } = await conn.getLatestBlockhash();

  // Test both: with and without the ATA creation pre-instruction
  for (const label of ["WITHOUT ATA creation", "WITH ATA creation"]) {
    const instructions = label.includes("WITH")
      ? [EXTRA_CU, createSellerAtaIx, listIx]
      : [EXTRA_CU, listIx];

    const msg = new TransactionMessage({
      payerKey: sellerPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);

    console.log(`\n=== SIMULATING ${label} ===`);
    const sim = await conn.simulateTransaction(vtx, { sigVerify: false });
    console.log("Error:", JSON.stringify(sim.value.err));
    console.log("Units consumed:", sim.value.unitsConsumed);
    console.log("\nLogs:");
    if (sim.value.logs) sim.value.logs.forEach((l) => console.log("  ", l));
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
