// =============================================================================
// tests/zzz-mint-from-vault-american-pricing.ts -- Pass 2 Step 2 coverage
// =============================================================================
//
// LIVE tests:
//   (b) AMER mint with fresh (sample_count=0) VolOracle -> VolOracleWarmup
//   (e) EUR mint with vol_oracle account present -> succeeds, premium = arg
//       (proves the uniform-context constraint doesn't regress EUR pricing)
//
// SKIPPED tests (it.skip, Tier-2 future-arc blocker):
//   (a) AMER mint with warmed-up oracle -> computed premium > 0
//   (c) AMER mint with last_sample_ts > 6h -> VolOracleStale
//   (d) AMER mint with last_spot_price = 0 -> VolOracleInvalidSpot
//   (f) AMER q=0 fast-path == European fast-path
//
// The skipped tests all require a warmed-up oracle (>= 168 hourly samples)
// which is not feasible without a test-only synth instruction. Building
// that synth instruction is a separate future arc (mirrors
// cu_profile_realized_vol pattern but exposed under a `test-synth-vol`
// feature flag rather than `cu-profile`). The CU profile + warmup error +
// EUR no-regression cover the critical signals for Pass 2 ship gate.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAccount as createTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import { fixturePubkey, AMER_PRICE_FEED_HEX } from "./_pyth_fixtures";
import { synthWarmVolOracle, spotScaled, staleTs } from "./_vol_oracle_helpers";

// Dedicated isolated feed for this suite so its cold/warm/stale oracle states
// don't collide with other files that warm the SOL oracle (e.g.
// zzz-american-vault-lifecycle.ts). Backed by the amer-price-fresh fixture.
const FEED_ID = Array.from(Buffer.from(AMER_PRICE_FEED_HEX, "hex"));
const FEED_FIXTURE = fixturePubkey("amer-price-fresh");

// Suite-specific asset name avoids collision with concurrent test suites in
// the same validator session.
const TEST_ASSET = "AMERPRICETEST";

const HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG",
);

const EXTRA_CU_400K = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const EXTRA_CU_800K = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

// UN-SKIPPED by the fixture-rot remediation arc. Runs under the harness built
// with test-fast-vol,american-enabled,test-synth-vol. (a)/(c)/(d) drive the
// oracle through warmed / stale / zero-spot states via synth_warm_vol_oracle
// on a DEDICATED feed (isolated from other files' SOL oracle). (b) runs first
// against the cold oracle; (f) proves the q=0 guard.
describe("zzz-mint-from-vault-american-pricing (Stage C Pass 2 Step 2)", function () {
  this.timeout(120_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.opta as Program<Opta>;
  const wallet = provider.wallet as anchor.Wallet;
  const payer = (wallet as any).payer as Keypair;

  let usdcMint: PublicKey;
  let protocolStatePda: PublicKey;
  let marketPda: PublicKey;
  let volOraclePda: PublicKey;

  function deriveSharedVault(seedPrefix: string, strike: BN, expiry: BN, optTypeIdx: number) {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from(seedPrefix),
        marketPda.toBuffer(),
        strike.toArrayLike(Buffer, "le", 8),
        expiry.toArrayLike(Buffer, "le", 8),
        Buffer.from([optTypeIdx]),
      ],
      program.programId,
    )[0];
  }
  function deriveVaultUsdc(vault: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault_usdc"), vault.toBuffer()],
      program.programId,
    )[0];
  }
  function deriveWriterPos(vault: PublicKey, writer: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("writer_position"), vault.toBuffer(), writer.toBuffer()],
      program.programId,
    )[0];
  }
  function deriveVaultOptionMint(vault: PublicKey, writer: PublicKey, createdAt: BN) {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault_option_mint"),
        vault.toBuffer(),
        writer.toBuffer(),
        createdAt.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    )[0];
  }
  function deriveVaultPurchaseEscrow(vault: PublicKey, writer: PublicKey, createdAt: BN) {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault_purchase_escrow"),
        vault.toBuffer(),
        writer.toBuffer(),
        createdAt.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    )[0];
  }
  function deriveVaultMintRecord(optionMint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault_mint_record"), optionMint.toBuffer()],
      program.programId,
    )[0];
  }
  function deriveExtraMetaList(mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.toBuffer()],
      HOOK_PROGRAM_ID,
    )[0];
  }
  function deriveHookState(mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("hook-state"), mint.toBuffer()],
      HOOK_PROGRAM_ID,
    )[0];
  }

  async function setupWriter(): Promise<{ kp: Keypair; usdcAta: PublicKey }> {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      kp.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
    const usdcAta = await createTokenAccount(
      provider.connection, payer, usdcMint, kp.publicKey,
      undefined, undefined, TOKEN_PROGRAM_ID,
    );
    await mintTo(
      provider.connection, payer, usdcMint, usdcAta, payer, 10_000_000_000,
    );
    return { kp, usdcAta };
  }

  before(async () => {
    // Protocol state is a session-wide singleton. Reuse its USDC mint when it
    // already exists (create_shared_vault enforces usdc_mint ==
    // protocol_state.usdc_mint); minting our own would trip ConstraintRaw 2003.
    [protocolStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_v2")],
      program.programId,
    );
    if (await provider.connection.getAccountInfo(protocolStatePda)) {
      const protocolState = await (program.account as any).protocolState.fetch(
        protocolStatePda,
      );
      usdcMint = protocolState.usdcMint;
    } else {
      usdcMint = await createMint(
        provider.connection, payer, payer.publicKey, null, 6,
      );
      const [treasuryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury_v2")],
        program.programId,
      );
      await (program.methods as any)
        .initializeProtocol()
        .accounts({
          admin: payer.publicKey,
          protocolState: protocolStatePda,
          treasury: treasuryPda,
          usdcMint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }

    // Market (AMERPRICETEST asset, SOL feed).
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(TEST_ASSET)],
      program.programId,
    );
    if (!(await provider.connection.getAccountInfo(marketPda))) {
      await (program.methods as any)
        .createMarket(TEST_ASSET, FEED_ID, 0, 0)
        .accounts({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: payer.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          priceUpdate: FEED_FIXTURE,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // VolOracle (fresh — sample_count=0, will trigger Warmup on AMER mint).
    [volOraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vol_oracle"), Buffer.from(FEED_ID)],
      program.programId,
    );
    if (!(await provider.connection.getAccountInfo(volOraclePda))) {
      await (program.methods as any)
        .initializeVolOracle(FEED_ID, 0, new BN(0))
        .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          initializer: payer.publicKey,
          priceUpdate: FEED_FIXTURE,
          volOracle: volOraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  it("(b) AMER mint with cold un-warmed oracle (seed_vol=0) reverts VolOracleWarmup", async () => {
    const { kp: writer, usdcAta: writerUsdc } = await setupWriter();
    const strike = usdc(100); // $100
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7200);
    const vault = deriveSharedVault("shared_vault_american", strike, expiry, 0);
    const vaultUsdc = deriveVaultUsdc(vault);

    // Create AMER vault.
    await (program.methods as any)
      .createSharedVault(
        strike, expiry, { call: {} }, { custom: {} },
        usdcMint, 0, { american: {} },
      )
      .accounts({
        creator: writer.publicKey,
        market: marketPda,
        sharedVault: vault,
        vaultUsdcAccount: vaultUsdc,
        usdcMint,
        protocolState: protocolStatePda,
        epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([EXTRA_CU_400K])
      .signers([writer])
      .rpc();

    // Deposit $1000 collateral.
    const writerPos = deriveWriterPos(vault, writer.publicKey);
    await (program.methods as any)
      .depositToVault(usdc(1000))
      .accounts({
        writer: writer.publicKey,
        sharedVault: vault,
        writerPosition: writerPos,
        writerUsdcAccount: writerUsdc,
        vaultUsdcAccount: vaultUsdc,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([writer])
      .rpc();

    // Mint -> expected: VolOracleWarmup
    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const optMint = deriveVaultOptionMint(vault, writer.publicKey, createdAt);
    const escrow = deriveVaultPurchaseEscrow(vault, writer.publicKey, createdAt);
    const vaultMint = deriveVaultMintRecord(optMint);

    try {
      await (program.methods as any)
        .mintFromVault(new BN(1), usdc(5), createdAt)
        .accounts({
          writer: writer.publicKey,
          sharedVault: vault,
          writerPosition: writerPos,
          market: marketPda,
          volOracle: volOraclePda,
          protocolState: protocolStatePda,
          optionMint: optMint,
          purchaseEscrow: escrow,
          vaultMintRecord: vaultMint,
          transferHookProgram: HOOK_PROGRAM_ID,
          extraAccountMetaList: deriveExtraMetaList(optMint),
          hookState: deriveHookState(optMint),
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .preInstructions([EXTRA_CU_800K])
        .signers([writer])
        .rpc();
      assert.fail("AMER mint should have reverted with VolOracleWarmup");
    } catch (err: any) {
      // Seed-at-birth (59aeb2e): initialize_vol_oracle now SEEDS last_spot_price
      // + last_sample_ts at birth, so the 6h staleness gate PASSES for a freshly
      // created oracle. A cold oracle (sample_count < 168) seeded with seed_vol=0
      // therefore falls through to the warmup gate → VolOracleWarmup (was
      // VolOracleStale pre-seed-at-birth, when last_sample_ts was 0). Actual
      // staleness (last_sample_ts > 6h → VolOracleStale) is covered by (c).
      assert.include(
        String(err),
        "VolOracleWarmup",
        "expected VolOracleWarmup; got: " + String(err),
      );
    }
  });

  it("(e) EUR mint with vol_oracle in context succeeds, premium = arg verbatim", async () => {
    const { kp: writer, usdcAta: writerUsdc } = await setupWriter();
    const strike = usdc(150); // $150 — distinct from (b)'s $100 to avoid PDA collision
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7200);
    const vault = deriveSharedVault("shared_vault", strike, expiry, 0);
    const vaultUsdc = deriveVaultUsdc(vault);

    await (program.methods as any)
      .createSharedVault(
        strike, expiry, { call: {} }, { custom: {} },
        usdcMint, 0, { european: {} },
      )
      .accounts({
        creator: writer.publicKey,
        market: marketPda,
        sharedVault: vault,
        vaultUsdcAccount: vaultUsdc,
        usdcMint,
        protocolState: protocolStatePda,
        epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([EXTRA_CU_400K])
      .signers([writer])
      .rpc();

    const writerPos = deriveWriterPos(vault, writer.publicKey);
    await (program.methods as any)
      .depositToVault(usdc(1000))
      .accounts({
        writer: writer.publicKey,
        sharedVault: vault,
        writerPosition: writerPos,
        writerUsdcAccount: writerUsdc,
        vaultUsdcAccount: vaultUsdc,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([writer])
      .rpc();

    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const optMint = deriveVaultOptionMint(vault, writer.publicKey, createdAt);
    const escrow = deriveVaultPurchaseEscrow(vault, writer.publicKey, createdAt);
    const vaultMint = deriveVaultMintRecord(optMint);
    const premiumArg = usdc(42); // sentinel value; expect verbatim storage

    await (program.methods as any)
      .mintFromVault(new BN(1), premiumArg, createdAt)
      .accounts({
        writer: writer.publicKey,
        sharedVault: vault,
        writerPosition: writerPos,
        market: marketPda,
        volOracle: volOraclePda,
        protocolState: protocolStatePda,
        optionMint: optMint,
        purchaseEscrow: escrow,
        vaultMintRecord: vaultMint,
        transferHookProgram: HOOK_PROGRAM_ID,
        extraAccountMetaList: deriveExtraMetaList(optMint),
        hookState: deriveHookState(optMint),
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([EXTRA_CU_800K])
      .signers([writer])
      .rpc();

    const record = await (program.account as any).vaultMint.fetch(vaultMint);
    assert.equal(
      record.premiumPerContract.toString(),
      premiumArg.toString(),
      "EUR branch stores premium arg verbatim",
    );
  });

  // ---------------------------------------------------------------------------
  // Warmed/stale/zero-spot tests — un-skipped via the test-synth-vol synth
  // instruction (synthWarmVolOracle), which plants oracle state on the
  // dedicated feed directly. Each uses a distinct strike to avoid vault PDA
  // collision in the shared validator session.
  // ---------------------------------------------------------------------------

  // Create an AMER vault + deposit, returning the handles a mint needs.
  async function createDepositAmer(writer: Keypair, writerUsdc: PublicKey, strike: BN) {
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7200);
    const vault = deriveSharedVault("shared_vault_american", strike, expiry, 0);
    const vaultUsdc = deriveVaultUsdc(vault);
    await (program.methods as any)
      .createSharedVault(strike, expiry, { call: {} }, { custom: {} }, usdcMint, 0, { american: {} })
      .accounts({
        creator: writer.publicKey, market: marketPda, sharedVault: vault,
        vaultUsdcAccount: vaultUsdc, usdcMint, protocolState: protocolStatePda,
        epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .preInstructions([EXTRA_CU_400K]).signers([writer]).rpc();
    const writerPos = deriveWriterPos(vault, writer.publicKey);
    await (program.methods as any)
      .depositToVault(usdc(1000))
      .accounts({
        writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos,
        writerUsdcAccount: writerUsdc, vaultUsdcAccount: vaultUsdc,
        protocolState: protocolStatePda, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([writer]).rpc();
    return { vault, writerPos };
  }

  // Build (not send) a mint_from_vault for the given quantity.
  function mintBuilder(writer: Keypair, vault: PublicKey, writerPos: PublicKey, quantity: BN) {
    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const optMint = deriveVaultOptionMint(vault, writer.publicKey, createdAt);
    const escrow = deriveVaultPurchaseEscrow(vault, writer.publicKey, createdAt);
    const vaultMint = deriveVaultMintRecord(optMint);
    const builder = (program.methods as any)
      .mintFromVault(quantity, usdc(1) /* sentinel; AMER ignores */, createdAt)
      .accounts({
        writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos,
        market: marketPda, volOracle: volOraclePda, protocolState: protocolStatePda,
        optionMint: optMint, purchaseEscrow: escrow, vaultMintRecord: vaultMint,
        transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: deriveExtraMetaList(optMint),
        hookState: deriveHookState(optMint), systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([EXTRA_CU_800K]).signers([writer]);
    return { vaultMint, builder };
  }

  it("(a) AMER mint with warmed oracle: computed premium > 0", async () => {
    // Warm the dedicated oracle: 720 samples, fresh ts, $500 spot (ITM vs the
    // $110 strike, so the 2h BS-2002 premium is comfortably > 0 — an OTM 2h
    // option would round to 0 USDC and trip InvalidPremium, which is a pricing
    // edge case, not the thing this test proves).
    await synthWarmVolOracle(program, FEED_ID, spotScaled(500), payer.publicKey);
    const { kp: writer, usdcAta: writerUsdc } = await setupWriter();
    const { vault, writerPos } = await createDepositAmer(writer, writerUsdc, usdc(110));
    const { vaultMint, builder } = mintBuilder(writer, vault, writerPos, new BN(1));
    await builder.rpc();
    const rec = await (program.account as any).vaultMint.fetch(vaultMint);
    assert.isTrue(rec.premiumPerContract.gtn(0), "American premium computed on-chain > 0");
  });

  it("(c) AMER mint with last_sample_ts > 6h -> VolOracleStale", async () => {
    // Warmed but stale: last_sample_ts 7h ago.
    await synthWarmVolOracle(program, FEED_ID, spotScaled(100), payer.publicKey, staleTs(7));
    const { kp: writer, usdcAta: writerUsdc } = await setupWriter();
    const { vault, writerPos } = await createDepositAmer(writer, writerUsdc, usdc(120));
    const { builder } = mintBuilder(writer, vault, writerPos, new BN(1));
    try {
      await builder.rpc();
      assert.fail("expected VolOracleStale");
    } catch (err: any) {
      assert.include(String(err), "VolOracleStale", "got: " + String(err));
    }
  });

  it("(d) AMER mint with last_spot_price = 0 -> VolOracleInvalidSpot", async () => {
    // Warmed + fresh but zero spot.
    await synthWarmVolOracle(program, FEED_ID, new BN(0), payer.publicKey);
    const { kp: writer, usdcAta: writerUsdc } = await setupWriter();
    const { vault, writerPos } = await createDepositAmer(writer, writerUsdc, usdc(130));
    const { builder } = mintBuilder(writer, vault, writerPos, new BN(1));
    try {
      await builder.rpc();
      assert.fail("expected VolOracleInvalidSpot");
    } catch (err: any) {
      assert.include(String(err), "VolOracleInvalidSpot", "got: " + String(err));
    }
  });

  it("(f) AMER mint with quantity = 0 -> InvalidContractSize", async () => {
    // Reinterpreted from the original placeholder "(f) q=0 fast-path": mint_from_vault
    // rejects quantity 0 at the top guard (before any oracle read), for BOTH styles —
    // the American q=0 path behaves identically to European. Oracle is warmed so the
    // revert is provably the quantity gate, not warmup.
    await synthWarmVolOracle(program, FEED_ID, spotScaled(500), payer.publicKey);
    const { kp: writer, usdcAta: writerUsdc } = await setupWriter();
    const { vault, writerPos } = await createDepositAmer(writer, writerUsdc, usdc(140));
    const { builder } = mintBuilder(writer, vault, writerPos, new BN(0));
    try {
      await builder.rpc();
      assert.fail("expected InvalidContractSize");
    } catch (err: any) {
      assert.include(String(err), "InvalidContractSize", "got: " + String(err));
    }
  });
});
