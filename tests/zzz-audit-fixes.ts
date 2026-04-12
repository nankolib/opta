// =============================================================================
// tests/audit-fixes.ts — Tests for re-audit findings (CRITICAL-01 through LOW-01)
// =============================================================================
//
// CRITICAL-01: settle_vault double-deduction — ITM + OTM lifecycle
// HIGH-01:     withdraw_post_settlement auto-claims unclaimed premium
// MEDIUM-01:   withdraw_from_vault requires premium claimed first
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

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

describe("audit-fixes", () => {
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
  let protocolStatePda: PublicKey;
  let treasuryPda: PublicKey;
  let epochConfigPda: PublicKey;

  // ==========================================================================
  // PDA derivation helpers
  // ==========================================================================

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

  // ==========================================================================
  // Setup: protocol, USDC, wallets
  // ==========================================================================
  before(async () => {
    [protocolStatePda] = deriveProtocolStatePda();
    [treasuryPda] = deriveTreasuryPda();
    [epochConfigPda] = deriveEpochConfigPda();

    // Read existing protocol state
    try {
      const existingProtocol = await program.account.protocolState.fetch(protocolStatePda);
      usdcMint = existingProtocol.usdcMint;
    } catch (e) {
      // Protocol doesn't exist yet — create
      usdcMint = await createMint(
        connection, payer, payer.publicKey, null, 6,
        undefined, undefined, TOKEN_PROGRAM_ID,
      );
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

    // Ensure epoch config exists
    try {
      await program.account.epochConfig.fetch(epochConfigPda);
    } catch (e) {
      await program.methods
        .initializeEpochConfig(5, 8, true)
        .accounts({
          admin: payer.publicKey,
          protocolState: protocolStatePda,
          epochConfig: epochConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();
    }
  });

  // ==========================================================================
  // Helper: set up a full vault scenario (market + vault + deposit + mint + buy)
  // Returns all PDAs and keypairs needed for settlement tests
  // ==========================================================================
  async function setupVaultScenario(opts: {
    assetName: string;
    strike: BN;
    expirySeconds: number;
    optionType: any; // { call: {} } or { put: {} }
    optionTypeIndex: number;
    depositAmount: BN;
    mintQuantity: number;
    premiumPerContract: BN;
    buyQuantity: number;
  }) {
    const writer = Keypair.generate();
    const buyer = Keypair.generate();

    // Fund wallets
    for (const kp of [writer, buyer]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }

    // Create USDC accounts
    const writerUsdcAccount = await createTokenAccount(
      connection, payer, usdcMint, writer.publicKey, undefined, undefined, TOKEN_PROGRAM_ID,
    );
    const buyerUsdcAccount = await createTokenAccount(
      connection, payer, usdcMint, buyer.publicKey, undefined, undefined, TOKEN_PROGRAM_ID,
    );

    // Mint USDC
    await mintTo(connection, payer, usdcMint, writerUsdcAccount, payer, 100_000_000_000);
    await mintTo(connection, payer, usdcMint, buyerUsdcAccount, payer, 100_000_000_000);

    // Short expiry
    const expiry = new BN(Math.floor(Date.now() / 1000) + opts.expirySeconds);

    // Create market
    const [marketPda] = deriveMarketPda(opts.assetName, opts.strike, expiry, opts.optionTypeIndex);
    await program.methods
      .createMarket(opts.assetName, opts.strike, expiry, opts.optionType, Keypair.generate().publicKey, 0)
      .accounts({
        admin: payer.publicKey,
        protocolState: protocolStatePda,
        market: marketPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    // Create vault
    const [vaultPda] = deriveSharedVaultPda(marketPda, opts.strike, expiry, opts.optionTypeIndex);
    const [vaultUsdcPda] = deriveVaultUsdcPda(vaultPda);

    await program.methods
      .createSharedVault(opts.strike, expiry, opts.optionType, { custom: {} })
      .accounts({
        creator: writer.publicKey,
        market: marketPda,
        sharedVault: vaultPda,
        vaultUsdcAccount: vaultUsdcPda,
        usdcMint,
        protocolState: protocolStatePda,
        epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([writer])
      .rpc();

    // Deposit
    const [writerPosPda] = deriveWriterPositionPda(vaultPda, writer.publicKey);
    await program.methods
      .depositToVault(opts.depositAmount)
      .accounts({
        writer: writer.publicKey,
        sharedVault: vaultPda,
        writerPosition: writerPosPda,
        vaultUsdcAccount: vaultUsdcPda,
        writerUsdcAccount,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([writer])
      .rpc();

    // Mint option tokens
    const mintCreatedAt = new BN(Math.floor(Date.now() / 1000));
    const [optionMintPda] = deriveVaultOptionMintPda(vaultPda, writer.publicKey, mintCreatedAt);
    const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(vaultPda, writer.publicKey, mintCreatedAt);
    const [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
    const [hookState] = deriveHookStatePda(optionMintPda);

    {
      const tx = new Transaction().add(EXTRA_CU);
      const ix = await program.methods
        .mintFromVault(new BN(opts.mintQuantity), opts.premiumPerContract, mintCreatedAt)
        .accounts({
          writer: writer.publicKey,
          sharedVault: vaultPda,
          writerPosition: writerPosPda,
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
        .signers([writer])
        .instruction();
      tx.add(ix);
      await provider.sendAndConfirm(tx, [writer]);
    }

    // Buyer purchases
    if (opts.buyQuantity > 0) {
      const buyerOptionAccount = await createAssociatedTokenAccountIdempotent(
        connection, payer, optionMintPda, buyer.publicKey, {}, TOKEN_2022_PROGRAM_ID,
      );

      const tx = new Transaction().add(EXTRA_CU);
      const ix = await program.methods
        .purchaseFromVault(new BN(opts.buyQuantity), usdc(999_999)) // high slippage tolerance
        .accounts({
          buyer: buyer.publicKey,
          sharedVault: vaultPda,
          writerPosition: writerPosPda,
          vaultMintRecord: vaultMintRecordPda,
          protocolState: protocolStatePda,
          market: marketPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          buyerOptionAccount,
          buyerUsdcAccount,
          vaultUsdcAccount: vaultUsdcPda,
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
    }

    return {
      writer, buyer, writerUsdcAccount, buyerUsdcAccount,
      marketPda, vaultPda, vaultUsdcPda, writerPosPda,
      optionMintPda, purchaseEscrowPda, vaultMintRecordPda,
      extraAccountMetaList, hookState,
      expiry, mintCreatedAt,
    };
  }

  // ==========================================================================
  // CRITICAL-01: ITM settlement — no stuck funds
  // ==========================================================================
  describe("CRITICAL-01: ITM settlement — no double-deduction, no stuck funds", () => {
    let ctx: Awaited<ReturnType<typeof setupVaultScenario>>;
    const strike = usdc(100); // $100 strike
    const deposit = usdc(1000); // 1000 USDC
    const quantity = 5; // 5 contracts (5 * $200 collateral = $1000)

    before(async function () {
      this.timeout(120_000);
      ctx = await setupVaultScenario({
        assetName: "CITM",
        strike,
        expirySeconds: 10, // 10s expiry
        optionType: { call: {} },
        optionTypeIndex: 0,
        depositAmount: deposit,
        mintQuantity: quantity,
        premiumPerContract: usdc(5), // $5 premium each
        buyQuantity: quantity, // buyer purchases all 5
      });

      // Wait for expiry
      console.log("    Waiting 12s for CITM market expiry...");
      await sleep(12_000);
    });

    it("settles market deep ITM ($250 settlement on $100 strike call)", async function () {
      this.timeout(30_000);
      // Settle market at $250 — deep ITM, payout = $150 per contract
      await program.methods
        .settleMarket(usdc(250))
        .accounts({
          admin: payer.publicKey,
          protocolState: protocolStatePda,
          market: ctx.marketPda,
        })
        .signers([payer])
        .rpc();

      const market = await program.account.optionsMarket.fetch(ctx.marketPda);
      assert.isTrue(market.isSettled);
      assert.equal(market.settlementPrice.toNumber(), usdc(250).toNumber());
    });

    it("settles vault — collateral_remaining equals total_collateral (no pre-deduction)", async function () {
      this.timeout(30_000);
      await program.methods
        .settleVault()
        .accounts({
          authority: payer.publicKey,
          sharedVault: ctx.vaultPda,
          market: ctx.marketPda,
        })
        .signers([payer])
        .rpc();

      // FIX CRITICAL-01: collateral_remaining should be total_collateral, NOT total - payout
      const vault = await program.account.sharedVault.fetch(ctx.vaultPda);
      assert.isTrue(vault.isSettled);
      // With the fix, collateral_remaining = total_collateral (premium was added to vault too)
      assert.equal(vault.collateralRemaining.toNumber(), vault.totalCollateral.toNumber(),
        "CRITICAL-01: collateral_remaining must equal total_collateral after settle (no pre-deduction)");
    });

    it("buyer exercises all 5 contracts — receives correct payout", async function () {
      this.timeout(30_000);
      const buyerOptionAccount = getAssociatedTokenAddressSync(
        ctx.optionMintPda, ctx.buyer.publicKey, false, TOKEN_2022_PROGRAM_ID,
      );
      const beforeBalance = await getAccount(connection, ctx.buyerUsdcAccount);

      await program.methods
        .exerciseFromVault(new BN(quantity))
        .accounts({
          holder: ctx.buyer.publicKey,
          sharedVault: ctx.vaultPda,
          market: ctx.marketPda,
          vaultMintRecord: ctx.vaultMintRecordPda,
          optionMint: ctx.optionMintPda,
          holderOptionAccount: buyerOptionAccount,
          vaultUsdcAccount: ctx.vaultUsdcPda,
          holderUsdcAccount: ctx.buyerUsdcAccount,
          protocolState: protocolStatePda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([ctx.buyer])
        .rpc();

      const afterBalance = await getAccount(connection, ctx.buyerUsdcAccount);
      const received = Number(afterBalance.amount) - Number(beforeBalance.amount);

      // Payout = ($250 - $100) * 5 = $750
      assert.equal(received, usdc(750).toNumber(),
        "Buyer should receive $750 (5 * $150 payout per contract)");
    });

    it("writer withdraws post-settlement — receives remaining collateral + premium", async function () {
      this.timeout(30_000);
      const beforeBalance = await getAccount(connection, ctx.writerUsdcAccount);

      await program.methods
        .withdrawPostSettlement()
        .accounts({
          writer: ctx.writer.publicKey,
          sharedVault: ctx.vaultPda,
          writerPosition: ctx.writerPosPda,
          vaultUsdcAccount: ctx.vaultUsdcPda,
          writerUsdcAccount: ctx.writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.writer])
        .rpc();

      const afterBalance = await getAccount(connection, ctx.writerUsdcAccount);
      const received = Number(afterBalance.amount) - Number(beforeBalance.amount);

      // Writer deposited $1000. Exercises took $750. Premium earned ~$24.875 (5*$5 - 0.5% fee).
      // Writer should get remaining collateral ($1000 - $750 = $250) + unclaimed premium
      // The exact premium depends on fee split, but collateral portion must be $250
      assert.ok(received >= usdc(250).toNumber(),
        `Writer should receive at least $250 remaining collateral, got ${received / 1_000_000}`);

      // Vault USDC account should be closed (last writer)
      const vaultUsdcInfo = await connection.getAccountInfo(ctx.vaultUsdcPda);
      assert.isNull(vaultUsdcInfo, "Vault USDC account should be closed — no stuck funds");
    });
  });

  // ==========================================================================
  // CRITICAL-01: OTM settlement — writers get everything back
  // ==========================================================================
  describe("CRITICAL-01: OTM settlement — writers get everything back", () => {
    let ctx: Awaited<ReturnType<typeof setupVaultScenario>>;
    const strike = usdc(100); // $100 strike
    const deposit = usdc(1000);

    before(async function () {
      this.timeout(120_000);
      ctx = await setupVaultScenario({
        assetName: "COTM",
        strike,
        expirySeconds: 10,
        optionType: { call: {} },
        optionTypeIndex: 0,
        depositAmount: deposit,
        mintQuantity: 5,
        premiumPerContract: usdc(5),
        buyQuantity: 5,
      });

      console.log("    Waiting 12s for COTM market expiry...");
      await sleep(12_000);
    });

    it("settles market OTM ($50 settlement on $100 strike call)", async function () {
      this.timeout(30_000);
      await program.methods
        .settleMarket(usdc(50))
        .accounts({
          admin: payer.publicKey,
          protocolState: protocolStatePda,
          market: ctx.marketPda,
        })
        .signers([payer])
        .rpc();
    });

    it("settles vault OTM", async function () {
      this.timeout(30_000);
      await program.methods
        .settleVault()
        .accounts({
          authority: payer.publicKey,
          sharedVault: ctx.vaultPda,
          market: ctx.marketPda,
        })
        .signers([payer])
        .rpc();
    });

    it("writer withdraws full collateral + premium (OTM, no exercises)", async function () {
      this.timeout(30_000);
      const beforeBalance = await getAccount(connection, ctx.writerUsdcAccount);

      await program.methods
        .withdrawPostSettlement()
        .accounts({
          writer: ctx.writer.publicKey,
          sharedVault: ctx.vaultPda,
          writerPosition: ctx.writerPosPda,
          vaultUsdcAccount: ctx.vaultUsdcPda,
          writerUsdcAccount: ctx.writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.writer])
        .rpc();

      const afterBalance = await getAccount(connection, ctx.writerUsdcAccount);
      const received = Number(afterBalance.amount) - Number(beforeBalance.amount);

      // Writer should get full $1000 collateral back + premium
      assert.ok(received >= usdc(1000).toNumber(),
        `Writer should receive at least $1000 (full collateral), got ${received / 1_000_000}`);

      // Vault closed
      const vaultUsdcInfo = await connection.getAccountInfo(ctx.vaultUsdcPda);
      assert.isNull(vaultUsdcInfo, "Vault USDC account should be closed");
    });
  });

  // ==========================================================================
  // HIGH-01: withdraw_post_settlement auto-claims unclaimed premium
  // ==========================================================================
  describe("HIGH-01: withdraw_post_settlement auto-claims unclaimed premium", () => {
    let ctx: Awaited<ReturnType<typeof setupVaultScenario>>;
    const strike = usdc(100);
    const deposit = usdc(1000);
    const premiumPerContract = usdc(10); // $10 premium each

    before(async function () {
      this.timeout(120_000);
      ctx = await setupVaultScenario({
        assetName: "HAUTO",
        strike,
        expirySeconds: 10,
        optionType: { call: {} },
        optionTypeIndex: 0,
        depositAmount: deposit,
        mintQuantity: 5,
        premiumPerContract,
        buyQuantity: 5,
      });

      console.log("    Waiting 12s for HAUTO market expiry...");
      await sleep(12_000);

      // Settle market OTM so writer gets everything back
      await program.methods
        .settleMarket(usdc(50))
        .accounts({
          admin: payer.publicKey,
          protocolState: protocolStatePda,
          market: ctx.marketPda,
        })
        .signers([payer])
        .rpc();

      await program.methods
        .settleVault()
        .accounts({
          authority: payer.publicKey,
          sharedVault: ctx.vaultPda,
          market: ctx.marketPda,
        })
        .signers([payer])
        .rpc();
    });

    it("writer does NOT call claim_premium, goes straight to withdraw_post_settlement", async function () {
      this.timeout(30_000);

      // Verify premium is unclaimed
      const writerPos = await program.account.writerPosition.fetch(ctx.writerPosPda);
      assert.equal(writerPos.premiumClaimed.toNumber(), 0, "Premium should be unclaimed");

      // Check vault has premium recorded
      const vault = await program.account.sharedVault.fetch(ctx.vaultPda);
      assert.ok(vault.netPremiumCollected.toNumber() > 0, "Premium should have been collected");

      const beforeBalance = await getAccount(connection, ctx.writerUsdcAccount);

      // Withdraw post settlement WITHOUT claiming premium first
      await program.methods
        .withdrawPostSettlement()
        .accounts({
          writer: ctx.writer.publicKey,
          sharedVault: ctx.vaultPda,
          writerPosition: ctx.writerPosPda,
          vaultUsdcAccount: ctx.vaultUsdcPda,
          writerUsdcAccount: ctx.writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.writer])
        .rpc();

      const afterBalance = await getAccount(connection, ctx.writerUsdcAccount);
      const received = Number(afterBalance.amount) - Number(beforeBalance.amount);

      // Writer should receive: $1000 collateral + premium (5 * $10 - 0.5% fee = $49.75)
      // Total premium collected = $49,750,000 (micro-USDC)
      assert.ok(received > usdc(1000).toNumber(),
        `Writer should receive collateral + premium (> $1000), got ${received / 1_000_000}`);

      // Specifically, premium should be approximately $49.75
      const premiumReceived = received - usdc(1000).toNumber();
      assert.ok(premiumReceived > usdc(49).toNumber(),
        `Auto-claimed premium should be ~$49.75, got ${premiumReceived / 1_000_000}`);
    });
  });

  // ==========================================================================
  // MEDIUM-01: withdraw_from_vault requires premium claimed first
  // ==========================================================================
  describe("MEDIUM-01: withdraw_from_vault requires premium claimed first", () => {
    let writer: Keypair;
    let buyer: Keypair;
    let writerUsdcAccount: PublicKey;
    let buyerUsdcAccount: PublicKey;
    let vaultPda: PublicKey;
    let vaultUsdcPda: PublicKey;
    let writerPosPda: PublicKey;
    let marketPda: PublicKey;
    const strike = usdc(100);

    before(async function () {
      this.timeout(120_000);

      writer = Keypair.generate();
      buyer = Keypair.generate();

      for (const kp of [writer, buyer]) {
        const sig = await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, "confirmed");
      }

      writerUsdcAccount = await createTokenAccount(
        connection, payer, usdcMint, writer.publicKey, undefined, undefined, TOKEN_PROGRAM_ID,
      );
      buyerUsdcAccount = await createTokenAccount(
        connection, payer, usdcMint, buyer.publicKey, undefined, undefined, TOKEN_PROGRAM_ID,
      );

      await mintTo(connection, payer, usdcMint, writerUsdcAccount, payer, 100_000_000_000);
      await mintTo(connection, payer, usdcMint, buyerUsdcAccount, payer, 100_000_000_000);

      // Long expiry so we can test withdrawal before settlement
      const expiry = new BN(Math.floor(Date.now() / 1000) + 3600);
      [marketPda] = deriveMarketPda("MCLM", strike, expiry, 0);

      await program.methods
        .createMarket("MCLM", strike, expiry, { call: {} }, Keypair.generate().publicKey, 0)
        .accounts({
          admin: payer.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();

      [vaultPda] = deriveSharedVaultPda(marketPda, strike, expiry, 0);
      [vaultUsdcPda] = deriveVaultUsdcPda(vaultPda);

      await program.methods
        .createSharedVault(strike, expiry, { call: {} }, { custom: {} })
        .accounts({
          creator: writer.publicKey,
          market: marketPda,
          sharedVault: vaultPda,
          vaultUsdcAccount: vaultUsdcPda,
          usdcMint,
          protocolState: protocolStatePda,
          epochConfig: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writer])
        .rpc();

      // Deposit $10,000
      [writerPosPda] = deriveWriterPositionPda(vaultPda, writer.publicKey);
      await program.methods
        .depositToVault(usdc(10_000))
        .accounts({
          writer: writer.publicKey,
          sharedVault: vaultPda,
          writerPosition: writerPosPda,
          vaultUsdcAccount: vaultUsdcPda,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writer])
        .rpc();

      // Mint 5 options
      const mintCreatedAt = new BN(Math.floor(Date.now() / 1000));
      const [optionMintPda] = deriveVaultOptionMintPda(vaultPda, writer.publicKey, mintCreatedAt);
      const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(vaultPda, writer.publicKey, mintCreatedAt);
      const [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await program.methods
          .mintFromVault(new BN(5), usdc(5), mintCreatedAt)
          .accounts({
            writer: writer.publicKey,
            sharedVault: vaultPda,
            writerPosition: writerPosPda,
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
          .signers([writer])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [writer]);
      }

      // Buyer purchases 3 → generates premium
      const buyerOptionAccount = await createAssociatedTokenAccountIdempotent(
        connection, payer, optionMintPda, buyer.publicKey, {}, TOKEN_2022_PROGRAM_ID,
      );

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await program.methods
          .purchaseFromVault(new BN(3), usdc(999_999))
          .accounts({
            buyer: buyer.publicKey,
            sharedVault: vaultPda,
            writerPosition: writerPosPda,
            vaultMintRecord: vaultMintRecordPda,
            protocolState: protocolStatePda,
            market: marketPda,
            optionMint: optionMintPda,
            purchaseEscrow: purchaseEscrowPda,
            buyerOptionAccount,
            buyerUsdcAccount,
            vaultUsdcAccount: vaultUsdcPda,
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
      }

      // Burn unsold (2 remaining)
      await program.methods
        .burnUnsoldFromVault()
        .accounts({
          writer: writer.publicKey,
          sharedVault: vaultPda,
          writerPosition: writerPosPda,
          vaultMintRecord: vaultMintRecordPda,
          protocolState: protocolStatePda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([writer])
        .rpc();
    });

    it("FAIL: withdraw with unclaimed premium → ClaimPremiumFirst", async function () {
      this.timeout(30_000);

      // Verify there IS unclaimed premium
      const vault = await program.account.sharedVault.fetch(vaultPda);
      assert.ok(vault.netPremiumCollected.toNumber() > 0, "Premium should exist");

      const writerPos = await program.account.writerPosition.fetch(writerPosPda);
      assert.equal(writerPos.premiumClaimed.toNumber(), 0, "Premium should be unclaimed");

      // Try to withdraw free collateral (writer has 3 options minted * $200 = $600 committed)
      // Free = $10,000 - $600 = $9,400 — try to withdraw a small amount
      try {
        await program.methods
          .withdrawFromVault(usdc(100)) // withdraw 100 shares (small amount)
          .accounts({
            writer: writer.publicKey,
            sharedVault: vaultPda,
            writerPosition: writerPosPda,
            vaultUsdcAccount: vaultUsdcPda,
            writerUsdcAccount,
            protocolState: protocolStatePda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([writer])
          .rpc();
        assert.fail("Should have failed with ClaimPremiumFirst");
      } catch (e) {
        assert.include(e.toString(), "ClaimPremiumFirst",
          "MEDIUM-01: withdraw_from_vault should require premium claimed first");
      }
    });

    it("SUCCESS: claim premium then withdraw", async function () {
      this.timeout(30_000);

      // Step 1: Claim premium
      await program.methods
        .claimPremium()
        .accounts({
          writer: writer.publicKey,
          sharedVault: vaultPda,
          writerPosition: writerPosPda,
          vaultUsdcAccount: vaultUsdcPda,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writer])
        .rpc();

      // Step 2: Now withdraw should succeed
      const beforeBalance = await getAccount(connection, writerUsdcAccount);

      await program.methods
        .withdrawFromVault(usdc(100))
        .accounts({
          writer: writer.publicKey,
          sharedVault: vaultPda,
          writerPosition: writerPosPda,
          vaultUsdcAccount: vaultUsdcPda,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writer])
        .rpc();

      const afterBalance = await getAccount(connection, writerUsdcAccount);
      const withdrawn = Number(afterBalance.amount) - Number(beforeBalance.amount);
      assert.ok(withdrawn > 0, "Writer should have withdrawn collateral after claiming premium");
    });
  });
});
