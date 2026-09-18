// =============================================================================
// tests/bankrun/sb-oracle-source-routing.test.ts  (Stage 3 wiring 1a-i)
//
// Proves the oracle_source match arm wired into exercise_american:
//   (1) BYTE-IDENTICAL (load-bearing): a LEGACY 11-account Pyth tx — exactly
//       what a pre-Stage-3 client sends (price_update present, NO Switchboard
//       trailing accounts at all) — still lands and pays out correctly. This
//       proves Anchor 0.32.1 + `allow-missing-optionals` deserializes a
//       present-price_update + absent-trailing-optionals tx with no change.
//   (2) SB arm wiring (closest-achievable, per the unit-1 deferral): with the
//       market flipped to oracle_source = Switchboard, assert the routing +
//       account-unwrap guard (SwitchboardAccountsMissing), the on-chain
//       ed25519-index derivation reaching its no-ix error (NoEd25519Instruction),
//       and a real-ed25519 tx reaching the QuoteVerifier (revert). A FULL happy-
//       path verify needs a controlled SlotHashes + real queue + real SB quote —
//       documented as impractical in litesvm; see the unit report.
// =============================================================================

import { assert } from "chai";
import {
  Keypair, Transaction, TransactionInstruction, Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY,
} from "@solana/web3.js";
import {
  setupEnv, createVault, deposit, mint, purchase, usdc, bal, actor, getClockUnix,
  BN, pythBody, injectPythFixture, deriveVaultUsdc, CU,
  OPTA_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "./helpers";

// Flip an already-created (Pyth) market to oracle_source = Switchboard in-place.
// oracle_source's byte offset is NOT fixed: Anchor Borsh-serializes asset_name
// (a String) at its ACTUAL length, so the field sits right after
// disc(8) + [4-byte len + name] + pyth_feed_id(32) + asset_class(1) + bump(1).
async function flipMarketToSwitchboard(e: any) {
  const acc = await e.h.context.banksClient.getAccount(e.market);
  const data = Buffer.from(acc.data);
  const nameLen = data.readUInt32LE(8);
  const osOffset = 8 + 4 + nameLen + 32 + 1 + 1;
  assert.equal(data[osOffset], 0, `oracle_source starts as Pyth (0) at offset ${osOffset}`);
  data[osOffset] = 1; // Switchboard
  e.h.context.setAccount(e.market, {
    lamports: acc.lamports, data, owner: acc.owner,
    executable: acc.executable, rentEpoch: Number(acc.rentEpoch),
  });
}

// Stand up an American Pyth vault with a holder holding `qty` option tokens.
async function setupHolder(asset: string, label: string) {
  const e = await setupEnv(asset, label);
  const writer = actor(e), buyer = actor(e);
  const now = await getClockUnix(e.h.context);
  const expiry = new BN(now + 7 * 86_400);
  const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
  const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
  const m = await mint(e, vault, wp, writer, 10, now, true);
  const { buyerOptionAta, buyerUsdc } = await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);
  return { e, buyer, m, buyerOptionAta, buyerUsdc, now, vault };
}

describe("bankrun: Stage 3 wiring 1a-i — exercise_american oracle_source routing", function () {
  this.timeout(180_000);

  it("(1) BYTE-IDENTICAL: legacy 11-account Pyth tx lands + pays out", async () => {
    const { e, buyer, m, buyerOptionAta, buyerUsdc, now, vault } = await setupHolder("SBBYTEID", "sb-byteid");

    // Inject a fresh price update ($150 spot) exactly like the helper does.
    const fix = Keypair.generate().publicKey;
    injectPythFixture(e.h.context, fix, pythBody(e.feedHex, 150, now));

    // Build the ix through the NEW IDL (price_update + 3 SB optionals as null)…
    const fullIx = await e.opta.methods.exerciseAmerican(new BN(1)).accountsStrict({
      holder: buyer.publicKey, sharedVault: vault,
      market: e.market, priceUpdate: fix, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, holderOptionAccount: buyerOptionAta, vaultUsdcAccount: deriveVaultUsdc(vault),
      holderUsdcAccount: buyerUsdc, token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
      writerAskPot: null, writerAskPotUsdc: null, protocolState: null, // pool-funded → pot arm null
    }).instruction();

    console.log(`    [byte-identical] new-IDL ix.keys.length = ${fullIx.keys.length} (11 named + any SB sentinels)`);

    // …then submit a LEGACY tx with ONLY the first 11 (named) accounts — no SB
    // metas at all, the exact wire a pre-Stage-3 client produces. Same data
    // (discriminator + qty) byte-for-byte; just sliced keys.
    const legacyIx = new TransactionInstruction({
      programId: OPTA_PROGRAM_ID,
      keys: fullIx.keys.slice(0, 11),
      data: fullIx.data,
    });
    assert.equal(legacyIx.keys.length, 11, "legacy wire is exactly 11 accounts");

    const before = await bal(e, buyerUsdc);
    const tx = new Transaction().add(CU(400_000), legacyIx);
    await (e.opta.provider as any).sendAndConfirm(tx, [buyer]);
    const paid = (await bal(e, buyerUsdc)) - before;
    console.log(`    [byte-identical] legacy 11-account tx landed; paid=${paid}`);
    assert.equal(paid, 50_000_000n, "1 CALL @ $150 strike $100 → capped intrinsic $50");
  });

  it("(2a) SB market + missing SB accounts → SwitchboardAccountsMissing", async () => {
    const { e, buyer, m, buyerOptionAta, buyerUsdc, vault } = await setupHolder("SBMISS", "sb-miss");
    await flipMarketToSwitchboard(e);

    let err = "";
    try {
      await e.opta.methods.exerciseAmerican(new BN(1)).accountsStrict({
        holder: buyer.publicKey, sharedVault: vault, market: e.market, priceUpdate: null,
        vaultMintRecord: m.vaultMintRecord, optionMint: m.optionMint, holderOptionAccount: buyerOptionAta,
        vaultUsdcAccount: deriveVaultUsdc(vault), holderUsdcAccount: buyerUsdc,
        token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
        sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null, // SB market but none provided
        writerAskPot: null, writerAskPotUsdc: null, protocolState: null,
      }).preInstructions([CU(400_000)]).signers([buyer]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (2a) ${err.slice(0, 120)}`);
    assert.match(err, /SwitchboardAccountsMissing|6065/, "must require the SB accounts");
  });

  it("(2b) SB market + SB accounts but NO ed25519 ix → NoEd25519Instruction", async () => {
    const { e, buyer, m, buyerOptionAta, buyerUsdc, vault } = await setupHolder("SBNOED", "sb-noed");
    await flipMarketToSwitchboard(e);
    const dummyQueue = Keypair.generate().publicKey;

    let err = "";
    try {
      await e.opta.methods.exerciseAmerican(new BN(1)).accountsStrict({
        holder: buyer.publicKey, sharedVault: vault, market: e.market, priceUpdate: null,
        vaultMintRecord: m.vaultMintRecord, optionMint: m.optionMint, holderOptionAccount: buyerOptionAta,
        vaultUsdcAccount: deriveVaultUsdc(vault), holderUsdcAccount: buyerUsdc,
        token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
        sbQueue: dummyQueue, sbSlothashes: SYSVAR_SLOT_HASHES_PUBKEY, sbInstructions: SYSVAR_INSTRUCTIONS_PUBKEY, optaPriceFeed: null,
        writerAskPot: null, writerAskPotUsdc: null, protocolState: null,
      }).preInstructions([CU(400_000)]).signers([buyer]).rpc(); // no ed25519 preIx
    } catch (ex: any) { err = String(ex); }
    console.log(`    (2b) ${err.slice(0, 120)}`);
    assert.match(err, /NoEd25519Instruction|6067/, "ed25519-index derivation must error when no ed25519 ix present");
  });

  it("(2c) SB market + valid ed25519 ix → reaches QuoteVerifier (reverts)", async () => {
    const { e, buyer, m, buyerOptionAta, buyerUsdc, vault } = await setupHolder("SBVERIFY", "sb-verify");
    await flipMarketToSwitchboard(e);
    const dummyQueue = Keypair.generate().publicKey;

    // A VALID (but non-Switchboard) ed25519 ix so the native precompile passes
    // and our find_ed25519_ix_index finds it; the QuoteVerifier then rejects it
    // (not an SB quote / queue+slothash mismatch) → SwitchboardVerifyFailed.
    const edKp = Keypair.generate();
    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: edKp.secretKey,
      message: Buffer.from("opta-stage3-probe"),
    });

    let err = "";
    try {
      await e.opta.methods.exerciseAmerican(new BN(1)).accountsStrict({
        holder: buyer.publicKey, sharedVault: vault, market: e.market, priceUpdate: null,
        vaultMintRecord: m.vaultMintRecord, optionMint: m.optionMint, holderOptionAccount: buyerOptionAta,
        vaultUsdcAccount: deriveVaultUsdc(vault), holderUsdcAccount: buyerUsdc,
        token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
        sbQueue: dummyQueue, sbSlothashes: SYSVAR_SLOT_HASHES_PUBKEY, sbInstructions: SYSVAR_INSTRUCTIONS_PUBKEY, optaPriceFeed: null,
        writerAskPot: null, writerAskPotUsdc: null, protocolState: null,
      }).preInstructions([CU(400_000), edIx]).signers([buyer]).rpc();
    } catch (ex: any) { err = String(ex); }
    console.log(`    (2c) ${err.slice(0, 200)}`);
    assert.notEqual(err, "", "must revert — a non-SB quote cannot verify");
    // The routing reached the QuoteVerifier: it got PAST every earlier guard
    // (price_update/SB-accounts/sysvar/ed25519-derivation). The crate aborts the
    // tx on a non-SB ed25519 payload (panic, not our mapped Err), so we assert
    // "reverted past all guards" rather than the specific 6061 — a clean
    // SwitchboardVerifyFailed needs a real-but-stale SB quote (see unit report).
    assert.notMatch(
      err,
      /PriceUpdateMissing|SwitchboardAccountsMissing|InvalidSwitchboardSysvar|NoEd25519Instruction/,
      "must get past all SB guards into the QuoteVerifier (not an earlier revert)",
    );
  });
});
