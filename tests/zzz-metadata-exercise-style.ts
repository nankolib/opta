// =============================================================================
// tests/zzz-metadata-exercise-style.ts — Phase 2 Stage E coverage
// =============================================================================
//
// Proves mint_from_vault writes the `exercise_style` pair onto the option
// mint's Token-2022 additional metadata, as a lowercase human word matching
// option_type's "call"/"put" convention.
//
//   (A) European vault → mint → metadata.additionalMetadata contains
//       ["exercise_style","european"]; option_type + strike_price pairs still
//       present + correct (loop-regression canary).
//   (B) American vault (warmed oracle) → mint → metadata contains
//       ["exercise_style","american"].
//
// zzz prefix: runs late (fixture-dependent). Reuses the standard mint setup
// helpers + synth_warm_vol_oracle (test-synth-vol) on a DEDICATED feed so the
// American warm-up doesn't collide with the other American suites' oracle
// states. Runs under the harness built with test-fast-vol,american-enabled,
// test-synth-vol (american-enabled makes the American arm reachable; without
// it the American mint reverts AmericanVaultsDisabled / 6052).
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
  getTokenMetadata,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import { fixturePubkey, AMER_META_FEED_HEX } from "./_pyth_fixtures";
import { ensureVolOracle, synthWarmVolOracle, spotScaled } from "./_vol_oracle_helpers";

// Dedicated isolated feed for this suite (see header).
const FEED_ID = Array.from(Buffer.from(AMER_META_FEED_HEX, "hex"));
const FEED_FIXTURE = fixturePubkey("amer-meta-fresh");

// Suite-specific asset name avoids collision with concurrent suites in the
// same validator session.
const TEST_ASSET = "METATEST";

const HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG",
);

const EXTRA_CU_400K = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const EXTRA_CU_800K = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
const EXTRA_CU_1_4M = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

/// Look up an additional-metadata value by key, or undefined if absent.
function metaValue(
  meta: { additionalMetadata: readonly (readonly [string, string])[] } | null,
  key: string,
): string | undefined {
  if (!meta) return undefined;
  const pair = meta.additionalMetadata.find(([k]) => k === key);
  return pair?.[1];
}

describe("zzz-metadata-exercise-style (Stage E)", function () {
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

  // Create a vault (style-parameterized) + deposit, returning mint handles.
  async function createDeposit(
    writer: Keypair,
    writerUsdc: PublicKey,
    strike: BN,
    expiry: BN,
    style: "european" | "american",
  ) {
    const seedPrefix = style === "american" ? "shared_vault_american" : "shared_vault";
    const styleArg = style === "american" ? { american: {} } : { european: {} };
    const vault = deriveSharedVault(seedPrefix, strike, expiry, 0);
    const vaultUsdc = deriveVaultUsdc(vault);
    await (program.methods as any)
      .createSharedVault(strike, expiry, { call: {} }, { custom: {} }, usdcMint, 0, styleArg)
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

  // Mint 1 contract and return the option mint pubkey.
  async function mintOne(
    writer: Keypair,
    vault: PublicKey,
    writerPos: PublicKey,
    cu: anchor.web3.TransactionInstruction,
  ): Promise<PublicKey> {
    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const optMint = deriveVaultOptionMint(vault, writer.publicKey, createdAt);
    const escrow = deriveVaultPurchaseEscrow(vault, writer.publicKey, createdAt);
    const vaultMint = deriveVaultMintRecord(optMint);
    const sig = await (program.methods as any)
      .mintFromVault(new BN(1), usdc(5) /* sentinel; AMER ignores arg */, createdAt)
      .accounts({
        writer: writer.publicKey, sharedVault: vault, writerPosition: writerPos,
        market: marketPda, volOracle: volOraclePda, protocolState: protocolStatePda,
        optionMint: optMint, purchaseEscrow: escrow, vaultMintRecord: vaultMint,
        transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: deriveExtraMetaList(optMint),
        hookState: deriveHookState(optMint), systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([cu]).signers([writer]).rpc();
    // .rpc() resolves at the provider's (processed) commitment, but the
    // getTokenMetadata read below uses "confirmed" — confirm the mint here so
    // the stricter read sees the account (avoids a TokenAccountNotFoundError race).
    await provider.connection.confirmTransaction(sig, "confirmed");
    return optMint;
  }

  before(async () => {
    // Protocol state is a session-wide singleton. Reuse its USDC mint when it
    // already exists (create_shared_vault enforces usdc_mint ==
    // protocol_state.usdc_mint).
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

    // Cold oracle is enough for the European mint (it carries the account but
    // never reads it); the American case warms it per-test below.
    volOraclePda = await ensureVolOracle(program, FEED_ID, FEED_FIXTURE, payer.publicKey);
  });

  it("(A) European mint writes exercise_style=european + preserves option_type/strike_price", async () => {
    const { kp: writer, usdcAta: writerUsdc } = await setupWriter();
    const strike = usdc(150); // → metadata strike_price "150000000"
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7200);
    const { vault, writerPos } = await createDeposit(writer, writerUsdc, strike, expiry, "european");
    const optMint = await mintOne(writer, vault, writerPos, EXTRA_CU_800K);

    const meta = await getTokenMetadata(
      provider.connection, optMint, "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    assert.exists(meta, "metadata must exist on European mint");
    console.log("    (A) European additionalMetadata:", JSON.stringify(meta!.additionalMetadata));

    assert.equal(metaValue(meta, "exercise_style"), "european", "exercise_style pair");
    // Loop-regression canary: existing pairs must still be present + correct.
    assert.equal(metaValue(meta, "option_type"), "call", "option_type preserved");
    assert.equal(metaValue(meta, "strike_price"), strike.toString(), "strike_price preserved");
  });

  it("(B) American mint writes exercise_style=american", async () => {
    // Warm the dedicated oracle: 720 samples, fresh ts, $500 spot (ITM vs the
    // $110 strike so the 2h BS-2002 premium is comfortably > 0; an OTM 2h
    // option rounds to 0 USDC → InvalidPremium).
    await synthWarmVolOracle(program, FEED_ID, spotScaled(500), payer.publicKey);
    const { kp: writer, usdcAta: writerUsdc } = await setupWriter();
    const strike = usdc(110);
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7200);
    const { vault, writerPos } = await createDeposit(writer, writerUsdc, strike, expiry, "american");
    const optMint = await mintOne(writer, vault, writerPos, EXTRA_CU_1_4M);

    const meta = await getTokenMetadata(
      provider.connection, optMint, "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    assert.exists(meta, "metadata must exist on American mint");
    console.log("    (B) American additionalMetadata:", JSON.stringify(meta!.additionalMetadata));

    assert.equal(metaValue(meta, "exercise_style"), "american", "exercise_style pair");
  });
});
