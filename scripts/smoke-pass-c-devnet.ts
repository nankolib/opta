// =============================================================================
// scripts/smoke-pass-c-devnet.ts — Phase 2 Pass C post-deploy smoke (devnet)
// =============================================================================
//
// Canaries (deployer D = operator + devnet-USDC mint authority + writer):
//   6  American create_and_deposit → reverts AmericanVaultsDisabled (6052):
//      proves the flag-false feature-free build is live on the NEW instruction.
//   7  EUR create_and_deposit: (a) fresh call creates vault + deposits, fields
//      correct; (b) second call into the SAME spec takes the existing path —
//      deposits only, created_at/creator verifiably UNCHANGED on-chain.
//   8  EUR mint_from_vault on that vault → premium stored verbatim (mint_from_vault
//      was touched by the a2 gate; proves the EUR mint path is byte-identical).
//   9  EUR withdraw_from_vault → withdraw uncommitted collateral succeeds
//      (withdraw_from_vault was touched by the a gate; proves EUR unchanged).
//
// Strike = $1 so collateral math is trivial (cpt = $1). Fresh (strike,expiry)
// per run → fresh vault PDA, no idempotency fights (leaves dust on devnet, OK).
//
// Run: RPC_URL=<helius> npx ts-node scripts/smoke-pass-c-devnet.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Connection, PublicKey, Keypair, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, mintTo, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const ASSET = "SOL";
const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const redact = (s: string) => s.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
const pda = (s: (Buffer | Uint8Array)[], pid: PublicKey = PROGRAM_ID) => PublicKey.findProgramAddressSync(s, pid)[0];
const sigs: Record<string, string> = {};
let pass = true;
const check = (n: string, ok: boolean, d = "") => { if (!ok) pass = false; console.log(`  [${ok ? "PASS" : "FAIL"}] ${n}${d ? ` (${d})` : ""}`); };

const CALL = { call: {} };
const CUSTOM = { custom: {} };
const EUR = { european: {} };
const AMER = { american: {} };

async function main() {
  const rpcUrl = process.env.RPC_URL ?? process.env.OPTA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, { commitment: "confirmed", confirmTransactionInitialTimeout: 90_000 });
  const D = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.OPTA_KEYPAIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config/solana/id.json"), "utf-8"))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(D), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const program = new Program(idl, provider) as Program<Opta>;

  console.log("=== smoke-pass-c-devnet ===");
  console.log("RPC:", redact(rpcUrl));
  console.log("D:", D.publicKey.toBase58());

  const protocolState = pda([Buffer.from("protocol_v2")]);
  const ps = await program.account.protocolState.fetch(protocolState);
  const usdcMint = ps.usdcMint as PublicKey;
  const market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
  const mkt = await program.account.optionsMarket.fetch(market);
  const volOracle = pda([Buffer.from("vol_oracle"), Buffer.from(mkt.pythFeedId as number[])]);
  const dUsdc = getAssociatedTokenAddressSync(usdcMint, D.publicKey, false, TOKEN_PROGRAM_ID);
  await mintTo(conn, D, usdcMint, dUsdc, D.publicKey, 5000 * 1_000_000).catch(() => {});

  const now = Math.floor(Date.now() / 1000);
  const expiry = new BN(now + 7200);
  const strike = usdc(1); // cpt = $1 — trivial collateral math

  // ---- Canary 6: American create_and_deposit → 6052 --------------------------
  console.log("\n[6] American create_and_deposit → AmericanVaultsDisabled (6052)");
  {
    const aVault = pda([Buffer.from("shared_vault_american"), market.toBuffer(), strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
    const aVaultUsdc = pda([Buffer.from("vault_usdc"), aVault.toBuffer()]);
    const aPos = pda([Buffer.from("writer_position"), aVault.toBuffer(), D.publicKey.toBuffer()]);
    let err = "";
    try {
      await program.methods.createAndDeposit(strike, expiry, CALL, CUSTOM, usdcMint, 0, AMER, usdc(100))
        .accountsStrict({ writer: D.publicKey, market, sharedVault: aVault, vaultUsdcAccount: aVaultUsdc, usdcMint, writerPosition: aPos, writerUsdcAccount: dUsdc, protocolState, epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .preInstructions([CU(400_000)]).rpc();
    } catch (e: any) { err = String(e) + " " + (e?.logs ? e.logs.join(" ") : ""); }
    check("American create_and_deposit reverts 6052", err.includes("AmericanVaultsDisabled") || err.includes("6052") || err.includes("0x17a4"), err.slice(0, 120));
  }

  // ---- Canary 7: EUR create_and_deposit fresh + existing-path ----------------
  console.log("\n[7] EUR create_and_deposit — fresh creates+deposits; existing deposits only");
  const eVault = pda([Buffer.from("shared_vault"), market.toBuffer(), strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
  const eVaultUsdc = pda([Buffer.from("vault_usdc"), eVault.toBuffer()]);
  const ePos = pda([Buffer.from("writer_position"), eVault.toBuffer(), D.publicKey.toBuffer()]);
  const cadAccounts = { writer: D.publicKey, market, sharedVault: eVault, vaultUsdcAccount: eVaultUsdc, usdcMint, writerPosition: ePos, writerUsdcAccount: dUsdc, protocolState, epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
  sigs.cadFresh = await program.methods.createAndDeposit(strike, expiry, CALL, CUSTOM, usdcMint, 0, EUR, usdc(500)).accountsStrict(cadAccounts).preInstructions([CU(400_000)]).rpc();
  const vFresh: any = await program.account.sharedVault.fetch(eVault);
  check("fresh: total_collateral = 500", (vFresh.totalCollateral as BN).eq(usdc(500)), `=${(vFresh.totalCollateral as BN).toString()}`);
  check("fresh: total_shares = 500", (vFresh.totalShares as BN).eq(usdc(500)));
  check("fresh: creator = D", (vFresh.creator as PublicKey).equals(D.publicKey));
  check("fresh: created_at > 0", (vFresh.createdAt as BN).gt(new BN(0)));

  // Second call into the SAME spec — existing path (deposit only, no rewrite).
  sigs.cadExisting = await program.methods.createAndDeposit(strike, expiry, CALL, CUSTOM, usdcMint, 0, EUR, usdc(300)).accountsStrict(cadAccounts).preInstructions([CU(400_000)]).rpc();
  const vExisting: any = await program.account.sharedVault.fetch(eVault);
  check("existing: collateral accumulated to 800", (vExisting.totalCollateral as BN).eq(usdc(800)), `=${(vExisting.totalCollateral as BN).toString()}`);
  check("existing: created_at NOT rewritten", (vExisting.createdAt as BN).eq(vFresh.createdAt as BN));
  check("existing: creator NOT rewritten", (vExisting.creator as PublicKey).equals(vFresh.creator as PublicKey));

  // ---- Canary 8: EUR mint_from_vault — premium verbatim ----------------------
  console.log("\n[8] EUR mint_from_vault — premium verbatim (a2-touched handler)");
  const createdAt = new BN(now);
  const eMint = pda([Buffer.from("vault_option_mint"), eVault.toBuffer(), D.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)]);
  const eEscrow = pda([Buffer.from("vault_purchase_escrow"), eVault.toBuffer(), D.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)]);
  const eRecord = pda([Buffer.from("vault_mint_record"), eMint.toBuffer()]);
  const eEaml = pda([Buffer.from("extra-account-metas"), eMint.toBuffer()], HOOK);
  const eHook = pda([Buffer.from("hook-state"), eMint.toBuffer()], HOOK);
  const PREMIUM = usdc(7);
  sigs.eurMint = await program.methods.mintFromVault(new BN(2), PREMIUM, createdAt).accountsStrict({
    writer: D.publicKey, sharedVault: eVault, writerPosition: ePos, market, volOracle, protocolState,
    optionMint: eMint, purchaseEscrow: eEscrow, vaultMintRecord: eRecord, transferHookProgram: HOOK,
    extraAccountMetaList: eEaml, hookState: eHook, systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
  }).preInstructions([CU(800_000)]).rpc();
  const evm: any = await program.account.vaultMint.fetch(eRecord);
  check("EUR premium stored verbatim", (evm.premiumPerContract as BN).eq(PREMIUM), `stored=${(evm.premiumPerContract as BN).toString()} expected=${PREMIUM.toString()}`);

  // ---- Canary 9: EUR withdraw_from_vault — uncommitted withdraw succeeds ------
  console.log("\n[9] EUR withdraw_from_vault — withdraw uncommitted (a-touched handler)");
  const before: any = await program.account.sharedVault.fetch(eVault);
  // 2 minted @ $1 cpt → $2 committed; free ≈ $798. Withdraw 100 shares ($100).
  sigs.eurWithdraw = await program.methods.withdrawFromVault(usdc(100)).accountsStrict({
    writer: D.publicKey, sharedVault: eVault, writerPosition: ePos, vaultUsdcAccount: eVaultUsdc,
    writerUsdcAccount: dUsdc, protocolState, tokenProgram: TOKEN_PROGRAM_ID,
  }).preInstructions([CU(400_000)]).rpc();
  const after: any = await program.account.sharedVault.fetch(eVault);
  check("withdraw reduced total_collateral by 100", (before.totalCollateral as BN).sub(after.totalCollateral as BN).eq(usdc(100)), `delta=${(before.totalCollateral as BN).sub(after.totalCollateral as BN).toString()}`);

  console.log("\n=== tx sigs ===");
  for (const [k, v] of Object.entries(sigs)) console.log(`  ${k}: ${v}`);
  console.log(`\n=== ${pass ? "ALL ASSERTIONS PASSED" : "FAILURES PRESENT"} ===`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-12).join("\n")); process.exit(1); });
