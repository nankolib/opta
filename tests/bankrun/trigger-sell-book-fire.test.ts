// =============================================================================
// tests/bankrun/trigger-sell-book-fire.test.ts — B2: sell legs → book bid side
// =============================================================================
// execute_trigger's TakeProfitSell / StopLossSell, flag-on (cfg testing →
// BOOK_TRIGGERS_ENABLED), route to bid_fill_core (delegate-pull arm): the
// protocol PermanentDelegate pulls the option out of the owner's ATA into the
// bidder's, and the bid's USDC escrow pays the owner (minus fee → treasury).
//
// The live bid side is EMPTY by design today, so every bid here is synthetic —
// posted in-test via post_order(Bid). Gates:
//   a  TP-sell fires into a bid (delegate pull, escrow→owner, fee split)
//   b  SL-sell same path (6079 retired in the testing build)
//   c  no crossing bid → TriggerSkipped, no revert, stays armed (skip-until-bid)
//   d  partial (bid depth < trigger qty) → remainder armed, decrement correct
//   e  bid price below the owner's stored floor → BidPriceBelowMin (6083) REVERT
//   f  sell-side conservation to the unit (exact BigInt equality)
//   g  flag-off shape: sell kinds with NO book accounts → TP takes the unchanged
//      vault exercise path; SL is the 6079 revert in a feature-free build
//   h  expiry guard: expired series → TriggerSkipped, no fire, no token movement
// The red-first proof (build with the cfg(testing) BOOK_TRIGGERS_ENABLED branch
// false) is run separately and recorded in the report; these assert flag-on
// behavior.
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, createSeries, deposit, usdcAta, bal, exists, actor, pda,
  getClockUnix, setClockUnix, HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";
import { injectPythFixture } from "./bootstrap";
import { serializePriceUpdateV2 } from "../_pyth_fixtures";

const DAY = 86_400;
const FEE_BPS = 50;
const feeOf = (total: BN) => total.muln(FEE_BPS).divn(10_000);
const TP_SELL = { takeProfitSell: {} };
const SL_SELL = { stopLossSell: {} };
const GE = { greaterOrEqual: {} };
const LE = { lessOrEqual: {} };
const WRITER_ASK = { writerAsk: {} };
const BID = { bid: {} };
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

describe("B2: TakeProfitSell / StopLossSell → book bid side (bid_fill_core)", function () {
  this.timeout(180_000);

  let e: Env;
  let strike: BN;
  let expiryCtr = 0;
  let nonceCtr = 1500;
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
  const optAta = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

  async function mkSeries(depositUsd: number) {
    const exp = new BN((await getClockUnix(e.h.context)) + 7 * DAY + (expiryCtr++) * 137 + 500);
    const writer = actor(e);
    await usdcAta(e, writer.publicKey, 1_000_000_000_000n);
    const cv = await createVault(e, "american", strike, exp, { call: {} }, writer);
    const s = await createSeries(e, strike, exp, { call: {} });
    await deposit(e, cv.vault, cv.vaultUsdc, writer, depositUsd);
    return {
      writer, mint: s.optionMint, record: s.vaultMintRecord, extraMetas: s.extraMetas,
      hookState: s.hookState, vault: cv.vault, vaultUsdc: cv.vaultUsdc, expiry: exp,
    };
  }

  /** Writer lists a WriterAsk so a holder can acquire real contracts to sell. */
  async function postAsk(m: any, price: BN, qty: number, nonce: BN) {
    const { order, escrow } = orderPdas(m.mint, m.writer.publicKey, nonce);
    await e.opta.methods.postOrder(WRITER_ASK, price, new BN(qty), nonce).accountsStrict({
      owner: m.writer.publicKey, sharedVault: m.vault, market: e.market, vaultMintRecord: m.record,
      optionMint: m.mint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: optAta(m.mint, m.writer.publicKey),
      ownerUsdcAccount: await usdcAta(e, m.writer.publicKey), usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([m.writer]).rpc();
    return { order, escrow };
  }

  /** A holder buys `qty` contracts off the writer ask — the inventory they will sell. */
  async function acquire(m: any, askNonce: BN, holder: Keypair, qty: number) {
    const { order, escrow } = orderPdas(m.mint, m.writer.publicKey, askNonce);
    const { pot, potUsdc, position } = potPdas(m.mint, m.writer.publicKey);
    const holderOpt = optAta(m.mint, holder.publicKey);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      holder.publicKey, holderOpt, holder.publicKey, m.mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    await e.opta.methods.fillWriterAsk(new BN(qty)).accountsStrict({
      taker: holder.publicKey, optionMint: m.mint, order, maker: m.writer.publicKey, sharedVault: m.vault,
      vaultMintRecord: m.record, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: await usdcAta(e, holder.publicKey),
      makerUsdcAccount: getAssociatedTokenAddressSync(e.usdcMint, m.writer.publicKey, false, TOKEN_PROGRAM_ID),
      takerOptionAccount: holderOpt, writerAskPot: pot, writerAskPotUsdc: potUsdc,
      writerAskPosition: position, usdcMint: e.usdcMint, tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).preInstructions([CU(400_000), ataIx]).signers([holder]).rpc();
    return holderOpt;
  }

  /** A bidder posts a Bid — escrows price×qty USDC into the per-order escrow. */
  async function postBid(m: any, bidder: Keypair, price: BN, qty: number, nonce: BN) {
    const { order, escrow } = orderPdas(m.mint, bidder.publicKey, nonce);
    await e.opta.methods.postOrder(BID, price, new BN(qty), nonce).accountsStrict({
      owner: bidder.publicKey, sharedVault: m.vault, market: e.market, vaultMintRecord: m.record,
      optionMint: m.mint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: optAta(m.mint, bidder.publicKey),
      ownerUsdcAccount: await usdcAta(e, bidder.publicKey), usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([bidder]).rpc();
    return { order, escrow };
  }

  /** Place a sell trigger. `floor` is the B2 per-contract MIN proceeds constraint
   *  (stored in max_premium; 0 = book-ineligible). */
  async function placeSell(
    m: any, owner: Keypair, kind: any, cmp: any, thresholdUsd: BN, qty: number, floor: BN, nonce: BN,
  ) {
    const { order, escrow } = triggerPdas(owner.publicKey, m.mint, nonce);
    await e.opta.methods.placeTrigger(kind, cmp, thresholdUsd, new BN(qty), floor, nonce, { underlying: {} }).accountsStrict({
      owner: owner.publicKey, market: e.market, sharedVault: m.vault, vaultMintRecord: m.record,
      optionMint: m.mint, triggerOrder: order, triggerEscrow: escrow, protocolState: e.protocolState,
      usdcMint: e.usdcMint, ownerUsdcAccount: await usdcAta(e, owner.publicKey),
      ownerOptionAta: optAta(m.mint, owner.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([owner]).rpc();
    return { order, escrow };
  }

  /**
   * Fire a sell trigger. `bid` null → NO book accounts (skip-until-bid / vault
   * fallback shape). Otherwise the eleven [21]-[31] optionals for a bid fire:
   * [21]-[23] + [28]-[31]; [24] book_maker_usdc and [25]-[27] are ask-only → null.
   */
  async function fireSell(
    m: any, owner: Keypair, trigNonce: BN, spotUsd: number,
    bid: { order: PublicKey; escrow: PublicKey; bidder: PublicKey } | null,
    expectErr = false,
  ) {
    const { order, escrow } = triggerPdas(owner.publicKey, m.mint, trigNonce);
    const ownerOpt = optAta(m.mint, owner.publicKey);
    const pre = [CU(400_000)];
    if (bid) {
      pre.push(createAssociatedTokenAccountIdempotentInstruction(
        e.admin.publicKey, optAta(m.mint, bid.bidder), bid.bidder, m.mint,
        TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID) as any);
    }
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, spotUsd, await getClockUnix(e.h.context)));
    const b = e.opta.methods.executeTrigger().accountsStrict({
      caller: e.admin.publicKey, triggerOrder: order, market: e.market, sharedVault: m.vault,
      vaultMintRecord: m.record, optionMint: m.mint, priceUpdate: fix, volOracle: e.volOracle,
      protocolState: e.protocolState, treasury: e.treasury, triggerEscrow: escrow,
      holderOptionAta: ownerOpt, ownerUsdcAccount: await usdcAta(e, owner.publicKey),
      ownerWallet: owner.publicKey, vaultUsdcAccount: m.vaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      bookOrder: bid ? bid.order : null,
      bookMaker: bid ? bid.bidder : null,
      bookEscrow: bid ? bid.escrow : null,
      bookMakerUsdc: null,                       // [24] ask-only
      writerAskPot: null, writerAskPotUsdc: null, writerAskPosition: null,  // [25]-[27] ask-only
      bookHookMetas: bid ? m.extraMetas : null,
      bookHookProgram: bid ? HOOK_PROGRAM_ID : null,
      bookHookState: bid ? m.hookState : null,
      bookMakerOption: bid ? optAta(m.mint, bid.bidder) : null,             // [31] bid-only
      ocoPeer: null,   // [32] B3 OCO peer; null unless the trigger is paired
    }).preInstructions(pre);
    if (expectErr) { let msg = ""; try { await b.rpc(); } catch (x: any) { msg = String(x); } return msg; }
    await b.rpc();
    return "";
  }

  /** One-call fixture: series + writer ask + a holder owning `qty` contracts. */
  async function withHolder(depositUsd: number, askPrice: BN, askQty: number, holderQty: number) {
    const m = await mkSeries(depositUsd);
    const askNonce = nextNonce();
    await postAsk(m, askPrice, askQty, askNonce);
    const holder = actor(e);
    await usdcAta(e, holder.publicKey);
    const holderOpt = await acquire(m, askNonce, holder, holderQty);
    return { m, holder, holderOpt };
  }

  before(async () => {
    e = await setupEnv("SELLBOOK", "sellbook-feed", 100);
    strike = usdc(100);
  });

  // ---- a ------------------------------------------------------------------
  it("a — TP-sell fires into a bid: delegate pull → maker, bid escrow USDC → owner, fee split", async () => {
    const { m, holder, holderOpt } = await withHolder(5000, usdc(6), 10, 5);
    const bidder = actor(e);
    await usdcAta(e, bidder.publicKey);
    const BP = usdc(7); const BQ = 5;
    const bid = await postBid(m, bidder, BP, BQ, nextNonce());
    const bidderOpt = optAta(m.mint, bidder.publicKey);

    const trigNonce = nextNonce();
    const Q = 3;
    // Strike $100, spot $100 → intrinsic 0. The VAULT exercise path would revert
    // OptionNotInTheMoney here, so a green fire PROVES the book path was taken.
    await placeSell(m, holder, TP_SELL, GE, usdc(100), Q, usdc(5), trigNonce);

    const ownerUsdc = await usdcAta(e, holder.publicKey);
    const uBefore = await bal(e, ownerUsdc);
    const tBefore = await bal(e, e.treasury);
    const escBefore = await bal(e, bid.escrow);
    const optBefore = await bal(e, holderOpt);

    await fireSell(m, holder, trigNonce, 100, { ...bid, bidder: bidder.publicKey });

    const total = BP.muln(Q);
    const fee = feeOf(total);
    assert.equal(optBefore - (await bal(e, holderOpt)), BigInt(Q), "delegate pulled Q out of the owner's ATA");
    assert.equal(await bal(e, bidderOpt), BigInt(Q), "bidder (maker) received Q contracts");
    assert.equal((await bal(e, ownerUsdc)) - uBefore, BigInt(total.sub(fee).toString()), "owner got total − fee");
    assert.equal((await bal(e, e.treasury)) - tBefore, BigInt(fee.toString()), "treasury got the fee");
    assert.equal(escBefore - (await bal(e, bid.escrow)), BigInt(total.toString()), "bid escrow debited exactly total");
  });

  // ---- b ------------------------------------------------------------------
  it("b — SL-sell takes the SAME path (StopLossSellDark 6079 retired in the testing build)", async () => {
    const { m, holder, holderOpt } = await withHolder(5000, usdc(6), 10, 4);
    const bidder = actor(e);
    await usdcAta(e, bidder.publicKey);
    const BP = usdc(2); const BQ = 4;
    const bid = await postBid(m, bidder, BP, BQ, nextNonce());

    const trigNonce = nextNonce();
    const Q = 2;
    // A true stop-loss: OTM long, LE comparator. No vault path exists for this.
    await placeSell(m, holder, SL_SELL, LE, usdc(100), Q, usdc(1), trigNonce);

    const ownerUsdc = await usdcAta(e, holder.publicKey);
    const uBefore = await bal(e, ownerUsdc);
    const optBefore = await bal(e, holderOpt);

    const msg = await fireSell(m, holder, trigNonce, 100, { ...bid, bidder: bidder.publicKey }, true);
    assert.equal(msg, "", `SL-sell must NOT revert 6079 on the book path (${msg.slice(0, 160)})`);

    const total = BP.muln(Q);
    const fee = feeOf(total);
    assert.equal(optBefore - (await bal(e, holderOpt)), BigInt(Q), "SL delegate-pulled Q");
    assert.equal(await bal(e, optAta(m.mint, bidder.publicKey)), BigInt(Q), "bidder received Q");
    assert.equal((await bal(e, ownerUsdc)) - uBefore, BigInt(total.sub(fee).toString()), "owner got total − fee");
  });

  // ---- c ------------------------------------------------------------------
  it("c — skip-until-bid: no crossing bid → TriggerSkipped, no revert, stays ARMED", async () => {
    const { m, holder, holderOpt } = await withHolder(5000, usdc(6), 10, 4);
    const trigNonce = nextNonce();
    const { order } = await placeSell(m, holder, SL_SELL, LE, usdc(100), 3, usdc(1), trigNonce);
    const optBefore = await bal(e, holderOpt);

    // Keeper found nothing to lift → passes NO book accounts at all.
    const msg = await fireSell(m, holder, trigNonce, 100, null, true);
    assert.equal(msg, "", `empty book must not revert (${msg.slice(0, 160)})`);
    assert.isTrue(await exists(e, order), "trigger STILL ARMED");
    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.quantity.toString(), "3", "quantity untouched");
    assert.equal(await bal(e, holderOpt), optBefore, "no option movement");

    // Same skip when a bid IS passed but carries zero depth (open, exhausted).
    const bidder = actor(e);
    await usdcAta(e, bidder.publicKey);
    const bid = await postBid(m, bidder, usdc(2), 4, nextNonce());
    const acc = await e.h.context.banksClient.getAccount(bid.order);
    const data = Buffer.from(acc!.data);
    data.writeBigUInt64LE(0n, 113);   // quantity_remaining → 0, order stays OPEN
    e.h.context.setAccount(bid.order, {
      lamports: acc!.lamports, data, owner: acc!.owner, executable: acc!.executable, rentEpoch: Number(acc!.rentEpoch),
    });
    const msg2 = await fireSell(m, holder, trigNonce, 100, { ...bid, bidder: bidder.publicKey }, true);
    assert.equal(msg2, "", `zero-depth bid must not revert (${msg2.slice(0, 160)})`);
    assert.isTrue(await exists(e, order), "trigger STILL ARMED after zero-depth skip");
    assert.equal(await bal(e, holderOpt), optBefore, "still no option movement");
  });

  // ---- d ------------------------------------------------------------------
  it("d — partial: bid depth < trigger qty → fires depth, remainder ARMED, decrement exact", async () => {
    const { m, holder, holderOpt } = await withHolder(5000, usdc(6), 10, 8);
    const bidder = actor(e);
    await usdcAta(e, bidder.publicKey);
    const BP = usdc(4);
    const bid = await postBid(m, bidder, BP, 3, nextNonce());   // only 3 deep

    const trigNonce = nextNonce();
    const Q = 7;                                                 // wants 7
    const { order } = await placeSell(m, holder, TP_SELL, GE, usdc(100), Q, usdc(1), trigNonce);
    const optBefore = await bal(e, holderOpt);

    await fireSell(m, holder, trigNonce, 100, { ...bid, bidder: bidder.publicKey });

    assert.equal(optBefore - (await bal(e, holderOpt)), 3n, "fired min(7,3) = 3");
    assert.isTrue(await exists(e, order), "trigger STILL ARMED for the remainder");
    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.quantity.toString(), "4", "remaining == 7 − 3");
    assert.isFalse(await exists(e, bid.order), "fully-lifted bid closed");
    assert.isFalse(await exists(e, bid.escrow), "emptied bid escrow closed");
  });

  // ---- e ------------------------------------------------------------------
  it("e — bid price below the owner's stored floor → BidPriceBelowMin (6083) REVERT", async () => {
    const { m, holder, holderOpt } = await withHolder(5000, usdc(6), 10, 4);
    const bidder = actor(e);
    await usdcAta(e, bidder.publicKey);
    const bid = await postBid(m, bidder, usdc(2), 4, nextNonce());   // bid $2

    const trigNonce = nextNonce();
    const { order } = await placeSell(m, holder, SL_SELL, LE, usdc(100), 2, usdc(5), trigNonce); // floor $5
    const optBefore = await bal(e, holderOpt);

    const msg = await fireSell(m, holder, trigNonce, 100, { ...bid, bidder: bidder.publicKey }, true);
    assert.isTrue(msg.includes("BidPriceBelowMin") || msg.includes("6083"), `6083 expected (${msg.slice(0, 200)})`);
    assert.isTrue(await exists(e, order), "trigger survives the reverted fire");
    assert.equal(await bal(e, holderOpt), optBefore, "no option left the owner's ATA");

    // A floor of 0 is book-INELIGIBLE — a sell placed the old way can never be
    // dumped into the book by a permissionless keeper.
    const n2 = nextNonce();
    await placeSell(m, holder, SL_SELL, LE, usdc(100), 2, new BN(0), n2);
    const msg2 = await fireSell(m, holder, n2, 100, { ...bid, bidder: bidder.publicKey }, true);
    assert.isTrue(msg2.includes("SellFloorRequired") || msg2.includes("6082"), `6082 expected (${msg2.slice(0, 200)})`);
  });

  // ---- f ------------------------------------------------------------------
  it("f — sell-side conservation to the unit: qty out == qty in; USDC == qty×price − fee (exact)", async () => {
    const { m, holder, holderOpt } = await withHolder(5000, usdc(6), 12, 9);
    const bidder = actor(e);
    const bidderUsdc = await usdcAta(e, bidder.publicKey);
    const BP = usdc(3); const BQ = 9;
    const bid = await postBid(m, bidder, BP, BQ, nextNonce());
    const bidderOpt = optAta(m.mint, bidder.publicKey);

    const trigNonce = nextNonce();
    const Q = 6;
    await placeSell(m, holder, TP_SELL, GE, usdc(100), Q, usdc(1), trigNonce);

    const ownerUsdc = await usdcAta(e, holder.publicKey);
    const uBefore = await bal(e, ownerUsdc);
    const tBefore = await bal(e, e.treasury);
    const escBefore = await bal(e, bid.escrow);
    const optBefore = await bal(e, holderOpt);
    const bidderUsdcBefore = await bal(e, bidderUsdc);

    await fireSell(m, holder, trigNonce, 100, { ...bid, bidder: bidder.publicKey });

    const total = BigInt(BP.muln(Q).toString());
    const fee = BigInt(feeOf(BP.muln(Q)).toString());
    const optOut = optBefore - (await bal(e, holderOpt));
    const optIn = await bal(e, bidderOpt);
    const usdcIn = (await bal(e, ownerUsdc)) - uBefore;
    const feeIn = (await bal(e, e.treasury)) - tBefore;
    const escOut = escBefore - (await bal(e, bid.escrow));

    // Option leg: nothing minted, nothing burned — a pure transfer.
    assert.equal(optOut, BigInt(Q), "exactly Q left the owner");
    assert.equal(optIn, BigInt(Q), "exactly Q reached the maker");
    assert.equal(optOut, optIn, "CONSERVATION: option qty out == qty in");
    // USDC leg: the escrow debit splits with ZERO residue.
    assert.equal(usdcIn, total - fee, "owner USDC in == qty×price − fee");
    assert.equal(feeIn, fee, "treasury in == fee");
    assert.equal(usdcIn + feeIn, escOut, "CONSERVATION: owner + treasury == escrow debit");
    assert.equal(escOut, total, "escrow debit == qty × bid_price exactly");
    // The bidder's own wallet is untouched — the bid was pre-funded at post time.
    assert.equal(await bal(e, bidderUsdc), bidderUsdcBefore, "bidder wallet untouched (escrow pre-funded)");
    // Remaining bid depth is exact.
    const bAcc: any = await e.opta.account.restingOrder.fetch(bid.order);
    assert.equal(bAcc.quantityRemaining.toString(), String(BQ - Q), "bid decremented exactly");
    assert.equal((await bal(e, bid.escrow)).toString(), BP.muln(BQ - Q).toString(), "bid escrow == remaining × price");
  });

  // ---- g ------------------------------------------------------------------
  it("g — no book accounts: TP-sell takes the UNCHANGED vault exercise path", async () => {
    // The flag-off production shape. With book_order = None the sell falls back
    // to american_exercise_core exactly as it does today (ITM required).
    const { m, holder, holderOpt } = await withHolder(5000, usdc(6), 10, 4);
    const trigNonce = nextNonce();
    const Q = 2;
    await placeSell(m, holder, TP_SELL, GE, usdc(100), Q, new BN(0), trigNonce);

    const ownerUsdc = await usdcAta(e, holder.publicKey);
    const uBefore = await bal(e, ownerUsdc);
    const vBefore = await bal(e, m.vaultUsdc);
    const optBefore = await bal(e, holderOpt);

    await fireSell(m, holder, trigNonce, 120, null);   // spot 120 > strike 100 → ITM

    const intrinsic = usdc(20).muln(Q);                 // (120 − 100) × Q
    assert.equal(optBefore - (await bal(e, holderOpt)), BigInt(Q), "vault path BURNED Q from the owner");
    assert.equal((await bal(e, ownerUsdc)) - uBefore, BigInt(intrinsic.toString()), "vault paid intrinsic");
    assert.equal(vBefore - (await bal(e, m.vaultUsdc)), BigInt(intrinsic.toString()), "vault USDC funded it");
  });

  // ---- h ------------------------------------------------------------------
  it("h — expiry guard: expired series → TriggerSkipped, no fire, no token movement", async () => {
    const { m, holder, holderOpt } = await withHolder(5000, usdc(6), 10, 4);
    const bidder = actor(e);
    await usdcAta(e, bidder.publicKey);
    const bid = await postBid(m, bidder, usdc(4), 4, nextNonce());

    const trigNonce = nextNonce();
    const { order } = await placeSell(m, holder, SL_SELL, LE, usdc(100), 2, usdc(1), trigNonce);

    const ownerUsdc = await usdcAta(e, holder.publicKey);
    const uBefore = await bal(e, ownerUsdc);
    const optBefore = await bal(e, holderOpt);
    const escBefore = await bal(e, bid.escrow);

    // Walk the clock past the series expiry, then fire with a live crossing bid.
    await setClockUnix(e.h.context, m.expiry.toNumber() + 60);
    const msg = await fireSell(m, holder, trigNonce, 100, { ...bid, bidder: bidder.publicKey }, true);

    assert.equal(msg, "", `expired series must SKIP, not revert (${msg.slice(0, 200)})`);
    assert.equal(await bal(e, holderOpt), optBefore, "no option left the owner's ATA");
    assert.equal(await bal(e, ownerUsdc), uBefore, "no USDC reached the owner");
    assert.equal(await bal(e, bid.escrow), escBefore, "bid escrow untouched");
    assert.isTrue(await exists(e, order), "trigger still exists (owner can cancel)");
    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.quantity.toString(), "2", "quantity untouched");
  });
});
