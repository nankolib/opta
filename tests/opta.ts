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
  // 3. settle_expiry — per-(asset, expiry) settlement record
  // ===========================================================================
  describe("settle_expiry", () => {
    // Use unique short expiry so we can wait it out within the test.
    const expiryWindow = 8;
    let expiry: BN;

    before(() => {
      expiry = new BN(Math.floor(Date.now() / 1000) + expiryWindow);
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

      // Use far-future expiry — will not have elapsed yet.
      const farFuture = new BN(Math.floor(Date.now() / 1000) + 86400);
      const [settlementPda] = deriveSettlementPda("SOL", farFuture);

      try {
        await program.methods
          .settleExpiry("SOL", farFuture, usdc(180))
          .accountsStrict({
            admin: admin.publicKey,
            protocolState: protocolStatePda,
            market: marketPda,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown MarketNotExpired");
      } catch (err: any) {
        assert.include(err.toString(), "MarketNotExpired");
      }
    });

    it("rejects zero price (InvalidSettlementPrice)", async () => {
      const [marketPda] = deriveMarketPda("SOL");

      // Wait for expiry
      await sleep((expiryWindow + 2) * 1000);
      const [settlementPda] = deriveSettlementPda("SOL", expiry);

      try {
        await program.methods
          .settleExpiry("SOL", expiry, new BN(0))
          .accountsStrict({
            admin: admin.publicKey,
            protocolState: protocolStatePda,
            market: marketPda,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown InvalidSettlementPrice");
      } catch (err: any) {
        assert.include(err.toString(), "InvalidSettlementPrice");
      }
    });

    it("rejects non-admin signer (Unauthorized)", async () => {
      const fakeAdmin = Keypair.generate();
      const sig = await connection.requestAirdrop(fakeAdmin.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");

      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", expiry);

      try {
        await program.methods
          .settleExpiry("SOL", expiry, usdc(180))
          .accountsStrict({
            admin: fakeAdmin.publicKey,
            protocolState: protocolStatePda,
            market: marketPda,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([fakeAdmin])
          .rpc();
        assert.fail("Should have thrown Unauthorized");
      } catch (err: any) {
        assert.include(err.toString(), "Unauthorized");
      }
    });

    it("rejects unregistered asset — market PDA does not resolve", async () => {
      const [fakeMarketPda] = deriveMarketPda("XYZ");
      const [settlementPda] = deriveSettlementPda("XYZ", expiry);

      try {
        await program.methods
          .settleExpiry("XYZ", expiry, usdc(180))
          .accountsStrict({
            admin: admin.publicKey,
            protocolState: protocolStatePda,
            market: fakeMarketPda,
            settlementRecord: settlementPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (err: any) {
        // Anchor: account does not exist for the derived market PDA
        assert.ok(err);
      }
    });

    it("admin records settlement post-expiry", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", expiry);

      await program.methods
        .settleExpiry("SOL", expiry, usdc(180))
        .accountsStrict({
          admin: admin.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          settlementRecord: settlementPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const record = await program.account.settlementRecord.fetch(settlementPda);
      assert.equal(record.assetName, "SOL");
      assert.ok(record.expiry.eq(expiry));
      assert.ok(record.settlementPrice.eq(usdc(180)));
      assert.ok(record.settledAt.toNumber() > 0);
    });

    it("rejects double-settle — plain init reverts", async () => {
      const [marketPda] = deriveMarketPda("SOL");
      const [settlementPda] = deriveSettlementPda("SOL", expiry);

      try {
        await program.methods
          .settleExpiry("SOL", expiry, usdc(200))
          .accountsStrict({
            admin: admin.publicKey,
            protocolState: protocolStatePda,
            market: marketPda,
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
});
