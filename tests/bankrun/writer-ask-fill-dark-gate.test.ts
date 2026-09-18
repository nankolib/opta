// =============================================================================
// tests/bankrun/writer-ask-fill-dark-gate.test.ts — Slice B (iii) dark gate
// =============================================================================
// Proves fill_writer_ask's WRITER_ASKS_ENABLED gate end-to-end: a FEATURE-FREE
// build rejects with 6054 (the first line of the handler, before the kind
// check). Uses a COLD-oracle bootstrap (no synth-vol) so it runs against a
// feature-free .so. The gate fires before the American/kind checks, so a plain
// Bid order on a European vault is a sufficient probe.
//
// Self-detecting (green in both builds):
//   - feature-free (gate closed): fill_writer_ask → WriterAsksDisabled (6054). ✓
//   - `testing` (gate open): proceeds past the gate, then rejects the Bid order
//     with NotAWriterAsk → the 6054 path is unreachable here → self-skips.
//
// Run feature-free:  anchor build -- ;  ts-mocha ... writer-ask-fill-dark-gate.test.ts
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import { setupBankrun, prebakeMint, injectPythFixture } from "./bootstrap";
import {
  createVault, deposit, mint, usdcAta, pda, actor, getClockUnix,
  HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";
import { serializePriceUpdateV2, synthFeedIdHex } from "../_pyth_fixtures";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK_POT_SEED = Buffer.from("writer_ask_pot");
const WRITER_ASK_POT_USDC_SEED = Buffer.from("writer_ask_pot_usdc");
const WRITER_ASK_POSITION_SEED = Buffer.from("writer_ask_position");
const BID = { bid: {} };

function pythBody(feedHex: string, priceUsd: number, publishTime: number): Buffer {
  const price = BigInt(priceUsd) * 100_000_000n;
  return serializePriceUpdateV2({
    feedIdHex: feedHex, price, conf: 1_000_000n, exponent: -8,
    publishTime: BigInt(Math.floor(publishTime)), prevPublishTime: BigInt(Math.floor(publishTime) - 1),
    emaPrice: price, emaConf: 1_000_000n,
  });
}

async function setupEnvCold(asset: string, feedLabel: string, spotUsd = 100): Promise<Env> {
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
  const fix = Keypair.generate().publicKey;
  injectPythFixture(h.context, fix, pythBody(feedHex, spotUsd, now));
  await opta.methods.createMarket(asset, feedId, 0, 0).accountsStrict({
    sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
    creator: admin.publicKey, protocolState, market, priceUpdate: fix, systemProgram: SystemProgram.programId,
  }).rpc();
  await opta.methods.initializeVolOracle(feedId, 0, new BN(0)).accountsStrict({
    initializer: admin.publicKey, priceUpdate: fix, volOracle, systemProgram: SystemProgram.programId,
    sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
  }).rpc();
  return { h, opta, admin, usdcMint, protocolState, treasury, market, volOracle, feedHex, feedId, asset };
}

describe("writer-ask fill dark gate (Slice B (iii) — feature-free → 6054)", function () {
  this.timeout(120_000);

  let e: Env;
  let writer: Keypair, vault: PublicKey, m: any;

  before(async () => {
    e = await setupEnvCold("WAFDARK", "wa-fill-dark-feed", 100);
    writer = actor(e);
    await usdcAta(e, writer.publicKey, 100_000_000_000n);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 3600);
    const cv = await createVault(e, "european", usdc(10), expiry, { call: {} }, writer);
    vault = cv.vault;
    const writerPos = await deposit(e, vault, cv.vaultUsdc, writer, 50_000);
    m = await mint(e, vault, writerPos, writer, 20, now, false); // European series, cold
  });

  it("(iii) — feature-free build rejects fill_writer_ask with 6054 (skips when gate open)", async function () {
    // Post a plain Bid order (allowed feature-free) to give the fill a real order.
    const nonce = new BN(950);
    const order = pda([RESTING_ORDER_SEED, m.optionMint.toBuffer(), writer.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]);
    const writerUsdc = await usdcAta(e, writer.publicKey);
    const writerOpt = getAssociatedTokenAddressSync(m.optionMint, writer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const postIx = await e.opta.methods.postOrder(BID, usdc(3), new BN(1), nonce).accountsStrict({
      owner: writer.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: writerOpt, ownerUsdcAccount: writerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();
    const ptx = new Transaction().add(postIx);
    ptx.feePayer = writer.publicKey; ptx.recentBlockhash = e.h.context.lastBlockhash; ptx.sign(writer);
    const pres = await e.h.context.banksClient.tryProcessTransaction(ptx);
    if (pres.result) throw new Error("bid post failed: " + JSON.stringify(pres.result));

    // Attempt fill_writer_ask on the Bid order.
    const taker = actor(e);
    const pot = pda([WRITER_ASK_POT_SEED, m.optionMint.toBuffer()]);
    const potUsdc = pda([WRITER_ASK_POT_USDC_SEED, m.optionMint.toBuffer()]);
    const position = pda([WRITER_ASK_POSITION_SEED, m.optionMint.toBuffer(), writer.publicKey.toBuffer()]);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);
    const takerOpt = getAssociatedTokenAddressSync(m.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const fillIx = await e.opta.methods.fillWriterAsk(new BN(1)).accountsStrict({
      taker: taker.publicKey, optionMint: m.optionMint, order, maker: writer.publicKey, sharedVault: vault,
      vaultMintRecord: m.vaultMintRecord, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).preInstructions([CU(400_000)]).instruction();
    const ftx = new Transaction().add(fillIx);
    ftx.feePayer = taker.publicKey; ftx.recentBlockhash = e.h.context.lastBlockhash; ftx.sign(taker);
    const fres = await e.h.context.banksClient.tryProcessTransaction(ftx);
    const logs = (fres.meta?.logMessages ?? []).join("\n");

    assert.isNotNull(fres.result, "fill_writer_ask must fail (gate 6054 or kind-guard)");
    if (logs.includes("WriterAsksDisabled")) {
      assert.isTrue(true, "feature-free build rejected fill_writer_ask with 6054");
    } else {
      assert.isTrue(logs.includes("NotAWriterAsk"), "testing build: gate open → Bid order rejected with NotAWriterAsk");
      this.skip();
    }
  });
});
