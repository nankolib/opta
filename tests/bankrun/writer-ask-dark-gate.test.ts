// =============================================================================
// tests/bankrun/writer-ask-dark-gate.test.ts — Phase 3 Slice A (iii) dark gate
// =============================================================================
// Proves the WRITER_ASKS_ENABLED dark gate end-to-end: a FEATURE-FREE build
// rejects a WriterAsk post with error 6054 (WriterAsksDisabled), the first line
// of the post_order WriterAsk arm — reached BEFORE the American/oracle checks,
// so no warmed oracle is needed (this file uses a COLD-oracle bootstrap and
// therefore runs against a feature-free .so, unlike setupEnv which warms via
// the test-only synth-vol instruction).
//
// Self-detecting so it is green in BOTH gate builds:
//   - feature-free .so (WRITER_ASKS_ENABLED = false): asserts the post fails
//     with WriterAsksDisabled (6054).  ← the real (iii) assertion
//   - `testing` .so (WRITER_ASKS_ENABLED = true, the npm test:bankrun build):
//     the gate is OPEN, so on this European vault the post is instead rejected
//     by the American-only gate (NotAmericanOption). The 6054 path is
//     unreachable in this artifact → the test self-skips with a logged reason.
//
// Run feature-free:  anchor build -- ;  ts-mocha ... writer-ask-dark-gate.test.ts
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupBankrun, prebakeMint, injectPythFixture,
} from "./bootstrap";
import {
  createVault, deposit, mint, usdcAta, pda, actor, getClockUnix,
  HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";
import { serializePriceUpdateV2, synthFeedIdHex } from "../_pyth_fixtures";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK = { writerAsk: {} };

function pythBody(feedHex: string, priceUsd: number, publishTime: number): Buffer {
  const price = BigInt(priceUsd) * 100_000_000n;
  return serializePriceUpdateV2({
    feedIdHex: feedHex, price, conf: 1_000_000n, exponent: -8,
    publishTime: BigInt(Math.floor(publishTime)), prevPublishTime: BigInt(Math.floor(publishTime) - 1),
    emaPrice: price, emaConf: 1_000_000n,
  });
}

/** Feature-free env: protocol + market + COLD (initialized, not warmed) vol
 *  oracle. No synth-vol → compiles + runs against a feature-free .so. European
 *  mint does not gate on oracle warmup, so a cold oracle suffices. */
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
    creator: admin.publicKey, protocolState, market, priceUpdate: fix,
    systemProgram: SystemProgram.programId,
  }).rpc();
  await opta.methods.initializeVolOracle(feedId, 0, new BN(0)).accountsStrict({
    initializer: admin.publicKey, priceUpdate: fix, volOracle,
    systemProgram: SystemProgram.programId,
    sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
  }).rpc();
  // NO synthWarmVolOracle — keeps this feature-free-build compatible.

  return { h, opta, admin, usdcMint, protocolState, treasury, market, volOracle, feedHex, feedId, asset };
}

describe("writer-ask dark gate (Phase 3 Slice A (iii) — feature-free → 6054)", function () {
  this.timeout(120_000);

  let e: Env;
  let writer: Keypair;
  let vault: PublicKey;
  let optionMint: PublicKey;
  let vaultMintRecord: PublicKey, extraMetas: PublicKey, hookState: PublicKey;

  before(async () => {
    e = await setupEnvCold("WADARK", "wa-dark-feed", 100);
    writer = actor(e);
    await usdcAta(e, writer.publicKey, 100_000_000_000n);

    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 3600);
    const strike = usdc(10);

    // EUROPEAN vault + cold oracle (no warm needed for European mint).
    const cv = await createVault(e, "european", strike, expiry, { call: {} }, writer);
    vault = cv.vault;
    const writerPos = await deposit(e, vault, cv.vaultUsdc, writer, 50_000);
    const m: any = await mint(e, vault, writerPos, writer, 20, now, false);
    optionMint = m.optionMint;
    vaultMintRecord = m.vaultMintRecord;
    extraMetas = m.extraMetas;
    hookState = m.hookState;
  });

  it("(iii) — feature-free build rejects WriterAsk with 6054 (skips when gate open)", async function () {
    const nonce = new BN(900);
    const order = pda([RESTING_ORDER_SEED, optionMint.toBuffer(), writer.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]);
    const ownerUsdc = await usdcAta(e, writer.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(optionMint, writer.publicKey, false, TOKEN_2022_PROGRAM_ID);

    const ix = await e.opta.methods.postOrder(WRITER_ASK, usdc(7), new BN(1), nonce).accountsStrict({
      owner: writer.publicKey, sharedVault: vault, market: e.market, vaultMintRecord,
      optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: extraMetas, hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = writer.publicKey;
    tx.recentBlockhash = e.h.context.lastBlockhash;
    tx.sign(writer);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    const logs = (res.meta?.logMessages ?? []).join("\n");

    assert.isNotNull(res.result, "WriterAsk post must fail (either dark gate 6054 or American gate)");

    if (logs.includes("WriterAsksDisabled")) {
      // Feature-free build: the dark gate (first line of the arm) fired. (iii) ✓
      assert.isTrue(true, "feature-free build rejected WriterAsk with WriterAsksDisabled (6054)");
    } else {
      // `testing` build: gate open → European vault hits the American-only gate.
      // The 6054 path is unreachable in this artifact; (iii) is proven by the
      // feature_flags.rs unit test + a feature-free run of THIS file.
      assert.isTrue(logs.includes("NotAmericanOption"),
        "testing build: gate open, rejected by American-only gate (NotAmericanOption)");
      this.skip();
    }
  });
});
