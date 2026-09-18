// =============================================================================
// tests/bankrun/sb-create-market-source.test.ts  (Stage 3 1c-i-B)
//
// Guard proofs for create_market generalized with oracle_source + branched
// HIGH-5. litesvm cannot fabricate a valid signed_slothash, so the SB-create
// happy-path (a real quote → market born oracle_source=1) is the devnet smoke,
// deferred to the coordinated 1c-ii deploy. Here we prove only the routing /
// validation surface + the source-aware idempotent check.
//
//   (PY)   oracle_source=0 (Pyth) + present price_update → market born source=0
//          (byte-identical Pyth create — records asset/feed/class/source/bump).
//   (X)    oracle_source=7 → InvalidOracleSource (6066).   [2 became valid at the plug]
//   (X2)   oracle_source=2 + NO opta_price_feed → OptaFeedMissing (6102).
//   (M)    oracle_source=0 + NO price_update → PriceUpdateMissing (6064).
//   (SBm)  oracle_source=1 + missing SB accounts → SwitchboardAccountsMissing (6065).
//   (SBe)  oracle_source=1 + SB accounts + no ed25519 → NoEd25519Instruction (6067).
//   (SBv)  oracle_source=1 + valid non-SB ed25519 → reaches QuoteVerifier, reverts past guards.
//   (IDok) same-source Pyth re-call → idempotent Ok.
//   (IDx)  stored source flipped to SB, Pyth re-call (arg source=0) → AssetMismatch
//          (the Pyth proof passes, so the source-aware idempotent check is reached).
// =============================================================================

import { assert } from "chai";
import {
  SystemProgram, Keypair, Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY,
} from "@solana/web3.js";
import { setupEnv, getClockUnix, pda, injectPythFixture, pythBody, CU } from "./helpers";
import { synthFeedIdHex } from "../_pyth_fixtures";

function freshFeed(label: string): { hex: string; bytes: number[] } {
  const hex = synthFeedIdHex(label);
  return { hex, bytes: Array.from(Buffer.from(hex, "hex")) };
}
const marketPda = (name: string) => pda([Buffer.from("market"), Buffer.from(name)]);

// Offset of oracle_source in OptionsMarket account data (asset_name-length-dependent):
// disc(8) + [4-byte len + name] + feed(32) + class(1) + bump(1).
function flipMarketSource(e: any, market: any, val: number) {
  const acc = e.h.context.banksClient.getAccount(market);
  return acc.then((a: any) => {
    const data = Buffer.from(a.data);
    const nameLen = data.readUInt32LE(8);
    data[8 + 4 + nameLen + 32 + 1 + 1] = val;
    e.h.context.setAccount(market, {
      lamports: a.lamports, data, owner: a.owner, executable: a.executable, rentEpoch: Number(a.rentEpoch),
    });
  });
}

function createArgs(e: any, name: string, priceUpdate: any, sb: any) {
  return {
    creator: e.admin.publicKey, protocolState: e.protocolState, priceUpdate,
    market: marketPda(name), systemProgram: SystemProgram.programId,
    sbQueue: sb?.queue ?? null, sbSlothashes: sb?.slothashes ?? null, sbInstructions: sb?.instructions ?? null, optaPriceFeed: null,
  };
}

describe("bankrun: Stage 3 1c-i-B — create_market oracle_source + branched HIGH-5", function () {
  this.timeout(180_000);

  it("(PY) oracle_source=0 + present price_update → market born source=0", async () => {
    const e = await setupEnv("SBCM0", "sbcm0", 100);
    const feed = freshFeed("sbcm0-py");
    const now = await getClockUnix(e.h.context);
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(feed.hex, 100, now));
    await e.opta.methods.createMarket("PYBI1", feed.bytes, 0, 0)
      .accountsStrict(createArgs(e, "PYBI1", fix, null)).rpc();
    const m: any = await e.opta.account.optionsMarket.fetch(marketPda("PYBI1"));
    assert.equal(m.oracleSource, 0, "born Pyth (oracle_source=0)");
    assert.deepEqual(Array.from(m.pythFeedId), feed.bytes, "feed stored");
    assert.equal(m.assetClass, 0, "class stored");
    console.log(`    (PY) Pyth create OK: oracle_source=${m.oracleSource}`);
  });

  it("(X) oracle_source=7 (out of range) → InvalidOracleSource (6066)", async () => {
    // Plug wave 1 (2026-09-18): source 2 is VALID now (Opta). The garbage-byte
    // negative moves to 7; source 2 gets its own negative below.
    const e = await setupEnv("SBCM1", "sbcm1", 100);
    const feed = freshFeed("sbcm1-bad");
    let err = "";
    try {
      await e.opta.methods.createMarket("BADSRC", feed.bytes, 0, 7)
        .accountsStrict(createArgs(e, "BADSRC", null, null)).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (X) ${err.slice(0, 110)}`);
    assert.match(err, /InvalidOracleSource|6066/, "out-of-range source must revert");
  });

  it("(X2) oracle_source=2 (Opta) + NO opta_price_feed → OptaFeedMissing (6102)", async () => {
    const e = await setupEnv("SBCM1B", "sbcm1b", 100);
    const feed = freshFeed("sbcm1b-nofeed");
    let err = "";
    try {
      await e.opta.methods.createMarket("NOFEED", feed.bytes, 0, 2)
        .accountsStrict(createArgs(e, "NOFEED", null, null)).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (X2) ${err.slice(0, 110)}`);
    assert.match(err, /OptaFeedMissing|6102/, "an Opta create without the feed account must revert on the arm, not on validation");
  });

  it("(M) oracle_source=0 (Pyth) but NO price_update → PriceUpdateMissing (6064)", async () => {
    const e = await setupEnv("SBCM2", "sbcm2", 100);
    const feed = freshFeed("sbcm2-miss");
    let err = "";
    try {
      await e.opta.methods.createMarket("NOPU", feed.bytes, 0, 0)
        .accountsStrict(createArgs(e, "NOPU", null, null)).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (M) ${err.slice(0, 110)}`);
    assert.match(err, /PriceUpdateMissing|6064/, "Pyth create must require price_update");
  });

  it("(SBm) oracle_source=1 + missing SB accounts → SwitchboardAccountsMissing (6065)", async () => {
    const e = await setupEnv("SBCM3", "sbcm3", 100);
    const feed = freshFeed("sbcm3-sb");
    let err = "";
    try {
      await e.opta.methods.createMarket("SBNOACC", feed.bytes, 0, 1)
        .accountsStrict(createArgs(e, "SBNOACC", null, null)).preInstructions([CU(400_000)]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (SBm) ${err.slice(0, 120)}`);
    assert.match(err, /SwitchboardAccountsMissing|6065/, "SB create must require the SB accounts");
  });

  it("(SBe) oracle_source=1 + SB accounts but no ed25519 ix → NoEd25519Instruction (6067)", async () => {
    const e = await setupEnv("SBCM4", "sbcm4", 100);
    const feed = freshFeed("sbcm4-sb");
    const sb = { queue: Keypair.generate().publicKey, slothashes: SYSVAR_SLOT_HASHES_PUBKEY, instructions: SYSVAR_INSTRUCTIONS_PUBKEY };
    let err = "";
    try {
      await e.opta.methods.createMarket("SBNOED", feed.bytes, 0, 1)
        .accountsStrict(createArgs(e, "SBNOED", null, sb)).preInstructions([CU(400_000)]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (SBe) ${err.slice(0, 120)}`);
    assert.match(err, /NoEd25519Instruction|6067/, "ed25519-index derivation must error with no ed25519 ix");
  });

  it("(SBv) oracle_source=1 + valid ed25519 ix → reaches QuoteVerifier (reverts past all guards)", async () => {
    const e = await setupEnv("SBCM5", "sbcm5", 100);
    const feed = freshFeed("sbcm5-sb");
    const sb = { queue: Keypair.generate().publicKey, slothashes: SYSVAR_SLOT_HASHES_PUBKEY, instructions: SYSVAR_INSTRUCTIONS_PUBKEY };
    const edKp = Keypair.generate();
    const edIx = Ed25519Program.createInstructionWithPrivateKey({ privateKey: edKp.secretKey, message: Buffer.from("opta-1cib-probe") });
    let err = "";
    try {
      await e.opta.methods.createMarket("SBVER", feed.bytes, 0, 1)
        .accountsStrict(createArgs(e, "SBVER", null, sb)).preInstructions([CU(400_000), edIx]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (SBv) ${err.slice(0, 160)}`);
    assert.notEqual(err, "", "must revert — a non-SB quote cannot verify");
    assert.notMatch(err, /PriceUpdateMissing|SwitchboardAccountsMissing|InvalidSwitchboardSysvar|NoEd25519Instruction|InvalidOracleSource/,
      "must reach the QuoteVerifier (past every earlier guard)");
  });

  it("(IDok) same-source Pyth re-call → idempotent Ok", async () => {
    const e = await setupEnv("SBCM6", "sbcm6", 100);
    const feed = freshFeed("sbcm6-py");
    const now = await getClockUnix(e.h.context);
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(feed.hex, 100, now));
    const args = () => createArgs(e, "IDEM1", fix, null);
    await e.opta.methods.createMarket("IDEM1", feed.bytes, 0, 0).accountsStrict(args()).rpc();
    // Re-call: same (name, feed, class, source) → silent idempotent Ok. A distinct
    // CU preInstruction varies the tx so bankrun executes it (not dedup-as-
    // already-processed — the re-call is otherwise byte-identical to the first).
    await e.opta.methods.createMarket("IDEM1", feed.bytes, 0, 0).accountsStrict(args())
      .preInstructions([CU(390_000)]).rpc();
    const m: any = await e.opta.account.optionsMarket.fetch(marketPda("IDEM1"));
    assert.equal(m.oracleSource, 0, "still Pyth after idempotent re-call");
    console.log(`    (IDok) idempotent same-source re-call OK`);
  });

  it("(IDx) stored source flipped to SB, Pyth re-call (arg source=0) → AssetMismatch", async () => {
    const e = await setupEnv("SBCM7", "sbcm7", 100);
    const feed = freshFeed("sbcm7-py");
    const now = await getClockUnix(e.h.context);
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(feed.hex, 100, now));
    await e.opta.methods.createMarket("IDEM2", feed.bytes, 0, 0)
      .accountsStrict(createArgs(e, "IDEM2", fix, null)).rpc();
    // Flip the stored oracle_source to 1 (Switchboard) so the source-aware
    // idempotent check sees a mismatch on a Pyth re-call (arg source=0). The
    // Pyth proof passes (present fixture), so the idempotent check IS reached.
    await flipMarketSource(e, marketPda("IDEM2"), 1);
    let err = "";
    try {
      // Distinct CU preInstruction varies the tx so bankrun executes the re-call
      // (not dedup-as-already-processed) — same workaround the (IDok) sibling
      // uses above; without it this byte-identical re-call is order-sensitive.
      await e.opta.methods.createMarket("IDEM2", feed.bytes, 0, 0)
        .accountsStrict(createArgs(e, "IDEM2", fix, null))
        .preInstructions([CU(390_000)]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (IDx) ${err.slice(0, 120)}`);
    assert.match(err, /AssetMismatch/, "source mismatch on re-call must reject AssetMismatch");
  });
});
