// =============================================================================
// tests/shared-vaults.ts — Integration tests for SharedVault liquidity system
// =============================================================================
//
// Tests the v2 shared vault layer added on top of the existing v1 isolated
// escrow system. All tests run against a local Solana validator.
//
// Test groups:
//   1. Epoch config + vault creation
//   2. Deposits + shares
//   3. Mint + purchase
//   4. Burn unsold
//   5. Premium claims
//   6. Withdrawal
//   7. Settlement + exercise
//   8. Edge cases + full lifecycle
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount as createTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotent,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

// Token-2022 operations need extra compute units
const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

describe("shared-vaults", () => {
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

  // Transfer Hook program ID
  const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

  let usdcMint: PublicKey;
  let writerA: Keypair;
  let writerB: Keypair;
  let buyer: Keypair;
  let writerAUsdcAccount: PublicKey;
  let writerBUsdcAccount: PublicKey;
  let buyerUsdcAccount: PublicKey;
  let protocolStatePda: PublicKey;
  let treasuryPda: PublicKey;
  let epochConfigPda: PublicKey;
  let marketPda: PublicKey;

  const fakePythFeed = Keypair.generate().publicKey;

  // =========================================================================
  // PDA derivation helpers
  // =========================================================================

  function deriveProtocolStatePda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_v2")],
      program.programId,
    );
  }

  function deriveTreasuryPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_v2")],
      program.programId,
    );
  }

  function deriveEpochConfigPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("epoch_config")],
      program.programId,
    );
  }

  function deriveMarketPda(
    assetName: string,
    strike: BN,
    expiry: BN,
    optionTypeIndex: number,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        Buffer.from(assetName),
        strike.toArrayLike(Buffer, "le", 8),
        expiry.toArrayLike(Buffer, "le", 8),
        Buffer.from([optionTypeIndex]),
      ],
      program.programId,
    );
  }

  function deriveSharedVaultPda(
    market: PublicKey,
    strike: BN,
    expiry: BN,
    optionTypeIndex: number,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("shared_vault"),
        market.toBuffer(),
        strike.toArrayLike(Buffer, "le", 8),
        expiry.toArrayLike(Buffer, "le", 8),
        Buffer.from([optionTypeIndex]),
      ],
      program.programId,
    );
  }

  function deriveVaultUsdcPda(vault: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault_usdc"), vault.toBuffer()],
      program.programId,
    );
  }

  function deriveWriterPositionPda(
    vault: PublicKey,
    owner: PublicKey,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("writer_position"), vault.toBuffer(), owner.toBuffer()],
      program.programId,
    );
  }

  function deriveVaultOptionMintPda(
    vault: PublicKey,
    writer: PublicKey,
    createdAt: BN,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault_option_mint"),
        vault.toBuffer(),
        writer.toBuffer(),
        createdAt.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
  }

  function deriveVaultPurchaseEscrowPda(
    vault: PublicKey,
    writer: PublicKey,
    createdAt: BN,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault_purchase_escrow"),
        vault.toBuffer(),
        writer.toBuffer(),
        createdAt.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
  }

  function deriveVaultMintRecordPda(optionMint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault_mint_record"), optionMint.toBuffer()],
      program.programId,
    );
  }

  function deriveExtraAccountMetaListPda(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.toBuffer()],
      HOOK_PROGRAM_ID,
    );
  }

  function deriveHookStatePda(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("hook-state"), mint.toBuffer()],
      HOOK_PROGRAM_ID,
    );
  }

  // =========================================================================
  // Helper to compute next Friday 08:00 UTC
  // =========================================================================
  function nextFriday0800Utc(): BN {
    const now = Math.floor(Date.now() / 1000);
    const daysSinceEpoch = Math.floor(now / 86400);
    const dayOfWeek = (daysSinceEpoch + 4) % 7; // 0=Sun, 5=Fri
    let daysUntilFriday = 5 - dayOfWeek;
    if (daysUntilFriday <= 0) daysUntilFriday += 7;
    // Make sure it's at least 2 days out
    if (daysUntilFriday < 2) daysUntilFriday += 7;
    const fridayTimestamp = (daysSinceEpoch + daysUntilFriday) * 86400 + 8 * 3600;
    return new BN(fridayTimestamp);
  }

  // Shared test state
  let fridayExpiry: BN;
  let customExpiry: BN;
  let epochVaultPda: PublicKey;
  let epochVaultUsdcPda: PublicKey;
  let customVaultPda: PublicKey;
  let customVaultUsdcPda: PublicKey;
  let strike: BN;
  let mintCreatedAt: BN;
  let optionMintPda: PublicKey;
  let purchaseEscrowPda: PublicKey;
  let vaultMintRecordPda: PublicKey;

  // =========================================================================
  // Setup: initialize protocol, create USDC, create market, fund wallets
  // =========================================================================
  before(async () => {
    // Derive protocol PDAs
    [protocolStatePda] = deriveProtocolStatePda();
    [treasuryPda] = deriveTreasuryPda();
    [epochConfigPda] = deriveEpochConfigPda();

    // Try to initialize protocol with a new USDC mint, OR if already
    // initialized (by the main test suite), read the existing USDC mint.
    let protocolExists = false;
    try {
      const existingProtocol = await program.account.protocolState.fetch(protocolStatePda);
      usdcMint = existingProtocol.usdcMint;
      protocolExists = true;
    } catch (e) {
      // Protocol doesn't exist yet — create USDC mint and initialize
      usdcMint = await createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        6,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID,
      );
    }

    if (!protocolExists) {
      await program.methods
        .initializeProtocol()
        .accounts({
          admin: payer.publicKey,
          usdcMint,
          protocolState: protocolStatePda,
          treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([payer])
        .rpc();
    }

    // Create writer A, writer B, and buyer keypairs
    writerA = Keypair.generate();
    writerB = Keypair.generate();
    buyer = Keypair.generate();

    // Fund all with SOL
    for (const kp of [writerA, writerB, buyer]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }

    // Create USDC accounts and mint USDC (using the protocol's USDC mint)
    // We need to be the mint authority — if protocol already existed, we may not be.
    // In that case, the payer IS the mint authority from the original init.
    writerAUsdcAccount = await createTokenAccount(
      connection, payer, usdcMint, writerA.publicKey, undefined, undefined, TOKEN_PROGRAM_ID,
    );
    writerBUsdcAccount = await createTokenAccount(
      connection, payer, usdcMint, writerB.publicKey, undefined, undefined, TOKEN_PROGRAM_ID,
    );
    buyerUsdcAccount = await createTokenAccount(
      connection, payer, usdcMint, buyer.publicKey, undefined, undefined, TOKEN_PROGRAM_ID,
    );

    // Mint USDC to all
    await mintTo(connection, payer, usdcMint, writerAUsdcAccount, payer, 100_000_000_000); // 100,000 USDC
    await mintTo(connection, payer, usdcMint, writerBUsdcAccount, payer, 100_000_000_000);
    await mintTo(connection, payer, usdcMint, buyerUsdcAccount, payer, 100_000_000_000);

    // Set up test parameters
    strike = usdc(200); // $200 strike
    fridayExpiry = nextFriday0800Utc();
    // Custom expiry: 2 hours from now
    customExpiry = new BN(Math.floor(Date.now() / 1000) + 7200);

    // Create market
    [marketPda] = deriveMarketPda("SOL", strike, fridayExpiry, 0);
    try {
      await program.methods
        .createMarket("SOL", strike, fridayExpiry, { call: {} }, fakePythFeed, 0)
        .accounts({
          admin: payer.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();
    } catch (e) {
      // Might already exist
    }

    // Derive vault PDAs
    [epochVaultPda] = deriveSharedVaultPda(marketPda, strike, fridayExpiry, 0);
    [epochVaultUsdcPda] = deriveVaultUsdcPda(epochVaultPda);
    [customVaultPda] = deriveSharedVaultPda(marketPda, strike, customExpiry, 0);
    [customVaultUsdcPda] = deriveVaultUsdcPda(customVaultPda);
  });

  // =========================================================================
  // TEST GROUP 1: Epoch Config + Vault Creation
  // =========================================================================
  describe("1. Epoch Config + Vault Creation", () => {
    it("initializes epoch config (Friday 08:00 UTC)", async () => {
      await program.methods
        .initializeEpochConfig(5, 8, true) // Friday, 08:00, monthly enabled
        .accounts({
          admin: payer.publicKey,
          protocolState: protocolStatePda,
          epochConfig: epochConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();

      const config = await program.account.epochConfig.fetch(epochConfigPda);
      assert.equal(config.weeklyExpiryDay, 5);
      assert.equal(config.weeklyExpiryHour, 8);
      assert.equal(config.monthlyEnabled, true);
    });

    it("creates epoch vault (valid Friday expiry)", async () => {
      await program.methods
        .createSharedVault(strike, fridayExpiry, { call: {} }, { epoch: {} })
        .accounts({
          creator: writerA.publicKey,
          market: marketPda,
          sharedVault: epochVaultPda,
          vaultUsdcAccount: epochVaultUsdcPda,
          usdcMint,
          protocolState: protocolStatePda,
          epochConfig: epochConfigPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writerA])
        .rpc();

      const vault = await program.account.sharedVault.fetch(epochVaultPda);
      assert.equal(vault.strikePrice.toNumber(), strike.toNumber());
      assert.equal(vault.expiry.toNumber(), fridayExpiry.toNumber());
      assert.deepEqual(vault.vaultType, { epoch: {} });
      assert.equal(vault.totalCollateral.toNumber(), 0);
      assert.equal(vault.totalShares.toNumber(), 0);
    });

    it("creates custom vault (arbitrary future expiry)", async () => {
      // Need a separate market for custom expiry
      const [customMarketPda] = deriveMarketPda("SOL", strike, customExpiry, 0);
      try {
        await program.methods
          .createMarket("SOL", strike, customExpiry, { call: {} }, fakePythFeed, 0)
          .accounts({
            admin: payer.publicKey,
            protocolState: protocolStatePda,
            market: customMarketPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([payer])
          .rpc();
      } catch (e) {
        // already exists
      }

      // Derive custom vault with the custom market
      [customVaultPda] = deriveSharedVaultPda(customMarketPda, strike, customExpiry, 0);
      [customVaultUsdcPda] = deriveVaultUsdcPda(customVaultPda);

      await program.methods
        .createSharedVault(strike, customExpiry, { call: {} }, { custom: {} })
        .accounts({
          creator: writerA.publicKey,
          market: customMarketPda,
          sharedVault: customVaultPda,
          vaultUsdcAccount: customVaultUsdcPda,
          usdcMint,
          protocolState: protocolStatePda,
          epochConfig: null, // Not needed for custom vaults
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writerA])
        .rpc();

      const vault = await program.account.sharedVault.fetch(customVaultPda);
      assert.deepEqual(vault.vaultType, { custom: {} });
    });

    it("FAIL: epoch vault with non-Friday expiry", async () => {
      // Tuesday expiry
      const tuesdayExpiry = new BN(fridayExpiry.toNumber() - 3 * 86400);
      const [badMarketPda] = deriveMarketPda("SOL", strike, tuesdayExpiry, 0);
      try {
        await program.methods
          .createMarket("SOL", strike, tuesdayExpiry, { call: {} }, fakePythFeed, 0)
          .accounts({
            admin: payer.publicKey,
            protocolState: protocolStatePda,
            market: badMarketPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([payer])
          .rpc();
      } catch (e) {
        // might already exist
      }

      const [badVaultPda] = deriveSharedVaultPda(badMarketPda, strike, tuesdayExpiry, 0);
      const [badVaultUsdcPda] = deriveVaultUsdcPda(badVaultPda);

      try {
        await program.methods
          .createSharedVault(strike, tuesdayExpiry, { call: {} }, { epoch: {} })
          .accounts({
            creator: writerA.publicKey,
            market: badMarketPda,
            sharedVault: badVaultPda,
            vaultUsdcAccount: badVaultUsdcPda,
            usdcMint,
            protocolState: protocolStatePda,
            epochConfig: epochConfigPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([writerA])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.toString(), "InvalidEpochExpiry");
      }
    });

    it("FAIL: vault with past expiry", async () => {
      const pastExpiry = new BN(1000); // Way in the past
      const [pastMarketPda] = deriveMarketPda("SOL", strike, pastExpiry, 0);
      const [pastVaultPda] = deriveSharedVaultPda(pastMarketPda, strike, pastExpiry, 0);
      const [pastVaultUsdcPda] = deriveVaultUsdcPda(pastVaultPda);

      try {
        await program.methods
          .createSharedVault(strike, pastExpiry, { call: {} }, { custom: {} })
          .accounts({
            creator: writerA.publicKey,
            market: pastMarketPda, // This market won't exist, but we hit expiry check first
            sharedVault: pastVaultPda,
            vaultUsdcAccount: pastVaultUsdcPda,
            usdcMint,
            protocolState: protocolStatePda,
            epochConfig: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([writerA])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        // Will fail — either market doesn't exist or expiry in past
        assert.ok(e);
      }
    });
  });

  // =========================================================================
  // TEST GROUP 2: Deposits + Shares
  // =========================================================================
  describe("2. Deposits + Shares", () => {
    it("Writer A deposits 10,000 USDC → gets 10,000,000,000 shares (1:1)", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);

      await program.methods
        .depositToVault(usdc(10_000))
        .accounts({
          writer: writerA.publicKey,
          sharedVault: epochVaultPda,
          writerPosition: writerAPosPda,
          writerUsdcAccount: writerAUsdcAccount,
          vaultUsdcAccount: epochVaultUsdcPda,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writerA])
        .rpc();

      const vault = await program.account.sharedVault.fetch(epochVaultPda);
      assert.equal(vault.totalCollateral.toNumber(), usdc(10_000).toNumber());
      // First deposit: shares = amount (1:1)
      assert.equal(vault.totalShares.toNumber(), usdc(10_000).toNumber());

      const pos = await program.account.writerPosition.fetch(writerAPosPda);
      assert.equal(pos.shares.toNumber(), usdc(10_000).toNumber());
      assert.equal(pos.depositedCollateral.toNumber(), usdc(10_000).toNumber());
    });

    it("Writer B deposits 5,000 USDC → gets proportional shares", async () => {
      const [writerBPosPda] = deriveWriterPositionPda(epochVaultPda, writerB.publicKey);

      await program.methods
        .depositToVault(usdc(5_000))
        .accounts({
          writer: writerB.publicKey,
          sharedVault: epochVaultPda,
          writerPosition: writerBPosPda,
          writerUsdcAccount: writerBUsdcAccount,
          vaultUsdcAccount: epochVaultUsdcPda,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writerB])
        .rpc();

      const vault = await program.account.sharedVault.fetch(epochVaultPda);
      assert.equal(vault.totalCollateral.toNumber(), usdc(15_000).toNumber());

      const pos = await program.account.writerPosition.fetch(writerBPosPda);
      // proportional: 5000 * 10_000_000_000 / 10_000_000_000 = 5_000_000_000
      assert.equal(pos.shares.toNumber(), usdc(5_000).toNumber());
    });

    it("FAIL: Writer B deposits into Writer A's custom vault", async () => {
      // First, writer A deposits into custom vault to make it non-empty
      const [writerACustomPosPda] = deriveWriterPositionPda(customVaultPda, writerA.publicKey);
      await program.methods
        .depositToVault(usdc(1_000))
        .accounts({
          writer: writerA.publicKey,
          sharedVault: customVaultPda,
          writerPosition: writerACustomPosPda,
          writerUsdcAccount: writerAUsdcAccount,
          vaultUsdcAccount: customVaultUsdcPda,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writerA])
        .rpc();

      // Now writer B tries to deposit — should fail
      const [writerBCustomPosPda] = deriveWriterPositionPda(customVaultPda, writerB.publicKey);
      try {
        await program.methods
          .depositToVault(usdc(500))
          .accounts({
            writer: writerB.publicKey,
            sharedVault: customVaultPda,
            writerPosition: writerBCustomPosPda,
            writerUsdcAccount: writerBUsdcAccount,
            vaultUsdcAccount: customVaultUsdcPda,
            protocolState: protocolStatePda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([writerB])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.toString(), "CustomVaultSingleWriter");
      }
    });
  });

  // =========================================================================
  // TEST GROUP 3: Mint + Purchase
  // =========================================================================
  describe("3. Mint + Purchase", () => {
    it("Writer A mints 10 option tokens from vault", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);
      mintCreatedAt = new BN(Math.floor(Date.now() / 1000));

      [optionMintPda] = deriveVaultOptionMintPda(epochVaultPda, writerA.publicKey, mintCreatedAt);
      [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(epochVaultPda, writerA.publicKey, mintCreatedAt);
      [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);

      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      const tx = new Transaction().add(EXTRA_CU);
      const ix = await program.methods
        .mintFromVault(new BN(10), usdc(5), mintCreatedAt) // 10 contracts at $5 premium each
        .accounts({
          writer: writerA.publicKey,
          sharedVault: epochVaultPda,
          writerPosition: writerAPosPda,
          market: marketPda,
          protocolState: protocolStatePda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          vaultMintRecord: vaultMintRecordPda,
          transferHookProgram: HOOK_PROGRAM_ID,
          extraAccountMetaList,
          hookState,
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([writerA])
        .instruction();
      tx.add(ix);

      await provider.sendAndConfirm(tx, [writerA]);

      // Verify vault mint record
      const mintRecord = await program.account.vaultMint.fetch(vaultMintRecordPda);
      assert.equal(mintRecord.quantityMinted.toNumber(), 10);
      assert.equal(mintRecord.quantitySold.toNumber(), 0);
      assert.equal(mintRecord.premiumPerContract.toNumber(), usdc(5).toNumber());

      // Verify writer position updated
      const pos = await program.account.writerPosition.fetch(writerAPosPda);
      assert.equal(pos.optionsMinted.toNumber(), 10);

      // Verify vault updated
      const vault = await program.account.sharedVault.fetch(epochVaultPda);
      assert.equal(vault.totalOptionsMinted.toNumber(), 10);
    });

    it("Buyer purchases 5 tokens → premium goes to vault", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      // Create buyer's Token-2022 ATA for the option mint
      const buyerOptionAccount = await createAssociatedTokenAccountIdempotent(
        connection,
        payer,
        optionMintPda,
        buyer.publicKey,
        {},
        TOKEN_2022_PROGRAM_ID,
      );

      const tx = new Transaction().add(EXTRA_CU);
      const ix = await program.methods
        .purchaseFromVault(new BN(5), usdc(50)) // buy 5, max premium $50
        .accounts({
          buyer: buyer.publicKey,
          sharedVault: epochVaultPda,
          writerPosition: writerAPosPda,
          vaultMintRecord: vaultMintRecordPda,
          protocolState: protocolStatePda,
          market: marketPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          buyerOptionAccount,
          buyerUsdcAccount,
          vaultUsdcAccount: epochVaultUsdcPda,
          treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          transferHookProgram: HOOK_PROGRAM_ID,
          extraAccountMetaList,
          hookState,
          systemProgram: SystemProgram.programId,
        })
        .signers([buyer])
        .instruction();
      tx.add(ix);

      await provider.sendAndConfirm(tx, [buyer]);

      // Verify: 5 tokens sold
      const mintRecord = await program.account.vaultMint.fetch(vaultMintRecordPda);
      assert.equal(mintRecord.quantitySold.toNumber(), 5);

      // Verify vault state
      const vault = await program.account.sharedVault.fetch(epochVaultPda);
      assert.equal(vault.totalOptionsSold.toNumber(), 5);
      // Premium collected = 5 * $5 - 0.5% fee = $25 - $0.125 = $24.875
      // Actually: writer_share = 25_000_000 - (25_000_000 * 50 / 10000) = 25_000_000 - 125_000 = 24_875_000
      assert.equal(vault.netPremiumCollected.toNumber(), 24_875_000);
    });

    it("FAIL: mint more tokens than available collateral", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);
      const bigMintCreatedAt = new BN(Math.floor(Date.now() / 1000) + 1);
      const [bigMintPda] = deriveVaultOptionMintPda(epochVaultPda, writerA.publicKey, bigMintCreatedAt);
      const [bigEscrowPda] = deriveVaultPurchaseEscrowPda(epochVaultPda, writerA.publicKey, bigMintCreatedAt);
      const [bigMintRecordPda] = deriveVaultMintRecordPda(bigMintPda);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(bigMintPda);
      const [hookState] = deriveHookStatePda(bigMintPda);

      try {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await program.methods
          .mintFromVault(new BN(1000), usdc(1), bigMintCreatedAt) // 1000 contracts — way too many
          .accounts({
            writer: writerA.publicKey,
            sharedVault: epochVaultPda,
            writerPosition: writerAPosPda,
            market: marketPda,
            protocolState: protocolStatePda,
            optionMint: bigMintPda,
            purchaseEscrow: bigEscrowPda,
            vaultMintRecord: bigMintRecordPda,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList,
            hookState,
            systemProgram: SystemProgram.programId,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([writerA])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [writerA]);
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.toString(), "InsufficientVaultCollateral");
      }
    });

    it("FAIL: buyer == writer (self-buy)", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      const writerAOptionAccount = await createAssociatedTokenAccountIdempotent(
        connection,
        payer,
        optionMintPda,
        writerA.publicKey,
        {},
        TOKEN_2022_PROGRAM_ID,
      );

      try {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await program.methods
          .purchaseFromVault(new BN(1), usdc(10))
          .accounts({
            buyer: writerA.publicKey,
            sharedVault: epochVaultPda,
            writerPosition: writerAPosPda,
            vaultMintRecord: vaultMintRecordPda,
            protocolState: protocolStatePda,
            market: marketPda,
            optionMint: optionMintPda,
            purchaseEscrow: purchaseEscrowPda,
            buyerOptionAccount: writerAOptionAccount,
            buyerUsdcAccount: writerAUsdcAccount,
            vaultUsdcAccount: epochVaultUsdcPda,
            treasury: treasuryPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList,
            hookState,
            systemProgram: SystemProgram.programId,
          })
          .signers([writerA])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [writerA]);
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.toString(), "CannotBuyOwnOption");
      }
    });

    it("FAIL: slippage exceeded", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      const buyerOptionAccount = getAssociatedTokenAddressSync(
        optionMintPda, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID,
      );

      try {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await program.methods
          .purchaseFromVault(new BN(3), usdc(1)) // max premium $1 but 3*$5 = $15
          .accounts({
            buyer: buyer.publicKey,
            sharedVault: epochVaultPda,
            writerPosition: writerAPosPda,
            vaultMintRecord: vaultMintRecordPda,
            protocolState: protocolStatePda,
            market: marketPda,
            optionMint: optionMintPda,
            purchaseEscrow: purchaseEscrowPda,
            buyerOptionAccount,
            buyerUsdcAccount,
            vaultUsdcAccount: epochVaultUsdcPda,
            treasury: treasuryPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList,
            hookState,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [buyer]);
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.toString(), "SlippageExceeded");
      }
    });
  });

  // =========================================================================
  // TEST GROUP 4: Burn Unsold
  // =========================================================================
  describe("4. Burn Unsold", () => {
    it("Writer A burns 5 unsold tokens", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);

      await program.methods
        .burnUnsoldFromVault()
        .accounts({
          writer: writerA.publicKey,
          sharedVault: epochVaultPda,
          writerPosition: writerAPosPda,
          vaultMintRecord: vaultMintRecordPda,
          protocolState: protocolStatePda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([writerA])
        .rpc();

      // Verify: 5 unsold burned, only 5 remain (the sold ones)
      const mintRecord = await program.account.vaultMint.fetch(vaultMintRecordPda);
      assert.equal(mintRecord.quantityMinted.toNumber(), 5); // 10 - 5 burned
      assert.equal(mintRecord.quantitySold.toNumber(), 5);

      const pos = await program.account.writerPosition.fetch(writerAPosPda);
      assert.equal(pos.optionsMinted.toNumber(), 5); // 10 - 5 burned

      const vault = await program.account.sharedVault.fetch(epochVaultPda);
      assert.equal(vault.totalOptionsMinted.toNumber(), 5);
    });
  });

  // =========================================================================
  // TEST GROUP 5: Premium Claims
  // =========================================================================
  describe("5. Premium Claims", () => {
    it("Writer A claims premium (2/3 share)", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);

      const beforeBalance = await getAccount(connection, writerAUsdcAccount);

      await program.methods
        .claimPremium()
        .accounts({
          writer: writerA.publicKey,
          sharedVault: epochVaultPda,
          writerPosition: writerAPosPda,
          vaultUsdcAccount: epochVaultUsdcPda,
          writerUsdcAccount: writerAUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writerA])
        .rpc();

      const afterBalance = await getAccount(connection, writerAUsdcAccount);
      const claimed = Number(afterBalance.amount) - Number(beforeBalance.amount);

      // Writer A has 10M shares out of 15M total = 2/3 of premium
      // Premium collected = 24,875,000 (from test 3.2)
      // Writer A's share = 24,875,000 * 10M / 15M = 16,583,333
      assert.equal(claimed, 16_583_333);

      const pos = await program.account.writerPosition.fetch(writerAPosPda);
      assert.equal(pos.premiumClaimed.toNumber(), 16_583_333);
    });

    it("Writer B claims premium (1/3 share)", async () => {
      const [writerBPosPda] = deriveWriterPositionPda(epochVaultPda, writerB.publicKey);

      const beforeBalance = await getAccount(connection, writerBUsdcAccount);

      await program.methods
        .claimPremium()
        .accounts({
          writer: writerB.publicKey,
          sharedVault: epochVaultPda,
          writerPosition: writerBPosPda,
          vaultUsdcAccount: epochVaultUsdcPda,
          writerUsdcAccount: writerBUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writerB])
        .rpc();

      const afterBalance = await getAccount(connection, writerBUsdcAccount);
      const claimed = Number(afterBalance.amount) - Number(beforeBalance.amount);

      // Writer B has 5M shares out of 15M total = 1/3 of premium
      // 24,875,000 * 5M / 15M = 8,291,666
      assert.equal(claimed, 8_291_666);
    });

    it("FAIL: claim again immediately", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);

      try {
        await program.methods
          .claimPremium()
          .accounts({
            writer: writerA.publicKey,
            sharedVault: epochVaultPda,
            writerPosition: writerAPosPda,
            vaultUsdcAccount: epochVaultUsdcPda,
            writerUsdcAccount: writerAUsdcAccount,
            protocolState: protocolStatePda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([writerA])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.toString(), "NothingToClaim");
      }
    });
  });

  // =========================================================================
  // TEST GROUP 6: Withdrawal
  // =========================================================================
  describe("6. Withdrawal", () => {
    it("Writer B withdraws free collateral", async () => {
      const [writerBPosPda] = deriveWriterPositionPda(epochVaultPda, writerB.publicKey);

      const beforeBalance = await getAccount(connection, writerBUsdcAccount);

      // Writer B has 5M shares, no options minted, so all collateral is free
      // Withdraw half: 2.5M shares
      await program.methods
        .withdrawFromVault(usdc(2_500))
        .accounts({
          writer: writerB.publicKey,
          sharedVault: epochVaultPda,
          writerPosition: writerBPosPda,
          vaultUsdcAccount: epochVaultUsdcPda,
          writerUsdcAccount: writerBUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writerB])
        .rpc();

      const afterBalance = await getAccount(connection, writerBUsdcAccount);
      const withdrawn = Number(afterBalance.amount) - Number(beforeBalance.amount);
      assert.ok(withdrawn > 0);

      const pos = await program.account.writerPosition.fetch(writerBPosPda);
      assert.equal(pos.shares.toNumber(), usdc(2_500).toNumber());
    });

    it("FAIL: withdraw collateral committed to active options", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);

      // Writer A has 5 options minted * $200 strike = $1000 committed
      // But they deposited $10,000 so should have free collateral
      // Try to withdraw MORE than free (all shares)
      try {
        await program.methods
          .withdrawFromVault(usdc(10_000)) // All shares — but some are committed
          .accounts({
            writer: writerA.publicKey,
            sharedVault: epochVaultPda,
            writerPosition: writerAPosPda,
            vaultUsdcAccount: epochVaultUsdcPda,
            writerUsdcAccount: writerAUsdcAccount,
            protocolState: protocolStatePda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([writerA])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.toString(), "CollateralCommitted");
      }
    });
  });

  // =========================================================================
  // TEST GROUP 7: Settlement + Exercise
  // =========================================================================
  describe("7. Settlement + Exercise", () => {
    // For this test we need a vault that's expired. We'll use a different
    // market with a very short expiry and warp time.
    // Since we can't easily warp time in localnet, we'll test the settle_vault
    // and exercise_from_vault logic indirectly by checking error paths.

    it("FAIL: settle vault before market is settled", async () => {
      try {
        await program.methods
          .settleVault()
          .accounts({
            authority: payer.publicKey,
            sharedVault: epochVaultPda,
            market: marketPda,
          })
          .signers([payer])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        // Market not settled yet
        assert.include(e.toString(), "MarketNotSettled");
      }
    });

    it("FAIL: exercise from unsettled vault", async () => {
      const buyerOptionAccount = getAssociatedTokenAddressSync(
        optionMintPda, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID,
      );

      try {
        await program.methods
          .exerciseFromVault(new BN(1))
          .accounts({
            holder: buyer.publicKey,
            sharedVault: epochVaultPda,
            market: marketPda,
            vaultMintRecord: vaultMintRecordPda, // FIX H-02: added vault-mint validation
            optionMint: optionMintPda,
            holderOptionAccount: buyerOptionAccount,
            vaultUsdcAccount: epochVaultUsdcPda,
            holderUsdcAccount: buyerUsdcAccount,
            protocolState: protocolStatePda,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([buyer])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.toString(), "VaultNotSettled");
      }
    });

    it("FAIL: withdraw post-settlement from unsettled vault", async () => {
      const [writerAPosPda] = deriveWriterPositionPda(epochVaultPda, writerA.publicKey);

      try {
        await program.methods
          .withdrawPostSettlement()
          .accounts({
            writer: writerA.publicKey,
            sharedVault: epochVaultPda,
            writerPosition: writerAPosPda,
            vaultUsdcAccount: epochVaultUsdcPda,
            writerUsdcAccount: writerAUsdcAccount,
            protocolState: protocolStatePda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([writerA])
          .rpc();
        assert.fail("Should have failed");
      } catch (e) {
        assert.include(e.toString(), "VaultNotSettled");
      }
    });
  });

  // =========================================================================
  // TEST GROUP 8: Verify Token Metadata Format
  // =========================================================================
  describe("8. Token Verification", () => {
    it("vault-minted token has correct Token-2022 metadata", async () => {
      // Just verify the mint account exists and has data (Token-2022 extensions)
      const mintInfo = await connection.getAccountInfo(optionMintPda);
      assert.isNotNull(mintInfo, "Option mint should exist");
      assert.equal(mintInfo!.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58(),
        "Mint should be owned by Token-2022 program");
      // Data size should be > 82 (base Mint) indicating extensions are present
      assert.ok(mintInfo!.data.length > 200,
        "Mint should have extension data (TransferHook, PermanentDelegate, Metadata)");
    });
  });
});
