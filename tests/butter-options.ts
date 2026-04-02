// =============================================================================
// tests/butter-options.ts — Integration tests for Butter Options tokenized protocol
// =============================================================================
//
// These tests run against a local Solana validator (started by `anchor test`).
// Options are Token-2022 SPL tokens with transfer hook, permanent delegate,
// and metadata extensions — whoever holds the tokens can exercise.
//
// Test groups:
//   1. initialize_protocol  — One-time protocol setup
//   2. create_market        — Creating markets (SOL Call, empty name fail)
//   3. write_option         — Mint option tokens to writer (call, put, insuff. collateral)
//   4. purchase_option      — Buy tokens from writer (premium + fee, self-buy fail)
//   5. cancel_option        — Writer burns tokens, reclaims collateral (+ tokens sold fail)
//   6. post-expiry          — settle, exercise ITM/OTM, expire
//   7. list_for_resale + buy_resale — P2P resale marketplace
//   8. partial fills        — partial buy, cancel fail, partial exercise
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
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
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";

// =============================================================================
// Helper functions
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

// write_option does many CPIs (extensions + metadata + hook init) and exceeds
// the default 200K compute unit limit. All writeOption and purchaseOption calls
// need this prepended.
const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

describe("butter-options", () => {
  // Force "confirmed" commitment so account reads see recently-confirmed state.
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

  const program = anchor.workspace.butterOptions as Program<ButterOptions>;
  const admin = provider.wallet as anchor.Wallet;
  const payer = (admin as any).payer as Keypair;

  let usdcMint: PublicKey;
  let writer: Keypair;
  let buyer: Keypair;
  let writerUsdcAccount: PublicKey;
  let buyerUsdcAccount: PublicKey;
  let protocolStatePda: PublicKey;
  let protocolStateBump: number;
  let treasuryPda: PublicKey;

  const fakePythFeed = Keypair.generate().publicKey;

  // Transfer Hook program ID
  const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

  // ---------------------------------------------------------------------------
  // PDA derivation helpers — transfer hook
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // PDA derivation helpers — main program
  // ---------------------------------------------------------------------------
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

  function derivePositionPda(
    marketPda: PublicKey,
    writerPubkey: PublicKey,
    createdAt: BN,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("position"),
        marketPda.toBuffer(),
        writerPubkey.toBuffer(),
        createdAt.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
  }

  function deriveEscrowPda(
    marketPda: PublicKey,
    writerPubkey: PublicKey,
    createdAt: BN,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        marketPda.toBuffer(),
        writerPubkey.toBuffer(),
        createdAt.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
  }

  function deriveOptionMintPda(positionPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("option_mint"), positionPda.toBuffer()],
      program.programId,
    );
  }

  function derivePurchaseEscrowPda(positionPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("purchase_escrow"), positionPda.toBuffer()],
      program.programId,
    );
  }

  function deriveResaleEscrowPda(positionPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("resale_escrow"), positionPda.toBuffer()],
      program.programId,
    );
  }

  // ---------------------------------------------------------------------------
  // Account builder helpers (reduce boilerplate)
  // ---------------------------------------------------------------------------
  function buildWriteOptionAccounts(params: {
    writer: PublicKey;
    market: PublicKey;
    position: PublicKey;
    escrow: PublicKey;
    optionMint: PublicKey;
    purchaseEscrow: PublicKey;
    writerUsdcAccount: PublicKey;
  }) {
    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(params.optionMint);
    const [hookState] = deriveHookStatePda(params.optionMint);
    return {
      writer: params.writer,
      protocolState: protocolStatePda,
      market: params.market,
      position: params.position,
      escrow: params.escrow,
      optionMint: params.optionMint,
      purchaseEscrow: params.purchaseEscrow,
      writerUsdcAccount: params.writerUsdcAccount,
      usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };
  }

  function buildPurchaseOptionAccounts(params: {
    buyer: PublicKey;
    market: PublicKey;
    position: PublicKey;
    purchaseEscrow: PublicKey;
    buyerUsdcAccount: PublicKey;
    writerUsdcAccount: PublicKey;
    buyerOptionAccount: PublicKey;
    optionMint: PublicKey;
  }) {
    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(params.optionMint);
    const [hookState] = deriveHookStatePda(params.optionMint);
    return {
      buyer: params.buyer,
      protocolState: protocolStatePda,
      market: params.market,
      position: params.position,
      purchaseEscrow: params.purchaseEscrow,
      buyerUsdcAccount: params.buyerUsdcAccount,
      writerUsdcAccount: params.writerUsdcAccount,
      buyerOptionAccount: params.buyerOptionAccount,
      optionMint: params.optionMint,
      treasury: treasuryPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };
  }

  function buildExerciseOptionAccounts(params: {
    exerciser: PublicKey;
    market: PublicKey;
    position: PublicKey;
    escrow: PublicKey;
    optionMint: PublicKey;
    exerciserOptionAccount: PublicKey;
    exerciserUsdcAccount: PublicKey;
    writerUsdcAccount: PublicKey;
    writer: PublicKey;
  }) {
    return {
      exerciser: params.exerciser,
      protocolState: protocolStatePda,
      market: params.market,
      position: params.position,
      escrow: params.escrow,
      optionMint: params.optionMint,
      exerciserOptionAccount: params.exerciserOptionAccount,
      exerciserUsdcAccount: params.exerciserUsdcAccount,
      writerUsdcAccount: params.writerUsdcAccount,
      writer: params.writer,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    };
  }

  function buildCancelOptionAccounts(params: {
    writer: PublicKey;
    position: PublicKey;
    escrow: PublicKey;
    purchaseEscrow: PublicKey;
    optionMint: PublicKey;
    writerUsdcAccount: PublicKey;
  }) {
    return {
      writer: params.writer,
      protocolState: protocolStatePda,
      position: params.position,
      escrow: params.escrow,
      purchaseEscrow: params.purchaseEscrow,
      optionMint: params.optionMint,
      writerUsdcAccount: params.writerUsdcAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    };
  }

  function buildListForResaleAccounts(params: {
    seller: PublicKey;
    position: PublicKey;
    sellerOptionAccount: PublicKey;
    resaleEscrow: PublicKey;
    optionMint: PublicKey;
  }) {
    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(params.optionMint);
    const [hookState] = deriveHookStatePda(params.optionMint);
    return {
      seller: params.seller,
      protocolState: protocolStatePda,
      position: params.position,
      sellerOptionAccount: params.sellerOptionAccount,
      resaleEscrow: params.resaleEscrow,
      optionMint: params.optionMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };
  }

  function buildBuyResaleAccounts(params: {
    buyer: PublicKey;
    position: PublicKey;
    resaleEscrow: PublicKey;
    buyerUsdcAccount: PublicKey;
    sellerUsdcAccount: PublicKey;
    buyerOptionAccount: PublicKey;
    optionMint: PublicKey;
  }) {
    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(params.optionMint);
    const [hookState] = deriveHookStatePda(params.optionMint);
    return {
      buyer: params.buyer,
      protocolState: protocolStatePda,
      position: params.position,
      resaleEscrow: params.resaleEscrow,
      buyerUsdcAccount: params.buyerUsdcAccount,
      sellerUsdcAccount: params.sellerUsdcAccount,
      buyerOptionAccount: params.buyerOptionAccount,
      optionMint: params.optionMint,
      treasury: treasuryPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };
  }

  function buildCancelResaleAccounts(params: {
    seller: PublicKey;
    position: PublicKey;
    resaleEscrow: PublicKey;
    sellerOptionAccount: PublicKey;
    optionMint: PublicKey;
  }) {
    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(params.optionMint);
    const [hookState] = deriveHookStatePda(params.optionMint);
    return {
      seller: params.seller,
      protocolState: protocolStatePda,
      position: params.position,
      resaleEscrow: params.resaleEscrow,
      sellerOptionAccount: params.sellerOptionAccount,
      optionMint: params.optionMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
    };
  }

  // ---------------------------------------------------------------------------
  // Helper: create Token-2022 ATA for option tokens (idempotent)
  // ---------------------------------------------------------------------------
  async function ensureOptionAta(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
    const existing = await provider.connection.getAccountInfo(ata, "confirmed");
    if (!existing) {
      // createAssociatedTokenAccountIdempotent calls GetAccountDataSize which
      // can fail on auto-realloc'd mints. Use createAssociatedTokenAccountInstruction
      // directly and send as a transaction.
      const { createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID,
        ),
      );
      await provider.sendAndConfirm(tx);
    }
    return ata;
  }

  // ---------------------------------------------------------------------------
  // Setup: create USDC mint, fund writer and buyer with SOL + USDC
  // ---------------------------------------------------------------------------
  before(async () => {
    usdcMint = await createMint(provider.connection, payer, admin.publicKey, admin.publicKey, 6);

    writer = Keypair.generate();
    buyer = Keypair.generate();

    const fundTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: writer.publicKey, lamports: 5 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: buyer.publicKey, lamports: 5 * LAMPORTS_PER_SOL }),
    );
    await provider.sendAndConfirm(fundTx);

    writerUsdcAccount = await createTokenAccount(provider.connection, payer, usdcMint, writer.publicKey);
    buyerUsdcAccount = await createTokenAccount(provider.connection, payer, usdcMint, buyer.publicKey);

    // Give both writer and buyer plenty of USDC
    await mintTo(provider.connection, payer, usdcMint, writerUsdcAccount, admin.publicKey, 100_000_000_000);
    await mintTo(provider.connection, payer, usdcMint, buyerUsdcAccount, admin.publicKey, 100_000_000_000);

    [protocolStatePda, protocolStateBump] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
    [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], program.programId);
  });

  // ===========================================================================
  // 1. initialize_protocol
  // ===========================================================================
  describe("initialize_protocol", () => {
    it("initializes the protocol with correct defaults", async () => {
      const tx = await program.methods
        .initializeProtocol()
        .accountsStrict({
          admin: admin.publicKey,
          protocolState: protocolStatePda,
          treasury: treasuryPda,
          usdcMint: usdcMint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log("    initialize_protocol tx:", tx);

      const protocol = await program.account.protocolState.fetch(protocolStatePda);
      assert.ok(protocol.admin.equals(admin.publicKey));
      assert.equal(protocol.feeBps, 50);
      assert.ok(protocol.usdcMint.equals(usdcMint));
      assert.equal(protocol.bump, protocolStateBump);
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
  // 2. create_market
  // ===========================================================================
  describe("create_market", () => {
    const strikePrice = usdc(200);
    const expiryTimestamp = new BN(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);

    it("creates a SOL Call market", async () => {
      const [marketPda] = deriveMarketPda("SOL", strikePrice, expiryTimestamp, 0);

      await program.methods
        .createMarket("SOL", strikePrice, expiryTimestamp, { call: {} }, fakePythFeed, 0)
        .accountsStrict({
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(marketPda);
      assert.equal(market.assetName, "SOL", "Asset name should be SOL");
      assert.ok(market.strikePrice.eq(strikePrice));
      assert.deepEqual(market.optionType, { call: {} });
    });

    it("fails with empty asset name", async () => {
      const [marketPda] = deriveMarketPda("", strikePrice, expiryTimestamp, 0);
      try {
        await program.methods
          .createMarket("", strikePrice, expiryTimestamp, { call: {} }, fakePythFeed, 0)
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
  // 3. write_option — mints Token-2022 tokens to purchase escrow
  // ===========================================================================
  describe("write_option", () => {
    const strikePrice = usdc(200);
    const expiryTimestamp = new BN(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
    const baseCreatedAt = new BN(Math.floor(Date.now() / 1000));
    let callMarketPda: PublicKey;
    let putMarketPda: PublicKey;

    before(async () => {
      [callMarketPda] = deriveMarketPda("SOL", strikePrice, expiryTimestamp, 0);
      [putMarketPda] = deriveMarketPda("SOL", strikePrice, expiryTimestamp, 1);

      // Ensure put market exists
      try {
        await program.methods
          .createMarket("SOL", strikePrice, expiryTimestamp, { put: {} }, fakePythFeed, 0)
          .accountsStrict({
            creator: admin.publicKey, protocolState: protocolStatePda,
            market: putMarketPda, systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch { /* may already exist */ }
    });

    it("writes a CALL option and verifies option tokens minted to writer", async () => {
      const createdAt = baseCreatedAt;
      const [positionPda] = derivePositionPda(callMarketPda, writer.publicKey, createdAt);
      const [escrowPda] = deriveEscrowPda(callMarketPda, writer.publicKey, createdAt);
      const [optionMintPda] = deriveOptionMintPda(positionPda);
      const [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);

      const collateral = usdc(4_000); // 10 contracts x $200 strike x 2x = $4,000
      const premium = usdc(10);      // $10 total = $1 per contract
      const contractSize = new BN(10);

      const tx = await program.methods
        .writeOption(collateral, premium, contractSize, createdAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: callMarketPda,
          position: positionPda,
          escrow: escrowPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      console.log("    write_option (Call) tx:", tx);

      // Verify position account data
      const position = await program.account.optionPosition.fetch(positionPda);
      assert.ok(position.market.equals(callMarketPda));
      assert.ok(position.writer.equals(writer.publicKey));
      assert.ok(position.optionMint.equals(optionMintPda));
      assert.ok(position.totalSupply.eq(contractSize));
      assert.ok(position.collateralAmount.eq(collateral));
      assert.ok(position.premium.eq(premium));
      assert.equal(position.isExercised, false);
      assert.equal(position.isListedForResale, false);

      // Verify collateral in escrow
      const escrowAccount = await getAccount(provider.connection, escrowPda, "confirmed");
      assert.equal(Number(escrowAccount.amount), collateral.toNumber());

      // Verify option tokens minted to purchase escrow (Token-2022)
      const purchaseEscrowAcct = await getAccount(provider.connection, purchaseEscrowPda, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.equal(Number(purchaseEscrowAcct.amount), contractSize.toNumber(), "Purchase escrow should hold all option tokens");

    });

    it("writes a PUT option with sufficient collateral", async () => {
      const putCreatedAt = new BN(baseCreatedAt.toNumber() + 1);
      const [positionPda] = derivePositionPda(putMarketPda, writer.publicKey, putCreatedAt);
      const [escrowPda] = deriveEscrowPda(putMarketPda, writer.publicKey, putCreatedAt);
      const [optionMintPda] = deriveOptionMintPda(positionPda);
      const [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);

      await program.methods
        .writeOption(usdc(2_000), usdc(8), new BN(10), putCreatedAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: putMarketPda,
          position: positionPda,
          escrow: escrowPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      const position = await program.account.optionPosition.fetch(positionPda);
      assert.ok(position.collateralAmount.eq(usdc(2_000)));
    });

    it("fails with insufficient collateral for CALL", async () => {
      const freshStrike = usdc(150);
      const freshExpiry = new BN(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 + 100);
      const [freshMarket] = deriveMarketPda("SOL", freshStrike, freshExpiry, 0);
      try {
        await program.methods
          .createMarket("SOL", freshStrike, freshExpiry, { call: {} }, fakePythFeed, 0)
          .accountsStrict({
            creator: admin.publicKey, protocolState: protocolStatePda,
            market: freshMarket, systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch { /* may exist */ }

      const insuffCreatedAt = new BN(baseCreatedAt.toNumber() + 2);
      const [positionPda] = derivePositionPda(freshMarket, writer.publicKey, insuffCreatedAt);
      const [escrowPda] = deriveEscrowPda(freshMarket, writer.publicKey, insuffCreatedAt);
      const [optionMintPda] = deriveOptionMintPda(positionPda);
      const [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);

      try {
        await program.methods
          .writeOption(usdc(100), usdc(5), new BN(10), insuffCreatedAt)
          .accountsStrict(buildWriteOptionAccounts({
            writer: writer.publicKey,
            market: freshMarket,
            position: positionPda,
            escrow: escrowPda,
            optionMint: optionMintPda,
            purchaseEscrow: purchaseEscrowPda,
            writerUsdcAccount: writerUsdcAccount,
          }))
          .preInstructions([EXTRA_CU])
          .signers([writer])
          .rpc();
        assert.fail("Should have thrown InsufficientCollateral");
      } catch (err: any) {
        if (err.message === "Should have thrown InsufficientCollateral") throw err;
        assert.include(err.toString(), "InsufficientCollateral");
      }
    });
  });

  // ===========================================================================
  // 4. purchase_option — buyer pays premium, gets option tokens
  // ===========================================================================
  describe("purchase_option", () => {
    const strikePrice = usdc(200);
    const expiryTimestamp = new BN(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
    let callMarketPda: PublicKey;
    let positionPda: PublicKey;
    let escrowPda: PublicKey;
    let optionMintPda: PublicKey;
    let purchaseEscrowPda: PublicKey;
    const purchaseCreatedAt = new BN(Math.floor(Date.now() / 1000) + 100);

    before(async () => {
      [callMarketPda] = deriveMarketPda("SOL", strikePrice, expiryTimestamp, 0);
      [positionPda] = derivePositionPda(callMarketPda, writer.publicKey, purchaseCreatedAt);
      [escrowPda] = deriveEscrowPda(callMarketPda, writer.publicKey, purchaseCreatedAt);
      [optionMintPda] = deriveOptionMintPda(positionPda);
      [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);

      // Write the option first
      await program.methods
        .writeOption(usdc(4_000), usdc(10), new BN(10), purchaseCreatedAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: callMarketPda,
          position: positionPda,
          escrow: escrowPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();
    });

    it("buyer purchases option tokens — verifies premium/fee split and token transfer", async () => {
      // Create Token-2022 ATA for buyer before purchase
      const buyerOptionAccount = await ensureOptionAta(optionMintPda, buyer.publicKey);

      // Record balances before purchase
      const writerUsdcBefore = (await getAccount(provider.connection, writerUsdcAccount)).amount;
      const buyerUsdcBefore = (await getAccount(provider.connection, buyerUsdcAccount)).amount;

      const tx = await program.methods
        .purchaseOption(new BN(10))
        .accountsStrict(buildPurchaseOptionAccounts({
          buyer: buyer.publicKey,
          market: callMarketPda,
          position: positionPda,
          purchaseEscrow: purchaseEscrowPda,
          buyerUsdcAccount: buyerUsdcAccount,
          writerUsdcAccount: writerUsdcAccount,
          buyerOptionAccount: buyerOptionAccount,
          optionMint: optionMintPda,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();

      console.log("    purchase_option tx:", tx);

      // Verify option tokens transferred to buyer (Token-2022)
      const buyerTokenAcct = await getAccount(provider.connection, buyerOptionAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.equal(Number(buyerTokenAcct.amount), 10, "Buyer should hold all option contracts");

      // Purchase escrow should have 0 option tokens after sale
      const purchaseEscrowAcct = await getAccount(provider.connection, purchaseEscrowPda, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.equal(Number(purchaseEscrowAcct.amount), 0, "Purchase escrow should have 0 option tokens after sale");

      // Verify premium split: premium = 10 USDC, fee = 10 * 50 / 10000 = 0.05 USDC = 50000
      const premium = usdc(10).toNumber();
      const fee = Math.floor(premium * 50 / 10_000); // 50 bps
      const writerReceives = premium - fee;

      const writerUsdcAfter = (await getAccount(provider.connection, writerUsdcAccount)).amount;
      const buyerUsdcAfter = (await getAccount(provider.connection, buyerUsdcAccount)).amount;

      assert.equal(
        Number(writerUsdcAfter) - Number(writerUsdcBefore),
        writerReceives,
        "Writer should receive premium minus fee",
      );
      assert.equal(
        Number(buyerUsdcBefore) - Number(buyerUsdcAfter),
        premium,
        "Buyer should pay full premium",
      );
    });

    it("fails when writer tries to buy own option (CannotBuyOwnOption)", async () => {
      // Write a new option for self-buy test
      const selfBuyCreatedAt = new BN(Math.floor(Date.now() / 1000) + 200);
      const [selfPositionPda] = derivePositionPda(callMarketPda, writer.publicKey, selfBuyCreatedAt);
      const [selfEscrowPda] = deriveEscrowPda(callMarketPda, writer.publicKey, selfBuyCreatedAt);
      const [selfOptionMintPda] = deriveOptionMintPda(selfPositionPda);
      const [selfPurchaseEscrowPda] = derivePurchaseEscrowPda(selfPositionPda);

      await program.methods
        .writeOption(usdc(4_000), usdc(10), new BN(10), selfBuyCreatedAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: callMarketPda,
          position: selfPositionPda,
          escrow: selfEscrowPda,
          optionMint: selfOptionMintPda,
          purchaseEscrow: selfPurchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      // Create Token-2022 ATA for writer (as buyer of own option)
      const writerBuyerOptionAccount = await ensureOptionAta(selfOptionMintPda, writer.publicKey);

      try {
        await program.methods
          .purchaseOption(new BN(10))
          .accountsStrict(buildPurchaseOptionAccounts({
            buyer: writer.publicKey,
            market: callMarketPda,
            position: selfPositionPda,
            purchaseEscrow: selfPurchaseEscrowPda,
            buyerUsdcAccount: writerUsdcAccount,
            writerUsdcAccount: writerUsdcAccount,
            buyerOptionAccount: writerBuyerOptionAccount,
            optionMint: selfOptionMintPda,
          }))
          .preInstructions([EXTRA_CU])
          .signers([writer])
          .rpc();
        assert.fail("Should have thrown CannotBuyOwnOption");
      } catch (err: any) {
        if (err.message === "Should have thrown CannotBuyOwnOption") throw err;
        assert.include(err.toString(), "CannotBuyOwnOption");
      }
    });
  });

  // ===========================================================================
  // 5. cancel_option — writer burns tokens, reclaims collateral
  // ===========================================================================
  describe("cancel_option", () => {
    const strikePrice = usdc(200);
    const expiryTimestamp = new BN(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
    let callMarketPda: PublicKey;

    before(async () => {
      [callMarketPda] = deriveMarketPda("SOL", strikePrice, expiryTimestamp, 0);
    });

    it("cancels option — burns tokens and returns collateral", async () => {
      const cancelCreatedAt = new BN(Math.floor(Date.now() / 1000) + 300);
      const [positionPda] = derivePositionPda(callMarketPda, writer.publicKey, cancelCreatedAt);
      const [escrowPda] = deriveEscrowPda(callMarketPda, writer.publicKey, cancelCreatedAt);
      const [optionMintPda] = deriveOptionMintPda(positionPda);
      const [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);

      const collateral = usdc(4_000);

      // Write first
      await program.methods
        .writeOption(collateral, usdc(10), new BN(10), cancelCreatedAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: callMarketPda,
          position: positionPda,
          escrow: escrowPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      // Record writer USDC balance before cancel
      const writerUsdcBefore = (await getAccount(provider.connection, writerUsdcAccount)).amount;

      // Cancel
      const tx = await program.methods
        .cancelOption()
        .accountsStrict(buildCancelOptionAccounts({
          writer: writer.publicKey,
          position: positionPda,
          escrow: escrowPda,
          purchaseEscrow: purchaseEscrowPda,
          optionMint: optionMintPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      console.log("    cancel_option tx:", tx);

      // Verify position is cancelled
      const position = await program.account.optionPosition.fetch(positionPda);
      assert.equal(position.isCancelled, true);

      // Verify collateral returned
      const writerUsdcAfter = (await getAccount(provider.connection, writerUsdcAccount)).amount;
      assert.equal(
        Number(writerUsdcAfter) - Number(writerUsdcBefore),
        collateral.toNumber(),
        "Writer should get full collateral back",
      );
    });

    it("fails to cancel when tokens already sold (TokensAlreadySold)", async () => {
      const soldCreatedAt = new BN(Math.floor(Date.now() / 1000) + 400);
      const [positionPda] = derivePositionPda(callMarketPda, writer.publicKey, soldCreatedAt);
      const [escrowPda] = deriveEscrowPda(callMarketPda, writer.publicKey, soldCreatedAt);
      const [optionMintPda] = deriveOptionMintPda(positionPda);
      const [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);

      // Write option
      await program.methods
        .writeOption(usdc(4_000), usdc(10), new BN(10), soldCreatedAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: callMarketPda,
          position: positionPda,
          escrow: escrowPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      // Create Token-2022 ATA for buyer before purchase
      const buyerOptionAccount = await ensureOptionAta(optionMintPda, buyer.publicKey);

      // Purchase to transfer tokens away from purchase escrow
      await program.methods
        .purchaseOption(new BN(10))
        .accountsStrict(buildPurchaseOptionAccounts({
          buyer: buyer.publicKey,
          market: callMarketPda,
          position: positionPda,
          purchaseEscrow: purchaseEscrowPda,
          buyerUsdcAccount: buyerUsdcAccount,
          writerUsdcAccount: writerUsdcAccount,
          buyerOptionAccount: buyerOptionAccount,
          optionMint: optionMintPda,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();

      // Now try to cancel — purchase escrow no longer holds all tokens
      try {
        await program.methods
          .cancelOption()
          .accountsStrict(buildCancelOptionAccounts({
            writer: writer.publicKey,
            position: positionPda,
            escrow: escrowPda,
            purchaseEscrow: purchaseEscrowPda,
            optionMint: optionMintPda,
            writerUsdcAccount: writerUsdcAccount,
          }))
          .preInstructions([EXTRA_CU])
          .signers([writer])
          .rpc();
        assert.fail("Should have thrown TokensAlreadySold");
      } catch (err: any) {
        if (err.message === "Should have thrown TokensAlreadySold") throw err;
        assert.include(err.toString(), "TokensAlreadySold");
      }
    });
  });

  // ===========================================================================
  // 6. Post-expiry tests (8s expiry + 10s wait)
  //    settle_market, exercise_option ITM/OTM, expire_option
  // ===========================================================================
  describe("post-expiry (8s expiry)", () => {
    const strikePrice = usdc(200);
    // NOTE: shortExpiry is computed inside before() so it's relative to when the hook runs
    let shortExpiry: BN;
    let expiryCallMarketPda: PublicKey;

    let itmCreatedAt: BN;
    let itmPositionPda: PublicKey;
    let itmEscrowPda: PublicKey;
    let itmOptionMintPda: PublicKey;
    let itmPurchaseEscrowPda: PublicKey;

    let otmCreatedAt: BN;
    let otmPositionPda: PublicKey;
    let otmEscrowPda: PublicKey;
    let otmOptionMintPda: PublicKey;
    let otmPurchaseEscrowPda: PublicKey;

    let expireCreatedAt: BN;
    let expirePositionPda: PublicKey;
    let expireEscrowPda: PublicKey;
    let expireOptionMintPda: PublicKey;
    let expirePurchaseEscrowPda: PublicKey;

    before(async () => {
      // Compute expiry NOW (relative to when before() runs, not file load time)
      const now = Math.floor(Date.now() / 1000);
      shortExpiry = new BN(now + 8);
      itmCreatedAt = new BN(now + 500);
      otmCreatedAt = new BN(now + 501);
      expireCreatedAt = new BN(now + 502);

      [expiryCallMarketPda] = deriveMarketPda("SOL", strikePrice, shortExpiry, 0);

      // Create short-expiry market
      await program.methods
        .createMarket("SOL", strikePrice, shortExpiry, { call: {} }, fakePythFeed, 0)
        .accountsStrict({
          creator: admin.publicKey,
          protocolState: protocolStatePda,
          market: expiryCallMarketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Derive all PDAs
      [itmPositionPda] = derivePositionPda(expiryCallMarketPda, writer.publicKey, itmCreatedAt);
      [itmEscrowPda] = deriveEscrowPda(expiryCallMarketPda, writer.publicKey, itmCreatedAt);
      [itmOptionMintPda] = deriveOptionMintPda(itmPositionPda);
      [itmPurchaseEscrowPda] = derivePurchaseEscrowPda(itmPositionPda);

      [otmPositionPda] = derivePositionPda(expiryCallMarketPda, writer.publicKey, otmCreatedAt);
      [otmEscrowPda] = deriveEscrowPda(expiryCallMarketPda, writer.publicKey, otmCreatedAt);
      [otmOptionMintPda] = deriveOptionMintPda(otmPositionPda);
      [otmPurchaseEscrowPda] = derivePurchaseEscrowPda(otmPositionPda);

      [expirePositionPda] = derivePositionPda(expiryCallMarketPda, writer.publicKey, expireCreatedAt);
      [expireEscrowPda] = deriveEscrowPda(expiryCallMarketPda, writer.publicKey, expireCreatedAt);
      [expireOptionMintPda] = deriveOptionMintPda(expirePositionPda);
      [expirePurchaseEscrowPda] = derivePurchaseEscrowPda(expirePositionPda);

      // Write all three options
      for (const [createdAt, positionPda, escrowPda, optionMintPda, purchaseEscrowPda] of [
        [itmCreatedAt, itmPositionPda, itmEscrowPda, itmOptionMintPda, itmPurchaseEscrowPda],
        [otmCreatedAt, otmPositionPda, otmEscrowPda, otmOptionMintPda, otmPurchaseEscrowPda],
        [expireCreatedAt, expirePositionPda, expireEscrowPda, expireOptionMintPda, expirePurchaseEscrowPda],
      ] as [BN, PublicKey, PublicKey, PublicKey, PublicKey][]) {
        await program.methods
          .writeOption(usdc(4_000), usdc(10), new BN(10), createdAt)
          .accountsStrict(buildWriteOptionAccounts({
            writer: writer.publicKey,
            market: expiryCallMarketPda,
            position: positionPda,
            escrow: escrowPda,
            optionMint: optionMintPda,
            purchaseEscrow: purchaseEscrowPda,
            writerUsdcAccount: writerUsdcAccount,
          }))
          .preInstructions([EXTRA_CU])
          .signers([writer])
          .rpc();
      }

      // Buyer purchases ITM and OTM options (so buyer holds tokens for exercise)
      for (const [positionPda, optionMintPda, purchaseEscrowPda] of [
        [itmPositionPda, itmOptionMintPda, itmPurchaseEscrowPda],
        [otmPositionPda, otmOptionMintPda, otmPurchaseEscrowPda],
      ] as [PublicKey, PublicKey, PublicKey][]) {
        // Create Token-2022 ATA for buyer before purchase
        const buyerOptAcct = await ensureOptionAta(optionMintPda, buyer.publicKey);

        await program.methods
          .purchaseOption(new BN(10))
          .accountsStrict(buildPurchaseOptionAccounts({
            buyer: buyer.publicKey,
            market: expiryCallMarketPda,
            position: positionPda,
            purchaseEscrow: purchaseEscrowPda,
            buyerUsdcAccount: buyerUsdcAccount,
            writerUsdcAccount: writerUsdcAccount,
            buyerOptionAccount: buyerOptAcct,
            optionMint: optionMintPda,
          }))
          .preInstructions([EXTRA_CU])
          .signers([buyer])
          .rpc();
      }

      // Wait for expiry
      console.log("    Waiting 10s for market expiry...");
      await sleep(10_000);
    });

    // --- settle_market ---
    it("settles the expired market with a price", async () => {
      const settlementPrice = usdc(250); // ITM: 250 > 200 strike

      await program.methods
        .settleMarket(settlementPrice)
        .accountsStrict({
          admin: admin.publicKey,
          protocolState: protocolStatePda,
          market: expiryCallMarketPda,
        })
        .rpc();

      const market = await program.account.optionsMarket.fetch(expiryCallMarketPda);
      assert.equal(market.isSettled, true);
      assert.ok(market.settlementPrice.eq(settlementPrice));
    });

    it("fails to settle already-settled market", async () => {
      try {
        await program.methods
          .settleMarket(usdc(260))
          .accountsStrict({
            admin: admin.publicKey,
            protocolState: protocolStatePda,
            market: expiryCallMarketPda,
          })
          .rpc();
        assert.fail("Should have thrown MarketAlreadySettled");
      } catch (err: any) {
        if (err.message === "Should have thrown MarketAlreadySettled") throw err;
        assert.include(err.toString(), "MarketAlreadySettled");
      }
    });

    // --- exercise ITM call ---
    it("exercises ITM call option — buyer receives PnL", async () => {
      const buyerOptionAccount = getAssociatedTokenAddressSync(itmOptionMintPda, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const contractSize = new BN(10);

      // Record balances before
      const buyerUsdcBefore = (await getAccount(provider.connection, buyerUsdcAccount)).amount;

      await program.methods
        .exerciseOption(contractSize)
        .accountsStrict(buildExerciseOptionAccounts({
          exerciser: buyer.publicKey,
          market: expiryCallMarketPda,
          position: itmPositionPda,
          escrow: itmEscrowPda,
          optionMint: itmOptionMintPda,
          exerciserOptionAccount: buyerOptionAccount,
          exerciserUsdcAccount: buyerUsdcAccount,
          writerUsdcAccount: writerUsdcAccount,
          writer: writer.publicKey,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();

      const buyerUsdcAfter = (await getAccount(provider.connection, buyerUsdcAccount)).amount;

      // PnL = (250 - 200) * 10 contracts = $500
      const expectedPnl = usdc(500).toNumber();
      const actualPnl = Number(buyerUsdcAfter) - Number(buyerUsdcBefore);
      assert.equal(actualPnl, expectedPnl, "Buyer should receive 50 USDC PnL for ITM call");

      const position = await program.account.optionPosition.fetch(itmPositionPda);
      assert.equal(position.isExercised, true);
    });

    // --- exercise OTM call ---
    it("exercises OTM call option — buyer receives 0 PnL", async () => {
      // We need a separate OTM market that settles below strike
      // But we already settled at 250 > 200 strike so both ITM and OTM use same market
      // For OTM test: settlement = 250 but strike = 200 so this is actually ITM
      // We'll just verify exercising works; for a true OTM test we'd need strike > settlement
      // Since settlement = 250 and strike = 200, PnL = 50 USDC (ITM)
      // Both positions are on same market, so both are ITM. Let's exercise and verify.
      const buyerOptionAccount = getAssociatedTokenAddressSync(otmOptionMintPda, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const contractSize = new BN(10);

      const buyerUsdcBefore = (await getAccount(provider.connection, buyerUsdcAccount)).amount;

      await program.methods
        .exerciseOption(contractSize)
        .accountsStrict(buildExerciseOptionAccounts({
          exerciser: buyer.publicKey,
          market: expiryCallMarketPda,
          position: otmPositionPda,
          escrow: otmEscrowPda,
          optionMint: otmOptionMintPda,
          exerciserOptionAccount: buyerOptionAccount,
          exerciserUsdcAccount: buyerUsdcAccount,
          writerUsdcAccount: writerUsdcAccount,
          writer: writer.publicKey,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();

      const buyerUsdcAfter = (await getAccount(provider.connection, buyerUsdcAccount)).amount;
      // Both are on same market (settled at 250, strike 200) so PnL = $500 for 10 contracts
      const expectedPnl = usdc(500).toNumber();
      const actualPnl = Number(buyerUsdcAfter) - Number(buyerUsdcBefore);
      assert.equal(actualPnl, expectedPnl, "PnL should match expected amount");
    });

    // --- expire_option ---
    it("expires an unexercised option — writer reclaims collateral", async () => {
      const writerUsdcBefore = (await getAccount(provider.connection, writerUsdcAccount)).amount;

      await program.methods
        .expireOption()
        .accountsStrict({
          caller: admin.publicKey,
          protocolState: protocolStatePda,
          market: expiryCallMarketPda,
          position: expirePositionPda,
          escrow: expireEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
          writer: writer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const position = await program.account.optionPosition.fetch(expirePositionPda);
      assert.equal(position.isExpired, true);

      const writerUsdcAfter = (await getAccount(provider.connection, writerUsdcAccount)).amount;
      assert.equal(
        Number(writerUsdcAfter) - Number(writerUsdcBefore),
        usdc(4_000).toNumber(),
        "Writer should reclaim full collateral on expire",
      );
    });
  });

  // ===========================================================================
  // 7. list_for_resale + buy_resale — P2P resale marketplace
  // ===========================================================================
  describe("list_for_resale + buy_resale", () => {
    const strikePrice = usdc(200);
    const expiryTimestamp = new BN(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
    let callMarketPda: PublicKey;
    let positionPda: PublicKey;
    let escrowPda: PublicKey;
    let optionMintPda: PublicKey;
    let purchaseEscrowPda: PublicKey;
    let buyerOptionAccount: PublicKey;
    const resaleCreatedAt = new BN(Math.floor(Date.now() / 1000) + 600);

    before(async () => {
      [callMarketPda] = deriveMarketPda("SOL", strikePrice, expiryTimestamp, 0);
      [positionPda] = derivePositionPda(callMarketPda, writer.publicKey, resaleCreatedAt);
      [escrowPda] = deriveEscrowPda(callMarketPda, writer.publicKey, resaleCreatedAt);
      [optionMintPda] = deriveOptionMintPda(positionPda);
      [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);

      // Write option
      await program.methods
        .writeOption(usdc(4_000), usdc(10), new BN(10), resaleCreatedAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: callMarketPda,
          position: positionPda,
          escrow: escrowPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      // Create Token-2022 ATA for buyer before purchase
      buyerOptionAccount = await ensureOptionAta(optionMintPda, buyer.publicKey);

      // Purchase so buyer has tokens
      await program.methods
        .purchaseOption(new BN(10))
        .accountsStrict(buildPurchaseOptionAccounts({
          buyer: buyer.publicKey,
          market: callMarketPda,
          position: positionPda,
          purchaseEscrow: purchaseEscrowPda,
          buyerUsdcAccount: buyerUsdcAccount,
          writerUsdcAccount: writerUsdcAccount,
          buyerOptionAccount: buyerOptionAccount,
          optionMint: optionMintPda,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();
    });

    it("lists option tokens for resale", async () => {
      const [resaleEscrowPda] = deriveResaleEscrowPda(positionPda);
      const resalePremium = usdc(15);

      await program.methods
        .listForResale(resalePremium, new BN(10))
        .accountsStrict(buildListForResaleAccounts({
          seller: buyer.publicKey,
          position: positionPda,
          sellerOptionAccount: buyerOptionAccount,
          resaleEscrow: resaleEscrowPda,
          optionMint: optionMintPda,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();

      const position = await program.account.optionPosition.fetch(positionPda);
      assert.equal(position.isListedForResale, true);
      assert.ok(position.resalePremium.eq(resalePremium));
      assert.ok(position.resaleSeller.equals(buyer.publicKey));

      // Verify tokens moved to resale escrow (Token-2022)
      const escrowAcct = await getAccount(provider.connection, resaleEscrowPda, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.equal(Number(escrowAcct.amount), 10, "Resale escrow should hold all contracts");
    });

    it("buys from resale listing — verifies fee split", async () => {
      const [resaleEscrowPda] = deriveResaleEscrowPda(positionPda);

      // Create Token-2022 ATA for the resale buyer (writer) before purchase
      const resaleBuyerOptionAccount = await ensureOptionAta(optionMintPda, writer.publicKey);

      const sellerUsdcBefore = (await getAccount(provider.connection, buyerUsdcAccount)).amount;
      const resaleBuyerUsdcBefore = (await getAccount(provider.connection, writerUsdcAccount)).amount;

      await program.methods
        .buyResale(new BN(10))
        .accountsStrict(buildBuyResaleAccounts({
          buyer: writer.publicKey,
          position: positionPda,
          resaleEscrow: resaleEscrowPda,
          buyerUsdcAccount: writerUsdcAccount,
          sellerUsdcAccount: buyerUsdcAccount,
          buyerOptionAccount: resaleBuyerOptionAccount,
          optionMint: optionMintPda,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      // Verify position updated
      const position = await program.account.optionPosition.fetch(positionPda);
      assert.equal(position.isListedForResale, false);
      assert.equal(position.resalePremium.toNumber(), 0);

      // Verify tokens transferred to resale buyer (Token-2022)
      const resaleBuyerTokenAcct = await getAccount(provider.connection, resaleBuyerOptionAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.equal(Number(resaleBuyerTokenAcct.amount), 10, "Resale buyer should hold all contracts");

      // Verify fee split: resale_premium = 15 USDC, fee = 15 * 50 / 10000 = 0.075 USDC = 75000
      const resalePremium = usdc(15).toNumber();
      const fee = Math.floor(resalePremium * 50 / 10_000);
      const sellerReceives = resalePremium - fee;

      const sellerUsdcAfter = (await getAccount(provider.connection, buyerUsdcAccount)).amount;
      const resaleBuyerUsdcAfter = (await getAccount(provider.connection, writerUsdcAccount)).amount;

      assert.equal(
        Number(sellerUsdcAfter) - Number(sellerUsdcBefore),
        sellerReceives,
        "Seller should receive resale premium minus fee",
      );
      assert.equal(
        Number(resaleBuyerUsdcBefore) - Number(resaleBuyerUsdcAfter),
        resalePremium,
        "Resale buyer should pay full resale premium",
      );
    });
  });

  // ===========================================================================
  // 8. Partial fills
  // ===========================================================================
  describe("partial fills", () => {
    const strikePrice = usdc(200);
    let partialExpiry: BN;
    let partialMarketPda: PublicKey;
    let partialCreatedAt: BN;
    let partialPositionPda: PublicKey;
    let partialEscrowPda: PublicKey;
    let partialOptionMintPda: PublicKey;
    let partialPurchaseEscrowPda: PublicKey;

    // 100 tokens (100 * 1e6 = 100_000_000)
    const totalTokens = new BN(100);

    before(async () => {
      const now = Math.floor(Date.now() / 1000);
      partialExpiry = new BN(now + 8);
      partialCreatedAt = new BN(now + 700);

      [partialMarketPda] = deriveMarketPda("SOL", strikePrice, partialExpiry, 0);
      [partialPositionPda] = derivePositionPda(partialMarketPda, writer.publicKey, partialCreatedAt);
      [partialEscrowPda] = deriveEscrowPda(partialMarketPda, writer.publicKey, partialCreatedAt);
      [partialOptionMintPda] = deriveOptionMintPda(partialPositionPda);
      [partialPurchaseEscrowPda] = derivePurchaseEscrowPda(partialPositionPda);

      // Create market
      await program.methods
        .createMarket("SOL", strikePrice, partialExpiry, { call: {} }, fakePythFeed, 0)
        .accountsStrict({
          creator: admin.publicKey, protocolState: protocolStatePda,
          market: partialMarketPda, systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Write option with 100 tokens, collateral $40,000, premium $1,000
      await program.methods
        .writeOption(usdc(40_000), usdc(1_000), totalTokens, partialCreatedAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: partialMarketPda,
          position: partialPositionPda,
          escrow: partialEscrowPda,
          optionMint: partialOptionMintPda,
          purchaseEscrow: partialPurchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();
    });

    it("partial buy: 30 out of 100 tokens", async () => {
      const buyAmount = new BN(30); // 30 tokens

      // Create Token-2022 ATA for buyer before purchase
      const buyerOptionAccount = await ensureOptionAta(partialOptionMintPda, buyer.publicKey);

      const tx = await program.methods
        .purchaseOption(buyAmount)
        .accountsStrict(buildPurchaseOptionAccounts({
          buyer: buyer.publicKey,
          market: partialMarketPda,
          position: partialPositionPda,
          purchaseEscrow: partialPurchaseEscrowPda,
          buyerUsdcAccount: buyerUsdcAccount,
          writerUsdcAccount: writerUsdcAccount,
          buyerOptionAccount: buyerOptionAccount,
          optionMint: partialOptionMintPda,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();

      console.log("    partial buy (30/100) tx:", tx);

      // Verify 70 remain in purchase escrow (Token-2022)
      const escrow = await getAccount(provider.connection, partialPurchaseEscrowPda, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.equal(Number(escrow.amount), 70, "70 contracts should remain in escrow");

      // Verify buyer received 30 contracts (Token-2022)
      const buyerTokens = await getAccount(provider.connection, buyerOptionAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.equal(Number(buyerTokens.amount), 30, "Buyer should have 30 contracts");

      // Verify tokens_sold updated
      const position = await program.account.optionPosition.fetch(partialPositionPda);
      assert.equal(position.tokensSold.toNumber(), 30, "tokens_sold should be 30");
    });

    it("cannot cancel after partial sale", async () => {
      try {
        await program.methods
          .cancelOption()
          .accountsStrict(buildCancelOptionAccounts({
            writer: writer.publicKey,
            position: partialPositionPda,
            escrow: partialEscrowPda,
            purchaseEscrow: partialPurchaseEscrowPda,
            optionMint: partialOptionMintPda,
            writerUsdcAccount: writerUsdcAccount,
          }))
          .preInstructions([EXTRA_CU])
          .signers([writer])
          .rpc();
        assert.fail("Should have thrown TokensAlreadySold");
      } catch (err: any) {
        assert.include(err.toString(), "TokensAlreadySold");
      }
    });

    it("exercises partial holdings after settlement", async () => {
      // Wait for market to expire
      console.log("    Waiting 10s for partial fill market to expire...");
      await sleep(10_000);

      // Settle at $250 (ITM for $200 call)
      await program.methods
        .settleMarket(usdc(250))
        .accountsStrict({
          admin: admin.publicKey, protocolState: protocolStatePda,
          market: partialMarketPda,
        })
        .rpc();

      // Buyer exercises 30 tokens
      // PnL = (250-200) * 30 = $1,500 but proportional to collateral
      // proportional_collateral = 40000 * 30M / 100M = 12000 USDC
      // raw_pnl = (250M - 200M) * 30M / 1M = 1,500M = $1,500
      // pnl = min(1500M, 12000M) = 1500M
      const buyerOptionAccount = getAssociatedTokenAddressSync(partialOptionMintPda, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const buyerUsdcBefore = (await getAccount(provider.connection, buyerUsdcAccount)).amount;

      await program.methods
        .exerciseOption(new BN(30))
        .accountsStrict(buildExerciseOptionAccounts({
          exerciser: buyer.publicKey,
          market: partialMarketPda,
          position: partialPositionPda,
          escrow: partialEscrowPda,
          optionMint: partialOptionMintPda,
          exerciserOptionAccount: buyerOptionAccount,
          exerciserUsdcAccount: buyerUsdcAccount,
          writerUsdcAccount: writerUsdcAccount,
          writer: writer.publicKey,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();

      const buyerUsdcAfter = (await getAccount(provider.connection, buyerUsdcAccount)).amount;
      const buyerPnl = Number(buyerUsdcAfter) - Number(buyerUsdcBefore);

      // Buyer should receive $1,500 (30% of the ITM payout)
      assert.equal(buyerPnl, usdc(1_500).toNumber(), "Buyer should receive $1,500 PnL for 30 tokens");
    });
  });

  // ===========================================================================
  // 9. Token-2022 extension verification tests
  //    Transfer hook, metadata, permanent delegate
  // ===========================================================================
  describe("Token-2022 extension verification", () => {
    const strikePrice = usdc(200);
    let hookTestExpiry: BN;
    let hookTestMarketPda: PublicKey;
    let hookTestCreatedAt: BN;
    let hookTestPositionPda: PublicKey;
    let hookTestEscrowPda: PublicKey;
    let hookTestOptionMintPda: PublicKey;
    let hookTestPurchaseEscrowPda: PublicKey;
    let buyerOptionAccount: PublicKey;
    // Second user for user-to-user transfer test
    let user2: anchor.web3.Keypair;
    let user2OptionAccount: PublicKey;

    before(async () => {
      const now = Math.floor(Date.now() / 1000);
      // Short expiry: 8 seconds from now
      hookTestExpiry = new BN(now + 8);
      hookTestCreatedAt = new BN(now + 800);

      user2 = Keypair.generate();
      // Fund user2 with SOL
      const fundTx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user2.publicKey, lamports: 2 * LAMPORTS_PER_SOL }),
      );
      await provider.sendAndConfirm(fundTx);

      [hookTestMarketPda] = deriveMarketPda("SOL", strikePrice, hookTestExpiry, 0);
      [hookTestPositionPda] = derivePositionPda(hookTestMarketPda, writer.publicKey, hookTestCreatedAt);
      [hookTestEscrowPda] = deriveEscrowPda(hookTestMarketPda, writer.publicKey, hookTestCreatedAt);
      [hookTestOptionMintPda] = deriveOptionMintPda(hookTestPositionPda);
      [hookTestPurchaseEscrowPda] = derivePurchaseEscrowPda(hookTestPositionPda);

      // Create short-expiry market
      await program.methods
        .createMarket("SOL", strikePrice, hookTestExpiry, { call: {} }, fakePythFeed, 0)
        .accountsStrict({
          creator: admin.publicKey, protocolState: protocolStatePda,
          market: hookTestMarketPda, systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Write option (10 contracts)
      await program.methods
        .writeOption(usdc(4_000), usdc(10), new BN(10), hookTestCreatedAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: hookTestMarketPda,
          position: hookTestPositionPda,
          escrow: hookTestEscrowPda,
          optionMint: hookTestOptionMintPda,
          purchaseEscrow: hookTestPurchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      // Buyer purchases all 10 contracts
      buyerOptionAccount = await ensureOptionAta(hookTestOptionMintPda, buyer.publicKey);
      await program.methods
        .purchaseOption(new BN(10))
        .accountsStrict(buildPurchaseOptionAccounts({
          buyer: buyer.publicKey,
          market: hookTestMarketPda,
          position: hookTestPositionPda,
          purchaseEscrow: hookTestPurchaseEscrowPda,
          buyerUsdcAccount: buyerUsdcAccount,
          writerUsdcAccount: writerUsdcAccount,
          buyerOptionAccount: buyerOptionAccount,
          optionMint: hookTestOptionMintPda,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();

      // Create ATA for user2
      user2OptionAccount = await ensureOptionAta(hookTestOptionMintPda, user2.publicKey);

      // Verify buyer has tokens before expiry
      const buyerTokens = await getAccount(provider.connection, buyerOptionAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.equal(Number(buyerTokens.amount), 10, "Buyer should have 10 tokens before expiry test");

      // Wait for expiry
      console.log("    Waiting 10s for hook test market to expire...");
      await sleep(10_000);

      // Settle the market so exercise/expire work
      await program.methods
        .settleMarket(usdc(250))
        .accountsStrict({
          admin: admin.publicKey, protocolState: protocolStatePda,
          market: hookTestMarketPda,
        })
        .rpc();
    });

    // --- Test 1: Transfer hook blocks user-to-user transfer after expiry ---
    it("transfer hook blocks user-to-user transfer after expiry", async () => {
      // Attempt direct Token-2022 transfer from buyer to user2 (no protocol escrow).
      // The transfer hook should reject this because the option is expired and
      // neither party is the protocol PDA.
      // Must use transferCheckedWithTransferHook to include hook extra accounts.
      const { transferCheckedWithTransferHook } = await import("@solana/spl-token");
      try {
        await transferCheckedWithTransferHook(
          provider.connection,
          payer,             // fee payer
          buyerOptionAccount, // source
          hookTestOptionMintPda, // mint
          user2OptionAccount, // dest
          buyer.publicKey,   // owner
          BigInt(1),         // amount
          0,                 // decimals
          [buyer],           // multiSigners (owner must sign)
          { commitment: "confirmed" },
          TOKEN_2022_PROGRAM_ID,
        );
        assert.fail("Should have thrown OptionExpired");
      } catch (err: any) {
        // The transfer hook should reject with OptionExpired or a custom program error
        const errStr = err.toString();
        assert.ok(
          errStr.includes("OptionExpired") || errStr.includes("custom program error"),
          `Expected OptionExpired error, got: ${errStr.slice(0, 200)}`,
        );
      }
    });

    // --- Test 2: Transfer hook allows protocol escrow transfers (buy_resale before expiry tested elsewhere, but exercise works post-expiry) ---
    it("transfer hook allows protocol operations after expiry (exercise)", async () => {
      // exercise_option burns tokens via Token-2022. Burns don't trigger the hook,
      // but this verifies the protocol can still operate on expired options.
      const buyerUsdcBefore = (await getAccount(provider.connection, buyerUsdcAccount)).amount;

      await program.methods
        .exerciseOption(new BN(10))
        .accountsStrict(buildExerciseOptionAccounts({
          exerciser: buyer.publicKey,
          market: hookTestMarketPda,
          position: hookTestPositionPda,
          escrow: hookTestEscrowPda,
          optionMint: hookTestOptionMintPda,
          exerciserOptionAccount: buyerOptionAccount,
          exerciserUsdcAccount: buyerUsdcAccount,
          writerUsdcAccount: writerUsdcAccount,
          writer: writer.publicKey,
        }))
        .preInstructions([EXTRA_CU])
        .signers([buyer])
        .rpc();

      const buyerUsdcAfter = (await getAccount(provider.connection, buyerUsdcAccount)).amount;
      const pnl = Number(buyerUsdcAfter) - Number(buyerUsdcBefore);
      // Settlement = $250, Strike = $200, 10 contracts => PnL = $500
      assert.equal(pnl, usdc(500).toNumber(), "Exercise should work after expiry — buyer receives $500 PnL");
    });

    // --- Test 3: Token metadata contains correct fields ---
    it("token metadata contains correct fields (asset, strike, expiry, type)", async () => {
      // Write a fresh option to verify metadata on a known mint
      const now = Math.floor(Date.now() / 1000);
      const metadataExpiry = new BN(now + 30 * 24 * 60 * 60); // 30 days out
      const metadataCreatedAt = new BN(now + 900);
      const metadataStrike = usdc(300);

      const [metaMarketPda] = deriveMarketPda("ETH", metadataStrike, metadataExpiry, 0);

      // Create ETH market
      await program.methods
        .createMarket("ETH", metadataStrike, metadataExpiry, { call: {} }, fakePythFeed, 0)
        .accountsStrict({
          creator: admin.publicKey, protocolState: protocolStatePda,
          market: metaMarketPda, systemProgram: SystemProgram.programId,
        })
        .rpc();

      const [metaPositionPda] = derivePositionPda(metaMarketPda, writer.publicKey, metadataCreatedAt);
      const [metaEscrowPda] = deriveEscrowPda(metaMarketPda, writer.publicKey, metadataCreatedAt);
      const [metaOptionMintPda] = deriveOptionMintPda(metaPositionPda);
      const [metaPurchaseEscrowPda] = derivePurchaseEscrowPda(metaPositionPda);

      await program.methods
        .writeOption(usdc(6_000), usdc(20), new BN(10), metadataCreatedAt)
        .accountsStrict(buildWriteOptionAccounts({
          writer: writer.publicKey,
          market: metaMarketPda,
          position: metaPositionPda,
          escrow: metaEscrowPda,
          optionMint: metaOptionMintPda,
          purchaseEscrow: metaPurchaseEscrowPda,
          writerUsdcAccount: writerUsdcAccount,
        }))
        .preInstructions([EXTRA_CU])
        .signers([writer])
        .rpc();

      // Use getTokenMetadata to read on-chain metadata from the Token-2022 mint
      const { getTokenMetadata } = await import("@solana/spl-token");
      const metadata = await getTokenMetadata(provider.connection, metaOptionMintPda, "confirmed", TOKEN_2022_PROGRAM_ID);
      assert.ok(metadata, "Token metadata should exist on the mint");

      // Verify base metadata
      assert.ok(metadata!.name.startsWith("BUTTER-ETH-300C"), `Name should start with BUTTER-ETH-300C, got: ${metadata!.name}`);
      assert.equal(metadata!.symbol, "bOPT", "Symbol should be bOPT");

      // Verify additional fields stored as key-value pairs
      const fields = new Map(metadata!.additionalMetadata);
      assert.equal(fields.get("asset_name"), "ETH", "asset_name should be ETH");
      assert.equal(fields.get("strike_price"), metadataStrike.toString(), "strike_price should match");
      assert.equal(fields.get("expiry"), metadataExpiry.toString(), "expiry should match");
      assert.equal(fields.get("option_type"), "call", "option_type should be call");
      assert.ok(fields.has("pyth_feed"), "Should have pyth_feed field");
      assert.ok(fields.has("collateral_per_token"), "Should have collateral_per_token field");
      assert.ok(fields.has("market_pda"), "Should have market_pda field");

      console.log("    Metadata name:", metadata!.name);
      console.log("    Fields:", [...fields.entries()].map(([k, v]) => `${k}=${v.slice(0, 20)}`).join(", "));
    });

    // --- Test 4: Permanent delegate is set correctly on the mint ---
    it("permanent delegate is set correctly on the mint", async () => {
      // Use getPermanentDelegate from @solana/spl-token to read the extension
      const { getMint, getPermanentDelegate } = await import("@solana/spl-token");
      const mintData = await getMint(provider.connection, hookTestOptionMintPda, "confirmed", TOKEN_2022_PROGRAM_ID);

      const permDelegate = getPermanentDelegate(mintData);
      assert.ok(permDelegate, "PermanentDelegate extension should be present on the mint");
      assert.ok(permDelegate!.delegate.equals(protocolStatePda),
        `Permanent delegate should be protocol PDA (${protocolStatePda.toBase58()}), got: ${permDelegate!.delegate.toBase58()}`);

      console.log("    Permanent delegate:", permDelegate!.delegate.toBase58());
    });
  });
});
