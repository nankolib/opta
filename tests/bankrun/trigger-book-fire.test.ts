// =============================================================================
// tests/bankrun/trigger-book-fire.test.ts — B1: StopEntryBuy → book (writer ask)
// =============================================================================
// execute_trigger's StopEntryBuy, flag-on (cfg testing → BOOK_TRIGGERS_ENABLED),
// routes to writer_ask_fill_core (escrow-pays arm): the trigger escrow pays the
// ask premium, the series mints to the owner, the writer's collateral moves
// escrow→pot. Gates:
//   1  lift-ask e2e (+ per-fire debit = fire_qty×ask_price + pot credited + fee split)
//   2  partial → remainder armed (escrow retained)
//   3  no-crossable (exhausted ask) → TriggerSkipped, no revert, stays armed
//   4  price > max_premium → AskPriceExceedsMax (6080)
//   5  full-fill remainder refund to owner + conservation to the unit
//   6  multi-fire-to-zero cumulative conservation (Σ debits + final refund == P*Q)
//   7  flag-off byte-identical: no book accounts → vault peg path (same build)
//   8  resale-secondary routing: ResaleAsk fill (option escrow→owner, USDC→reseller)
// The red-first proof (flip the cfg(testing) flag branch to false) is run
// separately in the report; these assert the flag-on book behavior.
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, createSeries, deposit, usdcAta, bal, exists, actor, pda, getClockUnix,
  HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";
import { injectPythFixture } from "./bootstrap";
import { serializePriceUpdateV2 } from "../_pyth_fixtures";

const DAY = 86_400;
const FEE_BPS = 50;
const feeOf = (total: BN) => total.muln(FEE_BPS).divn(10_000);
const BUY = { stopEntryBuy: {} };
const GE = { greaterOrEqual: {} };
const WRITER_ASK = { writerAsk: {} };
const RESALE_ASK = { resaleAsk: {} };
const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK_POT_SEED = Buffer.from("writer_ask_pot");
const WRITER_ASK_POT_USDC_SEED = Buffer.from("writer_ask_pot_usdc");
const WRITER_ASK_POSITION_SEED = Buffer.from("writer_ask_position");

function pythBody(feedHex: string, priceUsd: number, publishTime: number): Buffer {
  const price = BigInt(priceUsd) * 100_000_000n;
  return serializePriceUpdateV2({
    feedIdHex: feedHex, price, conf: 1_000_000n, exponent: -8,
    publishTime: BigInt(Math.floor(publishTime)), prevPublishTime: BigInt(Math.floor(publishTime) - 1),
    emaPrice: price, emaConf: 1_000_000n,
  });
}

describe("B1: StopEntryBuy → book (writer_ask_fill_core, escrow-pays)", function () {
  this.timeout(180_000);

  let e: Env;
  let strike: BN;
  let expiryCtr = 0;
  let nonceCtr = 900;
  const nextNonce = () => new BN(nonceCtr++);

  const orderPdas = (mint: PublicKey, owner: PublicKey, nonce: BN) => {
    const order = pda([RESTING_ORDER_SEED, mint.toBuffer(), owner.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    return { order, escrow: pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]) };
  };
  const potPdas = (mint: PublicKey, backer: PublicKey) => ({
    pot: pda([WRITER_ASK_POT_SEED, mint.toBuffer()]),
    potUsdc: pda([WRITER_ASK_POT_USDC_SEED, mint.toBuffer()]),
    position: pda([WRITER_ASK_POSITION_SEED, mint.toBuffer(), backer.toBuffer()]),
  });
  const triggerPdas = (owner: PublicKey, mint: PublicKey, nonce: BN) => {
    const order = pda([Buffer.from("trigger_order"), owner.toBuffer(), mint.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    return { order, escrow: pda([Buffer.from("trigger_escrow"), order.toBuffer()]) };
  };

  async function mkSeries(depositUsd: number) {
    const exp = new BN((await getClockUnix(e.h.context)) + 7 * DAY + (expiryCtr++) * 137 + 500);
    const writer = actor(e);
    await usdcAta(e, writer.publicKey, 1_000_000_000_000n);
    const cv = await createVault(e, "american", strike, exp, { call: {} }, writer);
    const s = await createSeries(e, strike, exp, { call: {} });
    await deposit(e, cv.vault, cv.vaultUsdc, writer, depositUsd);
    return { writer, mint: s.optionMint, record: s.vaultMintRecord, extraMetas: s.extraMetas, hookState: s.hookState, vault: cv.vault, vaultUsdc: cv.vaultUsdc };
  }

  async function postAsk(m: any, price: BN, qty: number, nonce: BN) {
    const { order, escrow } = orderPdas(m.mint, m.writer.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, m.writer.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.mint, m.writer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await e.opta.methods.postOrder(WRITER_ASK, price, new BN(qty), nonce).accountsStrict({
      owner: m.writer.publicKey, sharedVault: m.vault, market: e.market, vaultMintRecord: m.record,
      optionMint: m.mint, order, escrow, protocolState: e.protocolState, ownerOptionAccount: ownerOpt,
      ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: m.extraMetas, hookState: m.hookState, tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([m.writer]).rpc();
    return { order, escrow };
  }

  // A reseller (who already holds option tokens) lists a ResaleAsk — escrows the
  // option tokens into the per-order Token-2022 escrow. Used by the resale-secondary gate.
  async function postResale(m: any, reseller: Keypair, price: BN, qty: number, nonce: BN) {
    const { order, escrow } = orderPdas(m.mint, reseller.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, reseller.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.mint, reseller.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await e.opta.methods.postOrder(RESALE_ASK, price, new BN(qty), nonce).accountsStrict({
      owner: reseller.publicKey, sharedVault: m.vault, market: e.market, vaultMintRecord: m.record,
      optionMint: m.mint, order, escrow, protocolState: e.protocolState, ownerOptionAccount: ownerOpt,
      ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: m.extraMetas, hookState: m.hookState, tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([reseller]).rpc();
    return { order, escrow };
  }

  // A direct fill creates the pot/position (the book trigger requires them to pre-exist).
  async function directFill(m: any, nonce: BN, taker: Keypair, qty: number) {
    const { order, escrow } = orderPdas(m.mint, m.writer.publicKey, nonce);
    const { pot, potUsdc, position } = potPdas(m.mint, m.writer.publicKey);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, m.writer.publicKey, false, TOKEN_PROGRAM_ID);
    const takerOpt = getAssociatedTokenAddressSync(m.mint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(taker.publicKey, takerOpt, taker.publicKey, m.mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    await e.opta.methods.fillWriterAsk(new BN(qty)).accountsStrict({
      taker: taker.publicKey, optionMint: m.mint, order, maker: m.writer.publicKey, sharedVault: m.vault,
      vaultMintRecord: m.record, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).preInstructions([CU(400_000), ataIx]).signers([taker]).rpc();
  }

  async function placeBuy(m: any, owner: Keypair, thresholdUsd: BN, qty: number, maxPremium: BN, nonce: BN) {
    const { order, escrow } = triggerPdas(owner.publicKey, m.mint, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await e.opta.methods.placeTrigger(BUY, GE, thresholdUsd, new BN(qty), maxPremium, nonce, { underlying: {} }).accountsStrict({
      owner: owner.publicKey, market: e.market, sharedVault: m.vault, vaultMintRecord: m.record,
      optionMint: m.mint, triggerOrder: order, triggerEscrow: escrow, protocolState: e.protocolState,
      usdcMint: e.usdcMint, ownerUsdcAccount: ownerUsdc, ownerOptionAta: ownerOpt,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([owner]).rpc();
    return { order, escrow, ownerUsdc, ownerOpt };
  }

  // Fire the book path: 18 base accounts + 3 SB null + 7 book accounts.
  async function fireBook(m: any, owner: Keypair, askNonce: BN, trigNonce: BN, spotUsd: number, expectErr = false) {
    const { order, escrow } = triggerPdas(owner.publicKey, m.mint, trigNonce);
    const askO = orderPdas(m.mint, m.writer.publicKey, askNonce);
    const { pot, potUsdc, position } = potPdas(m.mint, m.writer.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, m.writer.publicKey, false, TOKEN_PROGRAM_ID);
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, spotUsd, await getClockUnix(e.h.context)));
    const b = e.opta.methods.executeTrigger().accountsStrict({
      caller: e.admin.publicKey, triggerOrder: order, market: e.market, sharedVault: m.vault,
      vaultMintRecord: m.record, optionMint: m.mint, priceUpdate: fix, volOracle: e.volOracle,
      protocolState: e.protocolState, treasury: e.treasury, triggerEscrow: escrow, holderOptionAta: ownerOpt,
      ownerUsdcAccount: ownerUsdc, ownerWallet: owner.publicKey, vaultUsdcAccount: m.vaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      bookOrder: askO.order, bookMaker: m.writer.publicKey, bookEscrow: askO.escrow, bookMakerUsdc: makerUsdc,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position,
      bookHookMetas: null, bookHookProgram: null, bookHookState: null, bookMakerOption: null,
      ocoPeer: null,   // [32] B3 OCO peer; null unless the trigger is paired
    }).preInstructions([CU(400_000)]);
    if (expectErr) { let msg = ""; try { await b.rpc(); } catch (x: any) { msg = String(x); } return msg; }
    await b.rpc();
    return "";
  }

  before(async () => {
    e = await setupEnv("BOOKFIRE", "bookfire-feed", 100);
    strike = usdc(100);
  });

  it("1 — lift-ask e2e: mint qty to owner, escrow debit = qty×price, pot credited, fee split", async () => {
    const m = await mkSeries(5000);
    const askNonce = nextNonce();
    await postAsk(m, usdc(6), 10, askNonce);         // ask: 10 @ $6/contract
    await directFill(m, askNonce, actor(e), 1);       // create pot/position (ask → 9 remaining)
    const owner = actor(e);
    const trigNonce = nextNonce();
    const P = usdc(8); const Q = 3;
    const { escrow, ownerUsdc, ownerOpt } = await placeBuy(m, owner, usdc(100), Q, P, trigNonce);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, m.writer.publicKey, false, TOKEN_PROGRAM_ID);
    const { pot, potUsdc } = potPdas(m.mint, m.writer.publicKey);

    const escBefore = await bal(e, escrow);
    const makerBefore = await bal(e, makerUsdc);
    const treBefore = await bal(e, e.treasury);
    const uBefore = await bal(e, ownerUsdc);
    const potBefore = await bal(e, potUsdc);
    const optBefore = await bal(e, ownerOpt);

    await fireBook(m, owner, askNonce, trigNonce, 100);  // ema 100 >= threshold 100

    const total = usdc(6).muln(Q);                        // fire_qty(3) × ask_price($6)
    const fee = feeOf(total);
    assert.equal((await bal(e, ownerOpt)) - optBefore, BigInt(Q), "owner minted Q contracts");
    assert.equal(BigInt(escBefore.toString()), BigInt(P.muln(Q).toString()), "escrow funded P*Q");
    assert.isFalse(await exists(e, escrow), "escrow closed on full fill");
    assert.equal((await bal(e, makerUsdc)) - makerBefore, BigInt(total.sub(fee).toString()), "writer got premium − fee");
    assert.equal((await bal(e, e.treasury)) - treBefore, BigInt(fee.toString()), "treasury got fee");
    assert.equal((await bal(e, potUsdc)) - potBefore, BigInt(strike.muln(Q).toString()), "pot credited cpt×fire_qty");
    // conservation: total spent + refund == P*Q
    const refund = (await bal(e, ownerUsdc)) - uBefore;
    assert.equal(BigInt(total.toString()) + refund, BigInt(P.muln(Q).toString()), "CONSERVATION: total + refund == P*Q");
  });

  it("2 — partial: trigger qty > ask depth → fires depth, remainder ARMED, escrow retained", async () => {
    const m = await mkSeries(5000);
    const askNonce = nextNonce();
    await postAsk(m, usdc(5), 4, askNonce);           // ask: 4 @ $5
    await directFill(m, askNonce, actor(e), 1);        // pot created; ask → 3 remaining
    const owner = actor(e);
    const trigNonce = nextNonce();
    const P = usdc(9); const Q = 7;                      // trigger wants 7, only 3 available
    const { order, escrow, ownerOpt } = await placeBuy(m, owner, usdc(100), Q, P, trigNonce);

    await fireBook(m, owner, askNonce, trigNonce, 100);  // fire_qty = min(7,3) = 3

    assert.equal(await bal(e, ownerOpt), 3n, "minted the 3 available");
    assert.isTrue(await exists(e, order), "trigger STILL ARMED for the remainder");
    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.quantity.toString(), "4", "remaining quantity == 7 − 3");
    assert.isTrue(await exists(e, escrow), "escrow RETAINED (partial)");
    // escrow retained == P*Q − (3 × $5)
    const spent = usdc(5).muln(3);
    assert.equal((await bal(e, escrow)).toString(), P.muln(Q).sub(spent).toString(), "escrow == P*Q − qty×price");
  });

  it("3 — no depth (open ask, remaining 0) → TriggerSkipped, no revert, stays armed", async () => {
    // fire_qty = min(quantity, ask remaining) == 0 needs an OPEN ask with
    // remaining 0 (a fully-filled ask closes, so this is the defensive branch).
    // Construct it: post + direct-fill to create the pot, then byte-patch the
    // ask's quantity_remaining to 0 (open, empty). Fire must skip cleanly.
    const m = await mkSeries(5000);
    const askNonce = nextNonce();
    const { order: askOrder } = await postAsk(m, usdc(5), 4, askNonce);
    await directFill(m, askNonce, actor(e), 1);         // pot created; ask → 3 open
    // Zero the ask's quantity_remaining (offset: disc8 + owner32 + mint32 + vault32
    // + kind1 + price8 = 113), keeping the order OPEN.
    const acc = await e.h.context.banksClient.getAccount(askOrder);
    const data = Buffer.from(acc!.data);
    data.writeBigUInt64LE(0n, 113);
    e.h.context.setAccount(askOrder, { lamports: acc!.lamports, data, owner: acc!.owner, executable: acc!.executable, rentEpoch: Number(acc!.rentEpoch) });

    const owner = actor(e);
    const trigNonce = nextNonce();
    const { order, escrow } = await placeBuy(m, owner, usdc(100), 2, usdc(8), trigNonce);
    const escBefore = await bal(e, escrow);

    const msg = await fireBook(m, owner, askNonce, trigNonce, 100);  // fire_qty = min(2,0) = 0
    assert.equal(msg, "", "no revert on zero depth");
    assert.isTrue(await exists(e, order), "trigger STILL ARMED (no fire)");
    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.quantity.toString(), "2", "quantity unchanged (no fire)");
    assert.equal((await bal(e, escrow)).toString(), escBefore.toString(), "escrow untouched");
  });

  it("4 — ask price > trigger max_premium → AskPriceExceedsMax (6080)", async () => {
    const m = await mkSeries(5000);
    const askNonce = nextNonce();
    await postAsk(m, usdc(12), 5, askNonce);           // ask @ $12
    await directFill(m, askNonce, actor(e), 1);
    const owner = actor(e);
    const trigNonce = nextNonce();
    await placeBuy(m, owner, usdc(100), 2, usdc(8), trigNonce);  // max_premium $8 < $12
    const msg = await fireBook(m, owner, askNonce, trigNonce, 100, true);
    assert.isTrue(msg.includes("AskPriceExceedsMax") || msg.includes("6080"), `6080 (${msg.slice(0, 140)})`);
  });

  it("5 — full-fill refund + conservation to the unit (P > price)", async () => {
    const m = await mkSeries(5000);
    const askNonce = nextNonce();
    await postAsk(m, usdc(4), 10, askNonce);
    await directFill(m, askNonce, actor(e), 1);
    const owner = actor(e);
    const trigNonce = nextNonce();
    const P = usdc(10); const Q = 4;                     // pays 4×$4=$16, escrow $40 → refund $24
    const { escrow, ownerUsdc, order } = await placeBuy(m, owner, usdc(100), Q, P, trigNonce);
    const uBefore = await bal(e, ownerUsdc);

    await fireBook(m, owner, askNonce, trigNonce, 100);

    const refund = (await bal(e, ownerUsdc)) - uBefore;
    assert.equal(refund, BigInt(P.muln(Q).sub(usdc(4).muln(Q)).toString()), "refund == P*Q − qty×price ($24)");
    assert.isFalse(await exists(e, escrow), "escrow closed on full fill");
    assert.isFalse(await exists(e, order), "trigger closed (remaining 0)");
  });

  it("6 — multi-fire to zero: Σ debits + final refund == P*Q to the unit", async () => {
    const m = await mkSeries(5000);
    // Two asks at different prices; trigger sweeps across them over two fires.
    const a1 = nextNonce(); await postAsk(m, usdc(3), 2, a1); await directFill(m, a1, actor(e), 1); // ask1 → 1 @ $3
    const a2 = nextNonce(); await postAsk(m, usdc(5), 5, a2); await directFill(m, a2, actor(e), 1); // ask2 → 4 @ $5
    const owner = actor(e);
    const trigNonce = nextNonce();
    const P = usdc(9); const Q = 3;                     // wants 3: 1 from ask1 ($3) + 2 from ask2 ($5)
    const { escrow, ownerUsdc, order } = await placeBuy(m, owner, usdc(100), Q, P, trigNonce);
    const uBefore = await bal(e, ownerUsdc);

    await fireBook(m, owner, a1, trigNonce, 100);        // fire 1: lift ask1 (1 @ $3), remaining 2
    let t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.quantity.toString(), "2", "after fire1: 3 − 1 = 2 armed");
    assert.isTrue(await exists(e, escrow), "escrow retained after partial");

    await fireBook(m, owner, a2, trigNonce, 100);        // fire 2: lift ask2 (2 @ $5), remaining 0 → close+refund

    const refund = (await bal(e, ownerUsdc)) - uBefore;
    const debits = usdc(3).muln(1).add(usdc(5).muln(2)); // $3 + $10 = $13
    assert.equal(BigInt(debits.toString()) + refund, BigInt(P.muln(Q).toString()), "Σ debits + refund == P*Q ($27)");
    assert.isFalse(await exists(e, order), "trigger closed after full fill");
    assert.isFalse(await exists(e, escrow), "escrow closed after full fill");
  });

  it("7 — flag-off byte-identical: NO book accounts → vault peg path (same build)", async () => {
    // With book_order = None, routing falls to the vault peg regardless of the flag.
    const m = await mkSeries(5000);
    const owner = actor(e);
    const trigNonce = nextNonce();
    const P = usdc(50); const Q = 2;
    const { order, escrow, ownerOpt } = await placeBuy(m, owner, usdc(100), Q, P, trigNonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const uBefore = await bal(e, ownerUsdc);
    const vBefore = await bal(e, m.vaultUsdc);
    const tBefore = await bal(e, e.treasury);

    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, 100, await getClockUnix(e.h.context)));
    await e.opta.methods.executeTrigger().accountsStrict({
      caller: e.admin.publicKey, triggerOrder: order, market: e.market, sharedVault: m.vault,
      vaultMintRecord: m.record, optionMint: m.mint, priceUpdate: fix, volOracle: e.volOracle,
      protocolState: e.protocolState, treasury: e.treasury, triggerEscrow: escrow, holderOptionAta: ownerOpt,
      ownerUsdcAccount: ownerUsdc, ownerWallet: owner.publicKey, vaultUsdcAccount: m.vaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      bookOrder: null, bookMaker: null, bookEscrow: null, bookMakerUsdc: null,
      writerAskPot: null, writerAskPotUsdc: null, writerAskPosition: null,
      bookHookMetas: null, bookHookProgram: null, bookHookState: null, bookMakerOption: null,
      ocoPeer: null,   // [32] B3 OCO peer; null unless the trigger is paired
    }).preInstructions([CU(400_000)]).rpc();

    const vaultShare = (await bal(e, m.vaultUsdc)) - vBefore;
    const feeGot = (await bal(e, e.treasury)) - tBefore;
    const refund = (await bal(e, ownerUsdc)) - uBefore;
    assert.equal((await bal(e, ownerOpt)), BigInt(Q), "peg minted Q (vault path)");
    assert.equal(vaultShare + feeGot + refund, BigInt(P.muln(Q).toString()), "peg conservation P*Q (unchanged)");
    assert.isFalse(await exists(e, order), "peg buy closes trigger");
  });

  it("8 — resale-secondary routing: ResaleAsk fill (option escrow→owner, USDC→reseller), conservation", async () => {
    const m = await mkSeries(5000);
    // A writer posts a WriterAsk; a reseller buys 3 (now holds option tokens).
    const askNonce = nextNonce();
    await postAsk(m, usdc(6), 5, askNonce);
    const reseller = actor(e);
    await directFill(m, askNonce, reseller, 3);
    const resellerOpt = getAssociatedTokenAddressSync(m.mint, reseller.publicKey, false, TOKEN_2022_PROGRAM_ID);
    assert.equal(await bal(e, resellerOpt), 3n, "reseller holds 3 option contracts");

    // Reseller lists a ResaleAsk 3 @ $5 (better-priced than the $6 writer ask).
    const resaleNonce = nextNonce();
    const RP = usdc(5);
    const resale = await postResale(m, reseller, RP, 3, resaleNonce);
    assert.equal((await bal(e, resale.escrow)).toString(), "3", "resale escrow holds 3 option contracts");

    // Buyer arms a StopEntryBuy for 2 @ max_premium $7.
    const buyer = actor(e);
    const trigNonce = nextNonce();
    const P = usdc(7); const Q = 2;
    const { order, escrow, ownerUsdc, ownerOpt } = await placeBuy(m, buyer, usdc(100), Q, P, trigNonce);
    const resellerUsdc = await usdcAta(e, reseller.publicKey);
    const escBefore = await bal(e, escrow);
    const rBefore = await bal(e, resellerUsdc);
    const tBefore = await bal(e, e.treasury);
    const uBefore = await bal(e, ownerUsdc);
    assert.equal(BigInt(escBefore.toString()), BigInt(P.muln(Q).toString()), "trigger escrowed P*Q");

    // Fire → routes to the ResaleAsk (kind ResaleAsk); pot/position null, hook accounts present.
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, 100, await getClockUnix(e.h.context)));
    await e.opta.methods.executeTrigger().accountsStrict({
      caller: e.admin.publicKey, triggerOrder: order, market: e.market, sharedVault: m.vault,
      vaultMintRecord: m.record, optionMint: m.mint, priceUpdate: fix, volOracle: e.volOracle,
      protocolState: e.protocolState, treasury: e.treasury, triggerEscrow: escrow, holderOptionAta: ownerOpt,
      ownerUsdcAccount: ownerUsdc, ownerWallet: buyer.publicKey, vaultUsdcAccount: m.vaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      bookOrder: resale.order, bookMaker: reseller.publicKey, bookEscrow: resale.escrow, bookMakerUsdc: resellerUsdc,
      writerAskPot: null, writerAskPotUsdc: null, writerAskPosition: null,
      bookHookMetas: m.extraMetas, bookHookProgram: HOOK_PROGRAM_ID, bookHookState: m.hookState, bookMakerOption: null,
      ocoPeer: null,   // [32] B3 OCO peer; null unless the trigger is paired
    }).preInstructions([CU(400_000)]).rpc();

    const total = RP.muln(Q);              // $10
    const fee = feeOf(total);              // $0.05
    const cpt = total.sub(fee);            // $9.95
    assert.equal(await bal(e, ownerOpt), BigInt(Q), "buyer received Q option contracts from resale escrow");
    assert.equal((await bal(e, resellerUsdc)) - rBefore, BigInt(cpt.toString()), "reseller received premium − fee");
    assert.equal((await bal(e, e.treasury)) - tBefore, BigInt(fee.toString()), "treasury received fee");
    const refund = (await bal(e, ownerUsdc)) - uBefore;
    assert.equal(BigInt(cpt.toString()) + BigInt(fee.toString()) + refund, BigInt(P.muln(Q).toString()),
      "CONSERVATION: cpt + fee + refund == P*Q");
    assert.isFalse(await exists(e, order), "trigger closed after full fill");
    assert.isFalse(await exists(e, escrow), "trigger escrow closed");
    // Resale ask decremented 3 → 1, stays open (partial fill of the ask).
    const resaleAcc: any = await e.opta.account.restingOrder.fetch(resale.order);
    assert.equal(resaleAcc.quantityRemaining.toString(), "1", "resale ask decremented to 1, stays open");
  });
});
