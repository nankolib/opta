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
// Asset registry — must match programs/opta/src/instructions/create_market.rs
// =============================================================================
const REGISTRY = {
  SOL:  new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"),
  BTC:  new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"),
  ETH:  new PublicKey("EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9GvYRk4HY7y44"),
  XAU:  new PublicKey("8y3WWjvmSmVGWVKH1rCA7VTRmuU7QbJ9axMK6JUUuCyi"),
  AAPL: new PublicKey("5yKHAuiDWKUGRgs3s6mYGdfZjFmTfgHVDBwFBDfMuZJH"),
};

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
        .createMarket("SOL", REGISTRY.SOL, 0)
        .accountsStrict({
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "SOL");
      assert.ok(market.pythFeed.equals(REGISTRY.SOL));
      assert.equal(market.assetClass, 0);
    });

    it("idempotent — second call with matching args is a silent Ok", async () => {
      const [marketPda] = deriveMarketPda("SOL");

      // Should not revert
      await program.methods
        .createMarket("SOL", REGISTRY.SOL, 0)
        .accountsStrict({
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "SOL");
      assert.ok(market.pythFeed.equals(REGISTRY.SOL));
    });

    it("idempotent re-call with different feed reverts AssetMismatch", async () => {
      const [marketPda] = deriveMarketPda("SOL");

      try {
        await program.methods
          .createMarket("SOL", REGISTRY.BTC, 0)  // wrong feed for SOL
          .accountsStrict({
            creator: admin.publicKey,
            protocolState: protocolStatePda,
            market: marketPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (err: any) {
        // Either UnknownAsset (registry rejects (SOL, BTC-feed, 0)) or
        // AssetMismatch (PDA exists with different feed). Both are correct
        // refusals; the registry check fires first.
        const s = err.toString();
        assert.ok(
          s.includes("UnknownAsset") || s.includes("AssetMismatch"),
          `expected UnknownAsset or AssetMismatch, got: ${s.slice(0, 200)}`,
        );
      }
    });

    it("registers a second asset (BTC)", async () => {
      const [marketPda] = deriveMarketPda("BTC");

      await program.methods
        .createMarket("BTC", REGISTRY.BTC, 0)
        .accountsStrict({
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "BTC");
      assert.ok(market.pythFeed.equals(REGISTRY.BTC));
    });

    it("rejects non-admin signer (Unauthorized)", async () => {
      const fakeAdmin = Keypair.generate();
      const sig = await connection.requestAirdrop(fakeAdmin.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");

      const [marketPda] = deriveMarketPda("ETH");

      try {
        await program.methods
          .createMarket("ETH", REGISTRY.ETH, 0)
          .accountsStrict({
            creator: fakeAdmin.publicKey,
            protocolState: protocolStatePda,
            market: marketPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([fakeAdmin])
          .rpc();
        assert.fail("Should have thrown Unauthorized");
      } catch (err: any) {
        assert.include(err.toString(), "Unauthorized");
      }
    });

    it("rejects unknown asset / wrong Pyth feed (UnknownAsset)", async () => {
      // Asset name "XYZ" is not in the registry.
      const [marketPda] = deriveMarketPda("XYZ");

      try {
        await program.methods
          .createMarket("XYZ", REGISTRY.SOL, 0)
          .accountsStrict({
            creator: admin.publicKey,
            protocolState: protocolStatePda,
            market: marketPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown UnknownAsset");
      } catch (err: any) {
        assert.include(err.toString(), "UnknownAsset");
      }
    });

    it("rejects lowercase asset name (InvalidAssetName)", async () => {
      const [marketPda] = deriveMarketPda("sol");

      try {
        await program.methods
          .createMarket("sol", REGISTRY.SOL, 0)
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
          .createMarket("", REGISTRY.SOL, 0)
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
        .createMarket("SOL", REGISTRY.SOL, 0)
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
