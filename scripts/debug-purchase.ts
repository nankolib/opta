// Debug script: simulate purchase_option to see exact error logs
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection, PublicKey, Keypair, SystemProgram,
  ComputeBudgetProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

async function main() {
  const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const rawKey = JSON.parse(fs.readFileSync(path.join(process.env.HOME || "~", ".config/solana/id.json"), "utf-8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(rawKey));
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl, provider) as Program<Opta>;

  const buyerPubkey = wallet.publicKey;

  // Fetch all positions + markets
  const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], PROGRAM_ID);
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);

  console.log("Protocol USDC mint:", protocolState.usdcMint.toBase58());

  // Safe fetch: use getProgramAccounts with discriminator filter, then decode individually
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

  console.log("\n=== All active positions ===");
  let target: any = null;
  for (const p of allPositions) {
    const mkt = marketMap.get(p.account.market.toBase58());
    if (!mkt) continue;
    const isCall = (mkt.optionType as any).call !== undefined;
    const strike = (mkt.strikePrice.toNumber() / 1e6).toFixed(0);
    const available = p.account.totalSupply.toNumber() - p.account.tokensSold.toNumber();
    const active = !p.account.isCancelled && !p.account.isExercised && !p.account.isExpired;
    console.log(`${mkt.assetName} $${strike} ${isCall ? "Call" : "Put"} | supply:${p.account.totalSupply} sold:${p.account.tokensSold} avail:${available} active:${active} | pos:${p.publicKey.toBase58().slice(0, 16)}...`);

    if (mkt.assetName === "SOL" && mkt.strikePrice.toNumber() === 180_000_000 && isCall && active && available > 0) {
      target = { position: p, market: mkt, marketPubkey: p.account.market };
    }
  }

  if (!target) {
    console.log("\nERROR: No active SOL $180 Call position found!");
    return;
  }

  const pos = target.position;
  console.log("\n=== Target position: SOL $180 Call ===");
  console.log("Position:", pos.publicKey.toBase58());
  console.log("Option mint:", pos.account.optionMint.toBase58());
  console.log("Writer:", pos.account.writer.toBase58());
  console.log("Market:", target.marketPubkey.toBase58());

  // Derive all accounts
  const optionMint = pos.account.optionMint;
  const [purchaseEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("purchase_escrow"), pos.publicKey.toBuffer()], PROGRAM_ID);
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), optionMint.toBuffer()], HOOK_PROGRAM_ID);
  const [hookState] = PublicKey.findProgramAddressSync([Buffer.from("hook-state"), optionMint.toBuffer()], HOOK_PROGRAM_ID);

  const buyerUsdcAccount = getAssociatedTokenAddressSync(protocolState.usdcMint, buyerPubkey, false, TOKEN_PROGRAM_ID);
  const writerUsdcAccount = getAssociatedTokenAddressSync(protocolState.usdcMint, pos.account.writer, false, TOKEN_PROGRAM_ID);
  const buyerOptionAccount = getAssociatedTokenAddressSync(optionMint, buyerPubkey, false, TOKEN_2022_PROGRAM_ID);

  console.log("\n=== Account checks ===");
  const checks = [
    { name: "Buyer USDC ATA", key: buyerUsdcAccount },
    { name: "Writer USDC ATA", key: writerUsdcAccount },
    { name: "Buyer Option ATA (T22)", key: buyerOptionAccount },
    { name: "Purchase Escrow", key: purchaseEscrowPda },
    { name: "Extra Account Meta List", key: extraAccountMetaList },
    { name: "Hook State", key: hookState },
    { name: "Treasury", key: treasuryPda },
    { name: "Protocol State", key: protocolStatePda },
    { name: "Option Mint", key: optionMint },
  ];
  for (const c of checks) {
    const info = await conn.getAccountInfo(c.key);
    console.log(`${c.name}: ${c.key.toBase58()} — ${info ? `EXISTS (owner: ${info.owner.toBase58().slice(0, 16)}..., ${info.data.length} bytes)` : "DOES NOT EXIST"}`);
  }

  // Build instruction
  const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
  const ix = await program.methods
    .purchaseOption(new BN(1))
    .accountsStrict({
      buyer: buyerPubkey,
      protocolState: protocolStatePda,
      market: target.marketPubkey,
      position: pos.publicKey,
      purchaseEscrow: purchaseEscrowPda,
      buyerUsdcAccount,
      writerUsdcAccount,
      buyerOptionAccount,
      optionMint,
      treasury: treasuryPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
    })
    .instruction();

  console.log("\n=== Instruction account keys ===");
  ix.keys.forEach((k, i) => {
    console.log(`  [${i}] ${k.pubkey.toBase58()} ${k.isSigner ? "SIGNER" : ""} ${k.isWritable ? "WRITABLE" : "READONLY"}`);
  });

  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: buyerPubkey,
    recentBlockhash: blockhash,
    instructions: [EXTRA_CU, ix],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);

  console.log("\n=== SIMULATING (sigVerify=false) ===");
  const sim = await conn.simulateTransaction(vtx, { sigVerify: false });
  console.log("Error:", JSON.stringify(sim.value.err));
  console.log("Units consumed:", sim.value.unitsConsumed);
  console.log("\nFull logs:");
  if (sim.value.logs) {
    sim.value.logs.forEach((l) => console.log("  ", l));
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
