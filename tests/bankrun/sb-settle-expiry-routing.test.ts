// =============================================================================
// tests/bankrun/sb-settle-expiry-routing.test.ts  (Stage 3 1b)
//
// Routes settle_expiry by market.oracle_source — the last of the 4 read sites,
// the architecturally distinct one (Switchboard has no historical lookback).
//
//   (BI) BYTE-IDENTICAL: a legacy 5-account Pyth settle_expiry tx (price_update
//        present, NO SB accounts) records settlement identically — same
//        settlement_price, same pyth_publish_time, same record creation.
//   (SB) SB arm on an oracle_source=Switchboard market: pre-expiry → MarketNotExpired;
//        past the 5-min window → SwitchboardSettleWindowElapsed (6069); within
//        window: missing SB accts → 6065; no ed25519 → 6067; valid non-SB ed25519
//        → reverts inside the QuoteVerifier. Happy-path verify deferred to devnet.
// =============================================================================

import { assert } from "chai";
import {
  SystemProgram, Keypair, Transaction, TransactionInstruction, Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY,
} from "@solana/web3.js";
import {
  setupEnv, getClockUnix, setClockUnix, settlementRecordPda, pythBody, injectPythFixture, CU, BN,
} from "./helpers";

const SB_SETTLE_WINDOW_SECS = 300;

// Flip the market to oracle_source = Switchboard in place. Offset is asset_name-
// length-dependent: disc(8) + [4-byte len + name] + feed(32) + class(1) + bump(1).
async function flipMarketToSwitchboard(e: any) {
  const acc = await e.h.context.banksClient.getAccount(e.market);
  const data = Buffer.from(acc.data);
  const nameLen = data.readUInt32LE(8);
  const off = 8 + 4 + nameLen + 32 + 1 + 1;
  data[off] = 1;
  e.h.context.setAccount(e.market, {
    lamports: acc.lamports, data, owner: acc.owner, executable: acc.executable, rentEpoch: Number(acc.rentEpoch),
  });
}

function settleArgs(e: any, expiry: any, priceUpdate: any, sb: any) {
  return {
    caller: e.admin.publicKey, market: e.market, priceUpdate,
    settlementRecord: settlementRecordPda(e, expiry), systemProgram: SystemProgram.programId,
    sbQueue: sb?.queue ?? null, sbSlothashes: sb?.slothashes ?? null, sbInstructions: sb?.instructions ?? null, optaPriceFeed: null,
  };
}

describe("bankrun: Stage 3 1b — settle_expiry oracle_source routing", function () {
  this.timeout(180_000);

  it("(BI) BYTE-IDENTICAL: legacy 5-account Pyth settle records identically", async () => {
    const e = await setupEnv("SBSET0", "sbset0", 100);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const exp = expiry.toNumber();
    await setClockUnix(e.h.context, exp + 5);

    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, 180, exp + 5)); // publish in [expiry, expiry+60]
    const full = await e.opta.methods.settleExpiry(e.asset, expiry)
      .accountsStrict(settleArgs(e, expiry, fix, null)).instruction();
    console.log(`    [byte-identical] new-IDL ix.keys = ${full.keys.length}; submitting legacy 5`);
    const legacy = new TransactionInstruction({ programId: full.programId, keys: full.keys.slice(0, 5), data: full.data });
    assert.equal(legacy.keys.length, 5, "legacy wire is exactly 5 accounts");

    const bh = (await e.h.context.banksClient.getLatestBlockhash())[0];
    const tx = new Transaction({ feePayer: e.admin.publicKey, recentBlockhash: bh }).add(CU(400_000), legacy);
    await (e.opta.provider as any).sendAndConfirm(tx, []);

    const rec: any = await e.opta.account.settlementRecord.fetch(settlementRecordPda(e, expiry));
    assert.equal(rec.settlementPrice.toString(), "180000000", "settlement_price = $180 (6-dec)");
    assert.equal(rec.pythPublishTime.toString(), (exp + 5).toString(), "pyth_publish_time = the Pyth publish_time (unchanged)");
    assert.equal(rec.expiry.toString(), exp.toString(), "record expiry");
    console.log(`    (BI) legacy 5-account Pyth settle OK: price=${rec.settlementPrice} publish_time=${rec.pythPublishTime}`);
  });

  it("(SB-pre) SB market settled before expiry → MarketNotExpired", async () => {
    const e = await setupEnv("SBSET1", "sbset1", 100);
    await flipMarketToSwitchboard(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400); // clock < expiry
    let err = "";
    try {
      await e.opta.methods.settleExpiry(e.asset, expiry)
        .accountsStrict(settleArgs(e, expiry, null, null)).preInstructions([CU(400_000)]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (SB-pre) ${err.slice(0, 110)}`);
    assert.match(err, /MarketNotExpired/, "pre-expiry settle rejected for both sources");
  });

  it("(SB-window) SB market settled past the 5-min window → SwitchboardSettleWindowElapsed (6069)", async () => {
    const e = await setupEnv("SBSET2", "sbset2", 100);
    await flipMarketToSwitchboard(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const exp = expiry.toNumber();
    await setClockUnix(e.h.context, exp + SB_SETTLE_WINDOW_SECS + 30); // past the window
    let err = "";
    try {
      await e.opta.methods.settleExpiry(e.asset, expiry)
        .accountsStrict(settleArgs(e, expiry, null, null)).preInstructions([CU(400_000)]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (SB-window) ${err.slice(0, 120)}`);
    assert.match(err, /SwitchboardSettleWindowElapsed|6069/, "past-window settle must revert");
  });

  it("(SB-miss) SB market within window + missing SB accounts → SwitchboardAccountsMissing (6065)", async () => {
    const e = await setupEnv("SBSET3", "sbset3", 100);
    await flipMarketToSwitchboard(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    await setClockUnix(e.h.context, expiry.toNumber() + 10); // within window
    let err = "";
    try {
      await e.opta.methods.settleExpiry(e.asset, expiry)
        .accountsStrict(settleArgs(e, expiry, null, null)).preInstructions([CU(400_000)]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (SB-miss) ${err.slice(0, 120)}`);
    assert.match(err, /SwitchboardAccountsMissing|6065/, "SB market must require the SB accounts");
  });

  it("(SB-noed) SB market + SB accounts but no ed25519 ix → NoEd25519Instruction (6067)", async () => {
    const e = await setupEnv("SBSET4", "sbset4", 100);
    await flipMarketToSwitchboard(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    await setClockUnix(e.h.context, expiry.toNumber() + 10);
    const sb = { queue: Keypair.generate().publicKey, slothashes: SYSVAR_SLOT_HASHES_PUBKEY, instructions: SYSVAR_INSTRUCTIONS_PUBKEY };
    let err = "";
    try {
      await e.opta.methods.settleExpiry(e.asset, expiry)
        .accountsStrict(settleArgs(e, expiry, null, sb)).preInstructions([CU(400_000)]).rpc(); // no ed25519
    } catch (ex: any) { err = String(ex); }
    console.log(`    (SB-noed) ${err.slice(0, 120)}`);
    assert.match(err, /NoEd25519Instruction|6067/, "ed25519-index derivation must error with no ed25519 ix");
  });

  it("(SB-verify) SB market + valid ed25519 ix → reaches QuoteVerifier (reverts past all guards)", async () => {
    const e = await setupEnv("SBSET5", "sbset5", 100);
    await flipMarketToSwitchboard(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    await setClockUnix(e.h.context, expiry.toNumber() + 10);
    const sb = { queue: Keypair.generate().publicKey, slothashes: SYSVAR_SLOT_HASHES_PUBKEY, instructions: SYSVAR_INSTRUCTIONS_PUBKEY };
    const edKp = Keypair.generate();
    const edIx = Ed25519Program.createInstructionWithPrivateKey({ privateKey: edKp.secretKey, message: Buffer.from("opta-1b-probe") });
    let err = "";
    try {
      await e.opta.methods.settleExpiry(e.asset, expiry)
        .accountsStrict(settleArgs(e, expiry, null, sb)).preInstructions([CU(400_000), edIx]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (SB-verify) ${err.slice(0, 160)}`);
    assert.notEqual(err, "", "must revert — a non-SB quote cannot verify");
    assert.notMatch(err, /MarketNotExpired|SwitchboardSettleWindowElapsed|PriceUpdateMissing|SwitchboardAccountsMissing|InvalidSwitchboardSysvar|NoEd25519Instruction/,
      "must reach the QuoteVerifier (past every earlier guard)");
  });
});
