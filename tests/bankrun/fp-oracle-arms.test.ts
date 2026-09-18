// =============================================================================
// FP-ORACLE plug, wave 1 — the six armed oracle_source sites + the D1 guard.
//
// Every test here is a market that was born on Pyth (setupEnv, source 0) and is
// FLIPPED to ORACLE_SOURCE_OPTA through set_oracle_source, exactly as the plug
// ceremony will do it. Nothing fabricates a source-2 byte by hand: if the flip
// path is wrong, every test below fails with it.
//
// Tests tagged "D1 guard" are the mutation target of
// scripts/fp-oracle-guard-mutation.sh: with the guard block deleted they MUST
// fail (the flip lands on a dead feed). If they keep passing on the mutant, the
// guard was never what refused the flip.
// =============================================================================
import { assert } from "chai";
import { SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  setupEnv, getClockUnix, setClockUnix, fundWallet, createVault, deposit, mint, purchase,
  createSeries, usdcAta, bal, actor, pda, settlementRecordPda, deriveVaultUsdc, CU,
  BN, PublicKey, Keypair, OPTA_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, HOOK_PROGRAM_ID, Env,
} from "./helpers";
import { synthFeedIdHex } from "../_pyth_fixtures";

const OPTA = 2;
const READ_MAX_AGE = 180;       // OPTA_FEED_READ_MAX_AGE_SECS
const SETTLE_WINDOW = 300;      // SB_SETTLE_WINDOW_SECS, shared by the Opta arm
const px = (n: number) => new BN(Math.round(n * 1_000_000));
const usdc = px;
const CALL = { call: {} };
const feedPda = (bytes: number[]) =>
  PublicKey.findProgramAddressSync([Buffer.from("opta_price_feed"), Buffer.from(bytes)], OPTA_PROGRAM_ID)[0];

function assertErr(err: string, name: string, ctx: string) {
  assert.include(err, name, `${ctx}: expected ${name}, got: ${err.slice(0, 400)}`);
}
async function attempt(p: Promise<unknown>): Promise<{ ok: boolean; err: string }> {
  try { await p; return { ok: true, err: "" }; } catch (ex: any) { return { ok: false, err: String(ex) }; }
}

/** An Opta feed for the SAME feed_id the market carries, with its own authority. */
async function initFeed(e: Env, bytes: number[]) {
  const feed = feedPda(bytes);
  const authority = Keypair.generate();
  fundWallet(e.h.context, authority);
  await e.opta.methods.initOptaPriceFeed(bytes, authority.publicKey).accountsStrict({
    admin: e.admin.publicKey, protocolState: e.protocolState, optaPriceFeed: feed, systemProgram: SystemProgram.programId,
  }).rpc();
  return { feed, authority };
}
async function push(e: Env, bytes: number[], feed: PublicKey, authority: Keypair, priceUsd: number, publishTime?: number) {
  const t = publishTime ?? (await getClockUnix(e.h.context));
  await e.opta.methods.pushOptaPrice(bytes, px(priceUsd), px(priceUsd * 0.0005), new BN(t))
    .accountsStrict({ authority: authority.publicKey, optaPriceFeed: feed }).signers([authority]).rpc();
}
/** set_oracle_source exactly as the ceremony calls it. `feed` null = omit the guard input. */
function flip(e: Env, newSource: number, feed: PublicKey | null, vaults: PublicKey[] = []) {
  return e.opta.methods.setOracleSource(e.asset, e.feedId, newSource).accountsStrict({
    admin: e.admin.publicKey, protocolState: e.protocolState, market: e.market, volOracle: e.volOracle,
    optaPriceFeed: feed,
  }).remainingAccounts(vaults.map((v) => ({ pubkey: v, isSigner: false, isWritable: false }))).rpc();
}
async function sources(e: Env): Promise<[number, number]> {
  const m: any = await (e.opta.account as any).optionsMarket.fetch(e.market);
  const o: any = await (e.opta.account as any).volOracle.fetch(e.volOracle);
  return [Number(m.oracleSource), Number(o.oracleSource)];
}
/** Fresh env + feed pushed once at `priceUsd`, market still on Pyth. */
async function envWithFeed(asset: string, label: string, priceUsd = 100) {
  const e = await setupEnv(asset, label, priceUsd);
  const { feed, authority } = await initFeed(e, e.feedId);
  await push(e, e.feedId, feed, authority, priceUsd);
  return { e, feed, authority };
}

describe("FP-ORACLE wave 1 — set_oracle_source D1 guard", () => {
  it("D1 guard: flip to source 2 WITHOUT the feed account is refused (OptaFeedMissing)", async () => {
    const { e } = await envWithFeed("ARM1", "arm-1");
    const r = await attempt(flip(e, OPTA, null));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedMissing", "flip without feed");
    assert.deepEqual(await sources(e), [0, 0], "nothing flipped");
  });
  it("D1 guard: flip to source 2 with a NEVER-PUSHED feed is refused (OptaFeedInvalidPrice)", async () => {
    const e = await setupEnv("ARM2", "arm-2");
    const { feed } = await initFeed(e, e.feedId);   // exists, price == 0
    const r = await attempt(flip(e, OPTA, feed));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedInvalidPrice", "flip on unpushed feed");
    assert.deepEqual(await sources(e), [0, 0]);
  });
  it("D1 guard: flip to source 2 with a FROZEN feed is refused (OptaFeedFrozen)", async () => {
    const { e, feed } = await envWithFeed("ARM3", "arm-3");
    await e.opta.methods.setFeedFrozen(e.feedId, true).accountsStrict({
      admin: e.admin.publicKey, protocolState: e.protocolState, optaPriceFeed: feed,
    }).rpc();
    const r = await attempt(flip(e, OPTA, feed));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedFrozen", "flip on frozen feed");
    assert.deepEqual(await sources(e), [0, 0]);
  });
  it("D1 guard: flip to source 2 with a STALE feed is refused (OptaFeedStale)", async () => {
    const { e, feed } = await envWithFeed("ARM4", "arm-4");
    const now = await getClockUnix(e.h.context);
    await setClockUnix(e.h.context, now + READ_MAX_AGE + 5);
    const r = await attempt(flip(e, OPTA, feed));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedStale", "flip on stale feed");
    assert.deepEqual(await sources(e), [0, 0]);
  });
  it("D1 guard: flip to source 2 with a feed for a DIFFERENT feed_id is refused (identity)", async () => {
    const { e } = await envWithFeed("ARM5", "arm-5");
    const other = Array.from(Buffer.from(synthFeedIdHex("arm-5-other"), "hex"));
    const { feed: otherFeed, authority } = await initFeed(e, other);
    await push(e, other, otherFeed, authority, 100);
    const r = await attempt(flip(e, OPTA, otherFeed));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedInvalidPrice", "wrong-id feed");
    assert.deepEqual(await sources(e), [0, 0]);
  });
  it("flip to source 2 with a LIVE feed lands: both bytes read 2", async () => {
    const { e, feed } = await envWithFeed("ARM6", "arm-6");
    await flip(e, OPTA, feed);
    assert.deepEqual(await sources(e), [2, 2]);
  });
  it("flip to an unknown source is still InvalidOracleSource", async () => {
    const { e, feed } = await envWithFeed("ARM7", "arm-7");
    const r = await attempt(flip(e, 3, feed));
    assert.isFalse(r.ok); assertErr(r.err, "InvalidOracleSource", "source 3");
  });
  it("flip refuses a market holding open collateral (MarketHasOpenCollateral) — unpluggable while written", async () => {
    const { e, feed } = await envWithFeed("ARM8", "arm-8");
    const writer = actor(e); await usdcAta(e, writer.publicKey);
    const now = await getClockUnix(e.h.context);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), new BN(now + 7 * 86_400), CALL, writer);
    await deposit(e, vault, vaultUsdc, writer, 500);
    const r = await attempt(flip(e, OPTA, feed, [vault]));
    assert.isFalse(r.ok); assertErr(r.err, "MarketHasOpenCollateral", "open collateral");
  });
  it("unplug: flipping BACK to Pyth needs no feed account (config-only)", async () => {
    const { e, feed } = await envWithFeed("ARM9", "arm-9");
    await flip(e, OPTA, feed);
    await flip(e, 0, null);
    assert.deepEqual(await sources(e), [0, 0]);
  });
});

describe("FP-ORACLE wave 1 — push_vol_sample / initialize_vol_oracle arms", () => {
  it("push_vol_sample on a source-2 oracle reads the Opta feed (gap-reseed, then a real sample)", async () => {
    const { e, feed, authority } = await envWithFeed("ARMV1", "arm-v1", 100);
    await flip(e, OPTA, feed);
    const before: any = await (e.opta.account as any).volOracle.fetch(e.volOracle);
    // The warm oracle was last sampled "now"; jump past the 2h gap so the first
    // Opta-sourced push is a RESEED (spot refreshed, ring untouched) ...
    let t = (await getClockUnix(e.h.context)) + 3 * 3600;
    await setClockUnix(e.h.context, t);
    await push(e, e.feedId, feed, authority, 103.0, t);   // +300bps: inside the 500bps band
    const pushVol = () => e.opta.methods.pushVolSample().accountsStrict({
      signer: e.admin.publicKey, priceUpdate: null, volOracle: e.volOracle, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: feed,
    }).rpc();
    await pushVol();
    const mid: any = await (e.opta.account as any).volOracle.fetch(e.volOracle);
    assert.equal(Number(mid.sampleCount), Number(before.sampleCount), "reseed records no sample");
    assert.equal(mid.lastSpotPrice.toString(), (103_000_000n * 1_000_000n).toString(), "spot refreshed from the Opta feed at SCALE");
    // ... then one hour later a real sample lands off the refreshed spot.
    t += 3600; await setClockUnix(e.h.context, t);
    await push(e, e.feedId, feed, authority, 103.5, t);
    await pushVol();
    const after: any = await (e.opta.account as any).volOracle.fetch(e.volOracle);
    // The synth-warmed oracle is already FULL (sample_count saturates at the 720
    // ring size), so the proof a sample landed is the write cursor, not the count.
    assert.equal(Number(after.head), (Number(mid.head) + 1) % 720, "ring head advanced by one: a real sample was written");
    assert.equal(Number(after.sampleCount), Math.min(Number(before.sampleCount) + 1, 720), "count +1, saturating at the ring size");
    assert.equal(Number(mid.head), Number(before.head), "...and the reseed before it wrote nothing");
  });
  it("push_vol_sample on a source-2 oracle WITHOUT the feed account is OptaFeedMissing", async () => {
    const { e, feed } = await envWithFeed("ARMV2", "arm-v2");
    await flip(e, OPTA, feed);
    const r = await attempt(e.opta.methods.pushVolSample().accountsStrict({
      signer: e.admin.publicKey, priceUpdate: null, volOracle: e.volOracle, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    }).rpc());
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedMissing", "push without feed");
  });
  it("push_vol_sample refuses a STALE Opta feed (OptaFeedStale) — the read gate, not the breaker", async () => {
    const { e, feed } = await envWithFeed("ARMV3", "arm-v3");
    await flip(e, OPTA, feed);
    const t = (await getClockUnix(e.h.context)) + READ_MAX_AGE + 10;
    await setClockUnix(e.h.context, t);
    const r = await attempt(e.opta.methods.pushVolSample().accountsStrict({
      signer: e.admin.publicKey, priceUpdate: null, volOracle: e.volOracle, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: feed,
    }).rpc());
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedStale", "stale feed");
  });
  it("initialize_vol_oracle with source 2 seeds last_spot from the Opta feed; absent feed is OptaFeedMissing", async () => {
    const { e } = await envWithFeed("ARMV4", "arm-v4");
    const bytes = Array.from(Buffer.from(synthFeedIdHex("arm-v4-new"), "hex"));
    const { feed, authority } = await initFeed(e, bytes);
    await push(e, bytes, feed, authority, 250);
    const oracle = pda([Buffer.from("vol_oracle"), Buffer.from(bytes)]);
    const init = (f: PublicKey | null) => e.opta.methods.initializeVolOracle(bytes, OPTA, new BN(0)).accountsStrict({
      initializer: e.admin.publicKey, priceUpdate: null, volOracle: oracle, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: f,
    }).rpc();
    const r = await attempt(init(null));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedMissing", "init without feed");
    await init(feed);
    const o: any = await (e.opta.account as any).volOracle.fetch(oracle);
    assert.equal(Number(o.oracleSource), OPTA);
    assert.equal(o.lastSpotPrice.toString(), (250_000_000n * 1_000_000n).toString());
  });
});

describe("FP-ORACLE wave 1 — create_market arm", () => {
  it("create_market with source 2 proves the feed exists (pushed, unfrozen); absent / unpushed are refused", async () => {
    const { e } = await envWithFeed("ARMC1", "arm-c1");
    const bytes = Array.from(Buffer.from(synthFeedIdHex("arm-c1-new"), "hex"));
    const market = pda([Buffer.from("market"), Buffer.from("ARMC1X")]);
    // createMarket args: (asset_name, pyth_feed_id, asset_class, oracle_source)
    const create = (f: PublicKey | null) => e.opta.methods.createMarket("ARMC1X", bytes, 0, OPTA).accountsStrict({
      creator: e.admin.publicKey, protocolState: e.protocolState, market, priceUpdate: null, systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: f,
    }).rpc();
    let r = await attempt(create(null));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedMissing", "create without feed");
    const { feed, authority } = await initFeed(e, bytes);
    r = await attempt(create(feed));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedInvalidPrice", "create on unpushed feed (HIGH-5)");
    await push(e, bytes, feed, authority, 42);
    await create(feed);
    const m: any = await (e.opta.account as any).optionsMarket.fetch(market);
    assert.equal(Number(m.oracleSource), OPTA);
  });
});

describe("FP-ORACLE wave 1 — settle_expiry arm (persist-at-expiry)", () => {
  async function settleSetup(asset: string, label: string) {
    const { e, feed, authority } = await envWithFeed(asset, label);
    await flip(e, OPTA, feed);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 3600);
    const settle = (f: PublicKey | null) => e.opta.methods.settleExpiry(e.asset, expiry).accountsStrict({
      caller: e.admin.publicKey, market: e.market, priceUpdate: null,
      settlementRecord: settlementRecordPda(e, expiry), systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: f,
    }).preInstructions([CU(400_000)]).rpc();
    return { e, feed, authority, expiry, settle };
  }
  it("settles from the CURRENT feed price when published at/after expiry inside the window", async () => {
    const { e, feed, authority, expiry, settle } = await settleSetup("ARMS1", "arm-s1");
    const t = expiry.toNumber() + 20;
    await setClockUnix(e.h.context, t);
    await push(e, e.feedId, feed, authority, 103.0, t);
    await settle(feed);
    const rec: any = await (e.opta.account as any).settlementRecord.fetch(settlementRecordPda(e, expiry));
    assert.equal(rec.settlementPrice.toString(), px(103.0).toString());
  });
  it("refuses a feed whose price PRE-dates expiry even though it is fresh (OptaFeedStale)", async () => {
    const { e, feed, authority, expiry, settle } = await settleSetup("ARMS2", "arm-s2");
    const t0 = expiry.toNumber() - 30;
    await setClockUnix(e.h.context, t0);
    await push(e, e.feedId, feed, authority, 103.0, t0);    // published BEFORE expiry
    await setClockUnix(e.h.context, expiry.toNumber() + 5); // still within 180s freshness
    const r = await attempt(settle(feed));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedStale", "pre-expiry price");
  });
  it("refuses settlement after the window (SwitchboardSettleWindowElapsed) — falls to reclaim, like SB", async () => {
    const { e, feed, authority, expiry, settle } = await settleSetup("ARMS3", "arm-s3");
    const t = expiry.toNumber() + SETTLE_WINDOW + 5;
    await setClockUnix(e.h.context, t);
    await push(e, e.feedId, feed, authority, 103.0, t);
    const r = await attempt(settle(feed));
    assert.isFalse(r.ok); assertErr(r.err, "SwitchboardSettleWindowElapsed", "late settle");
  });
  it("refuses without the feed account (OptaFeedMissing)", async () => {
    const { e, feed, authority, expiry, settle } = await settleSetup("ARMS4", "arm-s4");
    const t = expiry.toNumber() + 20;
    await setClockUnix(e.h.context, t);
    await push(e, e.feedId, feed, authority, 103.0, t);
    const r = await attempt(settle(null));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedMissing", "settle without feed");
  });
});

describe("FP-ORACLE wave 1 — exercise_american arm", () => {
  it("early exercise on a source-2 market pays intrinsic from the Opta spot; refuses without the feed", async () => {
    const { e, feed, authority } = await envWithFeed("ARME1", "arm-e1", 100);
    await flip(e, OPTA, feed);                                    // flip FIRST: market must be empty
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, CALL, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, true);
    const { buyerOptionAta, buyerUsdc } = await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);
    const t = (await getClockUnix(e.h.context)) + 60;
    await setClockUnix(e.h.context, t);
    await push(e, e.feedId, feed, authority, 104, t);             // ITM: spot 104 vs strike 100 (+400bps, inside the breaker band)
    const exercise = (f: PublicKey | null) => e.opta.methods.exerciseAmerican(new BN(2)).accountsStrict({
      holder: buyer.publicKey, sharedVault: vault, market: e.market, priceUpdate: null, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, holderOptionAccount: buyerOptionAta, vaultUsdcAccount: deriveVaultUsdc(vault),
      holderUsdcAccount: buyerUsdc, token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      sbQueue: null, sbSlothashes: null, sbInstructions: null,
      writerAskPot: null, writerAskPotUsdc: null, protocolState: null,
      optaPriceFeed: f,
    }).preInstructions([CU(400_000)]).signers([buyer]).rpc();
    let r = await attempt(exercise(null));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedMissing", "exercise without feed");
    const before = await bal(e, buyerUsdc);
    await exercise(feed);
    const after = await bal(e, buyerUsdc);
    assert.equal((after - before).toString(), (2n * 4_000_000n).toString(), "2 contracts x (104-100) USDC intrinsic");
  });
});

describe("FP-ORACLE wave 1 — execute_trigger arm", () => {
  it("a stop-entry BUY fires off the Opta spot; refuses without the feed", async () => {
    const { e, feed, authority } = await envWithFeed("ARMT1", "arm-t1", 100);
    await flip(e, OPTA, feed);
    const writer = actor(e); await usdcAta(e, writer.publicKey);
    const now = await getClockUnix(e.h.context);
    const strike = usdc(100), expiry = new BN(now + 7 * 86_400 + 11_000);
    const { vault, vaultUsdc } = await createVault(e, "american", strike, expiry, CALL, writer);
    await deposit(e, vault, vaultUsdc, writer, 5000);
    const s: any = await createSeries(e, strike, expiry, CALL);
    const owner = actor(e);
    const nonce = new BN(7);
    const order = pda([Buffer.from("trigger_order"), owner.publicKey.toBuffer(), s.optionMint.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([Buffer.from("trigger_escrow"), order.toBuffer()]);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(s.optionMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await e.opta.methods.placeTrigger({ stopEntryBuy: {} }, { greaterOrEqual: {} }, usdc(102), new BN(3), usdc(50), nonce, { underlying: {} }).accountsStrict({
      owner: owner.publicKey, market: e.market, sharedVault: vault, vaultMintRecord: s.vaultMintRecord,
      optionMint: s.optionMint, triggerOrder: order, triggerEscrow: escrow, protocolState: e.protocolState,
      usdcMint: e.usdcMint, ownerUsdcAccount: ownerUsdc, ownerOptionAta: ownerOpt,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([owner]).rpc();
    const t = (await getClockUnix(e.h.context)) + 60;
    await setClockUnix(e.h.context, t);
    await push(e, e.feedId, feed, authority, 104, t);             // condition GE 102 met at 104 (inside the band)
    const exec = (f: PublicKey | null) => e.opta.methods.executeTrigger().accountsStrict({
      caller: e.admin.publicKey, triggerOrder: order, market: e.market, sharedVault: vault,
      vaultMintRecord: s.vaultMintRecord, optionMint: s.optionMint, priceUpdate: null, volOracle: e.volOracle,
      protocolState: e.protocolState, treasury: e.treasury, triggerEscrow: escrow,
      holderOptionAta: ownerOpt, ownerUsdcAccount: ownerUsdc, ownerWallet: owner.publicKey,
      vaultUsdcAccount: vaultUsdc, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      sbQueue: null, sbSlothashes: null, sbInstructions: null,
      bookOrder: null, bookMaker: null, bookEscrow: null, bookMakerUsdc: null,
      writerAskPot: null, writerAskPotUsdc: null, writerAskPosition: null,
      bookHookMetas: null, bookHookProgram: null, bookHookState: null, bookMakerOption: null,
      ocoPeer: null,
      optaPriceFeed: f,
    }).preInstructions([CU(400_000)]).rpc();
    let r = await attempt(exec(null));
    assert.isFalse(r.ok); assertErr(r.err, "OptaFeedMissing", "trigger without feed");
    await exec(feed);
    const info = await e.h.context.banksClient.getAccount(order);
    assert.isNull(info, "trigger order closed after firing on the Opta spot");
  });
});
