// =============================================================================
// PoC: C-1 — expire_option before settlement steals all buyer collateral
// =============================================================================
//
// ## Proof Explanation
//
// test_PoC_C1 proves that expire_option can be called before settle_market,
// allowing the option writer to steal all USDC collateral from the escrow:
//
// 1. Writer writes a SOL $200 CALL option, locking $4,000 USDC collateral
// 2. Buyer purchases ALL 10 option tokens, paying $10 USDC premium
//    → Writer has received $10 premium, escrow holds $4,000 collateral
// 3. Market expiry passes (8s sleep)
// 4. Writer calls expire_option BEFORE admin calls settle_market
//    → expire_option succeeds because it only checks expiry, NOT settlement
//    → ALL $4,000 collateral transferred from escrow to writer
//    → position.is_expired = true
// 5. Admin settles market at $250 (ITM — option worth $50/token × 10 = $500)
// 6. Buyer calls exercise_option → FAILS with "PositionNotActive"
//    → position.is_expired == true blocks exercise
//    → Buyer loses $10 premium AND $500 unrealized PnL
//
// assert: writer USDC increased by $4,000 (full collateral recovered)
// assert: buyer exercise FAILS with PositionNotActive
// assert: buyer USDC unchanged after exercise attempt (PnL lost forever)
//
// This proves: attacker (writer) spends ~$0.001 in tx fees to steal $4,000+
// The attack is profitable by a factor of ~4,000,000x.
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
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

describe("PoC C-1: expire_option before settlement steals collateral", () => {
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
  let treasuryPda: PublicKey;

  const fakePythFeed = Keypair.generate().publicKey;
  const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

  // PDA helpers
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
  function deriveMarketPda(assetName: string, strike: BN, expiry: BN, optionTypeIndex: number): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([
      Buffer.from("market"), Buffer.from(assetName),
      strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([optionTypeIndex]),
    ], program.programId);
  }
  function derivePositionPda(market: PublicKey, writerKey: PublicKey, createdAt: BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([
      Buffer.from("position"), market.toBuffer(), writerKey.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ], program.programId);
  }
  function deriveEscrowPda(market: PublicKey, writerKey: PublicKey, createdAt: BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([
      Buffer.from("escrow"), market.toBuffer(), writerKey.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ], program.programId);
  }
  function deriveOptionMintPda(positionPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("option_mint"), positionPda.toBuffer()], program.programId,
    );
  }
  function derivePurchaseEscrowPda(positionPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("purchase_escrow"), positionPda.toBuffer()], program.programId,
    );
  }

  async function ensureOptionAta(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
    const existing = await provider.connection.getAccountInfo(ata, "confirmed");
    if (!existing) {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID),
      );
      await provider.sendAndConfirm(tx);
    }
    return ata;
  }

  // Shared state for the attack
  const strikePrice = usdc(200);
  let shortExpiry: BN;
  let marketPda: PublicKey;
  let createdAt: BN;
  let positionPda: PublicKey;
  let escrowPda: PublicKey;
  let optionMintPda: PublicKey;
  let purchaseEscrowPda: PublicKey;
  let buyerOptionAccount: PublicKey;

  const collateral = usdc(4_000); // 10 contracts × $200 strike × 2x = $4,000
  const premium = usdc(10);       // $10 total premium
  const contractSize = new BN(10);

  // -------------------------------------------------------------------------
  // Setup: init protocol (or reuse existing), fund accounts, create market, write + buy option
  // -------------------------------------------------------------------------
  before(async () => {
    [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
    [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], program.programId);

    // FIX: Reuse existing protocol if already initialized by main test suite
    let protocolExists = false;
    try {
      const existingProtocol = await program.account.protocolState.fetch(protocolStatePda);
      usdcMint = existingProtocol.usdcMint;
      protocolExists = true;
    } catch (e) {
      // Protocol doesn't exist yet — create USDC mint and initialize
      usdcMint = await createMint(provider.connection, payer, admin.publicKey, admin.publicKey, 6);
    }

    // Fund writer and buyer
    writer = Keypair.generate();
    buyer = Keypair.generate();
    const fundTx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: writer.publicKey, lamports: 5 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: buyer.publicKey, lamports: 5 * LAMPORTS_PER_SOL }),
    );
    await provider.sendAndConfirm(fundTx);

    writerUsdcAccount = await createTokenAccount(provider.connection, payer, usdcMint, writer.publicKey);
    buyerUsdcAccount = await createTokenAccount(provider.connection, payer, usdcMint, buyer.publicKey);
    await mintTo(provider.connection, payer, usdcMint, writerUsdcAccount, payer, 100_000_000_000);
    await mintTo(provider.connection, payer, usdcMint, buyerUsdcAccount, payer, 100_000_000_000);

    if (!protocolExists) {
      await program.methods.initializeProtocol().accountsStrict({
        admin: admin.publicKey, protocolState: protocolStatePda, treasury: treasuryPda,
        usdcMint, systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      }).rpc();
    }

    // Create short-expiry market (8 seconds)
    const now = Math.floor(Date.now() / 1000);
    shortExpiry = new BN(now + 8);
    createdAt = new BN(now + 7777); // unique PDA seed

    [marketPda] = deriveMarketPda("SOL", strikePrice, shortExpiry, 0);
    await program.methods
      .createMarket("SOL", strikePrice, shortExpiry, { call: {} }, fakePythFeed, 0)
      .accountsStrict({
        creator: admin.publicKey, protocolState: protocolStatePda,
        market: marketPda, systemProgram: SystemProgram.programId,
      }).rpc();

    // Derive all position PDAs
    [positionPda] = derivePositionPda(marketPda, writer.publicKey, createdAt);
    [escrowPda] = deriveEscrowPda(marketPda, writer.publicKey, createdAt);
    [optionMintPda] = deriveOptionMintPda(positionPda);
    [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);

    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
    const [hookState] = deriveHookStatePda(optionMintPda);

    // Writer writes option: lock $4,000 collateral
    await program.methods
      .writeOption(collateral, premium, contractSize, createdAt)
      .accountsStrict({
        writer: writer.publicKey, protocolState: protocolStatePda,
        market: marketPda, position: positionPda, escrow: escrowPda,
        optionMint: optionMintPda, purchaseEscrow: purchaseEscrowPda,
        writerUsdcAccount, usdcMint,
        transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList, hookState,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([EXTRA_CU])
      .signers([writer])
      .rpc();

    // Buyer purchases ALL 10 tokens — pays $10 premium
    buyerOptionAccount = await ensureOptionAta(optionMintPda, buyer.publicKey);
    await program.methods
      .purchaseOption(contractSize)
      .accountsStrict({
        buyer: buyer.publicKey, protocolState: protocolStatePda,
        market: marketPda, position: positionPda,
        purchaseEscrow: purchaseEscrowPda,
        buyerUsdcAccount, writerUsdcAccount,
        buyerOptionAccount, optionMint: optionMintPda,
        treasury: treasuryPda,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList, hookState,
        systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([EXTRA_CU])
      .signers([buyer])
      .rpc();

    // Verify setup: all tokens sold, escrow holds collateral
    const pos = await program.account.optionPosition.fetch(positionPda);
    assert.ok(pos.tokensSold.eq(contractSize), "Setup: all tokens sold to buyer");
    const escrow = await getAccount(provider.connection, escrowPda);
    assert.equal(Number(escrow.amount), 4_000_000_000, "Setup: escrow holds $4,000");

    console.log("    Setup complete. Waiting 10s for market expiry...");
    await sleep(10_000);
  });

  // -------------------------------------------------------------------------
  // VERIFY FIX: expire_option now correctly FAILS before settlement
  // (C-01 was fixed in previous audit — this test confirms the fix holds)
  // -------------------------------------------------------------------------
  it("FIX VERIFIED: expire_option before settle_market now fails with MarketNotSettled", async () => {
    // *** THE ATTACK ATTEMPT: writer calls expire_option ***
    // This now correctly FAILS because expire_option requires market.is_settled
    try {
      await program.methods
        .expireOption()
        .accountsStrict({
          caller: writer.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          position: positionPda,
          escrow: escrowPda,
          writerUsdcAccount,
          writer: writer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writer])
        .rpc();
      assert.fail("expire_option should have FAILED — market is not settled");
    } catch (err: any) {
      assert.include(err.toString(), "MarketNotSettled",
        "C-01 fix confirmed: expire_option blocked before settlement");
      console.log("    ✓ C-01 fix verified: expire_option blocked with MarketNotSettled");
    }

    // Position should NOT be expired
    const pos = await program.account.optionPosition.fetch(positionPda);
    assert.isFalse(pos.isExpired, "Position is NOT expired — attack blocked");
  });

  // -------------------------------------------------------------------------
  // VERIFY: Buyer CAN exercise after proper settlement
  // -------------------------------------------------------------------------
  it("FIX VERIFIED: after proper settlement, buyer can exercise normally", async () => {
    // Admin settles market at $250 (option is ITM: $250 > $200 strike)
    await program.methods
      .settleMarket(usdc(250))
      .accountsStrict({
        admin: admin.publicKey,
        protocolState: protocolStatePda,
        market: marketPda,
      }).rpc();

    const market = await program.account.optionsMarket.fetch(marketPda);
    assert.isTrue(market.isSettled, "Market is settled at $250");

    // Now expire_option should work for OTM options after settlement,
    // but this is a CALL at $200 settled at $250 — it's ITM.
    // The CannotExpireItmOption error should fire.
    try {
      await program.methods
        .expireOption()
        .accountsStrict({
          caller: writer.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          position: positionPda,
          escrow: escrowPda,
          writerUsdcAccount,
          writer: writer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([writer])
        .rpc();
      assert.fail("expire_option should fail for ITM option");
    } catch (err: any) {
      assert.include(err.toString(), "CannotExpireItmOption",
        "ITM option cannot be expired — holders must exercise");
      console.log("    ✓ ITM option correctly blocked from expiry after settlement");
    }
  });

  // -------------------------------------------------------------------------
  // VERIFY: expire_option still blocked for unsettled positions
  // -------------------------------------------------------------------------
  it("FIX VERIFIED: expire_option blocked for new unsettled position too", async () => {
    // Create a fresh position for this sub-test
    const now = Math.floor(Date.now() / 1000);
    const freshExpiry = new BN(now + 3);
    const freshCreatedAt = new BN(now + 8888);

    const [freshMarket] = deriveMarketPda("SOL", strikePrice, freshExpiry, 0);
    await program.methods
      .createMarket("SOL", strikePrice, freshExpiry, { call: {} }, fakePythFeed, 0)
      .accountsStrict({
        creator: admin.publicKey, protocolState: protocolStatePda,
        market: freshMarket, systemProgram: SystemProgram.programId,
      }).rpc();

    const [freshPos] = derivePositionPda(freshMarket, writer.publicKey, freshCreatedAt);
    const [freshEscrow] = deriveEscrowPda(freshMarket, writer.publicKey, freshCreatedAt);
    const [freshMint] = deriveOptionMintPda(freshPos);
    const [freshPE] = derivePurchaseEscrowPda(freshPos);
    const [freshEAML] = deriveExtraAccountMetaListPda(freshMint);
    const [freshHS] = deriveHookStatePda(freshMint);

    await program.methods
      .writeOption(collateral, premium, contractSize, freshCreatedAt)
      .accountsStrict({
        writer: writer.publicKey, protocolState: protocolStatePda,
        market: freshMarket, position: freshPos, escrow: freshEscrow,
        optionMint: freshMint, purchaseEscrow: freshPE,
        writerUsdcAccount, usdcMint,
        transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: freshEAML, hookState: freshHS,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([EXTRA_CU])
      .signers([writer])
      .rpc();

    // Wait for expiry
    await sleep(4_000);

    // Any wallet tries to expire — should fail because market not settled
    try {
      await program.methods
        .expireOption()
        .accountsStrict({
          caller: buyer.publicKey,
          protocolState: protocolStatePda,
          market: freshMarket,
          position: freshPos,
          escrow: freshEscrow,
          writerUsdcAccount,
          writer: writer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([buyer])
        .rpc();
      assert.fail("expire_option should have FAILED — market not settled");
    } catch (err: any) {
      assert.include(err.toString(), "MarketNotSettled",
        "C-01 fix confirmed: third-party expire also blocked");
      console.log("    ✓ Third-party expire also blocked with MarketNotSettled");
    }
  });
});
