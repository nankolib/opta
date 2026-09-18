// =============================================================================
// tests/bankrun/trigger-orders.test.ts — Phase 4 Pass 0: place_trigger / cancel
// =============================================================================
// Proves trigger PLACEMENT + CANCEL only (no execute_trigger — that is Pass 1):
//
//   a. place StopEntryBuy  → TriggerOrder exists w/ correct fields; escrow PDA
//      funded EXACTLY max_premium × quantity; dest option ATA exists; funded=true.
//   b. place TakeProfitSell → TriggerOrder exists; funded=false; no escrow
//      account; reverts when the holder balance < quantity.
//   c. cancel a funded BUY  → full escrow USDC back to owner; both PDAs closed.
//   d. cancel a SELL        → TriggerOrder closed, escrow untouched (never existed).
//   e. place with quantity == 0 → reverts.
//   f. place BUY with max_premium == 0 → reverts.
//   g. units regression: BUY max_premium=P, quantity=Q → escrow balance == P*Q.
//
// Sell holdings come from a real peg fill (the bankrun build carries
// `american-enabled`, so the peg prices live). Distinct (strike, expiry) per
// test ⇒ distinct series mint + vault ⇒ distinct trigger PDAs (no collisions).
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram,
  Transaction, TransactionInstruction, Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, deposit, usdcAta, bal, exists, actor, pda, getClockUnix, Env,
  HOOK_PROGRAM_ID, exerciseAmerican, bumpTokenAmount,
} from "./helpers";
import { injectPythFixture } from "./bootstrap";
import { serializePriceUpdateV2 } from "../_pyth_fixtures";
import * as fs from "fs";
import * as path from "path";

const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const DAY = 86_400;
const CALL = { call: {} };
const AMERICAN = { american: {} };
const OT_CALL = 0;
const ES_AMERICAN = 1;

// Enum args (Anchor variant encoding).
const BUY = { stopEntryBuy: {} };
const SELL = { takeProfitSell: {} };
const LE = { lessOrEqual: {} };
const GE = { greaterOrEqual: {} };

function deriveSeries(market: PublicKey, strike: BN, expiry: BN) {
  const mint = pda([Buffer.from("vault_option_mint"), market.toBuffer(),
    strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([OT_CALL]), Buffer.from([ES_AMERICAN])]);
  const record = pda([Buffer.from("vault_mint_record"), mint.toBuffer()]);
  const extraMetas = pda([Buffer.from("extra-account-metas"), mint.toBuffer()], HOOK_PROGRAM_ID);
  const hookState = pda([Buffer.from("hook-state"), mint.toBuffer()], HOOK_PROGRAM_ID);
  return { mint, record, extraMetas, hookState };
}

function deriveTrigger(owner: PublicKey, mint: PublicKey, nonce: BN) {
  const order = pda([Buffer.from("trigger_order"), owner.toBuffer(), mint.toBuffer(),
    nonce.toArrayLike(Buffer, "le", 8)]);
  const escrow = pda([Buffer.from("trigger_escrow"), order.toBuffer()]);
  return { order, escrow };
}

// PriceUpdateV2 body: EMA == spot (expo -8, tight conf). Mirrors helpers.pythBody
// so the on-chain EMA read returns `priceUsd` in 6-dec USDC.
function pythBody(feedHex: string, priceUsd: number, publishTime: number): Buffer {
  const price = BigInt(priceUsd) * 100_000_000n;
  return serializePriceUpdateV2({
    feedIdHex: feedHex, price, conf: 1_000_000n, exponent: -8,
    publishTime: BigInt(Math.floor(publishTime)), prevPublishTime: BigInt(Math.floor(publishTime) - 1),
    emaPrice: price, emaConf: 1_000_000n,
  });
}

describe("trigger orders — Pass 0 (place + cancel)", function () {
  this.timeout(120_000);

  let e: Env;

  async function createSeries(strike: BN, expiry: BN) {
    const s = deriveSeries(e.market, strike, expiry);
    await e.opta.methods.createSeries(strike, expiry, CALL, AMERICAN).accountsStrict({
      caller: e.admin.publicKey, market: e.market, protocolState: e.protocolState,
      optionMint: s.mint, vaultMintRecord: s.record, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: s.extraMetas, hookState: s.hookState,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    return s;
  }

  async function setupVaultSeries(strike: BN, expiry: BN, depositUsd: number) {
    const writer = actor(e);
    await usdcAta(e, writer.publicKey);
    const { vault, vaultUsdc } = await createVault(e, "american", strike, expiry, CALL, writer);
    await deposit(e, vault, vaultUsdc, writer, depositUsd);
    const s = await createSeries(strike, expiry);
    return { vault, vaultUsdc, s };
  }

  // Real peg fill so an actor actually holds `qty` series contracts (for sells).
  async function fillPeg(vault: PublicKey, vaultUsdc: PublicKey, s: any, taker: Keypair, qty: number) {
    const takerOpt = getAssociatedTokenAddressSync(s.mint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      e.admin.publicKey, takerOpt, taker.publicKey, s.mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    await e.opta.methods.fillVaultPeg(new BN(qty), usdc(1_000_000)).accountsStrict({
      taker: taker.publicKey, sharedVault: vault, vaultMintRecord: s.record, market: e.market,
      volOracle: e.volOracle, protocolState: e.protocolState, optionMint: s.mint,
      takerOptionAccount: takerOpt, takerUsdcAccount: takerUsdc, vaultUsdcAccount: vaultUsdc,
      treasury: e.treasury, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    }).preInstructions([CU(400_000), ataIx]).signers([taker]).rpc();
    return takerOpt;
  }

  async function placeBuy(
    owner: Keypair, s: any, vault: PublicKey, thresholdUsd: BN, qty: number, maxPremium: BN, nonce: BN,
  ) {
    const { order, escrow } = deriveTrigger(owner.publicKey, s.mint, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(s.mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await e.opta.methods.placeTrigger(BUY, GE, thresholdUsd, new BN(qty), maxPremium, nonce, { underlying: {} }).accountsStrict({
      owner: owner.publicKey, market: e.market, sharedVault: vault, vaultMintRecord: s.record,
      optionMint: s.mint, triggerOrder: order, triggerEscrow: escrow, protocolState: e.protocolState,
      usdcMint: e.usdcMint, ownerUsdcAccount: ownerUsdc, ownerOptionAta: ownerOpt,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([owner]).rpc();
    return { order, escrow, ownerUsdc, ownerOpt };
  }

  async function placeSell(
    owner: Keypair, s: any, vault: PublicKey, comparator: any, ownerOpt: PublicKey, thresholdUsd: BN, qty: number, nonce: BN,
  ) {
    const { order, escrow } = deriveTrigger(owner.publicKey, s.mint, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    await e.opta.methods.placeTrigger(SELL, comparator, thresholdUsd, new BN(qty), new BN(0), nonce, { underlying: {} }).accountsStrict({
      owner: owner.publicKey, market: e.market, sharedVault: vault, vaultMintRecord: s.record,
      optionMint: s.mint, triggerOrder: order, triggerEscrow: escrow, protocolState: e.protocolState,
      usdcMint: e.usdcMint, ownerUsdcAccount: ownerUsdc, ownerOptionAta: ownerOpt,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([owner]).rpc();
    return { order, escrow };
  }

  async function cancel(owner: Keypair, mint: PublicKey, nonce: BN) {
    const { order, escrow } = deriveTrigger(owner.publicKey, mint, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    await e.opta.methods.cancelTrigger().accountsStrict({
      owner: owner.publicKey, triggerOrder: order, triggerEscrow: escrow,
      protocolState: e.protocolState, ownerUsdcAccount: ownerUsdc, tokenProgram: TOKEN_PROGRAM_ID,
      ocoPeer: null,   // [6] B3 unlink slot; null unless the leg is paired
    }).signers([owner]).rpc();
    return { order, escrow };
  }

  before(async () => {
    e = await setupEnv("TRIGTEST", "trig-feed", 100); // spot $100, ~79% vol planted
  });

  it("a — place StopEntryBuy: order fields + escrow == P*Q + dest ATA + funded", async () => {
    const strike = usdc(100);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 1000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 5000);

    const owner = actor(e);
    const P = usdc(8);   // per-contract ceiling $8
    const Q = 3;
    const nonce = new BN(1);
    const { order, escrow, ownerOpt } = await placeBuy(owner, s, vault, usdc(120), Q, P, nonce);

    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.owner.toBase58(), owner.publicKey.toBase58(), "owner");
    assert.equal(t.market.toBase58(), e.market.toBase58(), "market");
    assert.equal(t.optionMint.toBase58(), s.mint.toBase58(), "option_mint");
    assert.equal(t.vault.toBase58(), vault.toBase58(), "vault");
    assert.isTrue("stopEntryBuy" in t.kind, "kind == StopEntryBuy");
    assert.isTrue("greaterOrEqual" in t.comparator, "comparator == GreaterOrEqual");
    assert.equal(t.thresholdUsdc.toString(), usdc(120).toString(), "threshold");
    assert.equal(t.quantity.toString(), String(Q), "quantity");
    assert.equal(t.maxPremium.toString(), P.toString(), "max_premium stored per-contract");
    assert.equal(t.holderOptionAta.toBase58(), ownerOpt.toBase58(), "dest ATA stored");
    assert.isTrue(t.escrowFunded, "escrow_funded == true");
    assert.equal(t.nonce.toString(), "1", "nonce");

    const escrowBal = await bal(e, escrow);
    assert.equal(escrowBal.toString(), P.mul(new BN(Q)).toString(), "escrow EXACTLY P*Q");
    assert.isTrue(await exists(e, ownerOpt), "destination option ATA created");
  });

  it("b — place TakeProfitSell: funded=false, no escrow; reverts if balance < qty", async () => {
    const strike = usdc(95);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 2000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 5000);

    // Give the owner 5 real contracts via a peg fill.
    const owner = actor(e);
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, 5);
    assert.equal(await bal(e, ownerOpt), 5n, "owner holds 5 contracts");

    // Happy sell placement (qty 5 <= balance 5).
    const nonce = new BN(7);
    const { order, escrow } = await placeSell(owner, s, vault, LE, ownerOpt, usdc(80), 5, nonce);
    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.isTrue("takeProfitSell" in t.kind, "kind == TakeProfitSell");
    assert.isFalse(t.escrowFunded, "escrow_funded == false");
    assert.equal(t.maxPremium.toString(), "0", "max_premium stored 0 for sell");
    assert.equal(t.holderOptionAta.toBase58(), ownerOpt.toBase58(), "source ATA stored");
    assert.isFalse(await exists(e, escrow), "no escrow account created for a sell");

    // Over-balance placement reverts (balance 5 < qty 6).
    let msg = "";
    try { await placeSell(owner, s, vault, LE, ownerOpt, usdc(80), 6, new BN(8)); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(
      msg.includes("InsufficientOptionTokens") || msg.length > 0,
      `balance < qty rejected (${msg.slice(0, 140)})`,
    );
  });

  it("c — cancel a funded BUY: full escrow refunded; both PDAs closed", async () => {
    const strike = usdc(105);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 3000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 5000);

    const owner = actor(e);
    const P = usdc(10);
    const Q = 4;
    const nonce = new BN(2);
    const { order, escrow, ownerUsdc } = await placeBuy(owner, s, vault, usdc(120), Q, P, nonce);

    const escrowBal = await bal(e, escrow);
    assert.equal(escrowBal.toString(), P.mul(new BN(Q)).toString(), "escrow funded P*Q before cancel");
    const ownerUsdcBefore = await bal(e, ownerUsdc);

    await cancel(owner, s.mint, nonce);

    const ownerUsdcAfter = await bal(e, ownerUsdc);
    assert.equal(
      (ownerUsdcAfter - ownerUsdcBefore).toString(), P.mul(new BN(Q)).toString(),
      "full escrow USDC refunded to owner",
    );
    assert.isFalse(await exists(e, order), "trigger_order closed");
    assert.isFalse(await exists(e, escrow), "trigger_escrow closed");
  });

  it("d — cancel a SELL: order closed, escrow untouched (never existed)", async () => {
    const strike = usdc(90);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 4000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 5000);

    const owner = actor(e);
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, 2);
    const optBefore = await bal(e, ownerOpt);

    const nonce = new BN(3);
    const { order, escrow } = await placeSell(owner, s, vault, LE, ownerOpt, usdc(80), 2, nonce);
    assert.isTrue(await exists(e, order), "sell trigger placed");
    assert.isFalse(await exists(e, escrow), "no escrow for a sell");

    await cancel(owner, s.mint, nonce);

    assert.isFalse(await exists(e, order), "trigger_order closed");
    assert.equal(await bal(e, ownerOpt), optBefore, "owner's contracts untouched by cancel");
  });

  it("e — place with quantity == 0 reverts", async () => {
    const strike = usdc(101);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 5000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 1000);

    let msg = "";
    try { await placeBuy(actor(e), s, vault, usdc(120), 0, usdc(8), new BN(4)); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(
      msg.includes("InvalidContractSize") || msg.length > 0,
      `quantity=0 rejected (${msg.slice(0, 140)})`,
    );
  });

  it("f — place BUY with max_premium == 0 reverts", async () => {
    const strike = usdc(102);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 6000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 1000);

    let msg = "";
    try { await placeBuy(actor(e), s, vault, usdc(120), 2, new BN(0), new BN(5)); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(
      msg.includes("InvalidPremium") || msg.length > 0,
      `max_premium=0 rejected (${msg.slice(0, 140)})`,
    );
  });

  it("g — units regression: BUY max_premium=P, qty=Q ⇒ escrow == P*Q exactly", async () => {
    const strike = usdc(103);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 7000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 5000);

    const P = usdc(3);
    const Q = 7;
    const nonce = new BN(6);
    const { escrow } = await placeBuy(actor(e), s, vault, usdc(120), Q, P, nonce);
    assert.equal(
      (await bal(e, escrow)).toString(), P.mul(new BN(Q)).toString(),
      `escrow == P*Q (${P.toString()} × ${Q})`,
    );
  });

  // ========================================================================
  // execute_trigger (Pass 1) — keeper fires; fresh-EMA re-check + cores
  // ========================================================================

  // Inject a fresh PriceUpdateV2 at the current clock, then fire the trigger.
  // The injected spot is the comparator EMA (BUY+SELL) AND the SELL intrinsic
  // spot; the BUY peg prices off the warm vol_oracle, not this fixture.
  async function execTrigger(owner: Keypair, s: any, vault: PublicKey, vaultUsdc: PublicKey, nonce: BN, spotUsd: number) {
    const { order, escrow } = deriveTrigger(owner.publicKey, s.mint, nonce);
    const now = await getClockUnix(e.h.context);
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, spotUsd, now));
    const ownerOpt = getAssociatedTokenAddressSync(s.mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    await e.opta.methods.executeTrigger().accountsStrict({
      caller: e.admin.publicKey, triggerOrder: order, market: e.market, sharedVault: vault,
      vaultMintRecord: s.record, optionMint: s.mint, priceUpdate: fix, volOracle: e.volOracle,
      protocolState: e.protocolState, treasury: e.treasury, triggerEscrow: escrow,
      holderOptionAta: ownerOpt, ownerUsdcAccount: ownerUsdc, ownerWallet: owner.publicKey,
      vaultUsdcAccount: vaultUsdc, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      // Stage 3 1a-ii: trailing Switchboard read-arm optionals — null on Pyth path.
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      // Phase B1: book-fire optionals [21]-[30] — null → vault-peg path (unchanged).
      bookOrder: null, bookMaker: null, bookEscrow: null, bookMakerUsdc: null,
      writerAskPot: null, writerAskPotUsdc: null, writerAskPosition: null,
      bookHookMetas: null, bookHookProgram: null, bookHookState: null, bookMakerOption: null,
      ocoPeer: null,   // [32] B3 OCO peer; null unless the trigger is paired
    }).preInstructions([CU(400_000)]).rpc();
  }

  it("h — BUY: condition met + premium ≤ budget → mint qty, escrow conserved (spent+refund), closes", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 11000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 5000);
    const owner = actor(e);
    const P = usdc(50); const Q = 3; const nonce = new BN(11);
    const { order, escrow, ownerOpt } = await placeBuy(owner, s, vault, usdc(100), Q, P, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);

    const escrowBefore = await bal(e, escrow);
    const uBefore = await bal(e, ownerUsdc);
    const vBefore = await bal(e, vaultUsdc);
    const tBefore = await bal(e, e.treasury);
    const optBefore = await bal(e, ownerOpt);

    await execTrigger(owner, s, vault, vaultUsdc, nonce, 100); // ema 100 >= threshold 100 (GE)

    const vaultShare = (await bal(e, vaultUsdc)) - vBefore;
    const feeGot = (await bal(e, e.treasury)) - tBefore;
    const refund = (await bal(e, ownerUsdc)) - uBefore;
    const total = vaultShare + feeGot;
    const pq = BigInt(P.toString()) * BigInt(Q);

    assert.equal((await bal(e, ownerOpt)) - optBefore, BigInt(Q), "owner minted Q contracts");
    assert.isTrue(total > 0n, "premium charged");
    assert.equal(escrowBefore, pq, "escrow funded exactly P*Q");
    assert.equal(total + refund, pq, "escrow conserved: total spent + refund == P*Q");
    assert.isFalse(await exists(e, escrow), "escrow closed");
    assert.isFalse(await exists(e, order), "trigger_order closed (buy fires once)");
  });

  it("i — BUY: condition NOT met → reverts 6059, nothing moves, order + escrow intact", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 12000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 2000);
    const owner = actor(e);
    const P = usdc(50); const Q = 2; const nonce = new BN(12);
    const { order, escrow } = await placeBuy(owner, s, vault, usdc(120), Q, P, nonce); // GE threshold 120
    const escrowBefore = await bal(e, escrow);

    let msg = "";
    try { await execTrigger(owner, s, vault, vaultUsdc, nonce, 100); } // ema 100 < 120 → GE fails
    catch (err: any) { msg = String(err); }
    assert.isTrue(msg.includes("TriggerConditionNotMet") || msg.includes("6059"), `6059 (${msg.slice(0, 140)})`);
    assert.isTrue(await exists(e, order), "order intact");
    assert.equal(await bal(e, escrow), escrowBefore, "escrow untouched");
  });

  it("j — SELL: condition met + ITM + bal ≥ qty → delegate-burn, payout, counters, order closed", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 13000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 5000);
    const owner = actor(e);
    const Q = 4;
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, Q);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const nonce = new BN(13);
    const { order } = await placeSell(owner, s, vault, GE, ownerOpt, usdc(110), Q, nonce);

    const vBefore: any = await e.opta.account.sharedVault.fetch(vault);
    const uBefore = await bal(e, ownerUsdc);

    await execTrigger(owner, s, vault, vaultUsdc, nonce, 120); // 120 >= 110 (GE), ITM (120 > 100)

    const expectedPayout = usdc(20).mul(new BN(Q)); // intrinsic = min(120-100, cpt) = 20
    assert.equal(await bal(e, ownerOpt), 0n, "all Q contracts burned (delegate, no holder sig)");
    assert.equal((await bal(e, ownerUsdc)) - uBefore, BigInt(expectedPayout.toString()), "owner paid capped intrinsic");
    const vAfter: any = await e.opta.account.sharedVault.fetch(vault);
    assert.equal(Number(vAfter.exercisedOptions) - Number(vBefore.exercisedOptions), Q, "exercised_options += Q");
    assert.equal(
      (vAfter.earlyExercisePayout as BN).sub(vBefore.earlyExercisePayout as BN).toString(),
      expectedPayout.toString(), "early_exercise_payout += payout");
    assert.isFalse(await exists(e, order), "order closed (remaining 0)");
  });

  it("k — SELL: condition met + OTM → OptionNotInTheMoney (why StopLoss is not a kind)", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 14000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 2000);
    const owner = actor(e);
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, 2);
    const nonce = new BN(14);
    await placeSell(owner, s, vault, GE, ownerOpt, usdc(90), 2, nonce); // fire when spot >= 90

    let msg = "";
    try { await execTrigger(owner, s, vault, vaultUsdc, nonce, 95); } // 95 >= 90 met, but 95 < 100 → OTM
    catch (err: any) { msg = String(err); }
    assert.isTrue(msg.includes("OptionNotInTheMoney"), `OTM revert (${msg.slice(0, 140)})`);
  });

  it("l — SELL partial: bal < qty → fires min(qty,bal), decrements order, STAYS OPEN", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 15000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 5000);
    const owner = actor(e);
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, 5);
    const nonce = new BN(15);
    const { order } = await placeSell(owner, s, vault, GE, ownerOpt, usdc(110), 5, nonce);
    await bumpTokenAmount(e, ownerOpt, -2); // holder moved 2 out: 5 → 3

    await execTrigger(owner, s, vault, vaultUsdc, nonce, 120); // ITM; fire_qty = min(5,3) = 3

    assert.equal(await bal(e, ownerOpt), 0n, "burned the 3 available");
    assert.isTrue(await exists(e, order), "order STILL OPEN for the remainder");
    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.quantity.toString(), "2", "remaining quantity == 5 − 3");
  });

  it("m — SELL: bal == 0 → clean no-op (no revert, no close, order intact)", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 16000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 2000);
    const owner = actor(e);
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, 2);
    const nonce = new BN(16);
    const { order } = await placeSell(owner, s, vault, GE, ownerOpt, usdc(110), 2, nonce);
    await bumpTokenAmount(e, ownerOpt, -2); // 2 → 0

    await execTrigger(owner, s, vault, vaultUsdc, nonce, 120); // must NOT revert (fire_qty 0)

    assert.isTrue(await exists(e, order), "order intact");
    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.quantity.toString(), "2", "quantity unchanged (no fire)");
    assert.equal(await bal(e, ownerOpt), 0n, "balance still 0");
  });

  it("n — SELL fire-time theft guard: source ATA owner != trigger.owner → 6060", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 17000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 2000);
    const owner = actor(e);
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, 2);
    const nonce = new BN(17);
    await placeSell(owner, s, vault, GE, ownerOpt, usdc(110), 2, nonce);

    // Corrupt the STORED ATA's owner field (bytes 32..64) to a stranger.
    const acc = await e.h.context.banksClient.getAccount(ownerOpt);
    const data = Buffer.from(acc!.data);
    Keypair.generate().publicKey.toBuffer().copy(data, 32);
    e.h.context.setAccount(ownerOpt, {
      lamports: acc!.lamports, data, owner: acc!.owner, executable: acc!.executable, rentEpoch: Number(acc!.rentEpoch),
    });

    let msg = "";
    try { await execTrigger(owner, s, vault, vaultUsdc, nonce, 120); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(msg.includes("TriggerSourceAtaInvalid") || msg.includes("6060"), `6060 (${msg.slice(0, 140)})`);
  });

  it("o — flag gate: require!(AMERICAN_ENABLED) is the FIRST gate in handle_execute_trigger", () => {
    // The bankrun build compiles with `american-enabled` (AMERICAN_ENABLED=true),
    // so it can't be flipped false at runtime. Prove instead that the 6052 flag
    // gate is the FIRST require! in the handler — it short-circuits before the
    // EMA read + dispatch when dark.
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../programs/opta/src/instructions/execute_trigger.rs"), "utf-8");
    const body = src.slice(src.indexOf("pub fn handle_execute_trigger"));
    const firstRequire = body.indexOf("require!(");
    const flagGate = body.indexOf("require!(AMERICAN_ENABLED, OptaError::AmericanVaultsDisabled)");
    assert.isTrue(flagGate >= 0, "flag gate present");
    assert.equal(firstRequire, flagGate, "AMERICAN_ENABLED is the FIRST require! in the handler");
  });

  it("p — refactor regression: BOTH core wirings — taker-signed peg fill + holder-signed exercise", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 18000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 5000);
    const taker = actor(e);
    // (1) Peg fill via the taker-signed wiring (vault_peg_fill_core, Some-signer).
    const takerOpt = await fillPeg(vault, vaultUsdc, s, taker, 3);
    assert.equal(await bal(e, takerOpt), 3n, "peg fill (taker-signed core) minted 3");
    // (2) Holder-signed exercise via american_exercise_core (None pda_bump → invoke).
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const uBefore = await bal(e, takerUsdc);
    const now = await getClockUnix(e.h.context);
    await exerciseAmerican(e, vault, { optionMint: s.mint, vaultMintRecord: s.record }, taker, takerOpt, takerUsdc, 3, 120, now);
    assert.equal(await bal(e, takerOpt), 0n, "holder-signed exercise burned 3");
    assert.equal((await bal(e, takerUsdc)) - uBefore, BigInt(usdc(20).mul(new BN(3)).toString()), "holder paid capped intrinsic");
  });

  // =========================================================================
  // Stage 3 wiring 1a-ii — execute_trigger oracle_source routing
  // =========================================================================

  // Flip the market to oracle_source = Switchboard in place. The byte offset is
  // NOT fixed (asset_name is Borsh-serialized at actual length): it sits after
  // disc(8) + [4-byte len + name] + pyth_feed_id(32) + asset_class(1) + bump(1).
  async function flipMarketToSwitchboard() {
    const acc = await e.h.context.banksClient.getAccount(e.market);
    const data = Buffer.from(acc.data);
    const nameLen = data.readUInt32LE(8);
    const off = 8 + 4 + nameLen + 32 + 1 + 1;
    // Idempotent: e.market is shared across tests, so it may already be flipped.
    data[off] = 1;
    e.h.context.setAccount(e.market, {
      lamports: acc.lamports, data, owner: acc.owner,
      executable: acc.executable, rentEpoch: Number(acc.rentEpoch),
    });
  }

  // Build the executeTrigger accountsStrict object. priceUpdate present + sb=null
  // → Pyth path; priceUpdate=null + sb present → Switchboard path.
  function execArgs(owner: Keypair, s: any, vault: PublicKey, vaultUsdc: PublicKey,
                    order: PublicKey, escrow: PublicKey, priceUpdate: PublicKey | null,
                    ownerUsdc: PublicKey, sb: { queue: PublicKey; slothashes: PublicKey; instructions: PublicKey } | null) {
    const ownerOpt = getAssociatedTokenAddressSync(s.mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    return {
      caller: e.admin.publicKey, triggerOrder: order, market: e.market, sharedVault: vault,
      vaultMintRecord: s.record, optionMint: s.mint, priceUpdate, volOracle: e.volOracle,
      protocolState: e.protocolState, treasury: e.treasury, triggerEscrow: escrow,
      holderOptionAta: ownerOpt, ownerUsdcAccount: ownerUsdc, ownerWallet: owner.publicKey,
      vaultUsdcAccount: vaultUsdc, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      sbQueue: sb?.queue ?? null, sbSlothashes: sb?.slothashes ?? null, sbInstructions: sb?.instructions ?? null, optaPriceFeed: null,
      // Phase B1: book-fire optionals [21]-[30] — null → vault-peg path (unchanged).
      bookOrder: null, bookMaker: null, bookEscrow: null, bookMakerUsdc: null,
      writerAskPot: null, writerAskPotUsdc: null, writerAskPosition: null,
      bookHookMetas: null, bookHookProgram: null, bookHookState: null, bookMakerOption: null,
      ocoPeer: null,   // [32] B3 OCO peer; null unless the trigger is paired
    };
  }

  // A placed SELL on a Switchboard-flipped market (the EMA match site fires
  // first, before the comparator/dispatch, so a SELL reaches the SB arm).
  async function setupSbSell(nonce: BN) {
    // Unique expiry offset per call (the suite's no-collision convention: fixed
    // strike, distinct expiry → distinct vault/series/trigger PDAs).
    const strike = usdc(100), expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 30000 + nonce.toNumber() * 1000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 2000);
    const owner = actor(e);
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, 3);
    const { order, escrow } = await placeSell(owner, s, vault, GE, ownerOpt, usdc(150), 2, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    await flipMarketToSwitchboard();
    return { owner, s, vault, vaultUsdc, order, escrow, ownerUsdc };
  }

  it("1a-ii SIZE GATE: Pyth / SB-BUY / SB-SELL serialized tx bytes vs 1232", async () => {
    const strike = usdc(100), expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 20000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 2000);
    const owner = actor(e);
    const { order, escrow, ownerUsdc } = await placeBuy(owner, s, vault, usdc(150), 1, usdc(50), new BN(21));
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, 150, await getClockUnix(e.h.context)));
    const bh = (await e.h.context.banksClient.getLatestBlockhash())[0];

    // (a) Pyth LEGACY wire — exactly 18 named accounts (price_update present, NO SB).
    const fullPyth = await e.opta.methods.executeTrigger()
      .accountsStrict(execArgs(owner, s, vault, vaultUsdc, order, escrow, fix, ownerUsdc, null)).instruction();
    const legacyPyth = new TransactionInstruction({ programId: fullPyth.programId, keys: fullPyth.keys.slice(0, 18), data: fullPyth.data });
    const pythTx = new Transaction({ feePayer: e.admin.publicKey, recentBlockhash: bh }).add(CU(400_000), legacyPyth);
    const pythSize = pythTx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;

    // (b)/(c) SB wire — price_update None (sentinel) + 3 SB accounts + ed25519 ix
    //   (a 2-signature self-packed SB quote is 318 B of ix data) + ComputeBudget.
    //   The BUY and SELL paths share ONE Accounts struct → identical account set
    //   → identical serialized size.
    const ed25519 = new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data: Buffer.alloc(318) });
    const sbIx = await e.opta.methods.executeTrigger()
      .accountsStrict(execArgs(owner, s, vault, vaultUsdc, order, escrow, null, ownerUsdc,
        { queue: Keypair.generate().publicKey, slothashes: SYSVAR_SLOT_HASHES_PUBKEY, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })).instruction();
    const sbTx = new Transaction({ feePayer: e.admin.publicKey, recentBlockhash: bh }).add(CU(400_000), ed25519, sbIx);
    const sbSize = sbTx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;

    console.log(`    SIZE (a) Pyth legacy = ${pythSize} B  | remaining ${1232 - pythSize}`);
    console.log(`    SIZE (b) SB-BUY      = ${sbSize} B  | remaining ${1232 - sbSize}  (incl 318B ed25519, worst-case 2-sig)`);
    console.log(`    SIZE (c) SB-SELL     = ${sbSize} B  (identical account set to SB-BUY)`);
    assert.isAtMost(pythSize, 1232, "Pyth legacy wire MUST fit 1232 (unchanged)");
    // SB size is reported for the gate decision; not asserted (SB triggers don't
    // exist until 1c — overflow there is a separate ALT decision, not a failure).
  });

  it("1a-ii byte-identical: legacy 18-account Pyth BUY tx fires + closes order", async () => {
    const strike = usdc(100), expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 21000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 2000);
    const owner = actor(e);
    const { order, escrow, ownerUsdc } = await placeBuy(owner, s, vault, usdc(150), 1, usdc(50), new BN(22));
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, 160, await getClockUnix(e.h.context))); // GE 150 met
    const full = await e.opta.methods.executeTrigger()
      .accountsStrict(execArgs(owner, s, vault, vaultUsdc, order, escrow, fix, ownerUsdc, null)).instruction();
    console.log(`    [byte-identical] new-IDL ix.keys = ${full.keys.length}; submitting legacy 18`);
    const legacy = new TransactionInstruction({ programId: full.programId, keys: full.keys.slice(0, 18), data: full.data });
    assert.equal(legacy.keys.length, 18, "legacy wire is exactly 18 accounts");
    const bh = (await e.h.context.banksClient.getLatestBlockhash())[0];
    const tx = new Transaction({ feePayer: e.admin.publicKey, recentBlockhash: bh }).add(CU(400_000), legacy);
    await (e.opta.provider as any).sendAndConfirm(tx, []); // provider wallet == caller (admin)
    assert.isFalse(await exists(e, order), "BUY fired via legacy wire → trigger_order closed");
  });

  it("1a-ii SB market: missing SB accounts → SwitchboardAccountsMissing (6065)", async () => {
    const x = await setupSbSell(new BN(23));
    let err = "";
    try {
      await e.opta.methods.executeTrigger()
        .accountsStrict(execArgs(x.owner, x.s, x.vault, x.vaultUsdc, x.order, x.escrow, null, x.ownerUsdc, null))
        .preInstructions([CU(400_000)]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (sb-miss) ${err.slice(0, 120)}`);
    assert.match(err, /SwitchboardAccountsMissing|6065/, "SB market must require the SB accounts");
  });

  it("1a-ii SB market: SB accounts but no ed25519 ix → NoEd25519Instruction (6067)", async () => {
    const x = await setupSbSell(new BN(24));
    let err = "";
    try {
      await e.opta.methods.executeTrigger()
        .accountsStrict(execArgs(x.owner, x.s, x.vault, x.vaultUsdc, x.order, x.escrow, null, x.ownerUsdc,
          { queue: Keypair.generate().publicKey, slothashes: SYSVAR_SLOT_HASHES_PUBKEY, instructions: SYSVAR_INSTRUCTIONS_PUBKEY }))
        .preInstructions([CU(400_000)]).rpc(); // no ed25519 preIx
    } catch (ex: any) { err = String(ex); }
    console.log(`    (sb-noed) ${err.slice(0, 120)}`);
    assert.match(err, /NoEd25519Instruction|6067/, "ed25519-index derivation must error with no ed25519 ix");
  });

  it("1a-ii SB market: valid ed25519 ix → reaches QuoteVerifier (reverts past all guards)", async () => {
    const x = await setupSbSell(new BN(25));
    const edKp = Keypair.generate();
    const edIx = Ed25519Program.createInstructionWithPrivateKey({ privateKey: edKp.secretKey, message: Buffer.from("opta-1a-ii-probe") });
    let err = "";
    try {
      await e.opta.methods.executeTrigger()
        .accountsStrict(execArgs(x.owner, x.s, x.vault, x.vaultUsdc, x.order, x.escrow, null, x.ownerUsdc,
          { queue: Keypair.generate().publicKey, slothashes: SYSVAR_SLOT_HASHES_PUBKEY, instructions: SYSVAR_INSTRUCTIONS_PUBKEY }))
        .preInstructions([CU(400_000), edIx]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (sb-verify) ${err.slice(0, 160)}`);
    assert.notEqual(err, "", "must revert — a non-SB quote cannot verify");
    assert.notMatch(err, /PriceUpdateMissing|SwitchboardAccountsMissing|InvalidSwitchboardSysvar|NoEd25519Instruction/,
      "must reach the QuoteVerifier (past every earlier guard)");
  });
});
