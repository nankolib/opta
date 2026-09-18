// =============================================================================
// tests/zzz-stage-c-schema.ts — Phase 2 Stage C Pass 1 (schema additions)
// =============================================================================
//
// Verifies the schema changes that wire ExerciseStyle into vault creation:
//   - create_shared_vault with exercise_style=European produces a vault under
//     b"shared_vault" PDA seed
//   - create_shared_vault with exercise_style=American produces a vault under
//     b"shared_vault_american" PDA seed
//   - Both vaults coexist at the same (market, strike, expiry, option_type)
//     tuple -- no PDA collision because seed prefix differs
//   - exercise_style field roundtrips via Anchor account fetch
//   - exercise_style byte sits at offset 8 + 232 = 240 in account data and
//     decodes to variant 0 (European) or variant 1 (American)
//   - SharedVault account size on disk is 260 bytes (8 disc + 252 INIT_SPACE)
//     post-Pass-A (was 257 post-Stage-F; +3 for spread_bps + voided; +16 for exercised_options +
//     early_exercise_payout, appended AFTER exercise_style so offset 240 holds)
//
// Does NOT exercise mint pricing or get_option_price (Pass 2/3).
//
// Phase 2 Stage C Pass 1 scope:
//   .context/plans/phase2-american-onchain-pricing-scope.md
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
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import { fixturePubkey } from "./_pyth_fixtures";

// SOL Pyth feed_id (same value as shared-vaults.ts REGISTRY.SOL).
const SOL_FEED_ID = Buffer.from(
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "hex",
);
// Pre-loaded sol-180-fresh Pyth fixture for create_market proof gate.
const SOL_180_FRESH_PK = fixturePubkey("sol-180-fresh");

// CU bump for create_shared_vault (matches frontend useWriteSubmit pattern).
const EXTRA_CU_400K = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

// Asset identifier used for this test suite's market. Chosen distinct from
// SOL/BTC so the test doesn't collide with shared-vaults.ts's fixtures
// running in the same validator session.
const TEST_ASSET = "STAGECTEST";

// Byte offset of the exercise_style field in the SharedVault on-disk layout.
// 8 (Anchor discriminator) + 232 (all fields before exercise_style per
// shared_vault.rs InitSpace) = 240.
const EXERCISE_STYLE_BYTE_OFFSET = 240;

// Expected account on-disk size (8 discriminator + 268 INIT_SPACE = 276).
// Was 257 post-Stage-F; +3 (Pass A: spread_bps u16 + voided bool) = 260;
// +8 (Slice D1: writer_ask_collateral_swept u64) = 268; +8 (Slice D2a:
// writer_ask_equiv_shares u64) = 276. All appended AFTER early_exercise_payout,
// so EXERCISE_STYLE_BYTE_OFFSET = 240 is unchanged.
const POST_PASS1_VAULT_SIZE = 276;

describe("zzz-stage-c-schema (Stage C Pass 1)", function () {
  this.timeout(60_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.opta as Program<Opta>;
  const wallet = provider.wallet as anchor.Wallet;
  const payer = (wallet as any).payer as Keypair;

  let usdcMint: PublicKey;
  let creator: Keypair;
  let protocolStatePda: PublicKey;
  let marketPda: PublicKey;

  before(async () => {
    // Fresh creator keypair, airdropped.
    creator = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      creator.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    // Protocol state is a session-wide singleton. Other test files running
    // first in the same validator session initialize it with THEIR USDC mint;
    // create_shared_vault enforces `usdc_mint == protocol_state.usdc_mint`, so
    // we MUST reuse the existing protocol's mint rather than minting our own
    // (minting our own trips ConstraintRaw 2003 — the fixture-rot
    // protocol-state-contamination failure). Mirrors the reuse idiom in
    // shared-vaults.ts / zzz-audit-fixes.ts / zzz-auto-finalize-*.ts.
    [protocolStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_v2")],
      program.programId,
    );
    const existing = await provider.connection.getAccountInfo(protocolStatePda);
    if (existing) {
      const protocolState = await (program.account as any).protocolState.fetch(
        protocolStatePda,
      );
      usdcMint = protocolState.usdcMint;
    } else {
      usdcMint = await createMint(
        provider.connection,
        payer,
        payer.publicKey,
        null,
        6,
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

    // Fresh market for this suite (asset = STAGECTEST). create_market is
    // idempotent on matching values; using a unique asset name avoids
    // tripping the AssetMismatch revert against any prior shared-vaults
    // market with different metadata.
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(TEST_ASSET)],
      program.programId,
    );
    const marketExisting = await provider.connection.getAccountInfo(marketPda);
    if (!marketExisting) {
      await (program.methods as any)
        .createMarket(TEST_ASSET, Array.from(SOL_FEED_ID), 0, 0)
        .accounts({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: payer.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          priceUpdate: SOL_180_FRESH_PK,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  // PDA derivation helper. Uses the seed prefix directly so the test
  // exercises BOTH namespaces (b"shared_vault" + b"shared_vault_american").
  function deriveVaultPda(
    seedPrefix: string,
    strike: BN,
    expiry: BN,
    optionTypeIdx: number,
  ): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(seedPrefix),
        marketPda.toBuffer(),
        strike.toArrayLike(Buffer, "le", 8),
        expiry.toArrayLike(Buffer, "le", 8),
        Buffer.from([optionTypeIdx]),
      ],
      program.programId,
    );
    return pda;
  }

  function deriveVaultUsdcPda(vaultPda: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_usdc"), vaultPda.toBuffer()],
      program.programId,
    );
    return pda;
  }

  type ExerciseStyleArg = { european: {} } | { american: {} };

  async function createVault(
    style: ExerciseStyleArg,
    strike: BN,
    expiry: BN,
  ): Promise<PublicKey> {
    const seedPrefix =
      "european" in style ? "shared_vault" : "shared_vault_american";
    const optionTypeIdx = 0; // Call
    const vaultPda = deriveVaultPda(seedPrefix, strike, expiry, optionTypeIdx);
    const vaultUsdcPda = deriveVaultUsdcPda(vaultPda);

    await (program.methods as any)
      .createSharedVault(
        strike,
        expiry,
        { call: {} },
        { custom: {} },
        usdcMint,
        0,
        style,
      )
      .accounts({
        creator: creator.publicKey,
        market: marketPda,
        sharedVault: vaultPda,
        vaultUsdcAccount: vaultUsdcPda,
        usdcMint,
        protocolState: protocolStatePda,
        epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([EXTRA_CU_400K])
      .signers([creator])
      .rpc();
    return vaultPda;
  }

  it("European vault creates under SHARED_VAULT_SEED with exerciseStyle.european", async () => {
    const strike = new BN(100_000_000); // $100
    const expiry = new BN(Math.floor(Date.now() / 1000) + 3600); // +1h
    const vaultPda = await createVault({ european: {} }, strike, expiry);

    // Confirm PDA was derived under b"shared_vault".
    const expectedPda = deriveVaultPda("shared_vault", strike, expiry, 0);
    assert.equal(vaultPda.toBase58(), expectedPda.toBase58());

    const vault = await (program.account as any).sharedVault.fetch(vaultPda);
    assert.exists(
      vault.exerciseStyle.european,
      "vault.exerciseStyle.european should be set",
    );

    const acct = await provider.connection.getAccountInfo(vaultPda);
    assert.isNotNull(acct);
    assert.equal(
      acct!.data.length,
      POST_PASS1_VAULT_SIZE,
      `European vault account is ${POST_PASS1_VAULT_SIZE} bytes (post-Pass-1)`,
    );
  });

  it("American vault creates under SHARED_VAULT_AMERICAN_SEED with exerciseStyle.american", async () => {
    const strike = new BN(200_000_000); // $200, distinct strike from prior test
    const expiry = new BN(Math.floor(Date.now() / 1000) + 3600);
    const vaultPda = await createVault({ american: {} }, strike, expiry);

    // Confirm PDA was derived under b"shared_vault_american".
    const expectedPda = deriveVaultPda(
      "shared_vault_american",
      strike,
      expiry,
      0,
    );
    assert.equal(vaultPda.toBase58(), expectedPda.toBase58());

    const vault = await (program.account as any).sharedVault.fetch(vaultPda);
    assert.exists(
      vault.exerciseStyle.american,
      "vault.exerciseStyle.american should be set",
    );

    const acct = await provider.connection.getAccountInfo(vaultPda);
    assert.isNotNull(acct);
    assert.equal(acct!.data.length, POST_PASS1_VAULT_SIZE);
  });

  it("EUR and AMER vaults coexist at the same (strike, expiry, option_type) tuple", async () => {
    // Same numeric tuple for both. Distinct PDAs only because the seed
    // prefix differs. This is the central invariant of the Pass 1 design.
    const strike = new BN(150_000_000); // $150 -- unique to this test
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7200); // +2h

    const eurPda = deriveVaultPda("shared_vault", strike, expiry, 0);
    const amerPda = deriveVaultPda("shared_vault_american", strike, expiry, 0);
    assert.notEqual(
      eurPda.toBase58(),
      amerPda.toBase58(),
      "EUR and AMER PDAs MUST differ at the same numeric tuple",
    );

    const createdEur = await createVault({ european: {} }, strike, expiry);
    const createdAmer = await createVault({ american: {} }, strike, expiry);
    assert.equal(createdEur.toBase58(), eurPda.toBase58());
    assert.equal(createdAmer.toBase58(), amerPda.toBase58());

    const eurVault = await (program.account as any).sharedVault.fetch(eurPda);
    const amerVault = await (program.account as any).sharedVault.fetch(amerPda);
    assert.exists(eurVault.exerciseStyle.european);
    assert.exists(amerVault.exerciseStyle.american);
  });

  it("exercise_style byte at offset 240 decodes to variant 0 (EUR) / 1 (AMER)", async () => {
    // Fresh strike to avoid colliding with prior tests.
    const strike = new BN(250_000_000);
    const expiry = new BN(Math.floor(Date.now() / 1000) + 3600);

    const eurPda = await createVault({ european: {} }, strike, expiry);
    const amerPda = await createVault({ american: {} }, strike, expiry);

    const eurAcct = await provider.connection.getAccountInfo(eurPda);
    const amerAcct = await provider.connection.getAccountInfo(amerPda);
    assert.isNotNull(eurAcct);
    assert.isNotNull(amerAcct);

    // 8-byte Anchor discriminator + 232 bytes of prior SharedVault fields
    // = byte offset 240. That byte is the Borsh-encoded ExerciseStyle.
    assert.equal(
      eurAcct!.data[EXERCISE_STYLE_BYTE_OFFSET],
      0,
      "European must encode to byte 240 = 0x00 (Borsh variant 0)",
    );
    assert.equal(
      amerAcct!.data[EXERCISE_STYLE_BYTE_OFFSET],
      1,
      "American must encode to byte 240 = 0x01 (Borsh variant 1)",
    );
  });
});
