// =============================================================================
// tests/bankrun/trigger-tape-oco.test.ts — 2A behavioural suite
// =============================================================================
// Covers the three behaviours the 2A program change introduces. Everything else
// in the trigger suites is regression; these are the paths that did not exist
// before, so nothing else can prove them.
//
//   TAPE  the comparator reads the tape THE ORDER SELECTED, not always the
//         underlying. Proven by DISCRIMINATION, not by a single green: the same
//         threshold and the same comparator produce OPPOSITE outcomes depending
//         only on `tape`. A test that merely fired an Underlying trigger would
//         pass just as well if the Contract branch were dead code.
//
//         Underlying spot is ~100 USDC (setupEnv warm spot) and an ATM ~7d CALL
//         marks in the single digits, so a threshold of 50 sits cleanly between
//         them and splits in BOTH comparator directions.
//
//   OCO   a fire decrements the sibling in the SAME transaction, and the link
//         cannot be forged, self-referential, cross-series, or silently dropped.
//
//   ERRORS 6086 / 6087 / 6088 / 6089 / 6090 each raised by the exact condition
//         they name — not merely "some revert happened".
//
// RUNTIME SHAPE: decoded accounts come back PascalCase ({"American":{}}) while
// instruction args must be camelCase ({american:{}}). Measured 2026-08-18; a
// lowercase filter against decoded data silently matched nothing. Args below are
// camelCase; any assertion against fetched account data uses PascalCase.
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
  setupEnv, createVault, deposit, usdcAta, bal, exists, actor, pda, getClockUnix, Env,
  HOOK_PROGRAM_ID, usdc, CU, pythBody,
} from "./helpers";
import { injectPythFixture } from "./bootstrap";

const DAY = 86_400;
const CALL = { call: {} };
const AMERICAN = { american: {} };
const EUROPEAN = { european: {} };
const BUY = { stopEntryBuy: {} };
const LE = { lessOrEqual: {} };
const GE = { greaterOrEqual: {} };
const UNDERLYING = { underlying: {} };
const CONTRACT = { contract: {} };

// Sits between the underlying (~100) and an ATM short-dated mark (single digits).
const SPLIT = usdc(50);

function deriveTrigger(owner: PublicKey, mint: PublicKey, nonce: BN) {
  const order = pda([Buffer.from("trigger_order"), owner.toBuffer(), mint.toBuffer(),
    nonce.toArrayLike(Buffer, "le", 8)]);
  const escrow = pda([Buffer.from("trigger_escrow"), order.toBuffer()]);
  return { order, escrow };
}

function codeOf(err: any): number | null {
  const n = err?.error?.errorCode?.number;
  if (typeof n === "number") return n;
  const m = String(err?.message ?? err).match(/custom program error: 0x([0-9a-f]+)/i);
  return m ? parseInt(m[1], 16) : null;
}

async function expectCode(fn: () => Promise<any>, want: number, what: string) {
  try {
    await fn();
    assert.fail(`${what}: expected ${want}, but it SUCCEEDED`);
  } catch (e: any) {
    const got = codeOf(e);
    assert.equal(got, want, `${what}: expected ${want}, got ${got} (${String(e?.message ?? e).slice(0, 120)})`);
  }
}

describe("2A — tape source + OCO", () => {
  let e: Env;
  let nonceSeq = 9000;
  const nextNonce = () => new BN(nonceSeq++);

  before(async () => {
    e = await setupEnv("TAPEOCO", "TAPEOCO/USD", 100);
  });

  function deriveSeriesLocal(strike: BN, expiry: BN, style: any) {
    // Mirrors the vault-mint derivation used by createSeries in the other suites.
    const otByte = Buffer.from([0]);              // CALL
    const esByte = Buffer.from([style === AMERICAN ? 1 : 0]);
    const mint = pda([Buffer.from("vault_option_mint"), e.market.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), otByte, esByte]);
    const record = pda([Buffer.from("vault_mint_record"), mint.toBuffer()]);
    const extraMetas = pda([Buffer.from("extra-account-metas"), mint.toBuffer()], HOOK_PROGRAM_ID);
    const hookState = pda([Buffer.from("hook-state"), mint.toBuffer()], HOOK_PROGRAM_ID);
    return { mint, record, extraMetas, hookState };
  }

  async function makeSeries(strike: BN, expiry: BN, style: any, depositUsd = 5000) {
    const writer = actor(e);
    await usdcAta(e, writer.publicKey);
    const styleName = style === AMERICAN ? "american" : "european";
    const { vault, vaultUsdc } = await createVault(e, styleName as any, strike, expiry, CALL, writer);
    await deposit(e, vault, vaultUsdc, writer, depositUsd);
    const s = deriveSeriesLocal(strike, expiry, style);
    await e.opta.methods.createSeries(strike, expiry, CALL, style).accountsStrict({
      caller: e.admin.publicKey, market: e.market, protocolState: e.protocolState,
      optionMint: s.mint, vaultMintRecord: s.record, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: s.extraMetas, hookState: s.hookState,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    return { vault, vaultUsdc, s };
  }

  async function placeBuy(
    owner: Keypair, s: any, vault: PublicKey, comparator: any, threshold: BN,
    qty: number, nonce: BN, tape: any,
  ) {
    const { order, escrow } = deriveTrigger(owner.publicKey, s.mint, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(s.mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await e.opta.methods
      // max_premium is PER CONTRACT and the escrow is max_premium x quantity.
      // usdc(1_000_000) escrows a million USDC per contract against a 10,000
      // USDC test balance, which fails in the Token program (0x1) during setup
      // and looks nothing like a program-logic failure.
      .placeTrigger(BUY, comparator, threshold, new BN(qty), usdc(50), nonce, tape)
      .accountsStrict({
        owner: owner.publicKey, market: e.market, sharedVault: vault, vaultMintRecord: s.record,
        optionMint: s.mint, triggerOrder: order, triggerEscrow: escrow, protocolState: e.protocolState,
        usdcMint: e.usdcMint, ownerUsdcAccount: ownerUsdc, ownerOptionAta: ownerOpt,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      }).preInstructions([CU(400_000)]).signers([owner]).rpc();
    return { order, escrow, ownerUsdc, ownerOpt };
  }

  async function fire(
    owner: Keypair, s: any, vault: PublicKey, vaultUsdc: PublicKey, nonce: BN,
    spotUsd: number, ocoPeer: PublicKey | null = null,
  ) {
    const { order, escrow } = deriveTrigger(owner.publicKey, s.mint, nonce);
    const now = await getClockUnix(e.h.context);
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, spotUsd, now));
    const ownerOpt = getAssociatedTokenAddressSync(s.mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    return e.opta.methods.executeTrigger().accountsStrict({
      caller: e.admin.publicKey, triggerOrder: order, market: e.market, sharedVault: vault,
      vaultMintRecord: s.record, optionMint: s.mint, priceUpdate: fix, volOracle: e.volOracle,
      protocolState: e.protocolState, treasury: e.treasury, triggerEscrow: escrow,
      holderOptionAta: ownerOpt, ownerUsdcAccount: ownerUsdc, ownerWallet: owner.publicKey,
      vaultUsdcAccount: vaultUsdc, tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      bookOrder: null, bookMaker: null, bookEscrow: null, bookMakerUsdc: null,
      writerAskPot: null, writerAskPotUsdc: null, writerAskPosition: null,
      bookHookMetas: null, bookHookProgram: null, bookHookState: null, bookMakerOption: null,
      ocoPeer,
    }).preInstructions([CU(700_000)]).rpc();
  }

  // ---------------------------------------------------------------------------
  // TAPE — proven by discrimination
  // ---------------------------------------------------------------------------

  it("tape default is Underlying and is stored as such", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 100);
    const { vault, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const nonce = nextNonce();
    const { order } = await placeBuy(owner, s, vault, GE, SPLIT, 1, nonce, UNDERLYING);
    const acct: any = await e.opta.account.triggerOrder.fetch(order);
    // Decoded enums are PascalCase.
    assert.property(acct.tape, "underlying");
  });

  it("UNDERLYING + GE at the split fires (underlying ~100 >= 50)", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 200);
    const { vault, vaultUsdc, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const nonce = nextNonce();
    await placeBuy(owner, s, vault, GE, SPLIT, 1, nonce, UNDERLYING);
    await fire(owner, s, vault, vaultUsdc, nonce, 100);
    const { order } = deriveTrigger(owner.publicKey, s.mint, nonce);
    assert.isFalse(await exists(e, order), "a full fill closes the trigger");
  });

  it("CONTRACT + GE at the SAME split does NOT fire (mark << 50) — 6059", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 300);
    const { vault, vaultUsdc, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const nonce = nextNonce();
    await placeBuy(owner, s, vault, GE, SPLIT, 1, nonce, CONTRACT);
    // Same threshold, same comparator, same spot as the test above. Only `tape`
    // differs — so a pass here proves the Contract branch is actually read.
    await expectCode(() => fire(owner, s, vault, vaultUsdc, nonce, 100), 6059,
      "contract tape GE must not fire on the underlying");
  });

  it("CONTRACT + LE at the split fires (mark << 50)", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 400);
    const { vault, vaultUsdc, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const nonce = nextNonce();
    await placeBuy(owner, s, vault, LE, SPLIT, 1, nonce, CONTRACT);
    await fire(owner, s, vault, vaultUsdc, nonce, 100);
    const { order } = deriveTrigger(owner.publicKey, s.mint, nonce);
    assert.isFalse(await exists(e, order));
  });

  it("UNDERLYING + LE at the SAME split does NOT fire (100 > 50) — 6059", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 500);
    const { vault, vaultUsdc, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const nonce = nextNonce();
    await placeBuy(owner, s, vault, LE, SPLIT, 1, nonce, UNDERLYING);
    await expectCode(() => fire(owner, s, vault, vaultUsdc, nonce, 100), 6059,
      "underlying tape LE must not fire when spot is above the split");
  });

  it("6086 is defence-in-depth: European is already blocked one layer earlier (6055)", async () => {
    // The intended path for this test does not exist. `create_series` is
    // American-only in Phase 2 (SeriesMustBeAmerican, 6055), so a European SERIES
    // cannot be created at all — and a trigger needs a series mint. 6086 is
    // therefore a SECOND line of defence that is currently unreachable, not a
    // live guard, and saying so is more useful than deleting the check or
    // pretending the test exercised it.
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 600);
    await expectCode(
      () => makeSeries(strike, expiry, EUROPEAN),
      6055, "European series creation");
  });

  // ---------------------------------------------------------------------------
  // OCO
  // ---------------------------------------------------------------------------

  async function pair(owner: Keypair, s: any, vault: PublicKey) {
    const nA = nextNonce(), nB = nextNonce();
    await placeBuy(owner, s, vault, GE, SPLIT, 2, nA, UNDERLYING);
    await placeBuy(owner, s, vault, LE, SPLIT, 2, nB, UNDERLYING);
    const a = deriveTrigger(owner.publicKey, s.mint, nA).order;
    const b = deriveTrigger(owner.publicKey, s.mint, nB).order;
    await e.opta.methods.linkOco().accountsStrict({
      owner: owner.publicKey, triggerA: a, triggerB: b,
    }).signers([owner]).rpc();
    return { a, b, nA, nB };
  }

  it("link_oco writes a MUTUAL link", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 700);
    const { vault, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const { a, b } = await pair(owner, s, vault);
    const ta: any = await e.opta.account.triggerOrder.fetch(a);
    const tb: any = await e.opta.account.triggerOrder.fetch(b);
    assert.equal(ta.ocoLink?.toBase58(), b.toBase58());
    assert.equal(tb.ocoLink?.toBase58(), a.toBase58());
  });

  it("6089 — re-linking an already-paired leg is refused", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 800);
    const { vault, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const { a } = await pair(owner, s, vault);
    const nC = nextNonce();
    await placeBuy(owner, s, vault, GE, SPLIT, 1, nC, UNDERLYING);
    const c = deriveTrigger(owner.publicKey, s.mint, nC).order;
    await expectCode(() => e.opta.methods.linkOco().accountsStrict({
      owner: owner.publicKey, triggerA: a, triggerB: c,
    }).signers([owner]).rpc(), 6089, "re-link a paired leg");
  });

  it("6090 — legs on different series cannot be linked", async () => {
    const now = await getClockUnix(e.h.context);
    const s1 = await makeSeries(usdc(100), new BN(now + 7 * DAY + 900), AMERICAN);
    const s2 = await makeSeries(usdc(110), new BN(now + 7 * DAY + 950), AMERICAN);
    const owner = actor(e);
    const n1 = nextNonce(), n2 = nextNonce();
    await placeBuy(owner, s1.s, s1.vault, GE, SPLIT, 1, n1, UNDERLYING);
    await placeBuy(owner, s2.s, s2.vault, GE, SPLIT, 1, n2, UNDERLYING);
    await expectCode(() => e.opta.methods.linkOco().accountsStrict({
      owner: owner.publicKey,
      triggerA: deriveTrigger(owner.publicKey, s1.s.mint, n1).order,
      triggerB: deriveTrigger(owner.publicKey, s2.s.mint, n2).order,
    }).signers([owner]).rpc(), 6090, "cross-series link");
  });

  it("a fire DECREMENTS the sibling in the same transaction", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 1000);
    const { vault, vaultUsdc, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const { a, b, nA } = await pair(owner, s, vault);

    const before: any = await e.opta.account.triggerOrder.fetch(b);
    assert.equal(before.quantity.toNumber(), 2);

    await fire(owner, s, vault, vaultUsdc, nA, 100, b);

    const after: any = await e.opta.account.triggerOrder.fetch(b);
    assert.equal(after.quantity.toNumber(), 0,
      "leg A fired 2 → the sibling must be decremented to 0 in the SAME tx");
    assert.isFalse(await exists(e, a), "the fired leg closes on a full fill");
  });

  it("6087 — a linked trigger cannot fire without its peer supplied", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 1100);
    const { vault, vaultUsdc, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const { nA } = await pair(owner, s, vault);
    await expectCode(() => fire(owner, s, vault, vaultUsdc, nA, 100, null), 6087,
      "linked trigger with ocoPeer omitted");
  });

  it("6088 — a peer that is not the linked one is refused", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 1200);
    const { vault, vaultUsdc, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const { nA } = await pair(owner, s, vault);
    // An unrelated, unlinked trigger — the account a griefer would substitute to
    // decrement somebody else's order.
    const nX = nextNonce();
    await placeBuy(owner, s, vault, GE, SPLIT, 1, nX, UNDERLYING);
    const x = deriveTrigger(owner.publicKey, s.mint, nX).order;
    await expectCode(() => fire(owner, s, vault, vaultUsdc, nA, 100, x), 6088,
      "substituted peer");
  });

  // ---------------------------------------------------------------------------
  // POST-OCO STATE — where the close-at-zero deferral could bite
  // ---------------------------------------------------------------------------

  it("a zeroed sibling cannot fire, and cancel still reclaims its rent", async () => {
    const strike = usdc(100);
    const expiry = new BN((await getClockUnix(e.h.context)) + 7 * DAY + 1300);
    const { vault, vaultUsdc, s } = await makeSeries(strike, expiry, AMERICAN);
    const owner = actor(e);
    const { b, nA, nB } = await pair(owner, s, vault);

    await fire(owner, s, vault, vaultUsdc, nA, 100, b);
    const zeroed: any = await e.opta.account.triggerOrder.fetch(b);
    assert.equal(zeroed.quantity.toNumber(), 0);

    // The keeper's contract: a zero-quantity leg is inert. Attempting it must not
    // move tokens — it must revert, so a keeper that retried would get a hard
    // stop rather than a silent partial.
    let fired = false;
    try { await fire(owner, s, vault, vaultUsdc, nB, 100, null); fired = true; } catch { /* expected */ }
    assert.isFalse(fired, "a zero-quantity trigger must not fire");

    // Rent hygiene: close-at-zero is deferred (B3.5), so cancel must still work
    // on the zeroed leg and return its rent.
    const { escrow } = deriveTrigger(owner.publicKey, s.mint, nB);
    const lamportsBefore = await e.h.context.banksClient.getBalance(owner.publicKey);
    await e.opta.methods.cancelTrigger().accountsStrict({
      owner: owner.publicKey, triggerOrder: b, triggerEscrow: escrow,
      protocolState: e.protocolState,
      ownerUsdcAccount: await usdcAta(e, owner.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
      ocoPeer: null,   // its partner already closed on the fire, so the link is dead
    }).signers([owner]).rpc();
    assert.isFalse(await exists(e, b), "cancel closes the zeroed leg");
    const lamportsAfter = await e.h.context.banksClient.getBalance(owner.publicKey);
    assert.isTrue(lamportsAfter > lamportsBefore, "rent must come back to the owner");
  });
});
