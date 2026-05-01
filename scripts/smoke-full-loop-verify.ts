// =============================================================================
// scripts/smoke-full-loop-verify.ts — Post-crank assertions for full loop
// =============================================================================
//
// Reads scripts/.last-smoke-loop-state.json (dropped by smoke-full-loop.ts)
// and asserts every expected state transition completed:
//
//   - listing PDA closed
//   - resale escrow closed
//   - writer position closed (auto_finalize_writers ran)
//   - vault USDC closed (last-writer trigger fired)
//   - operator option ATA balance = 0 (both tokens burned)
//   - writer USDC delta matches: collateral_back + premium_share
//   - operator USDC delta matches: 2 × max(0, settlement - strike)
//   - treasury USDC delta >= 0 (already earned buy fee, may earn dust on close)
//
// Also prints the SettlementRecord's settlement_price + ITM/OTM status so
// any math discrepancy can be reconciled by hand.
//
// Run: npx ts-node scripts/smoke-full-loop-verify.ts
// Required env: RPC_URL (Helius devnet)
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const STATE_JSON_PATH = path.join(__dirname, ".last-smoke-loop-state.json");

async function readTokenAmount(
  conn: Connection,
  ata: PublicKey,
): Promise<bigint | null> {
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length < 72) return null;
  return Buffer.from(info.data.slice(64, 72)).readBigUInt64LE(0);
}

async function main() {
  if (!fs.existsSync(STATE_JSON_PATH)) {
    console.error(`FATAL: state file not found at ${STATE_JSON_PATH}`);
    console.error(`Run smoke-full-loop.ts first.`);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(STATE_JSON_PATH, "utf-8"));
  if (state.schema !== "smoke-full-loop-v1") {
    console.error(`FATAL: state schema mismatch (got "${state.schema}")`);
    process.exit(1);
  }

  const rpcUrl =
    process.env.RPC_URL ?? state.rpcUrl ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, { commitment: "confirmed" });

  // Keypair only used for AnchorProvider; this script doesn't sign anything.
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

  console.log("=== smoke-full-loop-verify ===");
  console.log(`Loaded state from ${STATE_JSON_PATH}`);
  console.log(`Test started at: ${new Date(state.timestamp * 1000).toISOString()}`);
  console.log(`Vault expired at: ${new Date(state.expiry * 1000).toISOString()}`);
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`Now            : ${new Date(nowSec * 1000).toISOString()} (expiry+${nowSec - state.expiry}s)`);

  // ---- 1. SettlementRecord -------------------------------------------------
  const marketPda = new PublicKey(state.marketPda);
  const market = await program.account.optionsMarket.fetch(marketPda);
  const assetName = market.assetName as string;
  const [settlementRecordPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("settlement"),
      Buffer.from(assetName),
      new BN(state.expiry).toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );

  let settlementPrice: bigint | null = null;
  try {
    const sr = await program.account.settlementRecord.fetch(settlementRecordPda);
    settlementPrice = BigInt((sr.settlementPrice as BN).toString());
    console.log(`\n[SettlementRecord]`);
    console.log(`  PDA   : ${settlementRecordPda.toBase58()}`);
    console.log(`  price : ${settlementPrice} ($${(Number(settlementPrice) / 1e6).toFixed(6)})`);
  } catch {
    console.error("\nFATAL: SettlementRecord NOT found — vault never settled.");
    process.exit(1);
  }

  const strike = BigInt(state.strike);
  const itm = settlementPrice > strike;
  const perContractPayout = itm ? settlementPrice - strike : BigInt(0);
  console.log(`  strike: ${strike} ($${(Number(strike) / 1e6).toFixed(2)})`);
  console.log(`  status: ${itm ? "ITM (CALL)" : "OTM (CALL)"}`);
  console.log(`  per-contract payout: ${perContractPayout} microUSDC`);

  // ---- 2. PDA closure checks ----------------------------------------------
  console.log("\n[PDA closure checks]");
  const closureChecks: Array<{ name: string; pda: string }> = [
    { name: "listing PDA       ", pda: state.listingPda },
    { name: "resale escrow     ", pda: state.resaleEscrowPda },
    { name: "writer position   ", pda: state.writerPositionPda },
    { name: "vault USDC        ", pda: state.vaultUsdcPda },
    { name: "purchase escrow   ", pda: state.purchaseEscrowPda },
  ];
  let allClosed = true;
  const closedMap: Record<string, boolean> = {};
  for (const c of closureChecks) {
    const info = await conn.getAccountInfo(new PublicKey(c.pda));
    const closed = info === null;
    closedMap[c.name.trim()] = closed;
    console.log(`  ${c.name}: ${closed ? "CLOSED ✓" : "STILL OPEN ✗"}`);
    if (!closed) allClosed = false;
  }
  // Note: purchase_escrow may still be open if there were unsold contracts
  // — auto-finalize doesn't burn them (per the parked tech debt in HANDOFF
  // §7). Don't hard-fail on it; it's expected.
  if (!closedMap["purchase escrow"]) {
    console.log(`  (purchase escrow still open is EXPECTED — see HANDOFF §7 burn_unsold sequence issue)`);
  }

  // ---- 3. Token balances ---------------------------------------------------
  console.log("\n[Token balances]");
  const operatorOptionAta = new PublicKey(state.operatorOptionAta);
  const postOperatorOption = (await readTokenAmount(conn, operatorOptionAta)) ?? BigInt(0);
  console.log(`  operator option ATA : ${postOperatorOption} (expected: 0)`);

  // ---- 4. USDC deltas ------------------------------------------------------
  const operatorUsdcAta = new PublicKey(state.operatorUsdcAta);
  const writerUsdcAta = new PublicKey(state.writerUsdcAta);
  const treasury = new PublicKey(state.treasuryPda);

  const postOperatorUsdc = (await readTokenAmount(conn, operatorUsdcAta)) ?? BigInt(0);
  const postWriterUsdc = (await readTokenAmount(conn, writerUsdcAta)) ?? BigInt(0);
  const postTreasuryUsdc = (await readTokenAmount(conn, treasury)) ?? BigInt(0);

  const opUsdcDelta = postOperatorUsdc - BigInt(state.preTestOperatorUsdc);
  const wrUsdcDelta = postWriterUsdc - BigInt(state.preTestWriterUsdc);
  const trUsdcDelta = postTreasuryUsdc - BigInt(state.preTestTreasuryUsdc);

  console.log("\n[USDC deltas vs pre-test snapshot]");
  console.log(`  operator: ${opUsdcDelta} microUSDC ($${(Number(opUsdcDelta) / 1e6).toFixed(6)})`);
  console.log(`  writer  : ${wrUsdcDelta} microUSDC ($${(Number(wrUsdcDelta) / 1e6).toFixed(6)})`);
  console.log(`  treasury: ${trUsdcDelta} microUSDC ($${(Number(trUsdcDelta) / 1e6).toFixed(6)})`);

  // ---- 5. Expected math ----------------------------------------------------
  // Operator: bought 2, all 2 burned at expiry, paid out per-contract × 2.
  // (List/cancel doesn't move USDC; auto-cancel returns the listed token,
  // then auto-finalize burns both tokens + pays out.)
  const expectedOperatorDelta = perContractPayout * BigInt(state.qtyOperatorBought);

  // Writer: gets all collateral_remaining (sole writer) + accumulated premium
  // share. Initial collateral = strike × 2 × 5 = $500. Holders received
  // perContractPayout × 2 = (qty_sold × payout). Writer collateral_remaining
  // = initial - holder_payouts. Writer premium_share = qty_sold × premium ×
  // (1 - fee_bps/10000).
  const initialCollateral = strike * BigInt(2) * BigInt(state.qtyMinted);
  const holderPayoutsTotal = perContractPayout * BigInt(state.qtyOperatorBought);
  const collateralBack = initialCollateral - holderPayoutsTotal;
  const totalPremium =
    BigInt(state.premiumPerContract) * BigInt(state.qtyOperatorBought);
  const fee = (totalPremium * BigInt(state.feeBps)) / BigInt(10_000);
  const writerPremiumShare = totalPremium - fee;
  const expectedWriterDelta = collateralBack + writerPremiumShare;

  console.log("\n[Expected deltas (computed from settlement)]");
  console.log(`  operator: +${expectedOperatorDelta} microUSDC ($${(Number(expectedOperatorDelta) / 1e6).toFixed(6)})`);
  console.log(`  writer  : +${expectedWriterDelta} microUSDC ($${(Number(expectedWriterDelta) / 1e6).toFixed(6)})`);
  console.log(`    breakdown:`);
  console.log(`      initial collateral : ${initialCollateral} ($${(Number(initialCollateral) / 1e6).toFixed(2)})`);
  console.log(`      − holder payouts   : ${holderPayoutsTotal} ($${(Number(holderPayoutsTotal) / 1e6).toFixed(6)})`);
  console.log(`      = collateral back  : ${collateralBack}`);
  console.log(`      + writer premium   : ${writerPremiumShare} ($${(Number(writerPremiumShare) / 1e6).toFixed(6)})`);

  // ---- 6. Assertions -------------------------------------------------------
  console.log("\n[Assertions]");
  // Note: vault USDC closure pushes any USDC dust to treasury; writer's
  // delta SHOULD include the buy-time premium share (which is in the vault
  // USDC at time of close). We do NOT include the dust sweep in the writer
  // expected delta — last-writer dust goes to treasury, not the writer.
  const operatorMatches = opUsdcDelta === expectedOperatorDelta;
  const writerMatches = wrUsdcDelta === expectedWriterDelta;
  const treasuryNonNegative = trUsdcDelta >= BigInt(0);
  const operatorOptionBurned = postOperatorOption === BigInt(0);

  // Listing closure + writer position closure are the load-bearing
  // assertions. Vault USDC closure is required (proves last-writer trigger
  // fired). Purchase escrow may stay open (known parked tech debt).
  const requiredClosures =
    closedMap["listing PDA"] &&
    closedMap["resale escrow"] &&
    closedMap["writer position"] &&
    closedMap["vault USDC"];

  const assertions: Array<{ name: string; pass: boolean; detail?: string }> = [
    {
      name: "listing + escrow + writer pos + vault USDC closed",
      pass: requiredClosures,
    },
    { name: "operator option ATA = 0", pass: operatorOptionBurned, detail: `got ${postOperatorOption}` },
    {
      name: `operator USDC delta = ${expectedOperatorDelta}`,
      pass: operatorMatches,
      detail: `got ${opUsdcDelta}`,
    },
    {
      name: `writer USDC delta = ${expectedWriterDelta}`,
      pass: writerMatches,
      detail: `got ${wrUsdcDelta}`,
    },
    {
      name: "treasury USDC delta >= 0",
      pass: treasuryNonNegative,
      detail: `got ${trUsdcDelta}`,
    },
  ];

  let allPass = true;
  for (const a of assertions) {
    console.log(
      `  ${a.pass ? "PASS" : "FAIL"} : ${a.name}${
        a.detail && !a.pass ? ` (${a.detail})` : ""
      }`,
    );
    if (!a.pass) allPass = false;
  }

  const sep = "=".repeat(60);
  console.log("\n" + sep);
  if (allPass) {
    console.log("✓ FULL LOOP VERIFIED — all on-chain transitions matched expectations");
  } else {
    console.log("✗ VERIFICATION FAILED — see assertion log above");
  }
  console.log(sep);
  console.log(
    "\n(Look for VaultListingsAutoCancelled in the crank logs to confirm",
  );
  console.log(
    " listings_cancelled=1 + tokens_returned=1 from the auto-cancel pass.)",
  );

  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
