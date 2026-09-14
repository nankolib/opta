// =============================================================================
// scripts/smoke-stage-i-flip.ts — Stage-I post-flip canaries (devnet)
// =============================================================================
//
// Run AFTER the AMERICAN_ENABLED=true feature-free program is live. Proves:
//   1  6052 GONE (simulate-only, no tx landed): an American create_shared_vault
//      no longer reverts AmericanVaultsDisabled (6052). Inverse of the Stage-D
//      gate canary. Simulate-only so we do NOT create a real American vault.
//   2  EUR premium-verbatim (lands txs): EUR create_and_deposit + mint_from_vault
//      → VaultMint.premium_per_contract stored == the value passed in. Proves the
//      European mint path is byte-identical across the flip.
//
// Run: RPC_URL=<helius> npx ts-node scripts/smoke-stage-i-flip.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
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
  const program = new Program(idl, provider) as any;

  console.log("=== smoke-stage-i-flip ===");
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

  // ---- Canary 1: 6052 GONE (simulate-only) -----------------------------------
  console.log("\n[1] American create_shared_vault → 6052 must be GONE (simulate-only)");
  {
    const aVault = pda([Buffer.from("shared_vault_american"), market.toBuffer(), strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
    const aVaultUsdc = pda([Buffer.from("vault_usdc"), aVault.toBuffer()]);
    const tx = await (program.methods as any)
      .createSharedVault(strike, expiry, CALL, CUSTOM, usdcMint, 0, AMER)
      .accountsStrict({
        creator: D.publicKey, market, sharedVault: aVault, vaultUsdcAccount: aVaultUsdc,
        usdcMint, protocolState, epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .transaction();
    tx.feePayer = D.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const res = await conn.simulateTransaction(tx);
    const logs = res.value.logs || [];
    const joined = logs.join("\n") + " " + JSON.stringify(res.value.err);
    const is6052 = joined.includes("AmericanVaultsDisabled") || joined.includes("6052") || joined.includes("0x17a4") || joined.includes("0x17A4");
    const outcome = res.value.err === null ? "SIMULATED SUCCESS (vault would create)" : `reverted: ${JSON.stringify(res.value.err)}`;
    check("American create no longer reverts 6052 (gate removed)", !is6052, outcome);
  }

  // ---- Canary 2: EUR premium-verbatim (lands txs) ----------------------------
  console.log("\n[2] EUR create_and_deposit + mint_from_vault → premium verbatim");
  const eVault = pda([Buffer.from("shared_vault"), market.toBuffer(), strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
  const eVaultUsdc = pda([Buffer.from("vault_usdc"), eVault.toBuffer()]);
  const ePos = pda([Buffer.from("writer_position"), eVault.toBuffer(), D.publicKey.toBuffer()]);
  const cadAccounts = { writer: D.publicKey, market, sharedVault: eVault, vaultUsdcAccount: eVaultUsdc, usdcMint, writerPosition: ePos, writerUsdcAccount: dUsdc, protocolState, epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId };
  sigs.eurCreate = await program.methods.createAndDeposit(strike, expiry, CALL, CUSTOM, usdcMint, 0, EUR, usdc(500)).accountsStrict(cadAccounts).preInstructions([CU(400_000)]).rpc();
  const vFresh: any = await program.account.sharedVault.fetch(eVault);
  check("EUR fresh: total_collateral = 500", (vFresh.totalCollateral as BN).eq(usdc(500)), `=${(vFresh.totalCollateral as BN).toString()}`);

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

  console.log("\n=== tx sigs ===");
  for (const [k, v] of Object.entries(sigs)) console.log(`  ${k}: ${v}`);
  console.log(`\n=== ${pass ? "ALL ASSERTIONS PASSED" : "FAILURES PRESENT"} ===`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-12).join("\n")); process.exit(1); });
