// =============================================================================
// tests/zzz-auto-finalize-writers.ts — Tests for auto_finalize_writers
// =============================================================================
//
// Step 4 of the auto-finalize work (see docs/AUTO_FINALIZE_PLAN.md). Tests
// only the writer-side instruction shipped in commit 9069441. Holder-side,
// crank, and end-to-end smoke are NOT in scope.
//
// =============================================================================
// PRE-FLIGHT FINDING — multi-writer testability
// =============================================================================
// The original test plan called for tests with 3-4 writers (test 6 unequal
// shares, test 8 partial-finalize-and-resume across 4 writers, test 10
// re-encounter-mid-batch with 3 writers). The protocol's multi-writer path
// is Epoch vaults — but `initialize_epoch_config` hardcodes
// `min_epoch_duration_days = 1` (programs/opta/src/instructions/initialize_epoch_config.rs:36)
// and there is no update instruction. Multi-writer Epoch tests would require
// ≥1-day expiry waits, which is infeasible for local CI.
//
// Workaround: the deposit gate at deposit_to_vault.rs:37-42 only enforces
// `writer == creator` when `vault.total_shares > 0`. The very first deposit
// bypasses the gate. So with vault.creator = Alice:
//   1. Bob deposits FIRST (total_shares == 0, gate skipped) → Bob's
//      WriterPosition created.
//   2. Alice deposits SECOND (total_shares > 0, gate fires, writer == creator
//      passes) → Alice's WriterPosition created.
//   3. Charlie cannot deposit (gate fires, Charlie != Alice).
//
// This yields exactly 2 WriterPositions per Custom vault. Tests 6, 8, 10 in
// the original plan call for 3-4 writers; we adapt them to 2 writers, which
// still validates the core invariants (pro-rata math, partial-finalize-and-
// resume across batches, re-encounter-mid-batch). Surfaced in the report.
//
// If a future protocol change tightens the gate to strictly single-writer
// Custom vaults (closing the first-depositor exemption), these tests need to
// be ported to Epoch vaults via a new admin instruction
// `update_epoch_config(min_epoch_duration_days = 0)`.
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
  createAssociatedTokenAccountIdempotent,
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

describe("auto-finalize-writers", () => {
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

  // ---- Wallet bootstrap helper -----------------------------------------
  async function freshWallet(usdcAmount = 100_000_000_000): Promise<{ kp: Keypair; usdc: PublicKey }> {
    const kp = Keypair.generate();
    const sig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    const usdcAcc = await createTokenAccount(
      connection, payer, usdcMint, kp.publicKey,
      undefined, undefined, TOKEN_PROGRAM_ID,
    );
    if (usdcAmount > 0) {
      await mintTo(connection, payer, usdcMint, usdcAcc, payer, usdcAmount);
    }
    return { kp, usdc: usdcAcc };
  }

  // ---- Two-writer scenario ---------------------------------------------
  // Builds a Custom vault with creator=Alice, exploits the first-depositor
  // exemption to also fund Bob with a WriterPosition. Alice mints, buyer
  // purchases, premium collected. Caller chooses ITM/OTM via fixture.
  async function buildTwoWriterScenario(opts: {
    strike: BN;
    optionType: { call: {} } | { put: {} };
    optionTypeIndex: number;
    expirySeconds: number;
    aliceDeposit: BN;
    bobDeposit: BN;
    /// quantity to mint and sell — premium per contract is 5 USDC.
    quantitySold: number;
  }) {
    const alice = await freshWallet();
    const bob = await freshWallet();
    const buyer = await freshWallet();

    const expiry = new BN(Math.floor(Date.now() / 1000) + opts.expirySeconds);
    const [vaultPda] = deriveSharedVaultPda(
      marketPda, opts.strike, expiry, opts.optionTypeIndex,
    );
    const [vaultUsdcPda] = deriveVaultUsdcPda(vaultPda);

    // Alice creates the vault — vault.creator = Alice
    await (program as any).methods
      .createSharedVault(opts.strike, expiry, opts.optionType, { custom: {} }, usdcMint)
      .accounts({
        creator: alice.kp.publicKey,
        market: marketPda,
        sharedVault: vaultPda,
        vaultUsdcAccount: vaultUsdcPda,
        usdcMint,
        protocolState: protocolStatePda,
        epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice.kp])
      .rpc();

    // Bob deposits FIRST — total_shares == 0 → gate skipped → Bob's pos created
    const [bobPosPda] = deriveWriterPositionPda(vaultPda, bob.kp.publicKey);
    await (program as any).methods
      .depositToVault(opts.bobDeposit)
      .accounts({
        writer: bob.kp.publicKey,
        sharedVault: vaultPda,
        writerPosition: bobPosPda,
        vaultUsdcAccount: vaultUsdcPda,
        writerUsdcAccount: bob.usdc,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([bob.kp])
      .rpc();

    // Alice deposits SECOND — gate fires, writer == creator (Alice) passes
    const [alicePosPda] = deriveWriterPositionPda(vaultPda, alice.kp.publicKey);
    await (program as any).methods
      .depositToVault(opts.aliceDeposit)
      .accounts({
        writer: alice.kp.publicKey,
        sharedVault: vaultPda,
        writerPosition: alicePosPda,
        vaultUsdcAccount: vaultUsdcPda,
        writerUsdcAccount: alice.usdc,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice.kp])
      .rpc();

    // Mint + sell options to generate premium (Bob mints; either writer can)
    let optionMintPda: PublicKey | undefined;
    let vaultMintRecordPda: PublicKey | undefined;
    if (opts.quantitySold > 0) {
      const mintCreatedAt = new BN(Math.floor(Date.now() / 1000));
      [optionMintPda] = deriveVaultOptionMintPda(vaultPda, bob.kp.publicKey, mintCreatedAt);
      const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(vaultPda, bob.kp.publicKey, mintCreatedAt);
      [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await (program as any).methods
          .mintFromVault(new BN(opts.quantitySold), usdc(5), mintCreatedAt)
          .accounts({
            writer: bob.kp.publicKey,
            sharedVault: vaultPda,
            writerPosition: bobPosPda,
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
          .signers([bob.kp])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [bob.kp]);
      }

      const buyerOptAta = await createAssociatedTokenAccountIdempotent(
        connection, payer, optionMintPda, buyer.kp.publicKey, {}, TOKEN_2022_PROGRAM_ID,
      );

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await (program as any).methods
          .purchaseFromVault(new BN(opts.quantitySold), usdc(999_999))
          .accounts({
            buyer: buyer.kp.publicKey,
            sharedVault: vaultPda,
            writerPosition: bobPosPda,
            vaultMintRecord: vaultMintRecordPda,
            protocolState: protocolStatePda,
            market: marketPda,
            optionMint: optionMintPda,
            purchaseEscrow: purchaseEscrowPda,
            buyerOptionAccount: buyerOptAta,
            buyerUsdcAccount: buyer.usdc,
            vaultUsdcAccount: vaultUsdcPda,
            treasury: treasuryPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList,
            hookState,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer.kp])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [buyer.kp]);
      }
    }

    return {
      alice, bob, buyer,
      vaultPda, vaultUsdcPda,
      alicePosPda, bobPosPda,
      optionMintPda, vaultMintRecordPda,
      expiry,
    };
  }

  // ---- Single-writer scenario --------------------------------------------
  async function buildSingleWriterScenario(opts: {
    strike: BN;
    optionType: { call: {} } | { put: {} };
    optionTypeIndex: number;
    expirySeconds: number;
    deposit: BN;
    quantitySold: number;
  }) {
    const alice = await freshWallet();
    const buyer = await freshWallet();

    const expiry = new BN(Math.floor(Date.now() / 1000) + opts.expirySeconds);
    const [vaultPda] = deriveSharedVaultPda(
      marketPda, opts.strike, expiry, opts.optionTypeIndex,
    );
    const [vaultUsdcPda] = deriveVaultUsdcPda(vaultPda);

    await (program as any).methods
      .createSharedVault(opts.strike, expiry, opts.optionType, { custom: {} }, usdcMint)
      .accounts({
        creator: alice.kp.publicKey,
        market: marketPda,
        sharedVault: vaultPda,
        vaultUsdcAccount: vaultUsdcPda,
        usdcMint,
        protocolState: protocolStatePda,
        epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice.kp])
      .rpc();

    const [alicePosPda] = deriveWriterPositionPda(vaultPda, alice.kp.publicKey);
    await (program as any).methods
      .depositToVault(opts.deposit)
      .accounts({
        writer: alice.kp.publicKey,
        sharedVault: vaultPda,
        writerPosition: alicePosPda,
        vaultUsdcAccount: vaultUsdcPda,
        writerUsdcAccount: alice.usdc,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice.kp])
      .rpc();

    let optionMintPda: PublicKey | undefined;
    let vaultMintRecordPda: PublicKey | undefined;
    if (opts.quantitySold > 0) {
      const mintCreatedAt = new BN(Math.floor(Date.now() / 1000));
      [optionMintPda] = deriveVaultOptionMintPda(vaultPda, alice.kp.publicKey, mintCreatedAt);
      const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(vaultPda, alice.kp.publicKey, mintCreatedAt);
      [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await (program as any).methods
          .mintFromVault(new BN(opts.quantitySold), usdc(5), mintCreatedAt)
          .accounts({
            writer: alice.kp.publicKey,
            sharedVault: vaultPda,
            writerPosition: alicePosPda,
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
          .signers([alice.kp])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [alice.kp]);
      }

      const buyerOptAta = await createAssociatedTokenAccountIdempotent(
        connection, payer, optionMintPda, buyer.kp.publicKey, {}, TOKEN_2022_PROGRAM_ID,
      );

      {
        const tx = new Transaction().add(EXTRA_CU);
        const ix = await (program as any).methods
          .purchaseFromVault(new BN(opts.quantitySold), usdc(999_999))
          .accounts({
            buyer: buyer.kp.publicKey,
            sharedVault: vaultPda,
            writerPosition: alicePosPda,
            vaultMintRecord: vaultMintRecordPda,
            protocolState: protocolStatePda,
            market: marketPda,
            optionMint: optionMintPda,
            purchaseEscrow: purchaseEscrowPda,
            buyerOptionAccount: buyerOptAta,
            buyerUsdcAccount: buyer.usdc,
            vaultUsdcAccount: vaultUsdcPda,
            treasury: treasuryPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            transferHookProgram: HOOK_PROGRAM_ID,
            extraAccountMetaList,
            hookState,
            systemProgram: SystemProgram.programId,
          })
          .signers([buyer.kp])
          .instruction();
        tx.add(ix);
        await provider.sendAndConfirm(tx, [buyer.kp]);
      }
    }

    return {
      alice, buyer,
      vaultPda, vaultUsdcPda,
      alicePosPda, optionMintPda, vaultMintRecordPda,
      expiry,
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

  async function callAutoFinalizeWriters(
    ctx: { vaultPda: PublicKey; vaultUsdcPda: PublicKey },
    triples: { writerPos: PublicKey; writerUsdc: PublicKey; writerWallet: PublicKey }[],
    caller: Keypair = payer,
  ): Promise<string> {
    const remaining: AccountMeta[] = [];
    for (const t of triples) {
      remaining.push({ pubkey: t.writerPos, isSigner: false, isWritable: true });
      remaining.push({ pubkey: t.writerUsdc, isSigner: false, isWritable: true });
      remaining.push({ pubkey: t.writerWallet, isSigner: false, isWritable: true });
    }

    const tx = new Transaction().add(EXTRA_CU);
    const ix = await (program as any).methods
      .autoFinalizeWriters()
      .accounts({
        caller: caller.publicKey,
        sharedVault: ctx.vaultPda,
        market: marketPda,
        vaultUsdcAccount: ctx.vaultUsdcPda,
        treasury: treasuryPda,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(remaining)
      .signers([caller])
      .instruction();
    tx.add(ix);
    return await provider.sendAndConfirm(tx, [caller]);
  }

  async function getUsdc(ata: PublicKey): Promise<bigint> {
    const acc = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    return acc.amount;
  }

  async function getSol(pubkey: PublicKey): Promise<number> {
    return await connection.getBalance(pubkey, "confirmed");
  }

  /// Asserts the writer_position is closed: either GC'd entirely (null) or
  /// still on chain with lamports == 0, data.length == 0, owner == system_program.
  async function assertPositionClosed(pos: PublicKey, label: string) {
    const info = await connection.getAccountInfo(pos, "confirmed");
    if (info === null) {
      // GC'd by Solana — fully closed.
      return;
    }
    assert.equal(info.lamports, 0, `${label}: lamports should be 0`);
    assert.equal(info.data.length, 0, `${label}: data should be empty`);
    assert.isTrue(
      info.owner.equals(SystemProgram.programId),
      `${label}: owner should be system_program`,
    );
  }

  // ==========================================================================
  // 1. ITM call vault, 2 writers — happy path
  // ==========================================================================
  describe("1. ITM call vault, 2 writers — burn + USDC payout + dust sweep", () => {
    let ctx: Awaited<ReturnType<typeof buildTwoWriterScenario>>;
    const STRIKE = usdc(80); // ITM call: settlement $250 > $80

    before(async function () {
      this.timeout(180_000);
      ctx = await buildTwoWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        aliceDeposit: usdc(500),
        bobDeposit: usdc(500),
        quantitySold: 0, // skip sale to keep math clean (writers get full collateral back)
      });
      console.log("    Waiting 10s for ITM-call expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("each writer paid pro-rata, both positions closed, total_shares == 0, dust → treasury, vault_usdc closed", async function () {
      this.timeout(60_000);
      const events: any[] = [];
      const listener = program.addEventListener("writersFinalized", (e: any) => events.push(e));

      // Pre-state
      const aliceUsdcBefore = await getUsdc(ctx.alice.usdc);
      const bobUsdcBefore = await getUsdc(ctx.bob.usdc);
      const aliceSolBefore = await getSol(ctx.alice.kp.publicKey);
      const bobSolBefore = await getSol(ctx.bob.kp.publicKey);
      const treasuryUsdcBefore = await getUsdc(treasuryPda);
      const treasurySolBefore = await getSol(treasuryPda);
      const vaultUsdcBefore = await getUsdc(ctx.vaultUsdcPda);
      const vaultUsdcSolBefore = await getSol(ctx.vaultUsdcPda);

      // 50/50 split since aliceDeposit == bobDeposit. No premium (no sale).
      // Each writer should get $500 back.
      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
        { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
      ]);

      await sleep(1500);
      await program.removeEventListener(listener);

      // Each writer received $500 (pro-rata, no premium since no sale)
      const aliceUsdcDelta = Number((await getUsdc(ctx.alice.usdc)) - aliceUsdcBefore);
      const bobUsdcDelta = Number((await getUsdc(ctx.bob.usdc)) - bobUsdcBefore);
      assert.equal(aliceUsdcDelta, usdc(500).toNumber(), "Alice USDC delta = $500");
      assert.equal(bobUsdcDelta, usdc(500).toNumber(), "Bob USDC delta = $500");

      // Each writer received SOL rent refund from their closed writer_position
      const aliceSolDelta = (await getSol(ctx.alice.kp.publicKey)) - aliceSolBefore;
      const bobSolDelta = (await getSol(ctx.bob.kp.publicKey)) - bobSolBefore;
      assert.isAbove(aliceSolDelta, 0, "Alice received writer_position rent");
      assert.isAbove(bobSolDelta, 0, "Bob received writer_position rent");

      // Both positions closed
      await assertPositionClosed(ctx.alicePosPda, "Alice position");
      await assertPositionClosed(ctx.bobPosPda, "Bob position");

      // Vault state: total_shares = 0
      const vault = await program.account.sharedVault.fetch(ctx.vaultPda);
      assert.equal(vault.totalShares.toNumber(), 0, "total_shares should be 0");

      // Vault USDC account closed
      const vaultUsdcInfo = await connection.getAccountInfo(ctx.vaultUsdcPda);
      assert.isNull(vaultUsdcInfo, "vault_usdc_account should be closed");

      // Treasury received the rent SOL from the closed vault_usdc_account
      const treasurySolDelta = (await getSol(treasuryPda)) - treasurySolBefore;
      assert.isAtLeast(treasurySolDelta, vaultUsdcSolBefore,
        "Treasury should receive vault_usdc rent SOL");

      // Event
      assert.equal(events.length, 1);
      assert.equal(events[0].vault.toBase58(), ctx.vaultPda.toBase58());
      assert.equal(events[0].writersProcessed, 2);
      assert.equal(events[0].totalPaidOut.toNumber(), usdc(1000).toNumber(),
        "total_paid_out = $500 + $500");
      // dust_swept_to_treasury should match treasury USDC delta
      const treasuryUsdcDelta = Number((await getUsdc(treasuryPda)) - treasuryUsdcBefore);
      assert.equal(events[0].dustSweptToTreasury.toNumber(), treasuryUsdcDelta,
        "event dust_swept_to_treasury matches treasury USDC delta");
      // vault_usdc was empty (no sale, even split, no rounding) — dust = 0
      assert.equal(treasuryUsdcDelta, 0, "perfect 50/50 split → no dust");
    });
  });

  // ==========================================================================
  // 2. ITM put vault, 2 writers — symmetric
  // ==========================================================================
  describe("2. ITM put vault, 2 writers — symmetric", () => {
    let ctx: Awaited<ReturnType<typeof buildTwoWriterScenario>>;
    const STRIKE = usdc(290); // ITM put: settlement $50 < $290 → payout $240

    before(async function () {
      this.timeout(180_000);
      ctx = await buildTwoWriterScenario({
        strike: STRIKE,
        optionType: { put: {} },
        optionTypeIndex: 1,
        expirySeconds: 8,
        aliceDeposit: usdc(600),
        bobDeposit: usdc(600),
        quantitySold: 0,
      });
      console.log("    Waiting 10s for ITM-put expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_50_FRESH);
    });

    it("each writer paid $600 pro-rata, both positions closed", async function () {
      this.timeout(60_000);
      const aliceUsdcBefore = await getUsdc(ctx.alice.usdc);
      const bobUsdcBefore = await getUsdc(ctx.bob.usdc);

      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
        { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
      ]);

      assert.equal(Number((await getUsdc(ctx.alice.usdc)) - aliceUsdcBefore), usdc(600).toNumber());
      assert.equal(Number((await getUsdc(ctx.bob.usdc)) - bobUsdcBefore), usdc(600).toNumber());
      await assertPositionClosed(ctx.alicePosPda, "Alice");
      await assertPositionClosed(ctx.bobPosPda, "Bob");
    });
  });

  // ==========================================================================
  // 3. OTM call vault, 2 writers
  // ==========================================================================
  describe("3. OTM call vault, 2 writers — full collateral + premium", () => {
    let ctx: Awaited<ReturnType<typeof buildTwoWriterScenario>>;
    const STRIKE = usdc(310); // OTM call: settlement $50 < $310 → no holder payout

    before(async function () {
      this.timeout(180_000);
      ctx = await buildTwoWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        aliceDeposit: usdc(700),
        bobDeposit: usdc(700),
        quantitySold: 1, // generates premium
      });
      console.log("    Waiting 10s for OTM-call expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_50_FRESH);
    });

    it("writers get back full collateral + premium share, dust value asserted", async function () {
      this.timeout(60_000);
      const events: any[] = [];
      const listener = program.addEventListener("writersFinalized", (e: any) => events.push(e));

      const aliceUsdcBefore = await getUsdc(ctx.alice.usdc);
      const bobUsdcBefore = await getUsdc(ctx.bob.usdc);
      const treasuryUsdcBefore = await getUsdc(treasuryPda);

      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
        { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
      ]);

      await sleep(1500);
      await program.removeEventListener(listener);

      // Each writer should get >= $700 (full collateral) plus premium share.
      // Premium = $5 * 0.995 = $4.975 net to vault. 50/50 split → each gets ~$2.49 premium.
      const aliceDelta = Number((await getUsdc(ctx.alice.usdc)) - aliceUsdcBefore);
      const bobDelta = Number((await getUsdc(ctx.bob.usdc)) - bobUsdcBefore);
      assert.isAtLeast(aliceDelta, usdc(702).toNumber(), `Alice got $${aliceDelta / 1e6}, expected >$702`);
      assert.isAtLeast(bobDelta, usdc(702).toNumber(), `Bob got $${bodDeltaSafe(bobDelta)}, expected >$702`);
      assert.isAtMost(aliceDelta, usdc(703).toNumber(), `Alice got $${aliceDelta / 1e6}, expected <$703`);
      assert.isAtMost(bobDelta, usdc(703).toNumber(), `Bob got $${bodDeltaSafe(bobDelta)}, expected <$703`);

      // Treasury got dust (rounding remnant)
      const treasuryUsdcDelta = Number((await getUsdc(treasuryPda)) - treasuryUsdcBefore);
      assert.equal(events[0].dustSweptToTreasury.toNumber(), treasuryUsdcDelta);
      assert.isAtLeast(treasuryUsdcDelta, 0, "dust >= 0");
      console.log(`    OTM call dust to treasury: $${treasuryUsdcDelta / 1e6}`);
    });
  });

  // (helper to make assertion error messages safe even if bobDelta is bigint-ish)
  function bodDeltaSafe(x: number) { return x / 1e6; }

  // ==========================================================================
  // 4. OTM put vault, 2 writers — symmetric
  // ==========================================================================
  describe("4. OTM put vault, 2 writers", () => {
    let ctx: Awaited<ReturnType<typeof buildTwoWriterScenario>>;
    const STRIKE = usdc(40); // OTM put: settlement $250 > $40

    before(async function () {
      this.timeout(180_000);
      ctx = await buildTwoWriterScenario({
        strike: STRIKE,
        optionType: { put: {} },
        optionTypeIndex: 1,
        expirySeconds: 8,
        aliceDeposit: usdc(50),
        bobDeposit: usdc(50),
        quantitySold: 1,
      });
      console.log("    Waiting 10s for OTM-put expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("writers get full $50 + premium each", async function () {
      this.timeout(60_000);
      const aliceUsdcBefore = await getUsdc(ctx.alice.usdc);
      const bobUsdcBefore = await getUsdc(ctx.bob.usdc);

      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
        { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
      ]);

      const aliceDelta = Number((await getUsdc(ctx.alice.usdc)) - aliceUsdcBefore);
      const bobDelta = Number((await getUsdc(ctx.bob.usdc)) - bobUsdcBefore);
      assert.isAtLeast(aliceDelta, usdc(52).toNumber());
      assert.isAtLeast(bobDelta, usdc(52).toNumber());
    });
  });

  // ==========================================================================
  // 5. Single writer (degenerate) — last-writer + dust-sweep + vault close
  // ==========================================================================
  describe("5. Single writer — last-writer branch fires immediately", () => {
    let ctx: Awaited<ReturnType<typeof buildSingleWriterScenario>>;
    const STRIKE = usdc(81);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildSingleWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        deposit: usdc(800),
        quantitySold: 1,
      });
      console.log("    Waiting 10s for single-writer expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("single writer is last writer; dust + vault_usdc rent SOL flow to treasury", async function () {
      this.timeout(60_000);
      const events: any[] = [];
      const listener = program.addEventListener("writersFinalized", (e: any) => events.push(e));

      const aliceUsdcBefore = await getUsdc(ctx.alice.usdc);
      const treasurySolBefore = await getSol(treasuryPda);
      const vaultUsdcSolBefore = await getSol(ctx.vaultUsdcPda);

      await callAutoFinalizeWriters(ctx, [{
        writerPos: ctx.alicePosPda,
        writerUsdc: ctx.alice.usdc,
        writerWallet: ctx.alice.kp.publicKey,
      }]);

      await sleep(1500);
      await program.removeEventListener(listener);

      // ITM call: settlement $250, strike $81, payout = $169 per contract * 1 = $169 to holder.
      // Writer gets $800 - $169 = $631 + premium ($4.975).
      const aliceDelta = Number((await getUsdc(ctx.alice.usdc)) - aliceUsdcBefore);
      assert.isAtLeast(aliceDelta, usdc(635).toNumber(),
        `Alice should get ~$635-636 (collateral_remaining $631 + premium ~$4.975). Got $${aliceDelta / 1e6}`);

      await assertPositionClosed(ctx.alicePosPda, "Alice (last writer)");

      // Vault USDC closed; SOL rent went to treasury
      assert.isNull(await connection.getAccountInfo(ctx.vaultUsdcPda),
        "vault_usdc_account should be closed");
      const treasurySolDelta = (await getSol(treasuryPda)) - treasurySolBefore;
      assert.isAtLeast(treasurySolDelta, vaultUsdcSolBefore,
        "Treasury received vault_usdc rent SOL");

      assert.equal(events[0].writersProcessed, 1);
    });
  });

  // ==========================================================================
  // 6. Pro-rata math — 2 writers with 60/40 split
  // ==========================================================================
  // (Adapted from "3 writers 50/30/20" per pre-flight finding above.)
  describe("6. Pro-rata math — 2 writers 60/40 split (adapted from 3-writer plan)", () => {
    let ctx: Awaited<ReturnType<typeof buildTwoWriterScenario>>;
    const STRIKE = usdc(82);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildTwoWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        aliceDeposit: usdc(600),
        bobDeposit: usdc(400),
        quantitySold: 0,
      });
      console.log("    Waiting 10s for pro-rata expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("Alice gets 60% of $1000 = $600; Bob gets 40% = $400; pro-rata pre-rounding-loss", async function () {
      this.timeout(60_000);
      const aliceUsdcBefore = await getUsdc(ctx.alice.usdc);
      const bobUsdcBefore = await getUsdc(ctx.bob.usdc);

      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
        { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
      ]);

      const aliceDelta = Number((await getUsdc(ctx.alice.usdc)) - aliceUsdcBefore);
      const bobDelta = Number((await getUsdc(ctx.bob.usdc)) - bobUsdcBefore);
      // Mirror withdraw_post_settlement.rs:30-48 math:
      //   writer_remaining = shares * collateral_remaining / total_shares
      //   total_shares = 600M + 400M = 1000M (1:1 share:USDC for first depositor)
      //   collateral_remaining = $1000 (no payout — quantitySold=0)
      //   Bob: 400M * $1000 / 1000M = $400. Alice: 600M * $400 / 600M ... wait
      // Actually note: shares are decremented as writers process. First writer
      // (Bob) sees: shares=400M, total_shares=1000M, collat_rem=$1000 → $400
      // Then for Alice: shares=600M, total_shares=600M (after Bob's decrement),
      // collat_rem=$600 → 600M * $600 / 600M = $600
      // Net: Alice $600, Bob $400. Same as full-share-snapshot math.
      assert.equal(aliceDelta, usdc(600).toNumber(), `Alice 60%, got $${aliceDelta / 1e6}`);
      assert.equal(bobDelta, usdc(400).toNumber(), `Bob 40%, got $${bobDelta / 1e6}`);
    });
  });

  // ==========================================================================
  // 7. Race vs. manual withdraw_post_settlement
  // ==========================================================================
  describe("7. Race vs manual withdraw — Bob withdraws manually first", () => {
    let ctx: Awaited<ReturnType<typeof buildTwoWriterScenario>>;
    const STRIKE = usdc(83);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildTwoWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        aliceDeposit: usdc(500),
        bobDeposit: usdc(500),
        quantitySold: 0,
      });
      console.log("    Waiting 10s for race-test expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("Bob withdraws manually first; auto-finalize processes only Alice but still triggers dust sweep", async function () {
      this.timeout(60_000);
      const events: any[] = [];
      const listener = program.addEventListener("writersFinalized", (e: any) => events.push(e));

      // Bob withdraws first via the manual path
      await (program as any).methods
        .withdrawPostSettlement()
        .accounts({
          writer: ctx.bob.kp.publicKey,
          sharedVault: ctx.vaultPda,
          writerPosition: ctx.bobPosPda,
          vaultUsdcAccount: ctx.vaultUsdcPda,
          writerUsdcAccount: ctx.bob.usdc,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.bob.kp])
        .rpc();

      // Bob's position closed; Alice still alive
      await assertPositionClosed(ctx.bobPosPda, "Bob (manual withdraw)");

      const aliceUsdcBefore = await getUsdc(ctx.alice.usdc);
      const bobUsdcBefore = await getUsdc(ctx.bob.usdc);

      // Pass both writers — Bob's silent-skipped, Alice processed
      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
        { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
      ]);

      await sleep(1500);
      await program.removeEventListener(listener);

      // Bob unchanged after auto-finalize (already-paid via manual)
      const bobDelta = Number((await getUsdc(ctx.bob.usdc)) - bobUsdcBefore);
      assert.equal(bobDelta, 0, "Bob already withdrew — no double pay");

      // Alice processed
      const aliceDelta = Number((await getUsdc(ctx.alice.usdc)) - aliceUsdcBefore);
      assert.equal(aliceDelta, usdc(500).toNumber(), "Alice = $500");

      await assertPositionClosed(ctx.alicePosPda, "Alice (auto-finalize)");

      // Last-writer branch fired (Alice was last after Bob's manual withdraw)
      // → vault_usdc_account closed
      assert.isNull(await connection.getAccountInfo(ctx.vaultUsdcPda),
        "vault_usdc_account should be closed by auto-finalize last-writer branch");

      assert.equal(events[0].writersProcessed, 1, "only Alice processed");
    });
  });

  // ==========================================================================
  // 8. Partial-finalize-and-resume — manual close validation
  // ==========================================================================
  // Adapted from "4 writers, batch 1 = writers 1+2, batch 2 = writers 3+4" to
  // "2 writers, batch 1 = Bob, batch 2 = Alice" — same partial-resume pattern,
  // 2 writers because of the deposit gate constraint (see header).
  describe("8. Partial-finalize-and-resume — 2 writers across 2 batches", () => {
    let ctx: Awaited<ReturnType<typeof buildTwoWriterScenario>>;
    const STRIKE = usdc(84);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildTwoWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        aliceDeposit: usdc(500),
        bobDeposit: usdc(500),
        quantitySold: 0,
      });
      console.log("    Waiting 10s for partial-resume expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("batch 1 closes Bob only (vault still alive); batch 2 closes Alice + dust sweep", async function () {
      this.timeout(60_000);

      // ---- Batch 1: Bob only ----
      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
      ]);

      await assertPositionClosed(ctx.bobPosPda, "Bob (batch 1)");

      // Alice still alive
      const aliceInfo = await connection.getAccountInfo(ctx.alicePosPda);
      assert.isNotNull(aliceInfo, "Alice's position should still exist after batch 1");
      assert.isAbove(aliceInfo!.lamports, 0, "Alice's lamports > 0");

      // Vault still alive
      const vaultMid = await program.account.sharedVault.fetch(ctx.vaultPda);
      assert.isAbove(vaultMid.totalShares.toNumber(), 0, "total_shares > 0 after batch 1");
      const vaultUsdcMid = await connection.getAccountInfo(ctx.vaultUsdcPda);
      assert.isNotNull(vaultUsdcMid, "vault_usdc still alive");

      // ---- Batch 2: Alice ----
      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
      ]);

      await assertPositionClosed(ctx.alicePosPda, "Alice (batch 2)");

      const vaultEnd = await program.account.sharedVault.fetch(ctx.vaultPda);
      assert.equal(vaultEnd.totalShares.toNumber(), 0, "total_shares = 0 after batch 2");
      assert.isNull(await connection.getAccountInfo(ctx.vaultUsdcPda),
        "vault_usdc closed by last-writer branch in batch 2");
    });
  });

  // ==========================================================================
  // 9. Re-encounter closed positions AFTER vault closed — terminal state
  // ==========================================================================
  // Asymmetry vs holder-side: writer-side has a TERMINAL STATE (last writer
  // closes vault_usdc). A second auto_finalize_writers call after that point
  // reverts at the Accounts struct constraint because vault_usdc is gone.
  // Holder-side is symmetric: re-running on a fully-burned vault returns
  // zero counters silently.
  describe("9. Re-encounter after vault closed — Accounts-struct constraint reverts", () => {
    let ctx: Awaited<ReturnType<typeof buildTwoWriterScenario>>;
    const STRIKE = usdc(85);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildTwoWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        aliceDeposit: usdc(500),
        bobDeposit: usdc(500),
        quantitySold: 0,
      });
      console.log("    Waiting 10s for re-encounter-terminal expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);

      // First batch: finalize both writers, vault_usdc closed
      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
        { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
      ]);

      assert.isNull(await connection.getAccountInfo(ctx.vaultUsdcPda),
        "vault_usdc closed after first batch");
    });

    it("second call (after vault_usdc closed) reverts on Accounts deserialization", async function () {
      this.timeout(30_000);
      try {
        await callAutoFinalizeWriters(ctx, [
          { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
        ]);
        assert.fail("should have reverted");
      } catch (e: any) {
        // The vault_usdc_account is closed → AccountNotInitialized or similar
        // failure during Anchor deserialization. We don't hard-pin the exact
        // error string; just confirm it's a revert, not a successful tx.
        const msg = e.toString();
        assert.isTrue(
          msg.includes("AccountNotInitialized")
          || msg.includes("AccountOwnedByWrongProgram")
          || msg.includes("custom program error")
          || msg.includes("Account does not exist"),
          `expected an account-deserialization revert, got: ${msg}`,
        );
      }
    });
  });

  // ==========================================================================
  // 10. Re-encounter mid-batch — manual close validation across batches
  // ==========================================================================
  // Adapted from "3 writers, batch 1 closes 2, batch 2 includes 1 closed + 1
  // untouched" to "2 writers, batch 1 closes Bob, batch 2 includes Bob + Alice".
  describe("10. Re-encounter closed Bob in batch 2 alongside untouched Alice", () => {
    let ctx: Awaited<ReturnType<typeof buildTwoWriterScenario>>;
    const STRIKE = usdc(86);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildTwoWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        aliceDeposit: usdc(500),
        bobDeposit: usdc(500),
        quantitySold: 0,
      });
      console.log("    Waiting 10s for re-encounter-mid-batch expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("batch 2 [Bob (closed), Alice (untouched)] — Bob silent-skipped, Alice finalized + sweep", async function () {
      this.timeout(60_000);

      // Batch 1: Bob only
      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
      ]);
      await assertPositionClosed(ctx.bobPosPda, "Bob (batch 1)");

      const events: any[] = [];
      const listener = program.addEventListener("writersFinalized", (e: any) => events.push(e));

      const aliceUsdcBefore = await getUsdc(ctx.alice.usdc);
      const bobUsdcBefore = await getUsdc(ctx.bob.usdc);

      // Batch 2: re-pass closed Bob + untouched Alice
      await callAutoFinalizeWriters(ctx, [
        { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
        { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
      ]);

      await sleep(1500);
      await program.removeEventListener(listener);

      // Bob already closed → no further USDC delta from batch 2
      const bobDelta = Number((await getUsdc(ctx.bob.usdc)) - bobUsdcBefore);
      assert.equal(bobDelta, 0, "Bob silent-skipped, no double pay");

      // Alice processed
      const aliceDelta = Number((await getUsdc(ctx.alice.usdc)) - aliceUsdcBefore);
      assert.equal(aliceDelta, usdc(500).toNumber(), "Alice = $500");
      await assertPositionClosed(ctx.alicePosPda, "Alice (batch 2)");

      // Last-writer branch fired in batch 2
      assert.isNull(await connection.getAccountInfo(ctx.vaultUsdcPda),
        "vault_usdc closed by last-writer branch in batch 2");

      assert.equal(events[0].writersProcessed, 1, "only Alice processed (Bob silent-skipped)");
    });
  });

  // ==========================================================================
  // 11. Pre-settlement call reverts with VaultNotSettled
  // ==========================================================================
  describe("11. Pre-settlement call reverts with VaultNotSettled", () => {
    let ctx: Awaited<ReturnType<typeof buildSingleWriterScenario>>;
    const STRIKE = usdc(400);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildSingleWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 600, // not expiring during this test
        deposit: usdc(100),
        quantitySold: 0,
      });
    });

    it("auto_finalize_writers on un-settled vault reverts with VaultNotSettled", async function () {
      this.timeout(30_000);
      try {
        await callAutoFinalizeWriters(ctx, [{
          writerPos: ctx.alicePosPda,
          writerUsdc: ctx.alice.usdc,
          writerWallet: ctx.alice.kp.publicKey,
        }]);
        assert.fail("should have reverted with VaultNotSettled");
      } catch (e: any) {
        assert.include(e.toString(), "VaultNotSettled");
      }
    });
  });

  // ==========================================================================
  // 12. Wrong-vault writer position — hard revert
  // ==========================================================================
  describe("12. Wrong-vault writer position reverts with WriterPositionVaultMismatch", () => {
    let ctxA: Awaited<ReturnType<typeof buildSingleWriterScenario>>;
    let ctxB: Awaited<ReturnType<typeof buildSingleWriterScenario>>;

    before(async function () {
      this.timeout(240_000);
      // Two settled vaults (different strikes)
      ctxA = await buildSingleWriterScenario({
        strike: usdc(87),
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        deposit: usdc(100),
        quantitySold: 0,
      });
      ctxB = await buildSingleWriterScenario({
        strike: usdc(88),
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        deposit: usdc(100),
        quantitySold: 0,
      });
      console.log("    Waiting 10s for wrong-vault expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctxA.expiry, ctxA.vaultPda, SOL_250_FRESH);
      await settleAfterExpiry(ctxB.expiry, ctxB.vaultPda, SOL_250_FRESH);
    });

    it("calling auto_finalize_writers on vault A with vault B's writer_position reverts", async function () {
      this.timeout(30_000);
      try {
        await callAutoFinalizeWriters(
          { vaultPda: ctxA.vaultPda, vaultUsdcPda: ctxA.vaultUsdcPda },
          [{
            writerPos: ctxB.alicePosPda, // ← vault B's writer_position
            writerUsdc: ctxB.alice.usdc,
            writerWallet: ctxB.alice.kp.publicKey,
          }],
        );
        assert.fail("should have reverted with WriterPositionVaultMismatch");
      } catch (e: any) {
        assert.include(e.toString(), "WriterPositionVaultMismatch");
      }
    });
  });

  // ==========================================================================
  // 13. Wallet pubkey mismatch — hard revert
  // ==========================================================================
  describe("13. Wallet pubkey mismatch reverts with WriterWalletMismatch", () => {
    let ctx: Awaited<ReturnType<typeof buildSingleWriterScenario>>;
    let stranger: Keypair;
    const STRIKE = usdc(89);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildSingleWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        deposit: usdc(100),
        quantitySold: 0,
      });
      stranger = Keypair.generate();
      console.log("    Waiting 10s for wallet-mismatch expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("passing stranger's wallet pubkey for Alice's position reverts", async function () {
      this.timeout(30_000);
      try {
        await callAutoFinalizeWriters(ctx, [{
          writerPos: ctx.alicePosPda,
          writerUsdc: ctx.alice.usdc,
          writerWallet: stranger.publicKey, // ← wrong wallet
        }]);
        assert.fail("should have reverted with WriterWalletMismatch");
      } catch (e: any) {
        assert.include(e.toString(), "WriterWalletMismatch");
      }
    });
  });

  // ==========================================================================
  // 14. Mismatched USDC ATA — silent skip (NOT revert)
  // ==========================================================================
  describe("14. Mismatched USDC ATA — silent skip", () => {
    let ctx: Awaited<ReturnType<typeof buildSingleWriterScenario>>;
    let strangerUsdc: PublicKey;
    const STRIKE = usdc(91);

    before(async function () {
      this.timeout(180_000);
      ctx = await buildSingleWriterScenario({
        strike: STRIKE,
        optionType: { call: {} },
        optionTypeIndex: 0,
        expirySeconds: 8,
        deposit: usdc(100),
        quantitySold: 0,
      });

      const stranger = await freshWallet(0);
      strangerUsdc = stranger.usdc; // a USDC ATA whose owner != Alice

      console.log("    Waiting 10s for usdc-mismatch expiry...");
      await sleep(10_000);
      await settleAfterExpiry(ctx.expiry, ctx.vaultPda, SOL_250_FRESH);
    });

    it("call succeeds; Alice's position NOT closed; no USDC moves; writers_processed = 0", async function () {
      this.timeout(60_000);

      const events: any[] = [];
      const listener = program.addEventListener("writersFinalized", (e: any) => events.push(e));

      const aliceUsdcBefore = await getUsdc(ctx.alice.usdc);
      const strangerUsdcBefore = await getUsdc(strangerUsdc);

      await callAutoFinalizeWriters(ctx, [{
        writerPos: ctx.alicePosPda,
        writerUsdc: strangerUsdc, // ← wrong USDC ATA
        writerWallet: ctx.alice.kp.publicKey,
      }]);

      await sleep(1500);
      await program.removeEventListener(listener);

      // Alice's position survives — silent skip means no close
      const posInfo = await connection.getAccountInfo(ctx.alicePosPda);
      assert.isNotNull(posInfo, "Alice's position should still exist (silent skip)");
      assert.isAbove(posInfo!.lamports, 0, "Alice's lamports > 0");

      // No USDC moved
      assert.equal(await getUsdc(ctx.alice.usdc), aliceUsdcBefore, "Alice's USDC unchanged");
      assert.equal(await getUsdc(strangerUsdc), strangerUsdcBefore, "Stranger's USDC unchanged");

      // Event fires with zero counters
      assert.equal(events.length, 1);
      assert.equal(events[0].writersProcessed, 0, "skipped pair → 0");
      assert.equal(events[0].totalPaidOut.toNumber(), 0);
    });
  });
});
