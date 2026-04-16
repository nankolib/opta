// =============================================================================
// scripts/setup-faucet.ts — Create and fund a devnet USDC faucet wallet
// =============================================================================
// Usage: npx ts-node scripts/setup-faucet.ts
// Creates a faucet keypair, funds it with USDC, and outputs the keypair bytes
// for embedding in the frontend (devnet only).
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");

async function main() {
  console.log("=== Setup Devnet USDC Faucet ===\n");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.butterOptions as Program<ButterOptions>;
  const admin = provider.wallet as anchor.Wallet;
  const payer = (admin as any).payer as Keypair;

  // Fetch USDC mint from protocol state
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")], PROGRAM_ID,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint;
  console.log("USDC mint:", usdcMint.toBase58());

  // Load or create faucet keypair
  const faucetPath = path.join(__dirname, ".devnet-faucet-keypair.json");
  let faucet: Keypair;
  if (fs.existsSync(faucetPath)) {
    faucet = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(faucetPath, "utf-8"))),
    );
    console.log("Loaded existing faucet:", faucet.publicKey.toBase58());
  } else {
    faucet = Keypair.generate();
    fs.writeFileSync(faucetPath, JSON.stringify(Array.from(faucet.secretKey)));
    console.log("Created new faucet:", faucet.publicKey.toBase58());
  }

  // Fund faucet with SOL for transaction fees
  const faucetBalance = await provider.connection.getBalance(faucet.publicKey);
  if (faucetBalance < 0.1 * LAMPORTS_PER_SOL) {
    console.log("Funding faucet with 0.5 SOL...");
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: faucet.publicKey,
        lamports: 0.5 * LAMPORTS_PER_SOL,
      }),
    );
    await provider.sendAndConfirm(fundTx);
  }

  // Create faucet USDC ATA
  const faucetAta = getAssociatedTokenAddressSync(usdcMint, faucet.publicKey, false, TOKEN_PROGRAM_ID);
  const faucetAtaInfo = await provider.connection.getAccountInfo(faucetAta);
  if (!faucetAtaInfo) {
    console.log("Creating faucet USDC ATA...");
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey,
        faucetAta,
        faucet.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID,
      ),
    );
    await provider.sendAndConfirm(createAtaTx);
  }

  // Mint 10M USDC to faucet (enough for many test users)
  const faucetUsdcInfo = await getAccount(provider.connection, faucetAta);
  const currentBalance = Number(faucetUsdcInfo.amount);
  if (currentBalance < 5_000_000_000_000) { // < 5M USDC
    console.log("Minting 10,000,000 USDC to faucet...");
    await mintTo(
      provider.connection, payer, usdcMint, faucetAta,
      payer.publicKey, 10_000_000_000_000, // 10M USDC
    );
  }

  const finalBalance = await getAccount(provider.connection, faucetAta);
  console.log(`\nFaucet USDC balance: ${(Number(finalBalance.amount) / 1_000_000).toLocaleString()} USDC`);

  // Output the keypair bytes for frontend embedding
  console.log("\n=== Frontend Configuration ===");
  console.log("Add this to app/src/utils/constants.ts:\n");
  console.log(`// Devnet-only faucet wallet — has USDC to distribute to test users`);
  console.log(`// DO NOT use on mainnet. This keypair is public and has no real value.`);
  console.log(`export const DEVNET_FAUCET_KEYPAIR = Uint8Array.from([`);
  const bytes = Array.from(faucet.secretKey);
  // Print in rows of 16 for readability
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16).join(", ");
    console.log(`  ${row},`);
  }
  console.log(`]);\n`);
  console.log(`export const DEVNET_USDC_MINT = new PublicKey("${usdcMint.toBase58()}");\n`);

  console.log("=== Faucet setup complete! ===");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
