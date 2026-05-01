// =============================================================================
// scripts/smoke-auto-cancel.ts — Devnet smoke test for auto_cancel_listings
// =============================================================================
//
// Two-step smoke:
//   Step A: Operator lists 1 contract from their existing SOL CALL holding
//   Step B: Operator (as permissionless caller) immediately auto-cancels
//
// Asserts:
//   - listing closed (manual lamport drain fired)
//   - escrow closed
//   - operator option ATA balance restored to pre-listing value
//   - tx confirmed
//
// (Event values listings_cancelled=1, tokens_returned=1 are not asserted
// programmatically — would require log parsing — but should be visible in
// the program logs of the auto_cancel tx.)
//
// Run: npx ts-node scripts/smoke-auto-cancel.ts
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
  AccountMeta,
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

  const operatorKeypairPath =
    process.env.OPTA_KEYPAIR ??
    path.join(process.env.HOME ?? "/home/nanko", ".config/solana/id.json");
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(operatorKeypairPath, "utf-8"))),
  );

  const wallet = new anchor.Wallet(operator);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idlPath = path.join(__dirname, "..", "target", "idl", "opta.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider) as Program<Opta>;

  console.log("=== smoke-auto-cancel ===");
  console.log("Operator (lister + caller):", operator.publicKey.toBase58());
  console.log("RPC:", rpcUrl.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>"));

  // ---- [1/6] Find a vaultMint where operator has ≥1 token + vault is healthy
  console.log("\n[1/6] Scanning for a holdable + listable vaultMint...");
  const allMints = await safeFetchAll<any>(program, "vaultMint");
  const allVaults = await safeFetchAll<any>(program, "sharedVault");
  const vaultByPda = new Map<string, any>();
  for (const v of allVaults) vaultByPda.set(v.publicKey.toBase58(), v.account);

  const now = Math.floor(Date.now() / 1000);
  let target: {
    optionMint: PublicKey;
    vaultPda: PublicKey;
    vaultMintPda: PublicKey;
    operatorAta: PublicKey;
    balance: bigint;
  } | null = null;
  for (const m of allMints) {
    const optionMint = m.account.optionMint as PublicKey;
    const vaultPda = m.account.vault as PublicKey;
    const vaultAccount = vaultByPda.get(vaultPda.toBase58());
    if (!vaultAccount) continue;
    if (vaultAccount.isSettled) continue;
    const expiry =
      typeof vaultAccount.expiry === "number"
        ? vaultAccount.expiry
        : (vaultAccount.expiry as BN).toNumber();
    if (expiry <= now + 600) continue;
    const ata = getAssociatedTokenAddressSync(
      optionMint,
      operator.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const bal = await readTokenAmount(conn, ata);
    if (!bal || bal < BigInt(1)) continue;
    target = {
      optionMint,
      vaultPda,
      vaultMintPda: m.publicKey,
      operatorAta: ata,
      balance: bal,
    };
    break;
  }

  if (!target) {
    console.log(
      "  no vaultMint with operator-held tokens on a healthy vault. " +
        "Run buy-for-smoke first to seed inventory.",
    );
    process.exit(1);
  }

  console.log(`  picked option_mint : ${target.optionMint.toBase58()}`);
  console.log(`  vault PDA          : ${target.vaultPda.toBase58()}`);
  console.log(`  operator ATA       : ${target.operatorAta.toBase58()}`);
  console.log(`  pre-listing balance: ${target.balance.toString()}`);

  const preListingBalance = target.balance;

  // ---- [2/6] Derive PDAs ---------------------------------------------------
  console.log("\n[2/6] Deriving PDAs...");
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
  console.log("  market PDA       :", marketPda.toBase58());
  console.log("  protocol_state   :", protocolStatePda.toBase58());

  // ---- [3/6] Step A: list 1 contract --------------------------------------
  // If a listing already exists at this PDA (re-run state), skip the list step
  // and go straight to auto_cancel.
  const preListingExists = (await conn.getAccountInfo(listingPda)) !== null;
  if (preListingExists) {
    console.log(
      "\n[3/6] Listing PDA already exists at this address — skipping list step, going straight to auto-cancel.",
    );
  } else {
    console.log("\n[3/6] Step A: listing 1 contract at $1...");
    const listSig = await program.methods
      .listV2ForResale(new BN(1_000_000), new BN(1))
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
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ])
      .rpc();
    console.log(`  list tx: ${listSig}`);
  }

  // Mid-state sanity
  const midOperatorBal = await readTokenAmount(conn, target.operatorAta);
  const midEscrowBal = await readTokenAmount(conn, resaleEscrowPda);
  console.log("  mid-state:");
  console.log(`    operator ATA   : ${midOperatorBal?.toString() ?? "(no ATA)"}`);
  console.log(`    escrow balance : ${midEscrowBal?.toString() ?? "(no escrow)"}`);

  // ---- [4/6] Build remaining_accounts 4-tuple -----------------------------
  console.log("\n[4/6] Building remaining_accounts (1 listing × 4 accounts)...");
  const remaining: AccountMeta[] = [
    { pubkey: listingPda, isSigner: false, isWritable: true },
    { pubkey: resaleEscrowPda, isSigner: false, isWritable: true },
    { pubkey: target.operatorAta, isSigner: false, isWritable: true },
    { pubkey: operator.publicKey, isSigner: false, isWritable: true },
  ];
  remaining.forEach((m, i) => {
    console.log(`  [${i}] ${m.pubkey.toBase58()} (mut)`);
  });

  // ---- [5/6] Send auto_cancel_listings ------------------------------------
  console.log("\n[5/6] Sending auto_cancel_listings...");
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
  const cancelIx = await program.methods
    .autoCancelListings()
    .accountsStrict({
      caller: operator.publicKey,
      sharedVault: target.vaultPda,
      market: marketPda,
      vaultMintRecord: target.vaultMintPda,
      optionMint: target.optionMint,
      protocolState: protocolStatePda,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(remaining)
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

  // ---- [6/6] Post-state + assertions --------------------------------------
  console.log("\n[6/6] Post-state:");
  const postListingInfo = await conn.getAccountInfo(listingPda);
  const postEscrowInfo = await conn.getAccountInfo(resaleEscrowPda);
  const postOperatorBal = await readTokenAmount(conn, target.operatorAta);
  console.log(`  listing exists?     : ${postListingInfo !== null}`);
  console.log(`  escrow exists?      : ${postEscrowInfo !== null}`);
  console.log(`  operator ATA balance: ${postOperatorBal?.toString() ?? "(no ATA)"}`);

  console.log("\n=== Assertions ===");
  const listingClosed = postListingInfo === null;
  const escrowClosed = postEscrowInfo === null;
  const balanceRestored =
    (postOperatorBal ?? BigInt(0)) === preListingBalance;
  const checks = [
    { name: "listing closed       ", pass: listingClosed },
    { name: "escrow closed        ", pass: escrowClosed },
    {
      name: `operator ATA = ${preListingBalance}`.padEnd(21, " "),
      pass: balanceRestored,
      detail: `got ${postOperatorBal}`,
    },
  ];
  let allPass = true;
  for (const c of checks) {
    console.log(
      `  ${c.name}: ${c.pass ? "PASS" : `FAIL${c.detail ? " (" + c.detail + ")" : ""}`}`,
    );
    if (!c.pass) allPass = false;
  }
  if (!allPass) {
    console.log("\nFAIL: one or more assertions did not pass.");
    process.exit(1);
  }
  console.log(
    "\n=== smoke-auto-cancel complete (all assertions passed) ===",
  );
  console.log(
    "(Event VaultListingsAutoCancelled with listings_cancelled=1, tokens_returned=1 emitted in tx logs.)",
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
