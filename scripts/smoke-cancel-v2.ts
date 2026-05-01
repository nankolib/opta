// =============================================================================
// scripts/smoke-cancel-v2.ts — Devnet smoke test for cancel_v2_resale
// =============================================================================
//
// Picks the live VaultResaleListing for the operator wallet (created by
// scripts/smoke-list-v2.ts). Calls cancel_v2_resale, asserts the escrow
// account closed, the listing PDA closed, and the seller's option ATA
// balance increased by the previously-listed quantity.
//
// Run: npx ts-node scripts/smoke-cancel-v2.ts
// Required env: RPC_URL (Helius devnet)
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

async function readTokenAmount(
  conn: Connection,
  ata: PublicKey,
): Promise<bigint | null> {
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length < 72) return null;
  return Buffer.from(info.data.slice(64, 72)).readBigUInt64LE(0);
}

async function main() {
  const rpcUrl =
    process.env.RPC_URL ?? process.env.OPTA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });

  const keypairPath =
    process.env.OPTA_KEYPAIR ??
    path.join(process.env.HOME ?? "/home/nanko", ".config/solana/id.json");
  const rawKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const operator = Keypair.fromSecretKey(Uint8Array.from(rawKey));
  const wallet = new anchor.Wallet(operator);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "target", "idl", "opta.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider) as Program<Opta>;

  console.log("=== smoke-cancel-v2 ===");
  console.log("Operator wallet:", operator.publicKey.toBase58());
  console.log("RPC:", rpcUrl.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>"));

  // ---- Step 1: find the operator's active listings.
  // VaultResaleListing layout: 8-byte disc + 32-byte seller (offset 8).
  // Anchor's .all() prepends the disc filter automatically; we add seller.
  console.log("\n[1/4] Scanning VaultResaleListing for seller = operator...");
  const operatorListings = await program.account.vaultResaleListing.all([
    { memcmp: { offset: 8, bytes: operator.publicKey.toBase58() } },
  ]);
  console.log(`  found ${operatorListings.length} active listing(s) for this seller`);

  if (operatorListings.length === 0) {
    console.log("  no listings to cancel. Treating as a clean no-op state.");
    process.exit(0);
  }

  const target = operatorListings[0];
  const listingPda = target.publicKey;
  const optionMint = target.account.optionMint as PublicKey;
  const vaultPda = target.account.vault as PublicKey;
  const listedQty = (target.account.listedQuantity as BN).toString();
  console.log(`  picked listing : ${listingPda.toBase58()}`);
  console.log(`  option_mint    : ${optionMint.toBase58()}`);
  console.log(`  listed_qty     : ${listedQty}`);

  // ---- Step 2: derive PDAs.
  console.log("\n[2/4] Deriving PDAs...");
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    PROGRAM_ID,
  );
  const [resaleEscrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_resale_escrow"), listingPda.toBuffer()],
    PROGRAM_ID,
  );
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), optionMint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  const [hookState] = PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), optionMint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  const sellerOptionAta = getAssociatedTokenAddressSync(
    optionMint,
    operator.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  console.log("  resale_escrow   :", resaleEscrowPda.toBase58());
  console.log("  seller ATA      :", sellerOptionAta.toBase58());
  console.log("  protocol_state  :", protocolStatePda.toBase58());
  console.log("  extra_meta_list :", extraAccountMetaList.toBase58());
  console.log("  hook_state      :", hookState.toBase58());

  // ---- Step 3: pre-state.
  console.log("\n[3/4] Pre-state:");
  const preEscrowExists = (await conn.getAccountInfo(resaleEscrowPda)) !== null;
  const preEscrowBal = preEscrowExists
    ? await readTokenAmount(conn, resaleEscrowPda)
    : null;
  const preSellerBal = await readTokenAmount(conn, sellerOptionAta);
  console.log("  listing exists? :", true);
  console.log("  escrow exists?  :", preEscrowExists);
  console.log("  escrow balance  :", preEscrowBal?.toString() ?? "(n/a)");
  console.log("  seller balance  :", preSellerBal?.toString() ?? "(no ATA)");

  // ---- Step 4: build + send cancel_v2_resale.
  console.log("\n[4/4] Sending cancel_v2_resale...");
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
  const cancelIx = await program.methods
    .cancelV2Resale()
    .accountsStrict({
      seller: operator.publicKey,
      sharedVault: vaultPda,
      optionMint,
      listing: listingPda,
      resaleEscrow: resaleEscrowPda,
      sellerOptionAccount: sellerOptionAta,
      protocolState: protocolStatePda,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: operator.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuIx, cancelIx],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([operator]);

  const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
  console.log("  tx:", sig);
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  console.log("  confirmed.");

  // ---- Post-state + assertions.
  console.log("\nPost-state:");
  const postListingInfo = await conn.getAccountInfo(listingPda);
  const postEscrowInfo = await conn.getAccountInfo(resaleEscrowPda);
  const postSellerBal = await readTokenAmount(conn, sellerOptionAta);
  console.log("  listing exists? :", postListingInfo !== null);
  console.log("  escrow exists?  :", postEscrowInfo !== null);
  console.log("  seller balance  :", postSellerBal?.toString() ?? "(no ATA)");

  console.log("\n=== Assertions ===");
  const listingClosed = postListingInfo === null;
  const escrowClosed = postEscrowInfo === null;
  const expectedDelta = preEscrowBal ?? BigInt(0);
  const actualDelta =
    (postSellerBal ?? BigInt(0)) - (preSellerBal ?? BigInt(0));
  const balanceCorrect = actualDelta === expectedDelta;

  console.log(`  listing closed       : ${listingClosed ? "PASS" : "FAIL"}`);
  console.log(`  escrow closed        : ${escrowClosed ? "PASS" : "FAIL"}`);
  console.log(
    `  seller +${expectedDelta} tokens : ${balanceCorrect ? "PASS" : `FAIL (got delta = ${actualDelta})`}`,
  );

  if (!listingClosed || !escrowClosed || !balanceCorrect) {
    console.log("\nFAIL: one or more assertions did not pass.");
    process.exit(1);
  }
  console.log("\n=== smoke-cancel-v2 complete (all assertions passed) ===");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
