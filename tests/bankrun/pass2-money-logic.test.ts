// =============================================================================
// tests/bankrun/pass2-money-logic.test.ts — Stage G Pass 2 proofs (bankrun)
// =============================================================================
// Proves the three Pass-2 money-logic changes, on the Pass-1 bankrun harness:
//   1. HANDSHAKE — early exercise drains the pool; at settle,
//      collateral_remaining == total_collateral − early_exercise_payout, the
//      at-expiry holder count is the LIVE supply (no double-count of burned
//      early-exercised tokens), and ALL writers withdraw (last does not fail).
//   2. EUROPEAN REGRESSION — EUR vault settles with collateral_remaining ==
//      total_collateral (subtracts 0), byte-identical.
//   3. SEED SWEEP — American post-settlement payouts (auto_finalize_holders,
//      auto_finalize_writers, withdraw_post_settlement) sign with the American-
//      namespace vault PDA → USDC transfers succeed.
//   4. STALENESS — exercise_american reverts on a price older than 60s,
//      succeeds within 60s (setClock / fixture publish_time control "now").
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
import { assert } from "chai";
import {
  setupBankrun, fundWallet, prebakeMint, prebakeTokenAccount, injectPythFixture,
  getClockUnix, setClockUnix, OPTA_PROGRAM_ID, HOOK_PROGRAM_ID, Harness,
} from "./bootstrap";
import { serializePriceUpdateV2, synthFeedIdHex } from "../_pyth_fixtures";
import { settlePotAccountsFor } from "../shared/settle-pdas";
import { synthWarmVolOracle, spotScaled } from "../_vol_oracle_helpers";

const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const FEED_HEX = synthFeedIdHex("bankrun-pass2");
const FEED_ID = Array.from(Buffer.from(FEED_HEX, "hex"));
const ASSET = "PASS2MONEY";
const EXERCISE_WINDOW = 86_400;
const CU_400 = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const CU_800 = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
const CU_1_4M = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

function pda(seeds: (Buffer | Uint8Array)[], programId = OPTA_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
function pythBody(priceUsd: number, publishTime: number): Buffer {
  const price = BigInt(priceUsd) * 100_000_000n;
  return serializePriceUpdateV2({
    feedIdHex: FEED_HEX, price, conf: 1_000_000n, exponent: -8,
    publishTime: BigInt(Math.floor(publishTime)), prevPublishTime: BigInt(Math.floor(publishTime) - 1),
    emaPrice: price, emaConf: 1_000_000n,
  });
}

describe("bankrun Pass-2 money-logic (Stage G)", function () {
  this.timeout(120_000);

  let h: Harness;
  let opta: Program<any>;
  const admin = () => h.payer;
  const usdcMint = Keypair.generate();
  let protocolState: PublicKey, treasury: PublicKey, market: PublicKey, volOracle: PublicKey;
  let now0 = 0;

  const svSeed = (style: "european" | "american") =>
    style === "american" ? "shared_vault_american" : "shared_vault";

  // Pre-bake a funded classic USDC ATA for an owner; returns the ATA.
  function usdcAtaFor(owner: PublicKey, amount = 10_000_000_000n): PublicKey {
    const ata = getAssociatedTokenAddressSync(usdcMint.publicKey, owner, false, TOKEN_PROGRAM_ID);
    prebakeTokenAccount(h.context, ata, usdcMint.publicKey, owner, amount);
    return ata;
  }
  async function usdcBal(ata: PublicKey): Promise<bigint> {
    const acc = await h.context.banksClient.getAccount(ata);
    // bankrun returns data as Uint8Array, not Node Buffer — wrap for readBigUInt64LE.
    return acc ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n;
  }
  async function tokenBal(ata: PublicKey): Promise<bigint> {
    const acc = await h.context.banksClient.getAccount(ata);
    return acc ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n;
  }

  before(async () => {
    h = await setupBankrun();
    opta = h.opta;
    prebakeMint(h.context, usdcMint.publicKey, admin().publicKey, 6);
    protocolState = pda([Buffer.from("protocol_v2")]);
    treasury = pda([Buffer.from("treasury_v2")]);
    market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
    volOracle = pda([Buffer.from("vol_oracle"), Buffer.from(FEED_ID)]);
    now0 = await getClockUnix(h.context);

    await opta.methods.initializeProtocol().accountsStrict({
      admin: admin().publicKey, protocolState, treasury, usdcMint: usdcMint.publicKey,
      systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).rpc();

    const feedFixture = Keypair.generate().publicKey;
    injectPythFixture(h.context, feedFixture, pythBody(100, now0));
    await opta.methods.createMarket(ASSET, FEED_ID, 0, 0).accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      creator: admin().publicKey, protocolState, market, priceUpdate: feedFixture,
      systemProgram: SystemProgram.programId,
    }).rpc();
    await opta.methods.initializeVolOracle(FEED_ID, 0, new BN(0)).accountsStrict({
      initializer: admin().publicKey, priceUpdate: feedFixture, volOracle,
      systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    }).rpc();
    // Warm the oracle ($100 spot) so American mint pricing reads Ok. ts = bankrun clock.
    await synthWarmVolOracle(opta, FEED_ID, spotScaled(100), admin().publicKey, new BN(now0));
  });

  // Build an American vault + writers deposit; returns handles.
  async function makeAmericanVault(strikeUsd: number, expiry: number, writers: Keypair[], deposits: number[]) {
    const strike = usdc(strikeUsd);
    const vault = pda([Buffer.from(svSeed("american")), market.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8), new BN(expiry).toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
    const vaultUsdc = pda([Buffer.from("vault_usdc"), vault.toBuffer()]);
    await opta.methods.createSharedVault(strike, new BN(expiry), { call: {} }, { custom: {} }, usdcMint.publicKey, 0, { american: {} })
      .accountsStrict({
        creator: writers[0].publicKey, market, sharedVault: vault, vaultUsdcAccount: vaultUsdc,
        usdcMint: usdcMint.publicKey, protocolState, epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).preInstructions([CU_400]).signers([writers[0]]).rpc();
    const writerPositions: PublicKey[] = [];
    for (let i = 0; i < writers.length; i++) {
      const wp = pda([Buffer.from("writer_position"), vault.toBuffer(), writers[i].publicKey.toBuffer()]);
      writerPositions.push(wp);
      await opta.methods.depositToVault(usdc(deposits[i])).accountsStrict({
        writer: writers[i].publicKey, sharedVault: vault, writerPosition: wp,
        writerUsdcAccount: usdcAtaFor(writers[i].publicKey), vaultUsdcAccount: vaultUsdc,
        protocolState, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([writers[i]]).rpc();
    }
    return { vault, vaultUsdc, strike, writerPositions };
  }

  // Mint `qty` from writer; returns mint handles.
  async function mintFrom(vault: PublicKey, writerPos: PublicKey, writer: Keypair, qty: number, createdAt: number) {
    const optionMint = pda([Buffer.from("vault_option_mint"), vault.toBuffer(), writer.publicKey.toBuffer(), new BN(createdAt).toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([Buffer.from("vault_purchase_escrow"), vault.toBuffer(), writer.publicKey.toBuffer(), new BN(createdAt).toArrayLike(Buffer, "le", 8)]);
    const vaultMintRecord = pda([Buffer.from("vault_mint_record"), optionMint.toBuffer()]);
    const extraMetas = pda([Buffer.from("extra-account-metas"), optionMint.toBuffer()], HOOK_PROGRAM_ID);
    const hookState = pda([Buffer.from("hook-state"), optionMint.toBuffer()], HOOK_PROGRAM_ID);
    await opta.methods.mintFromVault(new BN(qty), usdc(1), new BN(createdAt)).accountsStrict({
      writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos, market,
      volOracle, protocolState, optionMint, purchaseEscrow: escrow, vaultMintRecord,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU_1_4M]).signers([writer]).rpc();
    return { optionMint, escrow, vaultMintRecord, extraMetas, hookState };
  }

  async function purchase(vault: PublicKey, writerPos: PublicKey, m: any, vaultUsdc: PublicKey, buyer: Keypair, qty: number) {
    const buyerOptionAta = getAssociatedTokenAddressSync(m.optionMint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const buyerUsdc = usdcAtaFor(buyer.publicKey);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      admin().publicKey, buyerOptionAta, buyer.publicKey, m.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    await opta.methods.purchaseFromVault(new BN(qty), usdc(100000)).accountsStrict({
      buyer: buyer.publicKey, sharedVault: vault, writerPosition: writerPos, vaultMintRecord: m.vaultMintRecord,
      protocolState, market, optionMint: m.optionMint, purchaseEscrow: m.escrow, buyerOptionAccount: buyerOptionAta,
      buyerUsdcAccount: buyerUsdc, vaultUsdcAccount: vaultUsdc, treasury,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      systemProgram: SystemProgram.programId,
    }).preInstructions([CU_400, ataIx]).signers([buyer]).rpc();
    return { buyerOptionAta, buyerUsdc };
  }

  async function settle(vault: PublicKey, expiry: number, settlePriceUsd: number) {
    const settleFixture = Keypair.generate().publicKey;
    injectPythFixture(h.context, settleFixture, pythBody(settlePriceUsd, expiry + 5));
    const settlementRecord = pda([Buffer.from("settlement"), Buffer.from(ASSET), new BN(expiry).toArrayLike(Buffer, "le", 8)]);
    await opta.methods.settleExpiry(ASSET, new BN(expiry)).accountsStrict({
      caller: admin().publicKey, market, priceUpdate: settleFixture, settlementRecord,
      systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    }).preInstructions([CU_400]).rpc();
    await opta.methods.settleVault().accountsStrict({
      authority: admin().publicKey, sharedVault: vault, market, settlementRecord,
      ...(await settlePotAccountsFor(opta, market, vault)),
    }).rpc();
  }

  it("1 — HANDSHAKE: collateral_remaining = total − early_payout; no double-count; all writers withdraw", async () => {
    // Single writer: Custom vaults only allow the creator to deposit (multi-
    // writer needs an Epoch vault). One writer still proves the fix — under the
    // OLD overstated collateral_remaining the sole/last writer's withdrawal
    // would over-draw the vault and fail.
    const w1 = Keypair.generate(), buyer = Keypair.generate();
    [w1, buyer].forEach((k) => fundWallet(h.context, k));
    // Re-warm the oracle relative to the CURRENT (shared, advancing) clock.
    // ts = now+1 (not now) so this warm tx is never byte-identical to the
    // before()-hook warm when the clock hasn't advanced yet (first `it`) —
    // bankrun dedups identical-signature txs as "already processed".
    const now = await getClockUnix(h.context);
    await synthWarmVolOracle(opta, FEED_ID, spotScaled(100), admin().publicKey, new BN(now + 1));
    const expiry = now + 7 * 86_400;
    const { vault, vaultUsdc, writerPositions } = await makeAmericanVault(100, expiry, [w1], [2000]);
    const m = await mintFrom(vault, writerPositions[0], w1, 10, now);
    const { buyerOptionAta, buyerUsdc } = await purchase(vault, writerPositions[0], m, vaultUsdc, buyer, 5);

    // Early-exercise 3 pre-expiry at spot $150 → capped intrinsic $50/contract → $150 payout.
    const exFixture = Keypair.generate().publicKey;
    injectPythFixture(h.context, exFixture, pythBody(150, now0)); // publish_time = now (fresh)
    await opta.methods.exerciseAmerican(new BN(3)).accountsStrict({
      holder: buyer.publicKey, sharedVault: vault, market, priceUpdate: exFixture, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, holderOptionAccount: buyerOptionAta, vaultUsdcAccount: vaultUsdc,
      holderUsdcAccount: buyerUsdc, token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      // Pool-funded exercise → the writer-ask pot arm stays null.
      writerAskPot: null, writerAskPotUsdc: null, protocolState: null,
    }).preInstructions([CU_400]).signers([buyer]).rpc();

    let v: any = await opta.account.sharedVault.fetch(vault);
    assert.equal(v.exercisedOptions.toString(), "3", "exercised_options=3");
    assert.equal(v.earlyExercisePayout.toString(), usdc(150).toString(), "early_exercise_payout=$150");
    const buyerOptBal = await tokenBal(buyerOptionAta);
    assert.equal(buyerOptBal, 2n, "buyer has 2 live tokens (5 bought − 3 exercised)");

    // Settle at expiry, spot $150 (CALL ITM $50).
    await setClockUnix(h.context, expiry + 30);
    await settle(vault, expiry, 150);

    v = await opta.account.sharedVault.fetch(vault);
    const expected = usdc(2000).sub(usdc(150));
    console.log(`    1: collateral_remaining=${v.collateralRemaining.toString()} expected=${expected.toString()} total=${v.totalCollateral.toString()}`);
    assert.equal(v.collateralRemaining.toString(), expected.toString(), "HANDSHAKE: collateral_remaining == total − early_payout ($1850)");

    // auto_finalize_holders → buyer paid for 2 LIVE tokens (= $100), NOT 5 ($250). [seed:192 + no double-count]
    const buyerBefore = await usdcBal(buyerUsdc);
    await opta.methods.autoFinalizeHolders().accountsStrict({
      caller: admin().publicKey, sharedVault: vault, market, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, vaultUsdcAccount: vaultUsdc, protocolState,
      token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
    }).remainingAccounts([
      { pubkey: buyerOptionAta, isSigner: false, isWritable: true },
      { pubkey: buyerUsdc, isSigner: false, isWritable: true },
    ]).preInstructions([CU_800]).signers([]).rpc();
    const buyerPaid = (await usdcBal(buyerUsdc)) - buyerBefore;
    console.log(`    1: holder payout=${buyerPaid} (expect 100000000 = 2×$50, NOT 250000000)`);
    assert.equal(buyerPaid, 100_000_000n, "no double-count: holder paid for 2 live tokens only");

    // auto_finalize_writers (after EXERCISE_WINDOW) → writer paid, last does NOT fail
    // (under OLD overstated collateral_remaining the transfer/dust-sweep would
    // over-draw and revert). [seed:197 + :290]
    await setClockUnix(h.context, expiry + EXERCISE_WINDOW + 60);
    const w1usdc = getAssociatedTokenAddressSync(usdcMint.publicKey, w1.publicKey, false, TOKEN_PROGRAM_ID);
    const w1Before = await usdcBal(w1usdc);
    await opta.methods.autoFinalizeWriters().accountsStrict({
      caller: admin().publicKey, sharedVault: vault, market, vaultUsdcAccount: vaultUsdc, treasury,
      protocolState, tokenProgram: TOKEN_PROGRAM_ID,
    }).remainingAccounts([
      { pubkey: writerPositions[0], isSigner: false, isWritable: true },
      { pubkey: w1usdc, isSigner: false, isWritable: true },
      { pubkey: w1.publicKey, isSigner: false, isWritable: true },
    ]).preInstructions([CU_800]).signers([]).rpc();
    const w1Paid = (await usdcBal(w1usdc)) - w1Before;
    console.log(`    1: writer payout=${w1Paid} (> 0, signed American PDA, did not fail)`);
    assert.isTrue(w1Paid > 0n, "writer paid; American auto_finalize_writers signer + dust sweep succeeded");
  });

  it("2 — EUROPEAN regression: collateral_remaining == total_collateral (subtracts 0)", async () => {
    const w = Keypair.generate(), buyer = Keypair.generate();
    [w, buyer].forEach((k) => fundWallet(h.context, k));
    const now = await getClockUnix(h.context);
    const expiry = now + 7 * 86_400 + 100; // distinct tuple, current-clock-relative
    const strike = usdc(100);
    const vault = pda([Buffer.from(svSeed("european")), market.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8), new BN(expiry).toArrayLike(Buffer, "le", 8), Buffer.from([0])]);
    const vaultUsdc = pda([Buffer.from("vault_usdc"), vault.toBuffer()]);
    const wp = pda([Buffer.from("writer_position"), vault.toBuffer(), w.publicKey.toBuffer()]);
    await opta.methods.createSharedVault(strike, new BN(expiry), { call: {} }, { custom: {} }, usdcMint.publicKey, 0, { european: {} })
      .accountsStrict({
        creator: w.publicKey, market, sharedVault: vault, vaultUsdcAccount: vaultUsdc, usdcMint: usdcMint.publicKey,
        protocolState, epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).preInstructions([CU_400]).signers([w]).rpc();
    await opta.methods.depositToVault(usdc(500)).accountsStrict({
      writer: w.publicKey, sharedVault: vault, writerPosition: wp, writerUsdcAccount: usdcAtaFor(w.publicKey),
      vaultUsdcAccount: vaultUsdc, protocolState, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([w]).rpc();
    const m = await mintFromEur(vault, wp, w, 5, now + 1);
    await purchase(vault, wp, m, vaultUsdc, buyer, 2);

    await setClockUnix(h.context, expiry + 30);
    await settle(vault, expiry, 150);
    const v: any = await opta.account.sharedVault.fetch(vault);
    console.log(`    2: EUR collateral_remaining=${v.collateralRemaining.toString()} total=${v.totalCollateral.toString()} early_payout=${v.earlyExercisePayout.toString()}`);
    assert.equal(v.earlyExercisePayout.toString(), "0", "EUR early_exercise_payout == 0");
    assert.equal(v.collateralRemaining.toString(), v.totalCollateral.toString(), "EUR: collateral_remaining == total_collateral (−0)");
  });

  it("3 — withdraw_post_settlement signs American PDA (seed sweep :81)", async () => {
    const w = Keypair.generate();
    fundWallet(h.context, w);
    const now = await getClockUnix(h.context);
    const expiry = now + 7 * 86_400 + 200;
    const { vault, vaultUsdc, writerPositions } = await makeAmericanVault(100, expiry, [w], [500]);
    // No mint / no buyers → total_options_sold==0 → EXERCISE_WINDOW gate bypassed.
    await setClockUnix(h.context, expiry + 30);
    await settle(vault, expiry, 80); // OTM call → writers get all collateral back
    const wusdc = getAssociatedTokenAddressSync(usdcMint.publicKey, w.publicKey, false, TOKEN_PROGRAM_ID);
    const before = await usdcBal(wusdc);
    await opta.methods.withdrawPostSettlement().accountsStrict({
      writer: w.publicKey, sharedVault: vault, writerPosition: writerPositions[0], vaultUsdcAccount: vaultUsdc,
      writerUsdcAccount: wusdc, protocolState, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([w]).rpc();
    const paid = (await usdcBal(wusdc)) - before;
    console.log(`    3: withdraw_post_settlement (American) paid=${paid}`);
    assert.isTrue(paid > 0n, "American withdraw_post_settlement signed correctly + paid writer");
  });

  it("4 — STALENESS: price > 60s old reverts; within 60s succeeds", async () => {
    const w = Keypair.generate(), buyer = Keypair.generate();
    [w, buyer].forEach((k) => fundWallet(h.context, k));
    const now = await getClockUnix(h.context);
    await synthWarmVolOracle(opta, FEED_ID, spotScaled(100), admin().publicKey, new BN(now));
    const expiry = now + 7 * 86_400 + 300;
    const { vault, vaultUsdc, writerPositions } = await makeAmericanVault(100, expiry, [w], [1000]);
    const m = await mintFrom(vault, writerPositions[0], w, 10, now + 2);
    const { buyerOptionAta, buyerUsdc } = await purchase(vault, writerPositions[0], m, vaultUsdc, buyer, 5);
    const clk = await getClockUnix(h.context);

    const exArgs = (fixture: PublicKey) => ({
      holder: buyer.publicKey, sharedVault: vault, market, priceUpdate: fixture, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, holderOptionAccount: buyerOptionAta, vaultUsdcAccount: vaultUsdc,
      holderUsdcAccount: buyerUsdc, token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      // Pool-funded exercise → the writer-ask pot arm stays null.
      writerAskPot: null, writerAskPotUsdc: null, protocolState: null,
    });

    // Stale: publish_time = now − 120s (> 60) → PriceTooOld.
    const staleFix = Keypair.generate().publicKey;
    injectPythFixture(h.context, staleFix, pythBody(150, clk - 120));
    let reverted = false, err = "";
    try {
      await opta.methods.exerciseAmerican(new BN(1)).accountsStrict(exArgs(staleFix)).preInstructions([CU_400]).signers([buyer]).rpc();
    } catch (e: any) { reverted = true; err = String(e).slice(0, 120); }
    console.log(`    4: stale(now-120) reverted=${reverted} (${err})`);
    assert.isTrue(reverted, "stale price (>60s) must revert PriceTooOld");

    // Fresh: publish_time = now − 10s (<= 60) → succeeds.
    const freshFix = Keypair.generate().publicKey;
    injectPythFixture(h.context, freshFix, pythBody(150, clk - 10));
    await opta.methods.exerciseAmerican(new BN(1)).accountsStrict(exArgs(freshFix)).preInstructions([CU_400]).signers([buyer]).rpc();
    console.log("    4: fresh(now-10) succeeded");
    const v: any = await opta.account.sharedVault.fetch(vault);
    assert.equal(v.exercisedOptions.toString(), "1", "fresh exercise recorded");
  });

  // EUR mint helper (no warm-oracle dependency; oracle account just present).
  async function mintFromEur(vault: PublicKey, writerPos: PublicKey, writer: Keypair, qty: number, createdAt: number) {
    return mintFrom(vault, writerPos, writer, qty, createdAt);
  }
});
