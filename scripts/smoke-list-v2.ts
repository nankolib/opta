// =============================================================================
// scripts/smoke-list-v2.ts — Devnet smoke test for list_v2_for_resale
// =============================================================================
//
// Picks a vaultMint where the operator wallet currently holds option tokens
// in their regular Token-2022 ATA, then calls list_v2_for_resale to list
// 1 contract at $1 USDC. Logs PDAs + balances pre/post. Does NOT clean up —
// the listing should remain live on devnet for the cancel smoke (Step 3).
//
// Run: npx ts-node scripts/smoke-list-v2.ts
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
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

import { safeFetchAll } from "../app/src/hooks/useFetchAccounts";

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

  console.log("=== smoke-list-v2 ===");
  console.log("Operator wallet:", operator.publicKey.toBase58());
  console.log("RPC:", rpcUrl.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>"));

  // ---- Step 1: enumerate vaultMint records and find one the operator
  //              currently holds tokens in via their regular ATA.
  // Note: we do NOT filter by `writer == operator`. The protocol blocks
  // writers from buying their own mint (purchase_from_vault.rs:39-43), so
  // writers never hold their own option tokens. The seller in a resale flow
  // has to be a buyer. We scan every vaultMint and check the operator's ATA.
  // Uses safeFetchAll instead of program.account.vaultMint.all() — defensive
  // against stale on-chain layouts. See seed-devnet.ts:421 + the Stage 2
  // refactor history (MIGRATION_LOG.md). Currently this script is "lucky"
  // with .all() because all on-chain VaultMint accounts are post-V2; the
  // switch is for consistency with buy-for-smoke and crank.
  console.log("\n[1/4] Scanning vaultMint records for held balances...");
  const allMints = await safeFetchAll<any>(program, "vaultMint");
  console.log(`  found ${allMints.length} vaultMint records on-chain`);

  type Holding = {
    vaultMintPda: PublicKey;
    optionMint: PublicKey;
    vaultPda: PublicKey;
    operatorAta: PublicKey;
    balance: bigint;
  };
  const holdings: Holding[] = [];
  for (const m of allMints) {
    const optionMint = m.account.optionMint as PublicKey;
    const ata = getAssociatedTokenAddressSync(
      optionMint,
      operator.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const bal = await readTokenAmount(conn, ata);
    if (bal && bal > BigInt(0)) {
      holdings.push({
        vaultMintPda: m.publicKey,
        optionMint,
        vaultPda: m.account.vault as PublicKey,
        operatorAta: ata,
        balance: bal,
      });
    }
  }

  if (holdings.length === 0) {
    console.log(
      "  no held balances. Operator must purchase from a V2 vault first.",
    );
    process.exit(1);
  }

  const target = holdings[0];
  console.log(`  picked ${target.optionMint.toBase58()} (balance: ${target.balance})`);

  // ---- Step 2: derive PDAs + fetch supporting accounts.
  console.log("\n[2/4] Deriving PDAs...");
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    PROGRAM_ID,
  );
  const [listingPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_resale_listing"),
      target.optionMint.toBuffer(),
      operator.publicKey.toBuffer(),
    ],
    PROGRAM_ID,
  );
  const [resaleEscrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_resale_escrow"), listingPda.toBuffer()],
    PROGRAM_ID,
  );
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), target.optionMint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  const [hookState] = PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), target.optionMint.toBuffer()],
    HOOK_PROGRAM_ID,
  );

  const vaultAccount = await program.account.sharedVault.fetch(target.vaultPda);
  const marketPda = vaultAccount.market as PublicKey;

  console.log("  listing PDA      :", listingPda.toBase58());
  console.log("  escrow PDA       :", resaleEscrowPda.toBase58());
  console.log("  vaultMint PDA    :", target.vaultMintPda.toBase58());
  console.log("  shared_vault PDA :", target.vaultPda.toBase58());
  console.log("  market PDA       :", marketPda.toBase58());
  console.log("  protocol_state   :", protocolStatePda.toBase58());
  console.log("  extra_meta_list  :", extraAccountMetaList.toBase58());
  console.log("  hook_state       :", hookState.toBase58());

  // ---- Step 3: pre-state.
  console.log("\n[3/4] Pre-state:");
  const preListingExists = (await conn.getAccountInfo(listingPda)) !== null;
  const preEscrowExists = (await conn.getAccountInfo(resaleEscrowPda)) !== null;
  const preSellerBal = await readTokenAmount(conn, target.operatorAta);
  const preEscrowBal = preEscrowExists
    ? await readTokenAmount(conn, resaleEscrowPda)
    : null;
  console.log("  listing exists?  :", preListingExists);
  console.log("  escrow exists?   :", preEscrowExists);
  console.log("  seller balance   :", preSellerBal?.toString() ?? "(no ATA)");
  console.log("  escrow balance   :", preEscrowBal?.toString() ?? "(n/a)");

  if (preListingExists) {
    console.log(
      "  listing already exists for (mint, seller). Cancel it first or use " +
        "a different mint. Treating as a clean no-op state.",
    );
    process.exit(0);
  }

  // ---- Step 4: build + send list_v2_for_resale.
  console.log("\n[4/4] Sending list_v2_for_resale (qty=1, price=$1 USDC)...");
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
  const listIx = await program.methods
    .listV2ForResale(new BN(1_000_000), new BN(1)) // price=1_000_000 (=$1), qty=1
    .accountsStrict({
      seller: operator.publicKey,
      sharedVault: target.vaultPda,
      market: marketPda,
      vaultMintRecord: target.vaultMintPda,
      optionMint: target.optionMint,
      sellerOptionAccount: target.operatorAta,
      listing: listingPda,
      resaleEscrow: resaleEscrowPda,
      protocolState: protocolStatePda,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: operator.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuIx, listIx],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([operator]);

  const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
  console.log("  tx:", sig);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("  confirmed.");

  // ---- Post-state.
  console.log("\nPost-state:");
  const postListing = await program.account.vaultResaleListing.fetch(listingPda);
  const postEscrowBal = await readTokenAmount(conn, resaleEscrowPda);
  const postSellerBal = await readTokenAmount(conn, target.operatorAta);
  console.log("  listing.seller        :", (postListing.seller as PublicKey).toBase58());
  console.log("  listing.vault         :", (postListing.vault as PublicKey).toBase58());
  console.log("  listing.option_mint   :", (postListing.optionMint as PublicKey).toBase58());
  console.log(
    "  listing.listed_qty    :",
    (postListing.listedQuantity as BN).toString(),
  );
  console.log(
    "  listing.price/contract:",
    (postListing.pricePerContract as BN).toString(),
  );
  console.log(
    "  listing.created_at    :",
    (postListing.createdAt as BN).toString(),
  );
  console.log("  escrow balance        :", postEscrowBal?.toString() ?? "(missing!)");
  console.log("  seller balance        :", postSellerBal?.toString() ?? "(missing!)");
  console.log("\n=== smoke-list-v2 complete ===");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
