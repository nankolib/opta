// =============================================================================
// scripts/smoke-pass-a-devnet.ts — Phase 2 Pass A post-deploy smoke (devnet)
// =============================================================================
//
// Canaries (deployer D is operator + devnet-USDC mint authority + writer + caller):
//   2  EUR mint on a fresh 260-byte vault → premium stored verbatim. Doubles as
//      the deser-window-closed proof (the program reads the new 260-byte schema).
//   3  create_series (American, ungated) → verify mint (3 ext, dec 0, protocol
//      authority), metadata incl. exercise_style=american, hook PDAs, series
//      record sentinels (writer=default, premium=0, created_at=0) + vault PDA.
//   4  negatives: 2nd create_series on the same spec reverts (PDA init);
//      European create_series reverts SeriesMustBeAmerican (6055).
//
// NOT covered (by design): book × series (post_order Bid on the series mint) —
// the series's American vault can't be created on devnet while AMERICAN_ENABLED
// is false; bankrun series-create test 4 proves that interop deterministically.
//
// Run: RPC_URL=<helius> npx ts-node scripts/smoke-pass-a-devnet.ts
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

async function main() {
  const rpcUrl = process.env.RPC_URL ?? process.env.OPTA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, { commitment: "confirmed", confirmTransactionInitialTimeout: 90_000 });
  const D = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.OPTA_KEYPAIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".config/solana/id.json"), "utf-8"))));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(D), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const program = new Program(idl, provider) as Program<Opta>;

  console.log("=== smoke-pass-a-devnet ===");
  console.log("RPC:", redact(rpcUrl));
  console.log("D:", D.publicKey.toBase58());

  const protocolState = pda([Buffer.from("protocol_v2")]);
  const ps = await program.account.protocolState.fetch(protocolState);
  const usdcMint = ps.usdcMint as PublicKey;
  const market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
  const mkt = await program.account.optionsMarket.fetch(market);
  const volOracle = pda([Buffer.from("vol_oracle"), Buffer.from(mkt.pythFeedId as number[])]);
  const dUsdc = getAssociatedTokenAddressSync(usdcMint, D.publicKey, false, TOKEN_PROGRAM_ID);

  const now = Math.floor(Date.now() / 1000);
  const expiry = new BN(now + 7200);

  // ---- Canary 2: EUR mint on a fresh 260-byte vault → premium verbatim -------
  console.log("\n[2] EUR mint — premium verbatim (260-byte deser proof)");
  const strikeEur = usdc(140);
  const eurVault = pda([Buffer.from("shared_vault"), market.toBuffer(), strikeEur.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
  const eurVaultUsdc = pda([Buffer.from("vault_usdc"), eurVault.toBuffer()]);
  const writerPos = pda([Buffer.from("writer_position"), eurVault.toBuffer(), D.publicKey.toBuffer()]);
  // Ensure D has USDC (D is the mint authority).
  if (!(await conn.getAccountInfo(dUsdc))) { console.log("  (D USDC ATA missing — creating via deposit-side helper not needed; minting)"); }
  await mintTo(conn, D, usdcMint, dUsdc, D.publicKey, 3000 * 1_000_000).catch(() => {});
  sigs.eurVault = await program.methods.createSharedVault(strikeEur, expiry, { call: {} }, { custom: {} }, usdcMint, 0, { european: {} })
    .accountsStrict({ creator: D.publicKey, market, sharedVault: eurVault, vaultUsdcAccount: eurVaultUsdc, usdcMint, protocolState, epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .preInstructions([CU(400_000)]).rpc();
  sigs.eurDeposit = await program.methods.depositToVault(usdc(2000)).accountsStrict({ writer: D.publicKey, sharedVault: eurVault, writerPosition: writerPos, writerUsdcAccount: dUsdc, vaultUsdcAccount: eurVaultUsdc, protocolState, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
  const createdAt = new BN(now);
  const eurMint = pda([Buffer.from("vault_option_mint"), eurVault.toBuffer(), D.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)]);
  const eurEscrow = pda([Buffer.from("vault_purchase_escrow"), eurVault.toBuffer(), D.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)]);
  const eurRecord = pda([Buffer.from("vault_mint_record"), eurMint.toBuffer()]);
  const eurEaml = pda([Buffer.from("extra-account-metas"), eurMint.toBuffer()], HOOK);
  const eurHook = pda([Buffer.from("hook-state"), eurMint.toBuffer()], HOOK);
  const PREMIUM = usdc(1);
  sigs.eurMint = await program.methods.mintFromVault(new BN(3), PREMIUM, createdAt).accountsStrict({
    writer: D.publicKey, sharedVault: eurVault, writerPosition: writerPos, market, volOracle, protocolState,
    optionMint: eurMint, purchaseEscrow: eurEscrow, vaultMintRecord: eurRecord, transferHookProgram: HOOK,
    extraAccountMetaList: eurEaml, hookState: eurHook, systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
  }).preInstructions([CU(800_000)]).rpc();
  const evm = await program.account.vaultMint.fetch(eurRecord);
  check("EUR premium stored verbatim", (evm.premiumPerContract as BN).eq(PREMIUM), `stored=${(evm.premiumPerContract as BN).toString()}`);

  // ---- Canary 3: create_series (American, ungated) ---------------------------
  console.log("\n[3] create_series (American) — mint/metadata/hook/record");
  const sStrike = usdc(155);
  const sMint = pda([Buffer.from("vault_option_mint"), market.toBuffer(), sStrike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0]), Buffer.from([1])]);
  const sRecord = pda([Buffer.from("vault_mint_record"), sMint.toBuffer()]);
  const sEaml = pda([Buffer.from("extra-account-metas"), sMint.toBuffer()], HOOK);
  const sHook = pda([Buffer.from("hook-state"), sMint.toBuffer()], HOOK);
  const sVaultPda = pda([Buffer.from("shared_vault_american"), market.toBuffer(), sStrike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
  sigs.createSeries = await program.methods.createSeries(sStrike, expiry, { call: {} }, { american: {} }).accountsStrict({
    caller: D.publicKey, market, protocolState, optionMint: sMint, vaultMintRecord: sRecord,
    transferHookProgram: HOOK, extraAccountMetaList: sEaml, hookState: sHook,
    systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
  }).preInstructions([CU(800_000)]).rpc();
  console.log("  series mint:", sMint.toBase58());
  const mi = await conn.getAccountInfo(sMint);
  const md = Buffer.from(mi!.data);
  check("mint owned by Token-2022 + extensions + dec 0", mi!.owner.equals(TOKEN_2022_PROGRAM_ID) && md.length > 82 && md[44] === 0);
  check("mint authority = protocol_state", md[0] === 1 && new PublicKey(md.subarray(4, 36)).equals(protocolState));
  check("metadata exercise_style=american", md.includes(Buffer.from("exercise_style")) && md.includes(Buffer.from("american")));
  check("hook PDAs initialized", (await conn.getAccountInfo(sEaml)) !== null && (await conn.getAccountInfo(sHook)) !== null);
  const rec = await program.account.vaultMint.fetch(sRecord);
  check("record sentinels (writer=default, premium=0, createdAt=0)", (rec.writer as PublicKey).equals(PublicKey.default) && (rec.premiumPerContract as BN).isZero() && (rec.createdAt as BN).isZero());
  check("record.vault = derived American vault PDA", (rec.vault as PublicKey).equals(sVaultPda));

  // ---- Canary 4: negatives ---------------------------------------------------
  console.log("\n[4] negatives");
  let dupErr = ""; try {
    await program.methods.createSeries(sStrike, expiry, { call: {} }, { american: {} }).accountsStrict({
      caller: D.publicKey, market, protocolState, optionMint: sMint, vaultMintRecord: sRecord,
      transferHookProgram: HOOK, extraAccountMetaList: sEaml, hookState: sHook,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
  } catch (e: any) { dupErr = String(e); }
  check("2nd create_series on same spec reverts (PDA init)", dupErr.length > 0);

  const eStrike = usdc(156);
  const eMint = pda([Buffer.from("vault_option_mint"), market.toBuffer(), eStrike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0]), Buffer.from([0])]);
  const eRecord = pda([Buffer.from("vault_mint_record"), eMint.toBuffer()]);
  const eEaml = pda([Buffer.from("extra-account-metas"), eMint.toBuffer()], HOOK);
  const eHook = pda([Buffer.from("hook-state"), eMint.toBuffer()], HOOK);
  let eurErr = ""; try {
    await program.methods.createSeries(eStrike, expiry, { call: {} }, { european: {} }).accountsStrict({
      caller: D.publicKey, market, protocolState, optionMint: eMint, vaultMintRecord: eRecord,
      transferHookProgram: HOOK, extraAccountMetaList: eEaml, hookState: eHook,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
  } catch (e: any) { eurErr = String(e); }
  check("European create_series reverts SeriesMustBeAmerican (6055)", eurErr.includes("SeriesMustBeAmerican") || eurErr.includes("6055"));

  console.log("\n=== tx sigs ===");
  for (const [k, v] of Object.entries(sigs)) console.log(`  ${k}: ${v}`);
  console.log("series mint address:", sMint.toBase58());
  console.log(`\n=== ${pass ? "ALL ASSERTIONS PASSED" : "FAILURES PRESENT"} ===`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e?.message || e); if (e?.logs) console.error(e.logs.slice(-12).join("\n")); process.exit(1); });
