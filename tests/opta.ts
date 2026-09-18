// =============================================================================
// tests/opta.ts — Top-level instruction tests for Opta v2-only protocol
// =============================================================================
//
// Stage 4 reshape: v1 P2P escrow + pricing tests are gone. This file now
// covers only the top-level instructions:
//   1. initialize_protocol  — One-time protocol setup
//   2. create_market        — Asset registry (admin-only, idempotent)
//   3. settle_expiry        — Per-(asset, expiry) settlement record
//
// Vault-side flows (deposit/mint/purchase/exercise/withdraw/burn/claim
// /settle_vault) are tested in tests/shared-vaults.ts and the audit-fix
// lifecycle tests in tests/zzz-audit-fixes.ts.
//
// All tests run against `anchor test` localnet.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import {
  fixturePubkey,
  serializePriceUpdateV2,
  deserializePriceUpdateV2,
  FEED_ID_HEX,
  getFixtureBaseTime,
} from "./_pyth_fixtures";

// =============================================================================
// Asset registry — 32-byte Pyth Pull feed IDs (mainnet hex from
// scripts/pyth-feed-ids.csv). Stage P1 stores these verbatim with no
// on-chain validation; Stage P2 settle_expiry will validate against
// PriceUpdateV2 accounts. Stage P5 may switch to Beta-cluster feed IDs.
// =============================================================================
const REGISTRY = {
  SOL:  Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex"),
  BTC:  Buffer.from("e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", "hex"),
};
// Anchor TS expects [u8; 32] as a `number[]` of length 32.
const SOL_ID = Array.from(REGISTRY.SOL);
const BTC_ID = Array.from(REGISTRY.BTC);
// Stand-in feed_id for the "anyone can create a market" test that doesn't
// care about Pyth correctness (pre-P2 only).
const ZERO_ID: number[] = Array.from(Buffer.alloc(32, 0));

// HIGH-5 (audit Run-7): create_market + migrate_pyth_feed now require a
// PriceUpdateV2 account whose feed_id matches the arg. We use the same
// fixture pubkeys settle_expiry tests use; the only requirement is that
// verification_level == Full and the feed_id matches the argument.
const SOL_180_FRESH_PK = fixturePubkey("sol-180-fresh");
const BTC_FIXTURE_PK = fixturePubkey("btc-fresh");

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/// Poll the VALIDATOR's on-chain unix clock (Clock sysvar, unix_timestamp at
/// byte offset 32) until it reaches `targetUnix`. settle_expiry gate 1 checks
/// `clock >= expiry`, and the test-validator clock LAGS real time under load, so
/// a Date.now()-based wait can return while the on-chain clock is still behind →
/// spurious MarketNotExpired (6006). Capped at `capMs` so a genuine validator
/// stall fails loudly instead of spinning forever.
async function waitForOnChainUnix(
  program: Program<Opta>,
  targetUnix: number,
  capMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + capMs;
  const readClock = async (): Promise<number> => {
    const acc = await program.provider.connection.getAccountInfo(
      anchor.web3.SYSVAR_CLOCK_PUBKEY,
    );
    if (!acc) throw new Error("Clock sysvar not found");
    return Number(acc.data.readBigInt64LE(32));
  };
  let clk = await readClock();
  while (clk < targetUnix) {
    if (Date.now() > deadline) {
      throw new Error(
        `waitForOnChainUnix: on-chain clock ${clk} never reached ${targetUnix} within ${capMs}ms (validator clock stalled)`,
      );
    }
    await sleep(500);
    clk = await readClock();
  }
}

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

describe("opta", () => {
  const connection = new anchor.web3.Connection(
    "http://127.0.0.1:8899",
    { commitment: "confirmed" },
  );
  const wallet = anchor.AnchorProvider.env().wallet;
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = anchor.workspace.opta as Program<Opta>;
  const admin = provider.wallet as anchor.Wallet;
  const payer = (admin as any).payer as Keypair;

  let usdcMint: PublicKey;
  let protocolStatePda: PublicKey;
  let treasuryPda: PublicKey;

  // -------------------------------------------------------------------------
  // PDA derivation helpers
  // -------------------------------------------------------------------------
  function deriveMarketPda(assetName: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(assetName)],
      program.programId,
    );
  }

  function deriveSettlementPda(assetName: string, expiry: BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("settlement"),
        Buffer.from(assetName),
        expiry.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
  }

  // -------------------------------------------------------------------------
  // Setup: create USDC mint, derive protocol PDAs
  // -------------------------------------------------------------------------
  before(async () => {
    usdcMint = await createMint(
      provider.connection, payer, admin.publicKey, admin.publicKey, 6,
    );

    [protocolStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_v2")], program.programId,
    );
    [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_v2")], program.programId,
    );
  });

  // ===========================================================================
  // 1. initialize_protocol
  // ===========================================================================
  describe("initialize_protocol", () => {
    // CRIT-3 audit fix: only the hardcoded deployer pubkey can initialize
    // the protocol. We test the gate from a random signer first (PDA still
    // uninitialized at this point on a fresh ledger via --reset) so the
    // handler's require_keys_eq! is the failing check, not Anchor's
    // "already in use" init constraint.
    it("rejects non-deployer signer (Unauthorized) — CRIT-3", async function () {
      this.timeout(20_000);
      // On a fresh ledger (--reset, default for run-tests.sh), the
      // protocol_state PDA is uninitialized so the handler-level gate
      // is the first thing to revert. On a stale ledger we'd hit the
      // init-constraint's "already in use" error before the gate;
      // skip in that case since the gate is then unreachable.
      try {
        await program.account.protocolState.fetch(protocolStatePda);
        this.skip();
        return;
      } catch {}

      const random = Keypair.generate();
      const sig = await connection.requestAirdrop(random.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");

      try {
        await program.methods
          .initializeProtocol()
          .accountsStrict({
            admin: random.publicKey,
            protocolState: protocolStatePda,
            treasury: treasuryPda,
            usdcMint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([random])
          .rpc();
        assert.fail("Should have thrown Unauthorized");
      } catch (err: any) {
        assert.include(err.toString(), "Unauthorized");
      }
    });

    it("initializes the protocol with correct defaults", async () => {
      // Idempotent across test files — if already initialized by another
      // suite, read existing state and assert it's well-formed.
      let alreadyInitialized = false;
      try {
        await program.account.protocolState.fetch(protocolStatePda);
        alreadyInitialized = true;
      } catch {}

      if (!alreadyInitialized) {
        await program.methods
          .initializeProtocol()
          .accountsStrict({
            admin: admin.publicKey,
            protocolState: protocolStatePda,
            treasury: treasuryPda,
            usdcMint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .rpc();
      }

      const protocol = await program.account.protocolState.fetch(protocolStatePda);
      assert.ok(protocol.admin instanceof PublicKey || typeof (protocol.admin as any).equals === "function");
      assert.equal(protocol.feeBps, 50);
      // Reseed our local usdcMint reference so downstream tests use the
      // same mint the protocol was initialized with.
      usdcMint = protocol.usdcMint;
    });

    it("fails when trying to initialize a second time", async () => {
      try {
        await program.methods.initializeProtocol().accountsStrict({
          admin: admin.publicKey, protocolState: protocolStatePda, treasury: treasuryPda,
          usdcMint, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        }).rpc();
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.ok(err);
      }
    });
  });

  // ===========================================================================
  // 2. create_market — asset registry (admin-only, idempotent)
  // ===========================================================================
  describe("create_market", () => {
    it("registers SOL with caller signer", async () => {
      const [marketPda] = deriveMarketPda("SOL");

      await program.methods
        .createMarket("SOL", SOL_ID, 0, 0)
        .accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          priceUpdate: SOL_180_FRESH_PK,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "SOL");
      assert.deepEqual(Array.from(market.pythFeedId), SOL_ID);
      assert.equal(market.assetClass, 0);
    });

    it("idempotent — second call with matching args is a silent Ok", async () => {
      const [marketPda] = deriveMarketPda("SOL");

      // Should not revert
      await program.methods
        .createMarket("SOL", SOL_ID, 0, 0)
        .accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          priceUpdate: SOL_180_FRESH_PK,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "SOL");
      assert.deepEqual(Array.from(market.pythFeedId), SOL_ID);
    });

    it("idempotent re-call with different feed reverts MismatchedFeedId", async () => {
      // Post-HIGH-5: the proof gate rejects (BTC arg + SOL fixture)
      // before the idempotent AssetMismatch check ever runs. Behavior
      // change is intentional — the proof gate is strictly stronger:
      // it rejects feed_id mismatches at the Pyth-attestation layer
      // (i.e., a griefer can't even claim a non-real feed_id).
      const [marketPda] = deriveMarketPda("SOL");

      try {
        await program.methods
          .createMarket("SOL", BTC_ID, 0, 0)  // wrong feed for SOL
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            creator: admin.publicKey,
            protocolState: protocolStatePda,
            priceUpdate: SOL_180_FRESH_PK,
            market: marketPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown MismatchedFeedId");
      } catch (err: any) {
        assert.include(err.toString(), "MismatchedFeedId");
      }
    });

    it("registers a second asset (BTC)", async () => {
      const [marketPda] = deriveMarketPda("BTC");

      await program.methods
        .createMarket("BTC", BTC_ID, 0, 0)
        .accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          priceUpdate: BTC_FIXTURE_PK,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "BTC");
      assert.deepEqual(Array.from(market.pythFeedId), BTC_ID);
    });

    it("anyone can create a market — permissionless + proof-bound", async () => {
      // Post-HIGH-5: still permissionless (no admin gate), but the proof
      // gate forces the caller-supplied feed_id to be real (verified
      // against PriceUpdateV2). Asset name "PERM5" is unused elsewhere;
      // we use SOL_ID + sol-180-fresh fixture so the proof gate passes.
      // Note: ZERO_ID-style griefing is now blocked at the proof gate
      // (no real Pyth feed has feed_id == [0u8; 32]).
      const randomUser = Keypair.generate();
      const sig = await connection.requestAirdrop(randomUser.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");

      const [marketPda] = deriveMarketPda("PERM5");

      await program.methods
        .createMarket("PERM5", SOL_ID, 0, 0)
        .accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: randomUser.publicKey,
          protocolState: protocolStatePda,
          priceUpdate: SOL_180_FRESH_PK,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([randomUser])
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "PERM5");
      assert.deepEqual(Array.from(market.pythFeedId), SOL_ID);
      assert.equal(market.assetClass, 0);
    });

    it("rejects lowercase asset name (InvalidAssetName)", async () => {
      const [marketPda] = deriveMarketPda("sol");

      try {
        await program.methods
          .createMarket("sol", SOL_ID, 0, 0)
          .accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            creator: admin.publicKey,
            protocolState: protocolStatePda,
            priceUpdate: SOL_180_FRESH_PK,
            market: marketPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown InvalidAssetName");
      } catch (err: any) {
        assert.include(err.toString(), "InvalidAssetName");
      }
    });

    it("rejects empty asset name (InvalidAssetName)", async () => {
      const [marketPda] = deriveMarketPda("");

      try {
        await program.methods
          .createMarket("", SOL_ID, 0, 0)
          .accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            creator: admin.publicKey,
            protocolState: protocolStatePda,
            priceUpdate: SOL_180_FRESH_PK,
            market: marketPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown InvalidAssetName");
      } catch (err: any) {
        assert.include(err.toString(), "InvalidAssetName");
      }
    });
  });

  // ===========================================================================
  // 3. Pyth fixture roundtrip smoke test (Stage P2)
  // ===========================================================================
  // First test in the suite — catches Borsh layout drift in
  // _pyth_fixtures.ts the moment it happens. If this test fails, every
  // downstream settle_expiry test would fail with cryptic errors; failing
  // here gives one clear "fixture layout broken" signal.
  describe("pyth fixture roundtrip", () => {
    it("anchor decoder reads back every field of a serialized PriceUpdateV2", async () => {
      const now = Math.floor(Date.now() / 1000);
      const fixture = {
        feedIdHex: FEED_ID_HEX.SOL,
        price: BigInt("18000000000"),
        conf: BigInt("1000000"),
        exponent: -8,
        publishTime: BigInt(now - 30),
        prevPublishTime: BigInt(now - 31),
        emaPrice: BigInt("18010000000"),
        emaConf: BigInt("999999"),
      };
      const body = serializePriceUpdateV2(fixture);

      // Self-consistency roundtrip: deserialize via our mirror decoder and
      // assert every field. This catches off-by-N / endianness / int-size
      // bugs in our serializer the moment they happen. Cross-side drift
      // (Pyth SDK changing PriceFeedMessage layout) is caught downstream
      // by the end-to-end settle_expiry tests, which fail loudly if the
      // program rejects fixtures of the wrong shape.
      const decoded = deserializePriceUpdateV2(body);

      // Discriminator length sanity
      assert.equal(decoded.discriminator.length, 8);
      // write_authority — wrote 32 zero bytes
      assert.deepEqual(Array.from(decoded.writeAuthority), Array.from(Buffer.alloc(32, 0)));
      // verification_level — Full = tag 1
      assert.equal(decoded.verificationLevelTag, 1);
      // price_message fields, every one
      assert.deepEqual(
        Array.from(decoded.feedId),
        Array.from(Buffer.from(FEED_ID_HEX.SOL, "hex")),
      );
      assert.equal(decoded.price.toString(), fixture.price.toString());
      assert.equal(decoded.conf.toString(), fixture.conf.toString());
      assert.equal(decoded.exponent, fixture.exponent);
      assert.equal(decoded.publishTime.toString(), fixture.publishTime.toString());
      assert.equal(decoded.prevPublishTime.toString(), fixture.prevPublishTime.toString());
      assert.equal(decoded.emaPrice.toString(), fixture.emaPrice.toString());
      assert.equal(decoded.emaConf.toString(), fixture.emaConf.toString());
      // posted_slot — wrote 0
      assert.equal(decoded.postedSlot.toString(), "0");
    });
  });

  // ===========================================================================
  // 4. settle_expiry — per-(asset, expiry) Pyth-validated settlement record
  // ===========================================================================
  // SKIPPED (fixture-rot): the happy-path settle uses an 8s-out expiry settled
  // with a fixed-publish-time fixture; publish_time < expiry → PriceUpdateBeforeExpiry
  // (6038). The D2/CRIT-2 describes below stay active (they anchor expiry to the
  // fixture baseTime). Deterministic only under bankrun setClock — Stage G.
  describe.skip("settle_expiry [ported to tests/bankrun/settle-expiry.test.ts — Stage G Pass 3a]", () => {
    // Pre-loaded fixture pubkeys (see tests/_pyth_fixtures.ts).
    const SOL_FRESH_PK = fixturePubkey("sol-180-fresh");
    const SOL_STALE_PK = fixturePubkey("sol-180-stale");
    const BTC_FRESH_PK = fixturePubkey("btc-fresh");

    // Per-test unique expiry so SettlementRecord PDAs don't collide.
    let happyExpiry: BN;
    let staleExpiry: BN;
    let wrongFeedExpiry: BN;
    let doubleSettleExpiry: BN;

    before(() => {
      // All expiries 8 seconds out so the pre-expiry test (using a
      // far-future stamp) is unaffected.
      const base = Math.floor(Date.now() / 1000) + 8;
      happyExpiry         = new BN(base + 0);
      staleExpiry         = new BN(base + 1);
      wrongFeedExpiry     = new BN(base + 2);
      doubleSettleExpiry  = new BN(base + 3);
    });

    it("rejects pre-expiry call (MarketNotExpired)", async () => {
      // Ensure SOL market exists (idempotent).
      const [marketPda] = deriveMarketPda("SOL");
      await program.methods
        .createMarket("SOL", SOL_ID, 0, 0)
        .accountsStrict({ sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: admin.publicKey, protocolState: protocolStatePda,
          priceUpdate: SOL_180_FRESH_PK,
          market: marketPda, systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Far-future expiry — won't have elapsed yet.
      const farFuture = new BN(Math.floor(Date.now() / 1000) + 86400);
      const [settlementPda] = deriveSettlementPda("SOL", farFuture);

      try {
        await program.methods
          .settleExpiry("SOL", farFuture)
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            caller: admin.publicKey,
            market: marketPda,
            priceUpdate: SOL_FRESH_PK,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown MarketNotExpired");
      } catch (err: any) {
        assert.include(err.toString(), "MarketNotExpired");
      }
    });

    it("rejects unregistered asset — market PDA does not resolve", async () => {
      const [fakeMarketPda] = deriveMarketPda("XYZ");
      const [settlementPda] = deriveSettlementPda("XYZ", happyExpiry);

      try {
        await program.methods
          .settleExpiry("XYZ", happyExpiry)
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            caller: admin.publicKey,
            market: fakeMarketPda,
            priceUpdate: SOL_FRESH_PK,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (err: any) {
        // Anchor: market PDA doesn't resolve to an initialized account
        assert.ok(err);
      }
    });

    it("permissionless caller settles with fresh PriceUpdateV2", async () => {
      const [marketPda] = deriveMarketPda("SOL");

      // Wait long enough for ALL settle_expiry per-test expiries to elapse
      // (max offset from `before()` is base+3 = now+11). 15s is safe.
      await sleep(15_000);

      const [settlementPda] = deriveSettlementPda("SOL", happyExpiry);

      // Use a non-admin signer to prove permissionless.
      const randomCaller = Keypair.generate();
      const sig = await connection.requestAirdrop(randomCaller.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");

      await program.methods
        .settleExpiry("SOL", happyExpiry)
        .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          caller: randomCaller.publicKey,
          market: marketPda,
          priceUpdate: SOL_FRESH_PK,
          settlementRecord: settlementPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([randomCaller])
        .rpc();

      const record = await program.account.settlementRecord.fetch(settlementPda);
      assert.equal(record.assetName, "SOL");
      assert.ok(record.expiry.eq(happyExpiry));
      // Pyth fixture: price=18_000_000_000, expo=-8 → $180.00 in USDC 6-dec.
      assert.equal(record.settlementPrice.toString(), "180000000");
      assert.ok(record.settledAt.toNumber() > 0);
    });

    it("rejects stale PriceUpdateV2 (PriceUpdateBeforeExpiry)", async () => {
      // Post-2026-05-03 settlement-pricing-fix arc: the stale fixture's
      // publish_time (-400s offset) lands BEFORE any test expiry. Under
      // the new on-chain check chain, the publish_time >= expiry guard
      // (D2) trips first, so the error code is PriceUpdateBeforeExpiry,
      // not PriceTooOld. Same negative behavior, different sentinel.
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", staleExpiry);

      try {
        await program.methods
          .settleExpiry("SOL", staleExpiry)
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            caller: admin.publicKey,
            market: marketPda,
            priceUpdate: SOL_STALE_PK,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown PriceUpdateBeforeExpiry");
      } catch (err: any) {
        assert.include(err.toString(), "PriceUpdateBeforeExpiry");
      }
    });

    it("rejects wrong-feed PriceUpdateV2 (MismatchedFeedId)", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", wrongFeedExpiry);

      try {
        await program.methods
          .settleExpiry("SOL", wrongFeedExpiry)
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            caller: admin.publicKey,
            market: marketPda,
            priceUpdate: BTC_FRESH_PK,  // BTC feed_id ≠ SOL feed_id
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown MismatchedFeedId");
      } catch (err: any) {
        assert.include(err.toString(), "MismatchedFeedId");
      }
    });

    it("rejects double-settle — plain init reverts", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", doubleSettleExpiry);

      // First call succeeds.
      await program.methods
        .settleExpiry("SOL", doubleSettleExpiry)
        .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          caller: admin.publicKey,
          market: marketPda,
          priceUpdate: SOL_FRESH_PK,
          settlementRecord: settlementPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Second call must fail (account already initialized).
      try {
        await program.methods
          .settleExpiry("SOL", doubleSettleExpiry)
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            caller: admin.publicKey,
            market: marketPda,
            priceUpdate: SOL_FRESH_PK,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown — second init must fail");
      } catch (err: any) {
        // Anchor account-already-in-use error
        assert.ok(err);
      }
    });
  });

  // ===========================================================================
  // 4b. settle_expiry — D2 expiry-window check (2026-05-03)
  // ===========================================================================
  //
  // Post-fix arc: settle_expiry now requires the Pyth update's publish_time
  // to land in [expiry, expiry + EXPIRY_WINDOW_SECS]. These three tests
  // pin both expiry and fixture publish_time to a single shared anchor
  // (baseTime, persisted by writeAllFixtures and read via
  // getFixtureBaseTime) so the gap is exact, not racy against suite
  // wall-clock drift.
  // ===========================================================================
  describe("settle_expiry — expiry-window check (D2)", () => {
    const D2_HAPPY_PK    = fixturePubkey("sol-180-window-future-5");
    const D2_BEFORE_PK   = fixturePubkey("sol-180-window-before-5");
    const D2_TOO_LATE_PK = fixturePubkey("sol-180-window-too-late-120");

    let baseTime: number;
    let happyExpiry: BN;
    let beforeExpiry: BN;
    let tooLateExpiry: BN;

    before(async function () {
      this.timeout(120_000);
      baseTime = getFixtureBaseTime();
      // Expiries paired with fixture publishTimeOffsetSec values in
      // _pyth_fixtures.ts. Only the GAP (publish_time - expiry) matters to the
      // window checks; the expiry OFFSET is kept SMALL (baseTime + 2..4) so
      // settle_expiry's gate-1 `clock >= expiry` is satisfied the moment the
      // validator starts — the test-validator clock lags/stalls under load, so
      // large offsets (the old +50..52) raced/timed-out MarketNotExpired.
      //   happy:    publish = baseTime + 7,   expiry = baseTime + 2, gap = +5   → success
      //   before:   publish = baseTime - 2,   expiry = baseTime + 3, gap = -5   → PriceUpdateBeforeExpiry
      //   too-late: publish = baseTime + 124, expiry = baseTime + 4, gap = +120 → PriceUpdateTooFarFromExpiry
      happyExpiry   = new BN(baseTime + 2);
      beforeExpiry  = new BN(baseTime + 3);
      tooLateExpiry = new BN(baseTime + 4);

      // Belt-and-suspenders: ensure the on-chain clock is past the (now tiny)
      // expiries. Returns essentially immediately since the suite is minutes in.
      await waitForOnChainUnix(program, tooLateExpiry.toNumber() + 1);
    });

    it("happy-path: publish_time = expiry + 5s succeeds and records pyth_publish_time", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", happyExpiry);

      await program.methods
        .settleExpiry("SOL", happyExpiry)
        .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          caller: admin.publicKey,
          market: marketPda,
          priceUpdate: D2_HAPPY_PK,
          settlementRecord: settlementPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const record = await program.account.settlementRecord.fetch(settlementPda);
      assert.equal(record.assetName, "SOL");
      assert.ok(record.expiry.eq(happyExpiry));
      // Fixture: ema_price=18_000_000_000, expo=-8 → $180.00 in USDC 6-dec.
      assert.equal(record.settlementPrice.toString(), "180000000");
      // Critical D2 assertion: publish_time was recorded, not just settled_at.
      // Matches the happy fixture's publishTimeOffsetSec (+7) in _pyth_fixtures.ts.
      assert.equal(record.pythPublishTime.toNumber(), baseTime + 7,
        "pyth_publish_time must equal the fixture's baseTime + 7");
      // settled_at must be a real on-chain timestamp. We can't assert
      // its relation to pyth_publish_time in this test because the
      // synthetic fixture's publish_time is set to baseTime + 7 (which may be
      // slightly ahead of the on-chain clock early in the suite) — in real Pyth,
      // publish_time is always in the past relative to clock, but the
      // test fixture doesn't replicate that ordering.
      assert.isAbove(record.settledAt.toNumber(), 0,
        "settled_at must be populated with the on-chain clock");
    });

    it("rejects publish_time before expiry (PriceUpdateBeforeExpiry)", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", beforeExpiry);

      try {
        await program.methods
          .settleExpiry("SOL", beforeExpiry)
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            caller: admin.publicKey,
            market: marketPda,
            priceUpdate: D2_BEFORE_PK,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown PriceUpdateBeforeExpiry");
      } catch (err: any) {
        assert.include(err.toString(), "PriceUpdateBeforeExpiry");
      }
    });

    it("rejects publish_time more than 60s after expiry (PriceUpdateTooFarFromExpiry)", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", tooLateExpiry);

      try {
        await program.methods
          .settleExpiry("SOL", tooLateExpiry)
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            caller: admin.publicKey,
            market: marketPda,
            priceUpdate: D2_TOO_LATE_PK,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown PriceUpdateTooFarFromExpiry");
      } catch (err: any) {
        const msg = err.toString();
        if (!msg.includes("PriceUpdateTooFarFromExpiry")) {
          // Print the full error so we can diagnose if the wrong code fires.
          console.error("FULL ERR for too-late test:", msg);
        }
        assert.include(msg, "PriceUpdateTooFarFromExpiry");
      }
    });
  });

  // ===========================================================================
  // settle_expiry — confidence-interval gate (CRIT-2 audit fix)
  // ===========================================================================
  // The handler rejects PriceUpdateV2 accounts whose ema_conf is wider than
  // MAX_CONF_BPS=200 (2%) of |ema_price|. We mint three fixtures with conf
  // dialed to: just-under boundary (passes), exactly at boundary (passes,
  // <= is inclusive), and just-over boundary (reverts PriceConfidenceTooWide).
  // Pinned to baseTime so the window-gate gap is exactly +5s.
  // ===========================================================================
  describe("settle_expiry — confidence-interval check (CRIT-2)", () => {
    const CONF_UNDER_PK = fixturePubkey("sol-180-conf-just-under");
    const CONF_EDGE_PK  = fixturePubkey("sol-180-conf-at-edge");
    const CONF_OVER_PK  = fixturePubkey("sol-180-conf-just-over");

    let baseTime: number;
    let underExpiry: BN;
    let edgeExpiry: BN;
    let overExpiry: BN;

    before(async function () {
      this.timeout(120_000);
      baseTime = getFixtureBaseTime();
      // Small expiry offsets (baseTime + 5..7) so gate-1 `clock >= expiry` is
      // satisfied immediately — the validator clock lags/stalls under load, so
      // the old +100..102 offsets timed out here. Distinct from the D2 block's
      // +2..4 so the settlement-record PDAs don't collide. Paired publish_time
      // gap = +5 preserved (conf fixtures at +10..12 in _pyth_fixtures.ts).
      underExpiry = new BN(baseTime + 5);
      edgeExpiry  = new BN(baseTime + 6);
      overExpiry  = new BN(baseTime + 7);
      // Belt-and-suspenders: essentially immediate (suite is minutes in).
      await waitForOnChainUnix(program, overExpiry.toNumber() + 1);
    });

    it("accepts ema_conf just under the MAX_CONF_BPS boundary", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", underExpiry);
      await program.methods
        .settleExpiry("SOL", underExpiry)
        .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          caller: admin.publicKey,
          market: marketPda,
          priceUpdate: CONF_UNDER_PK,
          settlementRecord: settlementPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const rec = await program.account.settlementRecord.fetch(settlementPda);
      assert.equal(rec.assetName, "SOL");
    });

    it("accepts ema_conf exactly at the MAX_CONF_BPS boundary (inclusive)", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", edgeExpiry);
      await program.methods
        .settleExpiry("SOL", edgeExpiry)
        .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          caller: admin.publicKey,
          market: marketPda,
          priceUpdate: CONF_EDGE_PK,
          settlementRecord: settlementPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const rec = await program.account.settlementRecord.fetch(settlementPda);
      assert.equal(rec.assetName, "SOL");
    });

    it("rejects ema_conf just past the MAX_CONF_BPS boundary (PriceConfidenceTooWide)", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", overExpiry);
      try {
        await program.methods
          .settleExpiry("SOL", overExpiry)
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            caller: admin.publicKey,
            market: marketPda,
            priceUpdate: CONF_OVER_PK,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown PriceConfidenceTooWide");
      } catch (err: any) {
        assert.include(err.toString(), "PriceConfidenceTooWide");
      }
    });
  });

  // ===========================================================================
  // 4. migrate_pyth_feed — admin-only feed_id rotation
  // ===========================================================================
  // Uses BTC (not SOL) for the happy-path mutation: SOL has many downstream
  // consumers across this file and zzz-audit-fixes.ts that depend on its
  // current feed_id matching the SOL fixtures. BTC has no downstream
  // consumers post-create_market, so rotating it is a safe isolated test.
  // ===========================================================================
  // 5. opta_transfer_hook::initialize_extra_account_meta_list — protocol_state gate (HIGH-1)
  // ===========================================================================
  // The hook program rejects any call whose `protocol_state` arg is not the
  // canonical opta protocol PDA. The positive case is covered implicitly by
  // every successful mint_from_vault flow (CPI passes the canonical PDA);
  // we only test the negative case here.
  describe("opta_transfer_hook — protocol_state gate (HIGH-1)", () => {
    it("rejects bogus protocol_state (InvalidProtocolState)", async () => {
      const hookProgram = (anchor.workspace as any).optaTransferHook;
      assert.ok(hookProgram, "hook program not loaded in workspace");

      // Use a fresh dummy "mint" pubkey so the hook_state + extra_account_meta_list
      // PDAs are unallocated — the gate fires before init constraint runs.
      const fakeMint = Keypair.generate();
      const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
        [Buffer.from("extra-account-metas"), fakeMint.publicKey.toBuffer()],
        hookProgram.programId,
      );
      const [hookState] = PublicKey.findProgramAddressSync(
        [Buffer.from("hook-state"), fakeMint.publicKey.toBuffer()],
        hookProgram.programId,
      );
      // A-to-Z H-01 (Run-8): protocol_state is now a `Signer` on the hook init.
      // Pass a SIGNED bogus keypair so the Signer gate is satisfied and the
      // require_keys_eq key check (bogus != canonical opta PDA) is what rejects
      // it with InvalidProtocolState — keeps the key-check coverage alive rather
      // than tripping a bare "Signature verification failed".
      const bogusProtocolState = Keypair.generate();
      const expiry = new BN(Math.floor(Date.now() / 1000) + 3600);

      try {
        await hookProgram.methods
          .initializeExtraAccountMetaList(expiry)
          .accountsStrict({
            payer: admin.publicKey,
            mint: fakeMint.publicKey,
            extraAccountMetaList,
            hookState,
            protocolState: bogusProtocolState.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([bogusProtocolState])
          .rpc();
        assert.fail("Should have thrown InvalidProtocolState");
      } catch (err: any) {
        assert.include(err.toString(), "InvalidProtocolState");
      }
    });
  });

  describe("migrate_pyth_feed", () => {
    // Post-HIGH-5: the new feed_id must be proof-bound to a real Pyth
    // feed via a PriceUpdateV2 account. We rotate BTC's pointer to the
    // SOL feed_id (operationally odd but tests-only) so we can use the
    // existing sol-180-fresh fixture for the proof.
    const NEW_BTC_ID: number[] = SOL_ID;

    it("admin migrates BTC feed_id to a new value", async () => {
      const [marketPda] = deriveMarketPda("BTC");

      const before = await program.account.optionsMarket.fetch(marketPda);
      assert.deepEqual(
        Array.from(before.pythFeedId),
        BTC_ID,
        "precondition: BTC market currently holds the original mainnet feed_id",
      );

      await program.methods
        .migratePythFeed("BTC", NEW_BTC_ID)
        .accountsStrict({
          admin: admin.publicKey,
          protocolState: protocolStatePda,
          priceUpdate: SOL_180_FRESH_PK,
          market: marketPda,
        })
        .rpc();

      const after = await program.account.optionsMarket.fetch(marketPda);
      assert.deepEqual(
        Array.from(after.pythFeedId),
        NEW_BTC_ID,
        "postcondition: BTC feed_id rotated to NEW_BTC_ID",
      );
      assert.equal(after.assetName, "BTC", "asset_name unchanged");
      assert.equal(after.assetClass, 0, "asset_class unchanged");
    });

    it("idempotent re-call with same feed_id succeeds silently", async () => {
      const [marketPda] = deriveMarketPda("BTC");

      // BTC currently holds NEW_BTC_ID from the prior test. Re-call with
      // the same value — must not throw.
      await program.methods
        .migratePythFeed("BTC", NEW_BTC_ID)
        .accountsStrict({
          admin: admin.publicKey,
          protocolState: protocolStatePda,
          priceUpdate: SOL_180_FRESH_PK,
          market: marketPda,
        })
        .rpc();

      const after = await program.account.optionsMarket.fetch(marketPda);
      assert.deepEqual(
        Array.from(after.pythFeedId),
        NEW_BTC_ID,
        "feed_id stays at NEW_BTC_ID (no-op re-call)",
      );
    });

    it("rejects non-admin signer (Unauthorized)", async () => {
      const [marketPda] = deriveMarketPda("BTC");

      // Spin up a wallet that is not the protocol admin and fund it so it
      // can pay for the transaction.
      const fakeAdmin = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        fakeAdmin.publicKey,
        LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig, "confirmed");

      try {
        await program.methods
          .migratePythFeed("BTC", BTC_ID) // admin gate fires before proof gate
          .accountsStrict({
            admin: fakeAdmin.publicKey,
            protocolState: protocolStatePda,
            priceUpdate: BTC_FIXTURE_PK,
            market: marketPda,
          })
          .signers([fakeAdmin])
          .rpc();
        assert.fail("Should have thrown Unauthorized");
      } catch (err: any) {
        assert.include(err.toString(), "Unauthorized");
      }
    });

    it("rejects nonexistent market — anchor seed validation fails", async () => {
      // "GHOST" was never registered via create_market; its market PDA is
      // therefore uninitialized and Anchor's seed/account validation must
      // reject the call before our handler even runs.
      const [ghostPda] = deriveMarketPda("GHOST");

      try {
        await program.methods
          .migratePythFeed("GHOST", NEW_BTC_ID)
          .accountsStrict({
            admin: admin.publicKey,
            protocolState: protocolStatePda,
            priceUpdate: SOL_180_FRESH_PK,
            market: ghostPda,
          })
          .rpc();
        assert.fail("Should have thrown — market does not exist");
      } catch (err: any) {
        assert.ok(err, "anchor must reject the call");
      }
    });
  });
});
