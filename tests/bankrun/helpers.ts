// =============================================================================
// tests/bankrun/helpers.ts — Stage G Pass 3a shared bankrun helpers
// =============================================================================
// Factors the proven Pass-1/Pass-2 bankrun patterns into reusable builders so
// the ported clock-dependent suites stay concise. Each ported test file calls
// setupEnv() in a fresh bankrun context (fresh SVM → isolated, also sidesteps
// the shared-protocol-state contamination class).
// =============================================================================

import { Program } from "@coral-xyz/anchor";
import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  setupBankrun, fundWallet, prebakeMint, prebakeTokenAccount, injectPythFixture,
  getClockUnix, setClockUnix, OPTA_PROGRAM_ID, HOOK_PROGRAM_ID, Harness,
} from "./bootstrap";
import { serializePriceUpdateV2, synthFeedIdHex } from "../_pyth_fixtures";
import { settlePotAccountsFor } from "../shared/settle-pdas";
import { synthWarmVolOracle, spotScaled } from "../_vol_oracle_helpers";

export {
  setupBankrun, fundWallet, getClockUnix, setClockUnix, OPTA_PROGRAM_ID, HOOK_PROGRAM_ID,
  PublicKey, Keypair, BN, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, injectPythFixture,
};
export const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
export const EXERCISE_WINDOW = 86_400;
export const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });

export function pda(seeds: (Buffer | Uint8Array)[], programId = OPTA_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export interface Env {
  h: Harness;
  opta: Program<any>;
  admin: Keypair;
  usdcMint: PublicKey;
  protocolState: PublicKey;
  treasury: PublicKey;
  market: PublicKey;
  volOracle: PublicKey;
  feedHex: string;
  feedId: number[];
  asset: string;
}

export function pythBody(feedHex: string, priceUsd: number, publishTime: number): Buffer {
  // Round INTO the 8-dec fixed-point rather than BigInt(priceUsd) * 1e8, which
  // throws on any non-integer dollar figure. Identical output for every integer
  // caller; fractional strikes/spots (e.g. the $75.20 writer-ask series) need it.
  const price = BigInt(Math.round(priceUsd * 100_000_000)); // expo -8
  return serializePriceUpdateV2({
    feedIdHex: feedHex, price, conf: 1_000_000n, exponent: -8,
    publishTime: BigInt(Math.floor(publishTime)), prevPublishTime: BigInt(Math.floor(publishTime) - 1),
    emaPrice: price, emaConf: 1_000_000n,
  });
}

/** Fresh env: bankrun ctx (deployer wallet) + protocol + market + warmed oracle. */
export async function setupEnv(asset: string, feedLabel: string, warmSpotUsd = 100): Promise<Env> {
  const h = await setupBankrun();
  const opta = h.opta;
  const admin = h.payer;
  const usdcMint = Keypair.generate().publicKey;
  prebakeMint(h.context, usdcMint, admin.publicKey, 6);
  const feedHex = synthFeedIdHex(feedLabel);
  const feedId = Array.from(Buffer.from(feedHex, "hex"));
  const protocolState = pda([Buffer.from("protocol_v2")]);
  const treasury = pda([Buffer.from("treasury_v2")]);
  const market = pda([Buffer.from("market"), Buffer.from(asset)]);
  const volOracle = pda([Buffer.from("vol_oracle"), Buffer.from(feedId)]);
  const now = await getClockUnix(h.context);

  await opta.methods.initializeProtocol().accountsStrict({
    admin: admin.publicKey, protocolState, treasury, usdcMint,
    systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
  }).rpc();

  const feedFixture = Keypair.generate().publicKey;
  injectPythFixture(h.context, feedFixture, pythBody(feedHex, warmSpotUsd, now));
  await opta.methods.createMarket(asset, feedId, 0, 0).accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    creator: admin.publicKey, protocolState, market, priceUpdate: feedFixture,
    systemProgram: SystemProgram.programId,
  }).rpc();
  await opta.methods.initializeVolOracle(feedId, 0, new BN(0)).accountsStrict({
    initializer: admin.publicKey, priceUpdate: feedFixture, volOracle,
    systemProgram: SystemProgram.programId,
    sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
  }).rpc();
  await synthWarmVolOracle(opta, feedId, spotScaled(warmSpotUsd), admin.publicKey, new BN(now));

  return { h, opta, admin, usdcMint, protocolState, treasury, market, volOracle, feedHex, feedId, asset };
}

export { spotScaled, synthWarmVolOracle };

const optIdx = (o: any) => ("put" in o ? 1 : 0);
const svSeed = (style: "european" | "american") =>
  style === "american" ? "shared_vault_american" : "shared_vault";

/** Idempotently ensure a funded classic USDC ATA; returns the ATA.
 * MUST be idempotent: re-baking (overwriting amount) on a later call would reset
 * the balance and corrupt balance-delta assertions in claim/withdraw helpers. */
export async function usdcAta(e: Env, owner: PublicKey, amount = 10_000_000_000n): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(e.usdcMint, owner, false, TOKEN_PROGRAM_ID);
  if (!(await e.h.context.banksClient.getAccount(ata))) {
    prebakeTokenAccount(e.h.context, ata, e.usdcMint, owner, amount);
  }
  return ata;
}
export async function bal(e: Env, ata: PublicKey): Promise<bigint> {
  const acc = await e.h.context.banksClient.getAccount(ata);
  return acc ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n;
}
export async function exists(e: Env, addr: PublicKey): Promise<boolean> {
  return (await e.h.context.banksClient.getAccount(addr)) !== null;
}

export function deriveVault(e: Env, style: "european" | "american", strike: BN, expiry: BN, optionType: any) {
  const vault = pda([Buffer.from(svSeed(style)), e.market.toBuffer(),
    strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([optIdx(optionType)])]);
  const vaultUsdc = pda([Buffer.from("vault_usdc"), vault.toBuffer()]);
  return { vault, vaultUsdc };
}

/** create_shared_vault (Custom). creator must sign. */
export async function createVault(
  e: Env, style: "european" | "american", strike: BN, expiry: BN, optionType: any, creator: Keypair,
) {
  const { vault, vaultUsdc } = deriveVault(e, style, strike, expiry, optionType);
  const styleArg = style === "american" ? { american: {} } : { european: {} };
  await e.opta.methods.createSharedVault(strike, expiry, optionType, { custom: {} }, e.usdcMint, 0, styleArg)
    .accountsStrict({
      creator: creator.publicKey, market: e.market, sharedVault: vault, vaultUsdcAccount: vaultUsdc,
      usdcMint: e.usdcMint, protocolState: e.protocolState, epochConfig: null,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).preInstructions([CU(400_000)]).signers([creator]).rpc();
  return { vault, vaultUsdc };
}

export async function deposit(e: Env, vault: PublicKey, vaultUsdc: PublicKey, writer: Keypair, amountUsd: number) {
  const writerPos = pda([Buffer.from("writer_position"), vault.toBuffer(), writer.publicKey.toBuffer()]);
  await e.opta.methods.depositToVault(usdc(amountUsd)).accountsStrict({
    writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos,
    writerUsdcAccount: await usdcAta(e, writer.publicKey), vaultUsdcAccount: vaultUsdc,
    protocolState: e.protocolState, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).signers([writer]).rpc();
  return writerPos;
}

export async function mint(
  e: Env, vault: PublicKey, writerPos: PublicKey, writer: Keypair, qty: number, createdAt: number, american: boolean,
) {
  const ca = new BN(createdAt);
  const optionMint = pda([Buffer.from("vault_option_mint"), vault.toBuffer(), writer.publicKey.toBuffer(), ca.toArrayLike(Buffer, "le", 8)]);
  const escrow = pda([Buffer.from("vault_purchase_escrow"), vault.toBuffer(), writer.publicKey.toBuffer(), ca.toArrayLike(Buffer, "le", 8)]);
  const vaultMintRecord = pda([Buffer.from("vault_mint_record"), optionMint.toBuffer()]);
  const extraMetas = pda([Buffer.from("extra-account-metas"), optionMint.toBuffer()], HOOK_PROGRAM_ID);
  const hookState = pda([Buffer.from("hook-state"), optionMint.toBuffer()], HOOK_PROGRAM_ID);
  await e.opta.methods.mintFromVault(new BN(qty), usdc(5), ca).accountsStrict({
    writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos, market: e.market,
    volOracle: e.volOracle, protocolState: e.protocolState, optionMint, purchaseEscrow: escrow, vaultMintRecord,
    transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState,
    systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
  }).preInstructions([CU(american ? 1_400_000 : 800_000)]).signers([writer]).rpc();
  return { optionMint, escrow, vaultMintRecord, extraMetas, hookState };
}

/** create_series — the CANONICAL per-spec series mint (writer-sentinel == default).
 * Phase 3 Slice D2.5: writer-asks may only rest on canonical mints, so the
 * writer-ask test suites post on this (not the per-writer `mint()`). Returns a
 * mint-shaped object the post/fill helpers consume. American-only (D12). */
export async function createSeries(e: Env, strike: BN, expiry: BN, optionType: any) {
  const otB = "put" in optionType ? 1 : 0;
  const optionMint = pda([Buffer.from("vault_option_mint"), e.market.toBuffer(),
    strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([otB]), Buffer.from([1])]);
  const s = {
    optionMint,
    vaultMintRecord: pda([Buffer.from("vault_mint_record"), optionMint.toBuffer()]),
    extraMetas: pda([Buffer.from("extra-account-metas"), optionMint.toBuffer()], HOOK_PROGRAM_ID),
    hookState: pda([Buffer.from("hook-state"), optionMint.toBuffer()], HOOK_PROGRAM_ID),
  };
  await e.opta.methods.createSeries(strike, expiry, optionType, { american: {} }).accountsStrict({
    caller: e.admin.publicKey, market: e.market, protocolState: e.protocolState,
    optionMint: s.optionMint, vaultMintRecord: s.vaultMintRecord, transferHookProgram: HOOK_PROGRAM_ID,
    extraAccountMetaList: s.extraMetas, hookState: s.hookState,
    systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
  }).preInstructions([CU(800_000)]).rpc();
  return s;
}

export async function purchase(e: Env, vault: PublicKey, writerPos: PublicKey, m: any, vaultUsdc: PublicKey, buyer: Keypair, qty: number) {
  const buyerOptionAta = getAssociatedTokenAddressSync(m.optionMint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const buyerUsdc = await usdcAta(e, buyer.publicKey);
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    e.admin.publicKey, buyerOptionAta, buyer.publicKey, m.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  await e.opta.methods.purchaseFromVault(new BN(qty), usdc(100000)).accountsStrict({
    buyer: buyer.publicKey, sharedVault: vault, writerPosition: writerPos, vaultMintRecord: m.vaultMintRecord,
    protocolState: e.protocolState, market: e.market, optionMint: m.optionMint, purchaseEscrow: m.escrow,
    buyerOptionAccount: buyerOptionAta, buyerUsdcAccount: buyerUsdc, vaultUsdcAccount: vaultUsdc, treasury: e.treasury,
    tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
    systemProgram: SystemProgram.programId,
  }).preInstructions([CU(400_000), ataIx]).signers([buyer]).rpc();
  return { buyerOptionAta, buyerUsdc };
}

export function settlementRecordPda(e: Env, expiry: BN): PublicKey {
  return pda([Buffer.from("settlement"), Buffer.from(e.asset), expiry.toArrayLike(Buffer, "le", 8)]);
}

/** settle_expiry only — caller controls clock + publishTime for revert tests. */
export async function settleExpiry(e: Env, expiry: BN, priceUsd: number, publishTime: number) {
  const fix = Keypair.generate().publicKey;
  injectPythFixture(e.h.context, fix, pythBody(e.feedHex, priceUsd, publishTime));
  await e.opta.methods.settleExpiry(e.asset, expiry).accountsStrict({
    caller: e.admin.publicKey, market: e.market, priceUpdate: fix,
    settlementRecord: settlementRecordPda(e, expiry), systemProgram: SystemProgram.programId,
    // Stage 3 1b: trailing Switchboard read-arm optionals — null on Pyth path.
    sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
  }).preInstructions([CU(400_000)]).rpc();
}

/** Phase 3 retro-harden: settle_vault's now-required pot accounts, derived from
 * the vault's on-chain identity (empty-derived for no-pot / EUR vaults). */
export async function settlePotAccounts(e: Env, vault: PublicKey) {
  return settlePotAccountsFor(e.opta, e.market, vault);
}

/** Full settle at/after expiry: setClock(expiry+30), settle_expiry(publish=expiry+5), settle_vault. */
export async function settle(e: Env, vault: PublicKey, expiry: BN, priceUsd: number) {
  const exp = expiry.toNumber();
  await setClockUnix(e.h.context, exp + 30);
  await settleExpiry(e, expiry, priceUsd, exp + 5);
  const sp = await settlePotAccounts(e, vault);
  await e.opta.methods.settleVault().accountsStrict({
    authority: e.admin.publicKey, sharedVault: vault, market: e.market, settlementRecord: settlementRecordPda(e, expiry),
    // Phase 3 retro-harden — required, derived from vault identity (empty for no-pot).
    ...sp,
  }).rpc();
}

export async function exerciseFromVault(e: Env, vault: PublicKey, m: any, holder: Keypair, holderOptAta: PublicKey, holderUsdc: PublicKey, qty: number) {
  await e.opta.methods.exerciseFromVault(new BN(qty)).accountsStrict({
    holder: holder.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
    optionMint: m.optionMint, holderOptionAccount: holderOptAta, vaultUsdcAccount: deriveVaultUsdc(vault),
    holderUsdcAccount: holderUsdc, protocolState: e.protocolState,
    token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
  }).preInstructions([CU(400_000)]).signers([holder]).rpc();
}

/** The writer-ask pot payout arm (2026-08-15). Pass `null` (the default) for a
 * pool-funded exercise: all three trailing optionals go out as null and the tx is
 * byte-identical to every exercise built before the arm existed. Pass the two pot
 * addresses when the vault's own USDC account cannot cover the payout — the
 * handler pairs them with protocol_state, the authority that already moves this
 * money at settlement. */
export async function exerciseAmerican(
  e: Env, vault: PublicKey, m: any, holder: Keypair, holderOptAta: PublicKey, holderUsdc: PublicKey,
  qty: number, spotUsd: number, publishTime: number,
  pot: { writerAskPot: PublicKey; writerAskPotUsdc: PublicKey } | null = null,
) {
  const fix = Keypair.generate().publicKey;
  injectPythFixture(e.h.context, fix, pythBody(e.feedHex, spotUsd, publishTime));
  await e.opta.methods.exerciseAmerican(new BN(qty)).accountsStrict({
    holder: holder.publicKey, sharedVault: vault, market: e.market, priceUpdate: fix, vaultMintRecord: m.vaultMintRecord,
    optionMint: m.optionMint, holderOptionAccount: holderOptAta, vaultUsdcAccount: deriveVaultUsdc(vault),
    holderUsdcAccount: holderUsdc, token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
    // Stage 3: trailing Switchboard read-arm optionals — null on the Pyth path.
    sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    // Writer-ask pot arm — anchor 0.32.1 does not auto-null unprovided optionals
    // under accountsStrict, so all three are always named.
    writerAskPot: pot ? pot.writerAskPot : null,
    writerAskPotUsdc: pot ? pot.writerAskPotUsdc : null,
    protocolState: pot ? e.protocolState : null,
  }).preInstructions([CU(400_000)]).signers([holder]).rpc();
}

export async function autoFinalizeHolders(e: Env, vault: PublicKey, m: any, vaultUsdc: PublicKey, pairs: PublicKey[][]) {
  await e.opta.methods.autoFinalizeHolders().accountsStrict({
    caller: e.admin.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
    optionMint: m.optionMint, vaultUsdcAccount: vaultUsdc, protocolState: e.protocolState,
    token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
  }).remainingAccounts(pairs.flatMap(([opt, usdc2]) => ([
    { pubkey: opt, isSigner: false, isWritable: true },
    { pubkey: usdc2, isSigner: false, isWritable: true },
  ]))).preInstructions([CU(1_400_000)]).rpc();
}

export async function autoFinalizeWriters(e: Env, vault: PublicKey, vaultUsdc: PublicKey, triples: PublicKey[][]) {
  await e.opta.methods.autoFinalizeWriters().accountsStrict({
    caller: e.admin.publicKey, sharedVault: vault, market: e.market, vaultUsdcAccount: vaultUsdc,
    treasury: e.treasury, protocolState: e.protocolState, tokenProgram: TOKEN_PROGRAM_ID,
  }).remainingAccounts(triples.flatMap(([pos, u, w]) => ([
    { pubkey: pos, isSigner: false, isWritable: true },
    { pubkey: u, isSigner: false, isWritable: true },
    { pubkey: w, isSigner: false, isWritable: true },
  ]))).preInstructions([CU(1_400_000)]).rpc();
}

export async function withdrawPostSettlement(e: Env, vault: PublicKey, writerPos: PublicKey, writer: Keypair) {
  const wusdc = getAssociatedTokenAddressSync(e.usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);
  await e.opta.methods.withdrawPostSettlement().accountsStrict({
    writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos, vaultUsdcAccount: deriveVaultUsdc(vault),
    writerUsdcAccount: wusdc, protocolState: e.protocolState, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).signers([writer]).rpc();
}

export function deriveVaultUsdc(vault: PublicKey): PublicKey {
  return pda([Buffer.from("vault_usdc"), vault.toBuffer()]);
}

export async function claimPremium(e: Env, vault: PublicKey, writerPos: PublicKey, writer: Keypair) {
  await e.opta.methods.claimPremium().accountsStrict({
    writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos,
    vaultUsdcAccount: deriveVaultUsdc(vault), writerUsdcAccount: await usdcAta(e, writer.publicKey),
    protocolState: e.protocolState, tokenProgram: TOKEN_PROGRAM_ID,
  }).signers([writer]).rpc();
}

export async function withdrawFromVault(e: Env, vault: PublicKey, writerPos: PublicKey, writer: Keypair, shares: number) {
  await e.opta.methods.withdrawFromVault(usdc(shares)).accountsStrict({
    writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos,
    vaultUsdcAccount: deriveVaultUsdc(vault), writerUsdcAccount: await usdcAta(e, writer.publicKey),
    protocolState: e.protocolState, tokenProgram: TOKEN_PROGRAM_ID,
  }).signers([writer]).rpc();
}

/** Inject `delta` micro-USDC of "dust" into a token account by bumping its amount field (bytes 64..72). */
export async function bumpTokenAmount(e: Env, ata: PublicKey, delta: number) {
  const acc = await e.h.context.banksClient.getAccount(ata);
  if (!acc) throw new Error("token account not found for dust injection");
  const data = Buffer.from(acc.data);
  data.writeBigUInt64LE(data.readBigUInt64LE(64) + BigInt(delta), 64);
  e.h.context.setAccount(ata, { lamports: acc.lamports, data, owner: acc.owner, executable: acc.executable, rentEpoch: Number(acc.rentEpoch) });
}

/** Fund a fresh actor keypair with SOL + return it. */
export function actor(e: Env): Keypair {
  const k = Keypair.generate();
  fundWallet(e.h.context, k);
  return k;
}
