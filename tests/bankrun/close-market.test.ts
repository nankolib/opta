// =============================================================================
// tests/bankrun/close-market.test.ts
// Proves the admin-only close_market instruction (SB crypto migration cutover).
//
//   1. happy path   — admin closes the market; account gone + rent → admin.
//   2. non-admin    — a non-admin signer is rejected (Unauthorized); market survives.
//   3. double-close — a second close of the same market reverts (account gone).
//   4. preflight rationale (Run-9) — close_market has NO on-chain child-check, so
//      it closes EVEN WITH a live child vault. This is the exact gap that
//      scripts/preflight_close_market.ts fills off-chain (it refuses to build the
//      tx if any live vault references the market). Test documents the on-chain
//      behavior the preflight compensates for.
//   5. name-reuse after close (Run-9) — the cutover's whole point: after close,
//      create_market re-registers the SAME asset_name (atomic name handover).
//
// close_market has NO on-chain child-check by design (see close_market.rs);
// safety is enforced off-chain by scripts/preflight_close_market.ts.
// =============================================================================

import { SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import {
  setupEnv, exists, actor, createVault, deposit, usdc, BN, getClockUnix,
  injectPythFixture, pythBody, Keypair,
} from "./helpers";

describe("bankrun: close_market (admin-only; cutover name-handover)", function () {
  this.timeout(180_000);

  it("happy path: admin closes the market and reclaims rent", async () => {
    const e = await setupEnv("CLOSEME", "closeme-feed");
    assert.isTrue(await exists(e, e.market), "market exists after setup");

    const marketAcct = await e.h.context.banksClient.getAccount(e.market);
    const rent = marketAcct!.lamports;
    const before = (await e.h.context.banksClient.getAccount(e.admin.publicKey))!.lamports;

    await e.opta.methods.closeMarket("CLOSEME").accountsStrict({
      admin: e.admin.publicKey,
      protocolState: e.protocolState,
      market: e.market,
    }).rpc();

    assert.isFalse(await exists(e, e.market), "market account is closed");
    const after = (await e.h.context.banksClient.getAccount(e.admin.publicKey))!.lamports;
    // admin nets the market rent minus the tx fee; rent (~0.001 SOL) >> fee (5000 lamports).
    assert.isAbove(after, before, "admin balance increased (rent reclaimed)");
    assert.isAbove(after - before, rent - 100_000, "admin received approximately the market rent");
  });

  it("rejects a non-admin caller and leaves the market intact", async () => {
    const e = await setupEnv("CLOSEME2", "closeme2-feed");
    const attacker = actor(e);

    let threw = false;
    try {
      await e.opta.methods.closeMarket("CLOSEME2").accountsStrict({
        admin: attacker.publicKey,
        protocolState: e.protocolState,
        market: e.market,
      }).signers([attacker]).rpc();
    } catch (err: any) {
      threw = true;
      assert.match(String(err), /Unauthorized|ConstraintAddress|2012|0x7d0/, "address gate rejected non-admin");
    }
    assert.isTrue(threw, "non-admin close must revert");
    assert.isTrue(await exists(e, e.market), "market survives a rejected close");
  });

  it("rejects a double-close (account already gone)", async () => {
    const e = await setupEnv("CLOSEME3", "closeme3-feed");
    await e.opta.methods.closeMarket("CLOSEME3").accountsStrict({
      admin: e.admin.publicKey,
      protocolState: e.protocolState,
      market: e.market,
    }).rpc();
    assert.isFalse(await exists(e, e.market), "market closed by the first call");

    let threw = false;
    try {
      await e.opta.methods.closeMarket("CLOSEME3").accountsStrict({
        admin: e.admin.publicKey,
        protocolState: e.protocolState,
        market: e.market,
      }).rpc();
    } catch (err: any) {
      threw = true;
    }
    assert.isTrue(threw, "second close of the same market must revert");
  });

  it("[preflight rationale] closes EVEN WITH a live child vault (no on-chain child-check)", async () => {
    // close_market intentionally has NO on-chain "no open vaults" guard (see
    // close_market.rs:11-29 — proving it would need unbounded remaining_accounts).
    // This test PROVES that gap: a live child vault does NOT block the close.
    // That is precisely why scripts/preflight_close_market.ts must run first at
    // cutover (it scans for live children and refuses to build the tx). After
    // this close the child vault is ORPHANED — the hazard the preflight prevents.
    const e = await setupEnv("CLOSELIVE", "closelive-feed");
    const writer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(100), expiry, { call: {} }, writer);
    await deposit(e, vault, vaultUsdc, writer, 500); // vault is LIVE (unsettled, funded)
    assert.isTrue(await exists(e, vault), "child vault is live before close");

    // No child-check: the close still succeeds on-chain.
    await e.opta.methods.closeMarket("CLOSELIVE").accountsStrict({
      admin: e.admin.publicKey, protocolState: e.protocolState, market: e.market,
    }).rpc();
    assert.isFalse(await exists(e, e.market), "market closed on-chain despite the live child");
    assert.isTrue(await exists(e, vault), "child vault is now ORPHANED (the preflight-prevented hazard)");
  });

  it("[name-reuse] re-registers the SAME asset_name after close (atomic name handover)", async () => {
    const e = await setupEnv("REUSE", "reuse-feed");
    assert.isTrue(await exists(e, e.market), "market exists after setup");

    // Close the market (frees the ["market", asset_name] PDA).
    await e.opta.methods.closeMarket("REUSE").accountsStrict({
      admin: e.admin.publicKey, protocolState: e.protocolState, market: e.market,
    }).rpc();
    assert.isFalse(await exists(e, e.market), "name PDA freed by close");

    // Re-create a market under the SAME real name (the cutover handover). A fresh
    // Pyth fixture proves feed-existence; oracle_source = 0 (Pyth) here, but at the
    // real cutover this is where an SB-sourced market (oracle_source = 1) takes the
    // undecorated name.
    const now = await getClockUnix(e.h.context);
    const feedFixture = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, feedFixture, pythBody(e.feedHex, 100, now));
    await e.opta.methods.createMarket("REUSE", e.feedId, 0, 0).accountsStrict({
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      creator: e.admin.publicKey, protocolState: e.protocolState, market: e.market,
      priceUpdate: feedFixture, systemProgram: SystemProgram.programId,
    }).rpc();
    assert.isTrue(await exists(e, e.market), "SAME-name market re-created after close (handover complete)");
  });
});
