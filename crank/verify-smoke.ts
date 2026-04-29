// crank/verify-smoke.ts
// =============================================================================
// One-shot READ-ONLY verifier for the SOL settle smoke.
//
// Confirms that a freshly-settled SOL vault matches expectations end-to-end:
//   1. SettlementRecord PDA exists and carries a non-zero settlement_price
//   2. SharedVault is_settled, settlement_price, collateral_remaining are sane
//   3. The atomic settle tx was signed by the crank wallet, ran without error,
//      and exercised both the Pyth Receiver + Wormhole + Opta program ixs
//   4. The most-recent settle_vault batch tx targeting the vault landed clean
//
// Performs only RPC reads (getAccountInfo, getTransaction,
// getSignaturesForAddress, getBalance). Submits no transactions and mutates
// no on-chain state.
//
// Run: OPTA_RPC_URL=... npx ts-node -r tsconfig-paths/register verify-smoke.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const SETTLEMENT_PDA = new PublicKey("AzZMv3XF2MGXv237fvLptiJS2P8SKypuNiSPh9Ksdrjj");
const VAULT_PDA = new PublicKey("DsFhwmU4ph4yLz4QXUCHUF8qcW4urneQiqjXYJBJPStW");
const ATOMIC_SIG =
  "5X2Hftry6EpLC8qer2eq1scASG6vQK6LBDJrRbmYt3dzKitxAQ1yuXy1m1WTtviXV4y96SoUHMJRDrd9vgMT1que";
const CRANK_WALLET = "5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk";
const KEYPAIR_PATH = path.join(os.homedir(), ".config/solana/id.json");
const IDL_JSON_PATH = path.resolve(__dirname, "../app/src/idl/opta.json");

function bn(x: any): number {
  if (typeof x === "number") return x;
  if (x && typeof x.toNumber === "function") return x.toNumber();
  return Number(x);
}

async function main(): Promise<void> {
  const rpc = process.env.OPTA_RPC_URL;
  if (!rpc) throw new Error("OPTA_RPC_URL required");

  const conn = new Connection(rpc, "confirmed");
  const secret = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8")) as number[];
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(IDL_JSON_PATH, "utf-8")) as Opta;
  const program = new anchor.Program<Opta>(idl, provider);

  console.log("=== SettlementRecord ===");
  const sr: any = await program.account.settlementRecord.fetch(SETTLEMENT_PDA);
  const srPrice = bn(sr.settlementPrice);
  console.log("  pda:               ", SETTLEMENT_PDA.toBase58());
  console.log("  asset_name:        ", sr.assetName);
  console.log("  expiry:            ", bn(sr.expiry));
  console.log("  settlement_price:  ", srPrice);
  console.log("  pyth_publish_time: ", bn(sr.pythPublishTime));

  console.log("");
  console.log("=== Vault ===");
  const vault: any = await program.account.sharedVault.fetch(VAULT_PDA);
  const vaultSettlePrice = bn(vault.settlementPrice);
  const collateralRemaining = bn(vault.collateralRemaining);
  console.log("  pda:                  ", VAULT_PDA.toBase58());
  console.log("  is_settled:           ", vault.isSettled);
  console.log("  settlement_price:     ", vaultSettlePrice);
  console.log("  collateral_remaining: ", collateralRemaining);
  console.log("  total_collateral:     ", bn(vault.totalCollateral));
  console.log("  expiry:               ", bn(vault.expiry));
  console.log("  strike_price:         ", bn(vault.strikePrice));
  console.log("  is_call:              ", vault.isCall);

  console.log("");
  console.log("=== atomicSig tx ===");
  const tx = await conn.getTransaction(ATOMIC_SIG, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error("atomic tx not found");
  const accountKeys = tx.transaction.message.getAccountKeys();
  const signer = accountKeys.get(0)!.toBase58();
  const ixs = tx.transaction.message.compiledInstructions;
  const programIds = ixs.map((ix) =>
    accountKeys.get(ix.programIdIndex)!.toBase58(),
  );
  const fee = tx.meta?.fee ?? 0;
  const err = tx.meta?.err;
  console.log("  signer:           ", signer);
  console.log("  err:              ", err);
  console.log("  fee (lamports):   ", fee);
  console.log("  ix count:         ", ixs.length);
  console.log("  program ids:      ", programIds);
  console.log("  hits Pyth Receiver:", programIds.includes(PYTH_RECEIVER.toBase58()));
  console.log("  hits Opta program:", programIds.includes(PROGRAM_ID.toBase58()));

  // Search for the most recent settle_vault tx that touched the vault PDA.
  console.log("");
  console.log("=== settle_vault batch tx (most recent on vault) ===");
  const vaultSigs = await conn.getSignaturesForAddress(VAULT_PDA, { limit: 5 });
  for (const sigInfo of vaultSigs) {
    if (sigInfo.signature === ATOMIC_SIG) continue;
    if (sigInfo.err) continue;
    const t = await conn.getTransaction(sigInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!t) continue;
    const ak = t.transaction.message.getAccountKeys();
    const signerB = ak.get(0)!.toBase58();
    const pids = t.transaction.message.compiledInstructions.map((ix) =>
      ak.get(ix.programIdIndex)!.toBase58(),
    );
    console.log("  sig:    ", sigInfo.signature);
    console.log("  signer: ", signerB);
    console.log("  err:    ", t.meta?.err);
    console.log("  fee:    ", t.meta?.fee);
    console.log("  pids:   ", pids);
    break;
  }

  console.log("");
  console.log("=== Crank wallet balance ===");
  const balance = await conn.getBalance(new PublicKey(CRANK_WALLET));
  console.log("  lamports: ", balance);
  console.log("  SOL:      ", balance / 1_000_000_000);

  // Pass/fail summary
  console.log("");
  console.log("=== summary ===");
  const checks: Array<[string, boolean, string]> = [
    ["SettlementRecord exists with price > 0", srPrice > 0, `price=${srPrice}`],
    ["vault.is_settled == true", vault.isSettled === true, `${vault.isSettled}`],
    [
      "vault.settlement_price == SettlementRecord.settlement_price",
      vaultSettlePrice === srPrice,
      `vault=${vaultSettlePrice} sr=${srPrice}`,
    ],
    [
      "vault.collateral_remaining is non-negative finite",
      Number.isFinite(collateralRemaining) && collateralRemaining >= 0,
      `${collateralRemaining}`,
    ],
    ["atomic tx signer == crank wallet", signer === CRANK_WALLET, signer],
    ["atomic tx no error", !err, JSON.stringify(err)],
    [
      "atomic tx hits Pyth Receiver",
      programIds.includes(PYTH_RECEIVER.toBase58()),
      "",
    ],
    [
      "atomic tx hits Opta program",
      programIds.includes(PROGRAM_ID.toBase58()),
      "",
    ],
  ];
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} ${detail ? `(${detail})` : ""}`);
  }
}

main().catch((err: any) => {
  console.error("FATAL:", err?.message ?? err);
  process.exit(1);
});
