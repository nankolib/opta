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

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    it("registers SOL with admin signer", async () => {
      const [marketPda] = deriveMarketPda("SOL");

      await program.methods
        .createMarket("SOL", SOL_ID, 0)
        .accountsStrict({
          creator: admin.publicKey,
          protocolState: protocolStatePda,
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
        .createMarket("SOL", SOL_ID, 0)
        .accountsStrict({
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "SOL");
      assert.deepEqual(Array.from(market.pythFeedId), SOL_ID);
    });

    it("idempotent re-call with different feed reverts AssetMismatch", async () => {
      const [marketPda] = deriveMarketPda("SOL");

      try {
        await program.methods
          .createMarket("SOL", BTC_ID, 0)  // wrong feed for SOL
          .accountsStrict({
            creator: admin.publicKey,
            protocolState: protocolStatePda,
            market: marketPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown AssetMismatch");
      } catch (err: any) {
        assert.include(err.toString(), "AssetMismatch");
      }
    });

    it("registers a second asset (BTC)", async () => {
      const [marketPda] = deriveMarketPda("BTC");

      await program.methods
        .createMarket("BTC", BTC_ID, 0)
        .accountsStrict({
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "BTC");
      assert.deepEqual(Array.from(market.pythFeedId), BTC_ID);
    });

    it("anyone can create a market — permissionless", async () => {
      // Stage 2-amend-lite: create_market is permissionless. Use a fresh
      // (non-admin) keypair, an asset name not used elsewhere in tests
      // ("TEST"), and SystemProgram as a stand-in pyth_feed pubkey to
      // make explicit "this is opaque, not validated".
      const randomUser = Keypair.generate();
      const sig = await connection.requestAirdrop(randomUser.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");

      const [marketPda] = deriveMarketPda("TEST");

      await program.methods
        .createMarket("TEST", ZERO_ID, 0)
        .accountsStrict({
          creator: randomUser.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([randomUser])
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "TEST");
      assert.deepEqual(Array.from(market.pythFeedId), ZERO_ID);
      assert.equal(market.assetClass, 0);
    });

    it("rejects lowercase asset name (InvalidAssetName)", async () => {
      const [marketPda] = deriveMarketPda("sol");

      try {
        await program.methods
          .createMarket("sol", SOL_ID, 0)
          .accountsStrict({
            creator: admin.publicKey,
            protocolState: protocolStatePda,
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
          .createMarket("", SOL_ID, 0)
          .accountsStrict({
            creator: admin.publicKey,
            protocolState: protocolStatePda,
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
  describe("settle_expiry", () => {
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
        .createMarket("SOL", SOL_ID, 0)
        .accountsStrict({
          creator: admin.publicKey, protocolState: protocolStatePda,
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

    it("rejects stale PriceUpdateV2 (PriceTooOld)", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", staleExpiry);

      try {
        await program.methods
          .settleExpiry("SOL", staleExpiry)
          .accountsStrict({
            caller: admin.publicKey,
            market: marketPda,
            priceUpdate: SOL_STALE_PK,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown PriceTooOld");
      } catch (err: any) {
        assert.include(err.toString(), "PriceTooOld");
      }
    });

    it("rejects wrong-feed PriceUpdateV2 (MismatchedFeedId)", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", wrongFeedExpiry);

      try {
        await program.methods
          .settleExpiry("SOL", wrongFeedExpiry)
          .accountsStrict({
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
  // 4. migrate_pyth_feed — admin-only feed_id rotation
  // ===========================================================================
  // Uses BTC (not SOL) for the happy-path mutation: SOL has many downstream
  // consumers across this file and zzz-audit-fixes.ts that depend on its
  // current feed_id matching the SOL fixtures. BTC has no downstream
  // consumers post-create_market, so rotating it is a safe isolated test.
  describe("migrate_pyth_feed", () => {
    // A new 32-byte feed_id we rotate BTC to. Non-zero, distinguishable
    // from the original BTC mainnet feed_id so we can assert the swap.
    const NEW_BTC_ID: number[] = Array.from(
      Buffer.from("0".repeat(63) + "1", "hex"), // 32 bytes ending in 0x01
    );

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
          .migratePythFeed("BTC", BTC_ID) // any feed_id; gate triggers first
          .accountsStrict({
            admin: fakeAdmin.publicKey,
            protocolState: protocolStatePda,
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
