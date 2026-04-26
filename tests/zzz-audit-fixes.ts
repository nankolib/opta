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
  transfer as splTransfer,
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

  const program = anchor.workspace.opta as Program<Opta>;
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

  // ==========================================================================
  // Premium accrues correctly after partial share withdrawal
  // ==========================================================================
  describe("Premium accrues correctly after partial share withdrawal", () => {
    let writer: Keypair;
    let buyer: Keypair;
    let writerUsdcAccount: PublicKey;
    let buyerUsdcAccount: PublicKey;
    let vaultPda: PublicKey;
    let vaultUsdcPda: PublicKey;
    let writerPosPda: PublicKey;
    let marketPda: PublicKey;
    let optionMintPda: PublicKey;
    let purchaseEscrowPda: PublicKey;
    let vaultMintRecordPda: PublicKey;
    let extraAccountMetaList: PublicKey;
    let hookState: PublicKey;
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

      const expiry = new BN(Math.floor(Date.now() / 1000) + 3600);
      [marketPda] = deriveMarketPda("PREM", strike, expiry, 0);

      await program.methods
        .createMarket("PREM", strike, expiry, { call: {} }, Keypair.generate().publicKey, 0)
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

      // Step 1: Writer deposits 100 USDC
      [writerPosPda] = deriveWriterPositionPda(vaultPda, writer.publicKey);
      await program.methods
        .depositToVault(usdc(100))
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

      // Step 2: Mint 1 option (uses $200 collateral for call at $100 strike with 2x)
      // Actually we only have $100, so mint amount must respect collateral
      // With $100 strike call: collateral_per_contract = $200 — can't mint any!
      // Use a $10 strike instead to allow minting with $100 collateral
    });

    it("premium accrues correctly after partial share withdrawal", async function () {
      this.timeout(60_000);

      // We need a separate vault with parameters that let us mint with small collateral.
      // Redesign: use $10 strike so 2x collateral = $20/contract. $100 deposit = max 5 contracts.
      // But the market is already created with $100 strike. We need a new market.

      // Create a new market with $10 strike
      const smallStrike = usdc(10);
      const expiry = new BN(Math.floor(Date.now() / 1000) + 3600);
      const [mktPda] = deriveMarketPda("PRMS", smallStrike, expiry, 0);

      await program.methods
        .createMarket("PRMS", smallStrike, expiry, { call: {} }, Keypair.generate().publicKey, 0)
        .accounts({
          admin: payer.publicKey,
          protocolState: protocolStatePda,
          market: mktPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();

      const [vPda] = deriveSharedVaultPda(mktPda, smallStrike, expiry, 0);
      const [vUsdcPda] = deriveVaultUsdcPda(vPda);

      await program.methods
        .createSharedVault(smallStrike, expiry, { call: {} }, { custom: {} })
        .accounts({
          creator: writer.publicKey,
          market: mktPda,
          sharedVault: vPda,
          vaultUsdcAccount: vUsdcPda,
          usdcMint,
          protocolState: protocolStatePda,
          epochConfig: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writer])
        .rpc();

      // Writer deposits 100 USDC → 100,000,000 shares (1:1 with micro-USDC)
      const [wPosPda] = deriveWriterPositionPda(vPda, writer.publicKey);
      await program.methods
        .depositToVault(usdc(100))
        .accounts({
          writer: writer.publicKey,
          sharedVault: vPda,
          writerPosition: wPosPda,
          vaultUsdcAccount: vUsdcPda,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([writer])
        .rpc();

      // Mint 1 option ($10 strike, 2x = $20 collateral committed)
      const mintCreatedAt1 = new BN(Math.floor(Date.now() / 1000));
      const [mintPda1] = deriveVaultOptionMintPda(vPda, writer.publicKey, mintCreatedAt1);
      const [escrowPda1] = deriveVaultPurchaseEscrowPda(vPda, writer.publicKey, mintCreatedAt1);
      const [mintRecPda1] = deriveVaultMintRecordPda(mintPda1);
      const [eaml1] = deriveExtraAccountMetaListPda(mintPda1);
      const [hs1] = deriveHookStatePda(mintPda1);

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await program.methods
          .mintFromVault(new BN(1), usdc(10), mintCreatedAt1) // $10 premium
          .accounts({
            writer: writer.publicKey,
            sharedVault: vPda,
            writerPosition: wPosPda,
            market: mktPda,
            protocolState: protocolStatePda,
            optionMint: mintPda1,
            purchaseEscrow: escrowPda1,
            vaultMintRecord: mintRecPda1,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList: eaml1,
            hookState: hs1,
            systemProgram: SystemProgram.programId,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([writer])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [writer]);
      }

      // Buyer purchases the 1 option → $10 premium (minus 0.5% fee = $9.95 to vault)
      const buyerOptAcc1 = await createAssociatedTokenAccountIdempotent(
        connection, payer, mintPda1, buyer.publicKey, {}, TOKEN_2022_PROGRAM_ID,
      );

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await program.methods
          .purchaseFromVault(new BN(1), usdc(999_999))
          .accounts({
            buyer: buyer.publicKey,
            sharedVault: vPda,
            writerPosition: wPosPda,
            vaultMintRecord: mintRecPda1,
            protocolState: protocolStatePda,
            market: mktPda,
            optionMint: mintPda1,
            purchaseEscrow: escrowPda1,
            buyerOptionAccount: buyerOptAcc1,
            buyerUsdcAccount,
            vaultUsdcAccount: vUsdcPda,
            treasury: treasuryPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList: eaml1,
            hookState: hs1,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [buyer]);
      }

      // Step 3: Writer claims first round of premium
      const beforeClaim1 = await getAccount(connection, writerUsdcAccount);
      await program.methods
        .claimPremium()
        .accounts({
          writer: writer.publicKey,
          sharedVault: vPda,
          writerPosition: wPosPda,
          vaultUsdcAccount: vUsdcPda,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writer])
        .rpc();

      const afterClaim1 = await getAccount(connection, writerUsdcAccount);
      const firstClaim = Number(afterClaim1.amount) - Number(beforeClaim1.amount);
      console.log(`    First premium claim: $${firstClaim / 1_000_000}`);
      assert.ok(firstClaim > 0, "First claim should be > 0");

      // Step 4: Writer withdraws 50% of shares (must burn unsold first to free collateral)
      // Actually the 1 option is sold, so options_minted = 1 and committed = $20.
      // Writer has $100 deposited, $20 committed, $80 free.
      // Withdraw 50M shares (half of 100M) = $50 withdrawal. $50 > free($80) check passes.
      const halfShares = usdc(50); // 50,000,000 shares
      await program.methods
        .withdrawFromVault(halfShares)
        .accounts({
          writer: writer.publicKey,
          sharedVault: vPda,
          writerPosition: wPosPda,
          vaultUsdcAccount: vUsdcPda,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writer])
        .rpc();

      // Verify shares are halved
      const posAfterWithdraw = await program.account.writerPosition.fetch(wPosPda);
      assert.equal(posAfterWithdraw.shares.toNumber(), halfShares.toNumber(),
        "Writer should have 50M shares remaining");

      // Step 5: Mint another option and buyer purchases → generates more premium
      const mintCreatedAt2 = new BN(Math.floor(Date.now() / 1000) + 1);
      const [mintPda2] = deriveVaultOptionMintPda(vPda, writer.publicKey, mintCreatedAt2);
      const [escrowPda2] = deriveVaultPurchaseEscrowPda(vPda, writer.publicKey, mintCreatedAt2);
      const [mintRecPda2] = deriveVaultMintRecordPda(mintPda2);
      const [eaml2] = deriveExtraAccountMetaListPda(mintPda2);
      const [hs2] = deriveHookStatePda(mintPda2);

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await program.methods
          .mintFromVault(new BN(1), usdc(10), mintCreatedAt2) // another $10 premium option
          .accounts({
            writer: writer.publicKey,
            sharedVault: vPda,
            writerPosition: wPosPda,
            market: mktPda,
            protocolState: protocolStatePda,
            optionMint: mintPda2,
            purchaseEscrow: escrowPda2,
            vaultMintRecord: mintRecPda2,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList: eaml2,
            hookState: hs2,
            systemProgram: SystemProgram.programId,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([writer])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [writer]);
      }

      const buyerOptAcc2 = await createAssociatedTokenAccountIdempotent(
        connection, payer, mintPda2, buyer.publicKey, {}, TOKEN_2022_PROGRAM_ID,
      );

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await program.methods
          .purchaseFromVault(new BN(1), usdc(999_999))
          .accounts({
            buyer: buyer.publicKey,
            sharedVault: vPda,
            writerPosition: wPosPda,
            vaultMintRecord: mintRecPda2,
            protocolState: protocolStatePda,
            market: mktPda,
            optionMint: mintPda2,
            purchaseEscrow: escrowPda2,
            buyerOptionAccount: buyerOptAcc2,
            buyerUsdcAccount,
            vaultUsdcAccount: vUsdcPda,
            treasury: treasuryPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList: eaml2,
            hookState: hs2,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [buyer]);
      }

      // Step 6: Writer claims second round of premium
      const beforeClaim2 = await getAccount(connection, writerUsdcAccount);
      await program.methods
        .claimPremium()
        .accounts({
          writer: writer.publicKey,
          sharedVault: vPda,
          writerPosition: wPosPda,
          vaultUsdcAccount: vUsdcPda,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writer])
        .rpc();

      const afterClaim2 = await getAccount(connection, writerUsdcAccount);
      const secondClaim = Number(afterClaim2.amount) - Number(beforeClaim2.amount);
      console.log(`    Second premium claim (after 50% withdrawal): $${secondClaim / 1_000_000}`);

      // Step 7: Verify the writer gets the FULL second premium, not half.
      // Writer is the only depositor, so they should get 100% of the new premium.
      // Premium = $10 - 0.5% fee = $9.95 = 9,950,000 micro-USDC
      // Without the fix, they'd get ~$4.975 (half) because stale debt/claimed would
      // cause the accumulator math to think half was already claimed.
      assert.ok(secondClaim >= usdc(9).toNumber(),
        `Second claim should be ~$9.95 (full premium), got $${secondClaim / 1_000_000}. ` +
        `Without the debt reset fix, this would be ~$4.975 (half).`);
    });
  });

  // ==========================================================================
  // Last writer withdrawal succeeds with premium rounding dust
  // ==========================================================================
  describe("Last writer withdrawal succeeds with premium rounding dust", () => {
    let ctx: Awaited<ReturnType<typeof setupVaultScenario>>;
    const strike = usdc(100);

    before(async function () {
      this.timeout(120_000);

      // Set up a single-writer vault with options purchased
      ctx = await setupVaultScenario({
        assetName: "DUST",
        strike,
        expirySeconds: 10,
        optionType: { call: {} },
        optionTypeIndex: 0,
        depositAmount: usdc(1000),
        mintQuantity: 1,
        premiumPerContract: usdc(5),
        buyQuantity: 1,
      });

      // Claim premium so the vault holds only collateral + any rounding remainder
      await program.methods
        .claimPremium()
        .accounts({
          writer: ctx.writer.publicKey,
          sharedVault: ctx.vaultPda,
          writerPosition: ctx.writerPosPda,
          vaultUsdcAccount: ctx.vaultUsdcPda,
          writerUsdcAccount: ctx.writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([ctx.writer])
        .rpc();

      // Inject dust: transfer 3 micro-USDC directly into the vault USDC account.
      // This simulates multi-writer accumulator truncation leaving rounding dust.
      // (In production, dust comes from integer division across multiple writers.)
      // Anyone can send tokens to a token account — no authority needed on the destination.
      const payerUsdcAccount = await createTokenAccount(
        connection, payer, usdcMint, payer.publicKey, undefined, undefined, TOKEN_PROGRAM_ID,
      );
      await mintTo(connection, payer, usdcMint, payerUsdcAccount, payer, 100);
      await splTransfer(
        connection, payer, payerUsdcAccount, ctx.vaultUsdcPda, payer, 3,
        undefined, undefined, TOKEN_PROGRAM_ID,
      );

      console.log("    Waiting 12s for DUST market expiry...");
      await sleep(12_000);

      // Settle market OTM so all collateral returns
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

    it("last writer withdrawal succeeds — dust swept, vault USDC account closed", async function () {
      this.timeout(30_000);

      // Verify there IS dust in the vault before withdrawal
      const vaultUsdcBefore = await getAccount(connection, ctx.vaultUsdcPda);
      console.log(`    Vault USDC balance before last writer withdrawal: ${vaultUsdcBefore.amount}`);

      // Without the dust sweep fix, this would revert because close_account
      // requires exact zero balance, but 3 micro-USDC of dust remains.
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

      // Vault USDC account should be closed — dust sweep prevented close_account revert
      const vaultUsdcInfo = await connection.getAccountInfo(ctx.vaultUsdcPda);
      assert.isNull(vaultUsdcInfo,
        "Vault USDC account should be closed — dust sweep prevents close_account revert");
    });
  });
});
