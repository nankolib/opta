// =============================================================================
// tests/zzz-auto-finalize-holders.ts — Tests for auto_finalize_holders
// =============================================================================
//
// Step 2 of the auto-finalize work (see docs/AUTO_FINALIZE_PLAN.md). Tests
// only the holder-side instruction shipped in commits a7924d2 + ecdc7a3.
// Writer-side, crank, and end-to-end smoke are NOT in scope.
//
// Cases covered:
//   1. ITM call vault, 3 holders — burn + USDC payout per holder
//   2. ITM put vault, 3 holders
//   3. OTM call vault, 3 holders — burn-only, no USDC moves
//   4. OTM put vault, 3 holders
//   5. Mixed pool — secondary-market holder receives proper share
//   6. Multi-ATA holder — wallet with two Token-2022 accounts of same mint
//   7. Single-holder, batch size 1
//   8. Race vs. manual exercise — already-burned holder skipped silently
//   9. Idempotent re-run — second call is a no-op
//  10. Pre-settlement call — must revert with VaultNotSettled
//  11. Mismatched USDC ATA — silent skip, holder NOT burned
//
// Deviations from plan §5.1: each test uses 1 writer (not 2). The
// auto_finalize_holders handler doesn't read writer state — writer count is
// orthogonal to this instruction's behavior. Multi-writer concerns belong
// to auto_finalize_writers (Step 3). Custom vaults don't allow multi-writer
// anyway; using Epoch would require Friday-08:00-UTC expiries which doesn't
// fit a 10-second-expiry test pattern.
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
  AccountMeta,
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
  transferChecked,
  ExtensionType,
  getAccountLen,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";

import { fixturePubkey } from "./_pyth_fixtures";

// ---- Asset registry --------------------------------------------------------
const SOL_FEED_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const SOL_ID = Array.from(Buffer.from(SOL_FEED_HEX, "hex"));

const SOL_250_FRESH = fixturePubkey("sol-250-fresh"); // settlement = $250
const SOL_50_FRESH = fixturePubkey("sol-50-fresh");   // settlement = $50

// ---- Helpers ---------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

describe("auto-finalize-holders", () => {
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
  let marketPda: PublicKey;

  // ---- PDA helpers ---------------------------------------------------------
  function deriveProtocolStatePda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
  }
  function deriveTreasuryPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], program.programId);
  }
  function deriveEpochConfigPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("epoch_config")], program.programId);
  }
  function deriveMarketPda(asset: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(asset)],
      program.programId,
    );
  }
  function deriveSettlementPda(asset: string, expiry: BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("settlement"), Buffer.from(asset), expiry.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
  }
  function deriveSharedVaultPda(
    market: PublicKey, strike: BN, expiry: BN, optTypeIdx: number,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("shared_vault"),
        market.toBuffer(),
        strike.toArrayLike(Buffer, "le", 8),
        expiry.toArrayLike(Buffer, "le", 8),
        Buffer.from([optTypeIdx]),
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
  function deriveWriterPositionPda(vault: PublicKey, owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("writer_position"), vault.toBuffer(), owner.toBuffer()],
      program.programId,
    );
  }
  function deriveVaultOptionMintPda(
    vault: PublicKey, writer: PublicKey, createdAt: BN,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault_option_mint"),
        vault.toBuffer(), writer.toBuffer(),
        createdAt.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
  }
  function deriveVaultPurchaseEscrowPda(
    vault: PublicKey, writer: PublicKey, createdAt: BN,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault_purchase_escrow"),
        vault.toBuffer(), writer.toBuffer(),
        createdAt.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );
  }
  function deriveVaultMintRecordPda(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault_mint_record"), mint.toBuffer()],
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

  // ---- One-time protocol bootstrap ----------------------------------------
  before(async () => {
    [protocolStatePda] = deriveProtocolStatePda();
    [treasuryPda] = deriveTreasuryPda();
    [epochConfigPda] = deriveEpochConfigPda();

    try {
      const existing = await program.account.protocolState.fetch(protocolStatePda);
      usdcMint = existing.usdcMint;
    } catch {
      usdcMint = await createMint(
        connection, payer, payer.publicKey, null, 6,
        undefined, undefined, TOKEN_PROGRAM_ID,
      );
      await (program as any).methods
        .initializeProtocol()
        .accounts({
          admin: payer.publicKey, usdcMint,
          protocolState: protocolStatePda, treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([payer])
        .rpc();
    }

    try {
      await program.account.epochConfig.fetch(epochConfigPda);
    } catch {
      await (program as any).methods
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

    [marketPda] = deriveMarketPda("SOL");
    try {
      await (program as any).methods
        .createMarket("SOL", SOL_ID, 0)
        .accounts({
          creator: payer.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();
    } catch { /* idempotent */ }
  });

  // ---- Scenario builder ----------------------------------------------------
  // Builds a Custom vault, single writer, N holders. Each holder buys
  // `quantityPerHolder` contracts. Returns everything needed for assertions.
  async function buildScenario(opts: {
    strike: BN;
    optionType: { call: {} } | { put: {} };
    optionTypeIndex: number;
    numHolders: number;
    quantityPerHolder: number;
    premiumPerContract: BN;
    expirySeconds: number;
  }) {
    const writer = Keypair.generate();
    const holders: Keypair[] = [];
    for (let i = 0; i < opts.numHolders; i++) holders.push(Keypair.generate());

    // Airdrops
    for (const kp of [writer, ...holders]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }

    // USDC accounts + funding
    const writerUsdc = await createTokenAccount(
      connection, payer, usdcMint, writer.publicKey,
      undefined, undefined, TOKEN_PROGRAM_ID,
    );
    await mintTo(connection, payer, usdcMint, writerUsdc, payer, 100_000_000_000);

    const holderUsdcs: PublicKey[] = [];
    for (const h of holders) {
      const ata = await createTokenAccount(
        connection, payer, usdcMint, h.publicKey,
        undefined, undefined, TOKEN_PROGRAM_ID,
      );
      await mintTo(connection, payer, usdcMint, ata, payer, 50_000_000_000);
      holderUsdcs.push(ata);
    }

    // Vault setup
    const expiry = new BN(Math.floor(Date.now() / 1000) + opts.expirySeconds);
    const [vaultPda] = deriveSharedVaultPda(marketPda, opts.strike, expiry, opts.optionTypeIndex);
    const [vaultUsdcPda] = deriveVaultUsdcPda(vaultPda);

    await (program as any).methods
      .createSharedVault(
        opts.strike, expiry, opts.optionType, { custom: {} }, usdcMint,
      )
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

    // Deposit collateral. For calls, 2x strike per contract; for puts, 1x.
    const collateralPerContract = opts.optionTypeIndex === 0
      ? opts.strike.muln(2) : opts.strike;
    const totalQty = opts.numHolders * opts.quantityPerHolder;
    const totalCollateral = collateralPerContract.muln(totalQty).muln(2); // 2x buffer
    const [writerPosPda] = deriveWriterPositionPda(vaultPda, writer.publicKey);

    await (program as any).methods
      .depositToVault(totalCollateral)
      .accounts({
        writer: writer.publicKey,
        sharedVault: vaultPda,
        writerPosition: writerPosPda,
        vaultUsdcAccount: vaultUsdcPda,
        writerUsdcAccount: writerUsdc,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([writer])
      .rpc();

    // Mint
    const mintCreatedAt = new BN(Math.floor(Date.now() / 1000));
    const [optionMintPda] = deriveVaultOptionMintPda(vaultPda, writer.publicKey, mintCreatedAt);
    const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(vaultPda, writer.publicKey, mintCreatedAt);
    const [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
    const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
    const [hookState] = deriveHookStatePda(optionMintPda);

    {
      const tx = new Transaction().add(EXTRA_CU);
      const ix = await (program as any).methods
        .mintFromVault(new BN(totalQty), opts.premiumPerContract, mintCreatedAt)
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

    // Each holder purchases `quantityPerHolder`
    const holderOptionAtas: PublicKey[] = [];
    for (let i = 0; i < holders.length; i++) {
      const h = holders[i];
      const ata = await createAssociatedTokenAccountIdempotent(
        connection, payer, optionMintPda, h.publicKey, {}, TOKEN_2022_PROGRAM_ID,
      );
      holderOptionAtas.push(ata);

      const tx = new Transaction().add(EXTRA_CU);
      const ix = await (program as any).methods
        .purchaseFromVault(new BN(opts.quantityPerHolder), usdc(999_999))
        .accounts({
          buyer: h.publicKey,
          sharedVault: vaultPda,
          writerPosition: writerPosPda,
          vaultMintRecord: vaultMintRecordPda,
          protocolState: protocolStatePda,
          market: marketPda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          buyerOptionAccount: ata,
          buyerUsdcAccount: holderUsdcs[i],
          vaultUsdcAccount: vaultUsdcPda,
          treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          transferHookProgram: HOOK_PROGRAM_ID,
          extraAccountMetaList,
          hookState,
          systemProgram: SystemProgram.programId,
        })
        .signers([h])
        .instruction();
      tx.add(ix);
      await provider.sendAndConfirm(tx, [h]);
    }

    return {
      writer, writerUsdc, writerPosPda,
      holders, holderUsdcs, holderOptionAtas,
      vaultPda, vaultUsdcPda, optionMintPda, purchaseEscrowPda,
      vaultMintRecordPda, extraAccountMetaList, hookState,
      expiry, mintCreatedAt,
    };
  }

  async function settleAfterExpiry(
    expiry: BN, vaultPda: PublicKey, pythFixture: PublicKey,
  ) {
    const [settlementPda] = deriveSettlementPda("SOL", expiry);
    await (program as any).methods
      .settleExpiry("SOL", expiry)
      .accounts({
        caller: payer.publicKey,
        market: marketPda,
        priceUpdate: pythFixture,
        settlementRecord: settlementPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    await (program as any).methods
      .settleVault()
      .accounts({
        authority: payer.publicKey,
        sharedVault: vaultPda,
        market: marketPda,
        settlementRecord: settlementPda,
      })
      .signers([payer])
      .rpc();
  }

  async function callAutoFinalizeHolders(
    ctx: {
      vaultPda: PublicKey;
      vaultUsdcPda: PublicKey;
      optionMintPda: PublicKey;
      vaultMintRecordPda: PublicKey;
    },
    pairs: { holderOption: PublicKey; holderUsdc: PublicKey }[],
    caller: Keypair = payer,
  ): Promise<string> {
    const remaining: AccountMeta[] = [];
    for (const p of pairs) {
      remaining.push({ pubkey: p.holderOption, isSigner: false, isWritable: true });
      remaining.push({ pubkey: p.holderUsdc, isSigner: false, isWritable: true });
    }

    const tx = new Transaction().add(EXTRA_CU);
    const ix = await (program as any).methods
      .autoFinalizeHolders()
      .accounts({
        caller: caller.publicKey,
        sharedVault: ctx.vaultPda,
        market: marketPda,
        vaultMintRecord: ctx.vaultMintRecordPda,
        optionMint: ctx.optionMintPda,
        vaultUsdcAccount: ctx.vaultUsdcPda,
        protocolState: protocolStatePda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(remaining)
      .signers([caller])
      .instruction();
    tx.add(ix);
    return await provider.sendAndConfirm(tx, [caller]);
  }

  async function getOptionAmount(ata: PublicKey): Promise<bigint> {
    const acc = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    return acc.amount;
  }

  async function getUsdcAmount(ata: PublicKey): Promise<bigint> {
    const acc = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    return acc.amount;
  }

  // ==========================================================================
  // 1. ITM call — happy path
  // ==========================================================================
  describe("1. ITM call vault, 3 holders — burn + USDC payout", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    const STRIKE = usdc(200);
    const QTY_PER_HOLDER = 2;

    before(async function () {
      this.timeout(180_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        numHolders: 3,
        quantityPerHolder: QTY_PER_HOLDER,
        premiumPerContract: usdc(5),
        expirySeconds: 10,
      });
      console.log("    Waiting 12s for ITM-call expiry...");
      await sleep(12_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("burns all 3 holders, pays each (settlement-strike) per contract, decrements collateral_remaining, emits HoldersFinalized with mint", async function () {
      this.timeout(60_000);

      // Capture HoldersFinalized event via listener
      const events: any[] = [];
      const listener = program.addEventListener("holdersFinalized", (e: any) => {
        events.push(e);
      });

      // Snapshot pre-state
      const collateralBefore = (await program.account.sharedVault.fetch(ctx.vaultPda))
        .collateralRemaining.toNumber();
      const usdcBefore = await Promise.all(ctx.holderUsdcs.map(getUsdcAmount));

      const pairs = ctx.holderOptionAtas.map((opt, i) => ({
        holderOption: opt, holderUsdc: ctx.holderUsdcs[i],
      }));
      await callAutoFinalizeHolders(ctx, pairs);

      // Give the listener a moment to fire
      await sleep(1500);
      await program.removeEventListener(listener);

      // Each holder ATA is zero
      for (let i = 0; i < ctx.holderOptionAtas.length; i++) {
        const amt = await getOptionAmount(ctx.holderOptionAtas[i]);
        assert.equal(amt, 0n, `holder ${i} option amount should be 0 after burn`);
      }

      // Each holder USDC balance increased by (250 - 200) * 2 = $100
      const expectedPayoutPerHolder = usdc(50).muln(QTY_PER_HOLDER).toNumber(); // $100
      for (let i = 0; i < ctx.holderUsdcs.length; i++) {
        const after = await getUsdcAmount(ctx.holderUsdcs[i]);
        const delta = Number(after - usdcBefore[i]);
        assert.equal(delta, expectedPayoutPerHolder,
          `holder ${i} USDC delta should be $100, got $${delta / 1_000_000}`);
      }

      // collateral_remaining decremented by 3 * $100 = $300
      const collateralAfter = (await program.account.sharedVault.fetch(ctx.vaultPda))
        .collateralRemaining.toNumber();
      assert.equal(
        collateralBefore - collateralAfter,
        expectedPayoutPerHolder * 3,
        "vault.collateral_remaining should drop by total payout",
      );

      // Event fired with all expected fields
      assert.equal(events.length, 1, "exactly one HoldersFinalized event");
      const ev = events[0];
      assert.equal(ev.vault.toBase58(), ctx.vaultPda.toBase58());
      assert.equal(ev.mint.toBase58(), ctx.optionMintPda.toBase58(),
        "event mint must be option_mint (added in commit ecdc7a3)");
      assert.equal(ev.holdersProcessed, 3);
      assert.equal(ev.totalBurned.toNumber(), QTY_PER_HOLDER * 3);
      assert.equal(ev.totalPaidOut.toNumber(), expectedPayoutPerHolder * 3);
    });
  });

  // ==========================================================================
  // 2. ITM put — symmetric
  // ==========================================================================
  describe("2. ITM put vault, 3 holders — symmetric to ITM call", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    const STRIKE = usdc(250);
    const QTY = 2;

    before(async function () {
      this.timeout(180_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { put: {} },
        optionTypeIndex: 1,
        numHolders: 3,
        quantityPerHolder: QTY,
        premiumPerContract: usdc(5),
        expirySeconds: 10,
      });
      console.log("    Waiting 12s for ITM-put expiry...");
      await sleep(12_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_50_FRESH);
    });

    it("burns + pays (strike-settlement) per contract", async function () {
      this.timeout(60_000);
      const usdcBefore = await Promise.all(ctx.holderUsdcs.map(getUsdcAmount));

      const pairs = ctx.holderOptionAtas.map((opt, i) => ({
        holderOption: opt, holderUsdc: ctx.holderUsdcs[i],
      }));
      await callAutoFinalizeHolders(ctx, pairs);

      const expectedPerHolder = usdc(200).muln(QTY).toNumber(); // ($250 - $50) * 2
      for (let i = 0; i < ctx.holderUsdcs.length; i++) {
        const delta = Number((await getUsdcAmount(ctx.holderUsdcs[i])) - usdcBefore[i]);
        assert.equal(delta, expectedPerHolder);
        assert.equal(await getOptionAmount(ctx.holderOptionAtas[i]), 0n);
      }
    });
  });

  // ==========================================================================
  // 3. OTM call — burn-only
  // ==========================================================================
  describe("3. OTM call vault, 3 holders — burn only, no USDC moves", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    const STRIKE = usdc(300);
    const QTY = 1;

    before(async function () {
      this.timeout(180_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        numHolders: 3,
        quantityPerHolder: QTY,
        premiumPerContract: usdc(5),
        expirySeconds: 10,
      });
      console.log("    Waiting 12s for OTM-call expiry...");
      await sleep(12_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_50_FRESH);
    });

    it("each option ATA hits 0; holder USDC unchanged; total_paid_out = 0", async function () {
      this.timeout(60_000);
      const events: any[] = [];
      const listener = program.addEventListener("holdersFinalized", (e: any) => events.push(e));

      const collateralBefore = (await program.account.sharedVault.fetch(ctx.vaultPda))
        .collateralRemaining.toNumber();
      const usdcBefore = await Promise.all(ctx.holderUsdcs.map(getUsdcAmount));

      const pairs = ctx.holderOptionAtas.map((opt, i) => ({
        holderOption: opt, holderUsdc: ctx.holderUsdcs[i],
      }));
      await callAutoFinalizeHolders(ctx, pairs);

      await sleep(1500);
      await program.removeEventListener(listener);

      for (let i = 0; i < ctx.holderOptionAtas.length; i++) {
        assert.equal(await getOptionAmount(ctx.holderOptionAtas[i]), 0n);
      }
      for (let i = 0; i < ctx.holderUsdcs.length; i++) {
        assert.equal(await getUsdcAmount(ctx.holderUsdcs[i]), usdcBefore[i],
          `OTM holder ${i} USDC should be unchanged`);
      }
      const collateralAfter = (await program.account.sharedVault.fetch(ctx.vaultPda))
        .collateralRemaining.toNumber();
      assert.equal(collateralAfter, collateralBefore,
        "OTM: vault.collateral_remaining is unchanged");

      assert.equal(events.length, 1);
      assert.equal(events[0].totalPaidOut.toNumber(), 0);
      assert.equal(events[0].totalBurned.toNumber(), 3 * QTY);
      assert.equal(events[0].holdersProcessed, 3);
    });
  });

  // ==========================================================================
  // 4. OTM put — symmetric
  // ==========================================================================
  describe("4. OTM put vault, 3 holders — burn only", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    const STRIKE = usdc(30);
    const QTY = 1;

    before(async function () {
      this.timeout(180_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { put: {} },
        optionTypeIndex: 1,
        numHolders: 3,
        quantityPerHolder: QTY,
        premiumPerContract: usdc(2),
        expirySeconds: 10,
      });
      console.log("    Waiting 12s for OTM-put expiry...");
      await sleep(12_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("burns each holder, no USDC moves", async function () {
      this.timeout(60_000);
      const usdcBefore = await Promise.all(ctx.holderUsdcs.map(getUsdcAmount));

      const pairs = ctx.holderOptionAtas.map((opt, i) => ({
        holderOption: opt, holderUsdc: ctx.holderUsdcs[i],
      }));
      await callAutoFinalizeHolders(ctx, pairs);

      for (let i = 0; i < ctx.holderOptionAtas.length; i++) {
        assert.equal(await getOptionAmount(ctx.holderOptionAtas[i]), 0n);
        assert.equal(await getUsdcAmount(ctx.holderUsdcs[i]), usdcBefore[i]);
      }
    });
  });

  // ==========================================================================
  // 5. Mixed pool — secondary holder via Token-2022 transfer
  // ==========================================================================
  describe("5. Mixed pool — pre-expiry transfer creates secondary holder", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    let secondaryHolder: Keypair;
    let secondaryHolderOptionAta: PublicKey;
    let secondaryHolderUsdc: PublicKey;
    const STRIKE = usdc(220);
    const QTY = 4; // primary holder buys 4, transfers 2 to secondary

    before(async function () {
      this.timeout(240_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        numHolders: 1, // only primary buyer
        quantityPerHolder: QTY,
        premiumPerContract: usdc(5),
        expirySeconds: 30, // longer — we need to transfer pre-expiry
      });

      // Set up secondary holder + transfer 2 contracts to them
      secondaryHolder = Keypair.generate();
      const sig = await connection.requestAirdrop(secondaryHolder.publicKey, 5 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");

      secondaryHolderUsdc = await createTokenAccount(
        connection, payer, usdcMint, secondaryHolder.publicKey,
        undefined, undefined, TOKEN_PROGRAM_ID,
      );
      secondaryHolderOptionAta = await createAssociatedTokenAccountIdempotent(
        connection, payer, ctx.optionMintPda, secondaryHolder.publicKey, {},
        TOKEN_2022_PROGRAM_ID,
      );

      // Token-2022 transferChecked with the transfer hook program in scope.
      // Transfer hook needs extra accounts; we pass them via remainingAccounts.
      const tx = new Transaction().add(EXTRA_CU);
      const transferIx = await (await import("@solana/spl-token")).createTransferCheckedWithTransferHookInstruction(
        connection,
        ctx.holderOptionAtas[0],
        ctx.optionMintPda,
        secondaryHolderOptionAta,
        ctx.holders[0].publicKey,
        BigInt(2),
        0,
        [],
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      tx.add(transferIx);
      await provider.sendAndConfirm(tx, [ctx.holders[0]]);

      // Wait remaining time for expiry
      const now = Math.floor(Date.now() / 1000);
      const wait = Math.max(0, ctx.expiry.toNumber() + 2 - now);
      console.log(`    Waiting ${wait}s for mixed-pool expiry...`);
      await sleep(wait * 1000);

      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("primary keeps 2, secondary holds 2, both finalized with proportional payout", async function () {
      this.timeout(60_000);
      // Pre-state
      const primaryBefore = await getUsdcAmount(ctx.holderUsdcs[0]);
      const secondaryBefore = await getUsdcAmount(secondaryHolderUsdc);
      assert.equal(await getOptionAmount(ctx.holderOptionAtas[0]), 2n);
      assert.equal(await getOptionAmount(secondaryHolderOptionAta), 2n);

      const pairs = [
        { holderOption: ctx.holderOptionAtas[0], holderUsdc: ctx.holderUsdcs[0] },
        { holderOption: secondaryHolderOptionAta, holderUsdc: secondaryHolderUsdc },
      ];
      await callAutoFinalizeHolders(ctx, pairs);

      // Each side burned + paid
      assert.equal(await getOptionAmount(ctx.holderOptionAtas[0]), 0n);
      assert.equal(await getOptionAmount(secondaryHolderOptionAta), 0n);
      // Payout per contract = $250 - $220 = $30. Each holds 2 = $60.
      const expected = usdc(60).toNumber();
      assert.equal(Number((await getUsdcAmount(ctx.holderUsdcs[0])) - primaryBefore), expected);
      assert.equal(Number((await getUsdcAmount(secondaryHolderUsdc)) - secondaryBefore), expected);
    });
  });

  // ==========================================================================
  // 6. Multi-ATA holder
  // ==========================================================================
  describe("6. Holder owns two Token-2022 accounts of same mint", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    let secondAccountKeypair: Keypair;
    const STRIKE = usdc(240);
    const QTY = 3;

    before(async function () {
      this.timeout(240_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        numHolders: 1,
        quantityPerHolder: QTY,
        premiumPerContract: usdc(5),
        expirySeconds: 30,
      });

      // Create a second non-ATA Token-2022 account for the same wallet.
      // Use a fresh keypair as the address; initialize_account3 lets a
      // wallet own arbitrary token accounts beyond the canonical ATA.
      secondAccountKeypair = Keypair.generate();
      const accountLen = getAccountLen([ExtensionType.TransferHookAccount]);
      const lamports = await connection.getMinimumBalanceForRentExemption(accountLen);

      const splToken = await import("@solana/spl-token");
      const tx = new Transaction()
        .add(EXTRA_CU)
        .add(SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: secondAccountKeypair.publicKey,
          space: accountLen,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }))
        .add(splToken.createInitializeAccount3Instruction(
          secondAccountKeypair.publicKey,
          ctx.optionMintPda,
          ctx.holders[0].publicKey,
          TOKEN_2022_PROGRAM_ID,
        ));
      await provider.sendAndConfirm(tx, [payer, secondAccountKeypair]);

      // Transfer 1 contract from canonical ATA to second account
      const xferTx = new Transaction().add(EXTRA_CU);
      const xferIx = await splToken.createTransferCheckedWithTransferHookInstruction(
        connection,
        ctx.holderOptionAtas[0],
        ctx.optionMintPda,
        secondAccountKeypair.publicKey,
        ctx.holders[0].publicKey,
        BigInt(1),
        0,
        [],
        "confirmed",
        TOKEN_2022_PROGRAM_ID,
      );
      xferTx.add(xferIx);
      await provider.sendAndConfirm(xferTx, [ctx.holders[0]]);

      // Wait for expiry
      const now = Math.floor(Date.now() / 1000);
      const wait = Math.max(0, ctx.expiry.toNumber() + 2 - now);
      console.log(`    Waiting ${wait}s for multi-ATA expiry...`);
      await sleep(wait * 1000);

      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("both accounts burn cleanly in one batch; USDC payout deposited to single buyer ATA", async function () {
      this.timeout(60_000);
      // Both accounts have tokens
      assert.equal(await getOptionAmount(ctx.holderOptionAtas[0]), BigInt(QTY - 1));
      assert.equal(await getOptionAmount(secondAccountKeypair.publicKey), 1n);

      const usdcBefore = await getUsdcAmount(ctx.holderUsdcs[0]);

      // Pass both accounts paired with the SAME holder USDC ATA.
      const pairs = [
        { holderOption: ctx.holderOptionAtas[0], holderUsdc: ctx.holderUsdcs[0] },
        { holderOption: secondAccountKeypair.publicKey, holderUsdc: ctx.holderUsdcs[0] },
      ];
      await callAutoFinalizeHolders(ctx, pairs);

      assert.equal(await getOptionAmount(ctx.holderOptionAtas[0]), 0n);
      assert.equal(await getOptionAmount(secondAccountKeypair.publicKey), 0n);

      // USDC delta: ($250 - $240) * 3 = $30 total → all to single ATA
      const delta = Number((await getUsdcAmount(ctx.holderUsdcs[0])) - usdcBefore);
      assert.equal(delta, usdc(30).toNumber());
    });
  });

  // ==========================================================================
  // 7. Single-holder, batch size 1
  // ==========================================================================
  describe("7. Single-holder batch size 1", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    const STRIKE = usdc(260);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        numHolders: 1,
        quantityPerHolder: 1,
        premiumPerContract: usdc(5),
        expirySeconds: 10,
      });
      console.log("    Waiting 12s for single-holder expiry...");
      await sleep(12_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("1-pair remaining_accounts works", async function () {
      this.timeout(60_000);
      const before = await getUsdcAmount(ctx.holderUsdcs[0]);
      await callAutoFinalizeHolders(ctx, [{
        holderOption: ctx.holderOptionAtas[0],
        holderUsdc: ctx.holderUsdcs[0],
      }]);
      assert.equal(await getOptionAmount(ctx.holderOptionAtas[0]), 0n);
      // Payout = ($250 - $260) negative → 0. Wait, $260 > $250 = OTM call.
      // Strike $260 with settlement $250 = OTM. Adjust: should be 0 USDC.
      const delta = Number((await getUsdcAmount(ctx.holderUsdcs[0])) - before);
      assert.equal(delta, 0, "OTM at strike $260 vs settlement $250");
    });
  });

  // ==========================================================================
  // 8. Race vs. manual exercise_from_vault
  // ==========================================================================
  describe("8. Race vs manual exercise — already-burned holder skipped", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    const STRIKE = usdc(180);
    const QTY = 2;

    before(async function () {
      this.timeout(180_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        numHolders: 3,
        quantityPerHolder: QTY,
        premiumPerContract: usdc(5),
        expirySeconds: 10,
      });
      console.log("    Waiting 12s for race-test expiry...");
      await sleep(12_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("holder #0 exercises manually first; auto_finalize tx still finalizes #1 and #2", async function () {
      this.timeout(60_000);

      // Holder #0 exercises manually — burns own tokens, gets payout
      await (program as any).methods
        .exerciseFromVault(new BN(QTY))
        .accounts({
          holder: ctx.holders[0].publicKey,
          sharedVault: ctx.vaultPda,
          market: marketPda,
          vaultMintRecord: ctx.vaultMintRecordPda,
          optionMint: ctx.optionMintPda,
          holderOptionAccount: ctx.holderOptionAtas[0],
          vaultUsdcAccount: ctx.vaultUsdcPda,
          holderUsdcAccount: ctx.holderUsdcs[0],
          protocolState: protocolStatePda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([ctx.holders[0]])
        .rpc();
      assert.equal(await getOptionAmount(ctx.holderOptionAtas[0]), 0n,
        "holder #0 already burned via manual exercise");

      const events: any[] = [];
      const listener = program.addEventListener("holdersFinalized", (e: any) => events.push(e));

      const usdcBefore = await Promise.all(ctx.holderUsdcs.map(getUsdcAmount));

      // Pass all 3 holders in batch — #0 already burned, should skip silently
      const pairs = ctx.holderOptionAtas.map((opt, i) => ({
        holderOption: opt, holderUsdc: ctx.holderUsdcs[i],
      }));
      await callAutoFinalizeHolders(ctx, pairs);

      await sleep(1500);
      await program.removeEventListener(listener);

      // #0 unchanged from before tx (already exercised)
      assert.equal(Number((await getUsdcAmount(ctx.holderUsdcs[0])) - usdcBefore[0]), 0,
        "#0 already paid via exercise_from_vault, no double-pay");

      // #1 and #2 finalized
      const expectedPerHolder = usdc(70).muln(QTY).toNumber(); // $250 - $180 = $70 * 2 = $140
      for (let i = 1; i < 3; i++) {
        assert.equal(await getOptionAmount(ctx.holderOptionAtas[i]), 0n);
        assert.equal(
          Number((await getUsdcAmount(ctx.holderUsdcs[i])) - usdcBefore[i]),
          expectedPerHolder,
        );
      }

      assert.equal(events.length, 1);
      assert.equal(events[0].holdersProcessed, 2,
        "only #1 and #2 processed; #0 silent-skipped (amount==0)");
      assert.equal(events[0].totalPaidOut.toNumber(), expectedPerHolder * 2);
    });
  });

  // ==========================================================================
  // 9. Idempotent re-run
  // ==========================================================================
  describe("9. Idempotent re-run — second call is a no-op", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    const STRIKE = usdc(160);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        numHolders: 2,
        quantityPerHolder: 1,
        premiumPerContract: usdc(5),
        expirySeconds: 10,
      });
      console.log("    Waiting 12s for idempotency expiry...");
      await sleep(12_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);

      // First call burns everyone
      const pairs = ctx.holderOptionAtas.map((opt, i) => ({
        holderOption: opt, holderUsdc: ctx.holderUsdcs[i],
      }));
      await callAutoFinalizeHolders(ctx, pairs);
    });

    it("second auto_finalize_holders call succeeds with all-zero counters", async function () {
      this.timeout(60_000);

      const events: any[] = [];
      const listener = program.addEventListener("holdersFinalized", (e: any) => events.push(e));

      const usdcBefore = await Promise.all(ctx.holderUsdcs.map(getUsdcAmount));
      const collateralBefore = (await program.account.sharedVault.fetch(ctx.vaultPda))
        .collateralRemaining.toNumber();

      const pairs = ctx.holderOptionAtas.map((opt, i) => ({
        holderOption: opt, holderUsdc: ctx.holderUsdcs[i],
      }));
      await callAutoFinalizeHolders(ctx, pairs);

      await sleep(1500);
      await program.removeEventListener(listener);

      // No state changed
      for (let i = 0; i < ctx.holderUsdcs.length; i++) {
        assert.equal(await getUsdcAmount(ctx.holderUsdcs[i]), usdcBefore[i]);
        assert.equal(await getOptionAmount(ctx.holderOptionAtas[i]), 0n);
      }
      assert.equal(
        (await program.account.sharedVault.fetch(ctx.vaultPda)).collateralRemaining.toNumber(),
        collateralBefore,
      );

      // Event still fires, all zeroes
      assert.equal(events.length, 1);
      assert.equal(events[0].holdersProcessed, 0);
      assert.equal(events[0].totalBurned.toNumber(), 0);
      assert.equal(events[0].totalPaidOut.toNumber(), 0);
    });
  });

  // ==========================================================================
  // 10. Pre-settlement call — must revert
  // ==========================================================================
  describe("10. Pre-settlement call reverts with VaultNotSettled", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    const STRIKE = usdc(170);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        numHolders: 1,
        quantityPerHolder: 1,
        premiumPerContract: usdc(5),
        expirySeconds: 600, // far future — no expiry, no settle
      });
    });

    it("auto_finalize_holders on un-settled vault reverts", async function () {
      this.timeout(30_000);
      try {
        await callAutoFinalizeHolders(ctx, [{
          holderOption: ctx.holderOptionAtas[0],
          holderUsdc: ctx.holderUsdcs[0],
        }]);
        assert.fail("should have reverted with VaultNotSettled");
      } catch (e: any) {
        assert.include(e.toString(), "VaultNotSettled",
          "must revert with VaultNotSettled error");
      }
    });
  });

  // ==========================================================================
  // 11. Mismatched USDC ATA — silent skip
  // ==========================================================================
  describe("11. Mismatched USDC ATA — silent skip, holder NOT burned", () => {
    let ctx: Awaited<ReturnType<typeof buildScenario>>;
    let strangerUsdc: PublicKey;
    const STRIKE = usdc(190);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        numHolders: 1,
        quantityPerHolder: 2,
        premiumPerContract: usdc(5),
        expirySeconds: 10,
      });

      // Stranger wallet's USDC ATA — owner does NOT match holder
      const stranger = Keypair.generate();
      const sig = await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      strangerUsdc = await createTokenAccount(
        connection, payer, usdcMint, stranger.publicKey,
        undefined, undefined, TOKEN_PROGRAM_ID,
      );

      console.log("    Waiting 12s for mismatch expiry...");
      await sleep(12_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("call succeeds; holder option amount unchanged; no USDC moved", async function () {
      this.timeout(60_000);

      const events: any[] = [];
      const listener = program.addEventListener("holdersFinalized", (e: any) => events.push(e));

      const optionBefore = await getOptionAmount(ctx.holderOptionAtas[0]);
      const holderUsdcBefore = await getUsdcAmount(ctx.holderUsdcs[0]);
      const strangerUsdcBefore = await getUsdcAmount(strangerUsdc);
      assert.isAbove(Number(optionBefore), 0);

      // Pair holder's option ATA with the STRANGER's USDC ATA — owner mismatch
      await callAutoFinalizeHolders(ctx, [{
        holderOption: ctx.holderOptionAtas[0],
        holderUsdc: strangerUsdc,
      }]);

      await sleep(1500);
      await program.removeEventListener(listener);

      // Silent skip: holder still has tokens, no USDC moved anywhere
      assert.equal(await getOptionAmount(ctx.holderOptionAtas[0]), optionBefore,
        "holder option NOT burned on USDC ATA mismatch");
      assert.equal(await getUsdcAmount(ctx.holderUsdcs[0]), holderUsdcBefore);
      assert.equal(await getUsdcAmount(strangerUsdc), strangerUsdcBefore);

      assert.equal(events.length, 1);
      assert.equal(events[0].holdersProcessed, 0,
        "skipped pair → holders_processed = 0");
      assert.equal(events[0].totalBurned.toNumber(), 0);
    });
  });
});
