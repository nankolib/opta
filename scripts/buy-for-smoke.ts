// =============================================================================
// scripts/buy-for-smoke.ts — Seed operator wallet with 2 V2 option tokens
// =============================================================================
//
// Pre-Step-4 setup. Picks an existing V2 vaultMint where:
//   - parent vault is unsettled and not expiring within 10 min
//   - writer != operator (protocol blocks self-buys)
//   - >= 2 contracts available for purchase (quantity_minted - quantity_sold)
// Then runs purchase_from_vault for quantity = 2 against the cheapest match
// (preferring SOL).
//
// After this script: operator wallet holds 2 option tokens for the chosen
// mint in their regular Token-2022 ATA — the prerequisite for smoke-list-v2.
//
// Run: npx ts-node scripts/buy-for-smoke.ts
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
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

const QTY = new BN(2);
const EXPIRY_BUFFER_S = 600;

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

  console.log("=== buy-for-smoke ===");
  console.log("Operator wallet:", operator.publicKey.toBase58());
  console.log("RPC:", rpcUrl.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>"));

  // ---- Step 1: enumerate vaultMints + parent vaults + markets.
  console.log("\n[1/6] Loading vaultMints + parent vaults + markets...");
  const allMints = await program.account.vaultMint.all();
  const allVaults = await program.account.sharedVault.all();
  const allMarkets = await program.account.optionsMarket.all();
  const vaultByPda = new Map<string, any>();
  for (const v of allVaults) vaultByPda.set(v.publicKey.toBase58(), v.account);
  const marketByPda = new Map<string, any>();
  for (const m of allMarkets) marketByPda.set(m.publicKey.toBase58(), m.account);
  console.log(`  vaultMints   : ${allMints.length}`);
  console.log(`  sharedVaults : ${allVaults.length}`);
  console.log(`  markets      : ${allMarkets.length}`);

  // ---- Step 2: qualify candidates.
  console.log("\n[2/6] Qualifying candidates...");
  const now = Math.floor(Date.now() / 1000);
  const operatorKey = operator.publicKey.toBase58();

  type Candidate = {
    vaultMintPda: PublicKey;
    optionMint: PublicKey;
    vaultPda: PublicKey;
    vaultAccount: any;
    marketPda: PublicKey;
    marketAccount: any;
    writer: PublicKey;
    premiumPerContract: BN;
    available: BN;
    createdAt: BN;
    expiry: number;
    assetName: string;
  };
  type Disqualified = { mint: string; reasons: string[] };

  const candidates: Candidate[] = [];
  const disqualified: Disqualified[] = [];

  for (const m of allMints) {
    const reasons: string[] = [];
    const optionMint = m.account.optionMint as PublicKey;
    const vaultPda = m.account.vault as PublicKey;
    const writer = m.account.writer as PublicKey;
    const quantityMinted = m.account.quantityMinted as BN;
    const quantitySold = m.account.quantitySold as BN;
    const available = quantityMinted.sub(quantitySold);
    const vaultAccount = vaultByPda.get(vaultPda.toBase58());

    if (!vaultAccount) {
      reasons.push("parent vault not found");
    } else {
      const expiry =
        typeof vaultAccount.expiry === "number"
          ? vaultAccount.expiry
          : (vaultAccount.expiry as BN).toNumber();
      if (vaultAccount.isSettled) reasons.push("vault settled");
      if (expiry <= now + EXPIRY_BUFFER_S)
        reasons.push(
          `expiry too soon (${expiry - now}s from now, need >= ${EXPIRY_BUFFER_S}s)`,
        );
      if (writer.toBase58() === operatorKey)
        reasons.push("writer == operator (self-buy blocked)");
      if (available.lt(QTY))
        reasons.push(
          `only ${available.toString()} available, need ${QTY.toString()}`,
        );

      if (reasons.length === 0) {
        const marketAccount = marketByPda.get(
          (vaultAccount.market as PublicKey).toBase58(),
        );
        if (!marketAccount) {
          reasons.push("market not found");
        } else {
          candidates.push({
            vaultMintPda: m.publicKey,
            optionMint,
            vaultPda,
            vaultAccount,
            marketPda: vaultAccount.market as PublicKey,
            marketAccount,
            writer,
            premiumPerContract: m.account.premiumPerContract as BN,
            available,
            createdAt: m.account.createdAt as BN,
            expiry,
            assetName: marketAccount.assetName as string,
          });
        }
      }
    }

    if (reasons.length > 0) {
      disqualified.push({ mint: optionMint.toBase58(), reasons });
    }
  }

  console.log(`  candidates   : ${candidates.length}`);
  console.log(`  disqualified : ${disqualified.length}`);

  if (candidates.length === 0) {
    console.log("\nNo qualifying vaultMints. Disqualification reasons:");
    for (const d of disqualified) {
      console.log(`  ${d.mint}: ${d.reasons.join("; ")}`);
    }
    process.exit(1);
  }

  // ---- Step 3: pick — SOL preferred, then cheapest, then earliest expiry.
  candidates.sort((a, b) => {
    const aIsSol = a.assetName === "SOL" ? 0 : 1;
    const bIsSol = b.assetName === "SOL" ? 0 : 1;
    if (aIsSol !== bIsSol) return aIsSol - bIsSol;
    const premCmp = a.premiumPerContract.cmp(b.premiumPerContract);
    if (premCmp !== 0) return premCmp;
    return a.expiry - b.expiry;
  });
  const target = candidates[0];

  const totalCost = target.premiumPerContract.mul(QTY);

  console.log("\n[3/6] Picked candidate:");
  console.log(`  asset            : ${target.assetName}`);
  console.log(`  option_mint      : ${target.optionMint.toBase58()}`);
  console.log(`  shared_vault     : ${target.vaultPda.toBase58()}`);
  console.log(`  vaultMint PDA    : ${target.vaultMintPda.toBase58()}`);
  console.log(`  writer           : ${target.writer.toBase58()}`);
  console.log(
    `  expiry           : ${target.expiry} (${target.expiry - now}s from now)`,
  );
  console.log(
    `  premium/contract : ${target.premiumPerContract.toString()} (${(target.premiumPerContract.toNumber() / 1e6).toFixed(2)} USDC)`,
  );
  console.log(`  available        : ${target.available.toString()}`);
  console.log(
    `  total cost (qty=${QTY.toString()}): ${totalCost.toString()} (${(totalCost.toNumber() / 1e6).toFixed(2)} USDC)`,
  );

  // ---- Step 4: derive PDAs.
  console.log("\n[4/6] Deriving PDAs...");
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    PROGRAM_ID,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const treasury = protocolState.treasury as PublicKey;
  const usdcMint = protocolState.usdcMint as PublicKey;
  const feeBps = protocolState.feeBps as number;

  const [writerPositionPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("writer_position"),
      target.vaultPda.toBuffer(),
      target.writer.toBuffer(),
    ],
    PROGRAM_ID,
  );
  const [purchaseEscrowPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("vault_purchase_escrow"),
      target.vaultPda.toBuffer(),
      target.writer.toBuffer(),
      target.createdAt.toArrayLike(Buffer, "le", 8),
    ],
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

  const buyerOptionAta = getAssociatedTokenAddressSync(
    target.optionMint,
    operator.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const buyerUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    operator.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );
  const vaultUsdcAccount = target.vaultAccount.vaultUsdcAccount as PublicKey;

  console.log("  protocol_state    :", protocolStatePda.toBase58());
  console.log("  treasury          :", treasury.toBase58());
  console.log("  usdc_mint         :", usdcMint.toBase58());
  console.log("  fee_bps           :", feeBps);
  console.log("  writer_position   :", writerPositionPda.toBase58());
  console.log("  purchase_escrow   :", purchaseEscrowPda.toBase58());
  console.log("  vault_usdc        :", vaultUsdcAccount.toBase58());
  console.log("  buyer option ATA  :", buyerOptionAta.toBase58());
  console.log("  buyer USDC ATA    :", buyerUsdcAta.toBase58());
  console.log("  extra_meta_list   :", extraAccountMetaList.toBase58());
  console.log("  hook_state        :", hookState.toBase58());

  // ---- Step 5: pre-state read + ATA pre-create + USDC sufficiency check.
  // NOTE: USDC sufficiency is checked AFTER ATA creation. If the USDC ATA
  // is missing, the pre-read returns null/0 and we'd report "insufficient
  // USDC: have 0" when the real issue is "ATA missing". Re-reading after
  // create makes the error path honest.
  console.log("\n[5/6] Pre-state + ATA pre-create:");
  const preBuyerOptionExists = (await conn.getAccountInfo(buyerOptionAta)) !== null;
  const preBuyerUsdcExists = (await conn.getAccountInfo(buyerUsdcAta)) !== null;
  const preBuyerOptionBal = await readTokenAmount(conn, buyerOptionAta);
  const preBuyerUsdcBal = await readTokenAmount(conn, buyerUsdcAta);
  console.log("  option ATA exists?:", preBuyerOptionExists);
  console.log("  USDC ATA exists?  :", preBuyerUsdcExists);
  console.log("  option balance    :", preBuyerOptionBal?.toString() ?? "(no ATA)");
  console.log("  USDC balance      :", preBuyerUsdcBal?.toString() ?? "(no ATA)");

  const ataIxs = [];
  if (!preBuyerOptionExists) {
    ataIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey,
        buyerOptionAta,
        operator.publicKey,
        target.optionMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  if (!preBuyerUsdcExists) {
    ataIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey,
        buyerUsdcAta,
        operator.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  if (ataIxs.length > 0) {
    console.log(`  pre-creating ${ataIxs.length} missing ATA(s)...`);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const ataMsg = new TransactionMessage({
      payerKey: operator.publicKey,
      recentBlockhash: blockhash,
      instructions: ataIxs,
    }).compileToV0Message();
    const ataTx = new VersionedTransaction(ataMsg);
    ataTx.sign([operator]);
    const ataSig = await conn.sendTransaction(ataTx, { skipPreflight: false });
    await conn.confirmTransaction(
      { signature: ataSig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log(`  ATA-create tx: ${ataSig}`);
  } else {
    console.log("  both ATAs already exist");
  }

  // Re-read USDC balance now that the ATA is guaranteed to exist. This is
  // the true "pre-purchase" baseline used for both the sufficiency check
  // AND the post-purchase delta calculation below.
  const usdcBalBeforePurchase =
    (await readTokenAmount(conn, buyerUsdcAta)) ?? BigInt(0);
  const requiredBigInt = BigInt(totalCost.toString());
  console.log(
    `  USDC after ATA-create: ${usdcBalBeforePurchase} (need ${requiredBigInt})`,
  );
  if (usdcBalBeforePurchase < requiredBigInt) {
    console.log(
      `\nFAIL: insufficient USDC. Have ${usdcBalBeforePurchase}, need ${requiredBigInt}. ` +
        `Top up the operator wallet's USDC ATA before retrying.`,
    );
    process.exit(1);
  }

  // ---- Step 6: send purchase_from_vault.
  console.log("\n[6/6] Sending purchase_from_vault (qty=2)...");
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
  const purchaseIx = await program.methods
    .purchaseFromVault(QTY, totalCost) // max_premium = totalCost (slippage cap = exact)
    .accountsStrict({
      buyer: operator.publicKey,
      sharedVault: target.vaultPda,
      writerPosition: writerPositionPda,
      vaultMintRecord: target.vaultMintPda,
      protocolState: protocolStatePda,
      market: target.marketPda,
      optionMint: target.optionMint,
      purchaseEscrow: purchaseEscrowPda,
      buyerOptionAccount: buyerOptionAta,
      buyerUsdcAccount: buyerUsdcAta,
      vaultUsdcAccount,
      treasury,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: operator.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuIx, purchaseIx],
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

  // ---- Post-state.
  console.log("\nPost-state:");
  const postBuyerOptionBal = await readTokenAmount(conn, buyerOptionAta);
  const postBuyerUsdcBal = await readTokenAmount(conn, buyerUsdcAta);
  const usdcDelta = usdcBalBeforePurchase - (postBuyerUsdcBal ?? BigInt(0));
  console.log("  option balance    :", postBuyerOptionBal?.toString() ?? "(missing!)");
  console.log("  USDC balance      :", postBuyerUsdcBal?.toString() ?? "(missing!)");
  console.log(
    `  USDC delta (paid) : ${usdcDelta} (expected: ${totalCost.toString()})`,
  );

  if (postBuyerOptionBal !== BigInt(2)) {
    console.log(`\nFAIL: expected option balance = 2, got ${postBuyerOptionBal}`);
    process.exit(1);
  }
  if (usdcDelta !== BigInt(totalCost.toString())) {
    console.log(
      `\nFAIL: expected USDC delta = ${totalCost.toString()}, got ${usdcDelta}`,
    );
    process.exit(1);
  }

  console.log(
    `\nOperator wallet now holds 2 contracts of mint ${target.optionMint.toBase58()}. Ready for smoke-list-v2.`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
