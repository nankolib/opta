// =============================================================================
// tests/zzz-crit1-holders-first-gate.ts — CRIT-1 holders-first gate tests
// =============================================================================
//
// Tests the holders-first gate added to withdraw_post_settlement.rs and
// auto_finalize_writers.rs by the May-4 audit-fix arc (audit Run-6, CRIT-1).
//
// The gate blocks writers from withdrawing pro-rata collateral until either:
//   (a) EXERCISE_WINDOW (24h) has elapsed since vault.expiry, OR
//   (b) the vault never sold any options (total_options_sold == 0).
//
// =============================================================================
// SCOPE
// =============================================================================
//
// Active tests (4) cover the directly-testable scenarios:
//
//   1. withdraw_post_settlement — sole writer ITM, BEFORE window → reverts
//   2. withdraw_post_settlement — sole writer no-buyer fast path → succeeds
//   3. auto_finalize_writers   — multi-writer ITM, BEFORE window → batch reverts
//   4. auto_finalize_writers   — multi-writer no-buyer fast path → both processed
//
// Skipped tests (3) cover the AFTER-window paths. Localnet has no clock-warp
// helper (confirmed via shared-vaults.ts:1111 and a grep for warp/forwardTime
// across tests/ — zero hits). Crossing the 24h boundary requires either:
//   - 24h real wall-clock wait (unacceptable)
//   - Adoption of bankrun or litesvm — separate test-infra arc
//
// Each it.skip() below documents what it would prove and what infra it needs.
//
// =============================================================================
// HOW TO RUN
// =============================================================================
//
// Incremental (against a running validator with fixtures pre-loaded):
//   ./.test-fixtures/run-tests.sh tests/zzz-crit1-holders-first-gate.ts
//
// Full clean-slate (fresh validator + fixtures + all tests):
//   anchor test
//
// =============================================================================
// TIMING APPROACH (on-chain clock polling + two fixtures, ~155s total)
// =============================================================================
//
// Past-baseTime expiries fail create_shared_vault.rs:42 ("expiry must be
// strictly future, ≥ now + 5s for Custom vaults"), so we use future expiries.
// The 90s spread between Test 1 and Test 4's expiries (60 → 150) exceeds the
// 60s settle_expiry publish-time window, so we use TWO fixtures:
//
//   Fixture A (sol-250-window-future-90, publish_time = baseTime + 90):
//     Test 1 expiry = baseTime + 60   (gap = +30)
//     Test 2 expiry = baseTime + 90   (gap = 0)
//
//   Fixture B (sol-250-window-future-180, publish_time = baseTime + 180):
//     Test 3 expiry = baseTime + 120  (gap = +60)
//     Test 4 expiry = baseTime + 150  (gap = +30)
//
// Each test:
//   1. Creates vault with its baseTime-relative future expiry.
//   2. Waits via waitUntilOnchain() — polls connection.getBlockTime() every
//      500ms until on-chain clock crosses the expiry. 120s hard cap before
//      throwing (safety against stuck validator).
//   3. Calls settleAfterExpiry with the matching fixture pubkey.
//   4. Tests gate behavior. Gate fires for ITM tests because clock is only
//      seconds past expiry — far below expiry + EXERCISE_WINDOW (24h).
//
// Why on-chain polling instead of wall-clock: solana-test-validator's slot
// rate can lag wall-clock during idle waits, so Date.now() crossing expiry
// doesn't guarantee Clock::get() has crossed it yet. The previous
// wall-clock-based attempt (with a 500ms buffer) failed every settle for
// exactly this reason. Polling on-chain directly eliminates the drift.
//
// Total runtime ~155s. The 3 it.skip placeholders below still document the
// after-window paths that require bankrun/litesvm — that gap is unchanged.
//
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

import { fixturePubkey, getFixtureBaseTime } from "./_pyth_fixtures";
import { ensureVolOracle } from "./_vol_oracle_helpers";
import { settlePotAccountsFor } from "./shared/settle-pdas";

// ---- Constants -------------------------------------------------------------
const SOL_FEED_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const SOL_ID = Array.from(Buffer.from(SOL_FEED_HEX, "hex"));
const SOL_250_WINDOW_FUTURE_90  = fixturePubkey("sol-250-window-future-90");  // Fixture A: $250, publish_time = baseTime + 90
const SOL_250_WINDOW_FUTURE_180 = fixturePubkey("sol-250-window-future-180"); // Fixture B: $250, publish_time = baseTime + 180
// HIGH-5: create_market proof gate (sol-180-fresh has feed_id == SOL_ID).
const SOL_180_FRESH_PK = fixturePubkey("sol-180-fresh");

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 });
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

// SKIPPED (fixture-rot remediation): the 4 active gate tests use baseTime-relative
// expiries (baseTime + 60..150) that are already in the PAST by the time this file
// runs (minutes after fixtures are written) — ExpiryInPast (6001) at vault creation.
// Plus the 3 after-window it.skips already needed clock warp. The whole gate suite
// is deterministic only under bankrun setClock — Stage G. Pre-existing, not a regression.
describe.skip("CRIT-1 holders-first gate [ported to tests/bankrun/crit1-holders-first.test.ts — Stage G Pass 3a]", () => {
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
  let marketPda: PublicKey;
  let baseTime: number;

  // ---- PDA helpers (mirrored from zzz-auto-finalize-writers.ts) ----------
  function deriveProtocolStatePda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
  }
  function deriveTreasuryPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], program.programId);
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

  // ---- Bootstrap (idempotent across test files in the same suite) --------
  before(async () => {
    [protocolStatePda] = deriveProtocolStatePda();
    [treasuryPda] = deriveTreasuryPda();
    baseTime = getFixtureBaseTime();

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

    [marketPda] = deriveMarketPda("SOL");
    try {
      await (program as any).methods
        .createMarket("SOL", SOL_ID, 0, 0)
        .accounts({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: payer.publicKey,
          protocolState: protocolStatePda,
          priceUpdate: SOL_180_FRESH_PK,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([payer])
        .rpc();
    } catch { /* idempotent — market may already exist from a prior test file */ }

    // Pass 2 requires vol_oracle on mint_from_vault's uniform context; EUR
    // mints don't read it but it must exist + be program-owned (else 3007).
    await ensureVolOracle(program, SOL_ID, SOL_180_FRESH_PK, payer.publicKey);
  });

  // ---- Wallet helper -----------------------------------------------------
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

  // ---- Single-writer scenario builder ------------------------------------
  // Mirrors buildSingleWriterScenario from zzz-auto-finalize-writers.ts but
  // takes an absolute expiry (not expirySeconds-from-now) so we can pin to
  // baseTime-relative timestamps that match the Pyth fixture's publish_time.
  async function buildSingleWriter(opts: {
    strike: BN;
    optionType: { call: {} } | { put: {} };
    optionTypeIndex: number;
    expiry: BN;
    deposit: BN;
    quantitySold: number;
  }) {
    const alice = await freshWallet();
    const buyer = await freshWallet();

    const [vaultPda] = deriveSharedVaultPda(
      marketPda, opts.strike, opts.expiry, opts.optionTypeIndex,
    );
    const [vaultUsdcPda] = deriveVaultUsdcPda(vaultPda);

    await (program as any).methods
      .createSharedVault(opts.strike, opts.expiry, opts.optionType, { custom: {} }, usdcMint, 0, { european: {} })
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

    if (opts.quantitySold > 0) {
      const mintCreatedAt = new BN(Math.floor(Date.now() / 1000));
      const [optionMintPda] = deriveVaultOptionMintPda(vaultPda, alice.kp.publicKey, mintCreatedAt);
      const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(vaultPda, alice.kp.publicKey, mintCreatedAt);
      const [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      const mintTx = new Transaction().add(EXTRA_CU);
      mintTx.add(
        await (program as any).methods
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
          .instruction(),
      );
      await provider.sendAndConfirm(mintTx, [alice.kp]);

      const buyerOptAta = await createAssociatedTokenAccountIdempotent(
        connection, payer, optionMintPda, buyer.kp.publicKey, {}, TOKEN_2022_PROGRAM_ID,
      );

      const buyTx = new Transaction().add(EXTRA_CU);
      buyTx.add(
        await (program as any).methods
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
          .instruction(),
      );
      await provider.sendAndConfirm(buyTx, [buyer.kp]);
    }

    return { alice, buyer, vaultPda, vaultUsdcPda, alicePosPda };
  }

  // ---- Two-writer scenario builder ---------------------------------------
  // Same first-deposit-bypasses-creator-gate trick as buildTwoWriterScenario
  // in zzz-auto-finalize-writers.ts. Produces two WriterPositions on a
  // Custom vault: Alice (creator) and Bob (first depositor).
  async function buildTwoWriters(opts: {
    strike: BN;
    optionType: { call: {} } | { put: {} };
    optionTypeIndex: number;
    expiry: BN;
    aliceDeposit: BN;
    bobDeposit: BN;
    quantitySold: number;
  }) {
    const alice = await freshWallet();
    const bob = await freshWallet();
    const buyer = await freshWallet();

    const [vaultPda] = deriveSharedVaultPda(
      marketPda, opts.strike, opts.expiry, opts.optionTypeIndex,
    );
    const [vaultUsdcPda] = deriveVaultUsdcPda(vaultPda);

    await (program as any).methods
      .createSharedVault(opts.strike, opts.expiry, opts.optionType, { custom: {} }, usdcMint, 0, { european: {} })
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

    // Bob deposits FIRST — total_shares == 0 → creator-gate skipped
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

    // Alice deposits SECOND — gate fires, writer == creator passes
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

    if (opts.quantitySold > 0) {
      const mintCreatedAt = new BN(Math.floor(Date.now() / 1000));
      const [optionMintPda] = deriveVaultOptionMintPda(vaultPda, bob.kp.publicKey, mintCreatedAt);
      const [purchaseEscrowPda] = deriveVaultPurchaseEscrowPda(vaultPda, bob.kp.publicKey, mintCreatedAt);
      const [vaultMintRecordPda] = deriveVaultMintRecordPda(optionMintPda);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      const mintTx = new Transaction().add(EXTRA_CU);
      mintTx.add(
        await (program as any).methods
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
          .instruction(),
      );
      await provider.sendAndConfirm(mintTx, [bob.kp]);

      const buyerOptAta = await createAssociatedTokenAccountIdempotent(
        connection, payer, optionMintPda, buyer.kp.publicKey, {}, TOKEN_2022_PROGRAM_ID,
      );

      const buyTx = new Transaction().add(EXTRA_CU);
      buyTx.add(
        await (program as any).methods
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
          .instruction(),
      );
      await provider.sendAndConfirm(buyTx, [buyer.kp]);
    }

    return { alice, bob, buyer, vaultPda, vaultUsdcPda, alicePosPda, bobPosPda };
  }

  // ---- Settle helper -----------------------------------------------------
  async function settleAfterExpiry(
    expiry: BN,
    vaultPda: PublicKey,
    priceUpdate: PublicKey,
  ) {
    const [settlementPda] = deriveSettlementPda("SOL", expiry);
    await (program as any).methods
      .settleExpiry("SOL", expiry)
      .accounts({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
        caller: payer.publicKey,
        market: marketPda,
        priceUpdate,
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
        // Phase 3 retro-harden — required, derived from vault identity (empty for no-pot).
        ...(await settlePotAccountsFor(program, marketPda, vaultPda)),
      })
      .signers([payer])
      .rpc();
  }

  // ---- Auto-finalize-writers helper --------------------------------------
  async function callAutoFinalizeWriters(
    ctx: { vaultPda: PublicKey; vaultUsdcPda: PublicKey },
    triples: { writerPos: PublicKey; writerUsdc: PublicKey; writerWallet: PublicKey }[],
  ): Promise<string> {
    const remaining: AccountMeta[] = [];
    for (const t of triples) {
      remaining.push({ pubkey: t.writerPos, isSigner: false, isWritable: true });
      remaining.push({ pubkey: t.writerUsdc, isSigner: false, isWritable: true });
      remaining.push({ pubkey: t.writerWallet, isSigner: false, isWritable: true });
    }

    const tx = new Transaction().add(EXTRA_CU);
    tx.add(
      await (program as any).methods
        .autoFinalizeWriters()
        .accounts({
          caller: payer.publicKey,
          sharedVault: ctx.vaultPda,
          market: marketPda,
          vaultUsdcAccount: ctx.vaultUsdcPda,
          treasury: treasuryPda,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remaining)
        .signers([payer])
        .instruction(),
    );
    return await provider.sendAndConfirm(tx, [payer]);
  }

  async function getUsdc(ata: PublicKey): Promise<bigint> {
    const acc = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    return acc.amount;
  }

  /// Wait until the validator's on-chain Clock crosses targetSec (Unix seconds).
  /// Polls connection.getBlockTime() every 500ms; treats null returns as "not
  /// yet" and keeps polling. Throws after 120s of polling to surface a stuck
  /// validator instead of hanging the test.
  ///
  /// Used to cross a SharedVault's expiry between vault-create (which requires
  /// expiry > clock + 5s) and settle_expiry (which requires clock >= expiry).
  /// On-chain clock can lag wall-clock by several seconds during idle waits;
  /// polling on-chain directly eliminates that drift.
  async function waitUntilOnchain(targetSec: number): Promise<void> {
    const startMs = Date.now();
    const maxPollMs = 120_000;
    while (true) {
      const slot = await connection.getSlot("confirmed");
      const blockTime = await connection.getBlockTime(slot);
      if (blockTime !== null && blockTime >= targetSec) {
        return;
      }
      if (Date.now() - startMs > maxPollMs) {
        throw new Error(
          `waitUntilOnchain: timed out after 120s — on-chain clock did not reach ${targetSec}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ==========================================================================
  // withdraw_post_settlement gate
  // ==========================================================================

  describe("withdraw_post_settlement gate", () => {

    // Test 1 — Sole writer ITM, BEFORE window. Buyers exist (quantitySold=1),
    // settle landed but only seconds ago — gate must reject the writer's
    // attempt to drain ahead of the holder. Proves the manual writer-withdraw
    // path enforces the holders-first invariant.
    it("Test 1: sole writer ITM, BEFORE window → reverts with HolderExerciseWindowOpen", async function () {
      this.timeout(120_000);
      const expiry = new BN(baseTime + 60); // gap = +30 with sol-250-window-future-90 (Fixture A)
      const ctx = await buildSingleWriter({
        strike: usdc(200), // CALL strike $200, settle $250 → ITM by $50/contract
        optionType: { call: {} },
        optionTypeIndex: 0,
        expiry,
        deposit: usdc(500),
        quantitySold: 1,
      });
      await waitUntilOnchain(expiry.toNumber());
      await settleAfterExpiry(expiry, ctx.vaultPda, SOL_250_WINDOW_FUTURE_90);

      let reverted = false;
      let errString = "";
      try {
        await (program as any).methods
          .withdrawPostSettlement()
          .accounts({
            writer: ctx.alice.kp.publicKey,
            sharedVault: ctx.vaultPda,
            writerPosition: ctx.alicePosPda,
            vaultUsdcAccount: ctx.vaultUsdcPda,
            writerUsdcAccount: ctx.alice.usdc,
            protocolState: protocolStatePda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([ctx.alice.kp])
          .rpc();
      } catch (err: any) {
        reverted = true;
        errString = String(err);
      }

      assert.isTrue(reverted, "expected withdraw_post_settlement to revert");
      assert.match(
        errString,
        /HolderExerciseWindowOpen/,
        `expected HolderExerciseWindowOpen, got: ${errString}`,
      );
    });

    // Test 2 — Sole writer NO-BUYER fast path. quantitySold=0 means
    // total_options_sold == 0 in the vault, so the gate skips entirely and
    // the writer withdraws immediately at settle. Mirrors the existing
    // zzz-auto-finalize-writers.ts:984 test path but for the manual
    // withdraw_post_settlement instruction (existing test exercises
    // auto_finalize_writers).
    it("Test 2: sole writer no-buyer fast path → succeeds immediately", async function () {
      this.timeout(120_000);
      const expiry = new BN(baseTime + 90); // gap = 0 with sol-250-window-future-90 (Fixture A)
      const ctx = await buildSingleWriter({
        strike: usdc(200),
        optionType: { call: {} },
        optionTypeIndex: 0,
        expiry,
        deposit: usdc(500),
        quantitySold: 0, // ← no buyers — fast path triggers
      });
      await waitUntilOnchain(expiry.toNumber());
      await settleAfterExpiry(expiry, ctx.vaultPda, SOL_250_WINDOW_FUTURE_90);

      const beforeBal = await getUsdc(ctx.alice.usdc);
      await (program as any).methods
        .withdrawPostSettlement()
        .accounts({
          writer: ctx.alice.kp.publicKey,
          sharedVault: ctx.vaultPda,
          writerPosition: ctx.alicePosPda,
          vaultUsdcAccount: ctx.vaultUsdcPda,
          writerUsdcAccount: ctx.alice.usdc,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([ctx.alice.kp])
        .rpc();
      const afterBal = await getUsdc(ctx.alice.usdc);

      assert.equal(
        Number(afterBal - beforeBal),
        usdc(500).toNumber(),
        "writer should receive full deposit back via fast path",
      );
    });

    // SKIPPED — would prove that AFTER the window opens (24h post-expiry),
    // a writer's withdraw_post_settlement succeeds with the correct reduced
    // amount accounting for any prior holder exercises. Cannot test today
    // because localnet has no clock-warp helper. Re-enable after adopting
    // bankrun or litesvm in a separate test-infra arc.
    it.skip("(future) sole writer ITM, AFTER window → succeeds with reduction; requires bankrun/litesvm", () => {});
  });

  // ==========================================================================
  // auto_finalize_writers gate
  // ==========================================================================

  describe("auto_finalize_writers gate", () => {

    // Test 3 — Multi-writer ITM, BEFORE window. Crank-style call to
    // auto_finalize_writers with both writers' triples in remaining_accounts.
    // Whole batch must revert (the gate evaluates once per instruction call,
    // not per writer). Proves the crank's batched payout path enforces the
    // same invariant as the manual path tested above.
    it("Test 3: multi-writer ITM batch, BEFORE window → whole batch reverts", async function () {
      this.timeout(120_000);
      const expiry = new BN(baseTime + 120); // gap = +60 with sol-250-window-future-180 (Fixture B)
      const ctx = await buildTwoWriters({
        strike: usdc(200),
        optionType: { call: {} },
        optionTypeIndex: 0,
        expiry,
        aliceDeposit: usdc(500),
        bobDeposit: usdc(500),
        quantitySold: 1,
      });
      await waitUntilOnchain(expiry.toNumber());
      await settleAfterExpiry(expiry, ctx.vaultPda, SOL_250_WINDOW_FUTURE_180);

      let reverted = false;
      let errString = "";
      try {
        await callAutoFinalizeWriters(
          { vaultPda: ctx.vaultPda, vaultUsdcPda: ctx.vaultUsdcPda },
          [
            { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
            { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
          ],
        );
      } catch (err: any) {
        reverted = true;
        errString = String(err);
      }

      assert.isTrue(reverted, "expected auto_finalize_writers to revert");
      assert.match(
        errString,
        /HolderExerciseWindowOpen/,
        `expected HolderExerciseWindowOpen, got: ${errString}`,
      );
    });

    // Test 4 — Multi-writer NO-BUYER fast path. Same setup as Test 3 but
    // quantitySold=0 → gate skips → both writers processed normally on the
    // first crank call. Asserts both receive their full deposits back.
    // Companion to zzz-auto-finalize-writers.ts:984 (which uses the same
    // mechanism but a different test scenario shape).
    it("Test 4: multi-writer no-buyer fast path → both writers processed", async function () {
      this.timeout(120_000);
      const expiry = new BN(baseTime + 150); // gap = +30 with sol-250-window-future-180 (Fixture B)
      const ctx = await buildTwoWriters({
        strike: usdc(200),
        optionType: { call: {} },
        optionTypeIndex: 0,
        expiry,
        aliceDeposit: usdc(500),
        bobDeposit: usdc(500),
        quantitySold: 0,
      });
      await waitUntilOnchain(expiry.toNumber());
      await settleAfterExpiry(expiry, ctx.vaultPda, SOL_250_WINDOW_FUTURE_180);

      const aliceBefore = await getUsdc(ctx.alice.usdc);
      const bobBefore = await getUsdc(ctx.bob.usdc);

      await callAutoFinalizeWriters(
        { vaultPda: ctx.vaultPda, vaultUsdcPda: ctx.vaultUsdcPda },
        [
          { writerPos: ctx.bobPosPda, writerUsdc: ctx.bob.usdc, writerWallet: ctx.bob.kp.publicKey },
          { writerPos: ctx.alicePosPda, writerUsdc: ctx.alice.usdc, writerWallet: ctx.alice.kp.publicKey },
        ],
      );

      const aliceDelta = Number((await getUsdc(ctx.alice.usdc)) - aliceBefore);
      const bobDelta = Number((await getUsdc(ctx.bob.usdc)) - bobBefore);

      assert.equal(aliceDelta, usdc(500).toNumber(), "Alice should receive full deposit back");
      assert.equal(bobDelta, usdc(500).toNumber(), "Bob should receive full deposit back");
    });

    // SKIPPED — would prove that AFTER the window opens, the batched
    // auto_finalize_writers call processes both writers and pays them
    // pro-rata after holder exercises completed. Same blocker as the
    // withdraw_post_settlement skip above: needs bankrun/litesvm.
    it.skip("(future) multi-writer ITM batch, AFTER window → both processed pro-rata; requires bankrun/litesvm", () => {});

    // SKIPPED — would prove the OTM path (settlement < strike for CALL,
    // or > strike for PUT) returns full collateral to writers after the
    // window opens. Companion to Test 4 but for OTM rather than no-buyer.
    // Same bankrun/litesvm dependency.
    it.skip("(future) OTM after window → writers receive full collateral; requires bankrun/litesvm", () => {});
  });
});
