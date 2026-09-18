// =============================================================================
// tests/zzz-american-vault-lifecycle.ts — Phase 2 Stage D end-to-end proof
// =============================================================================
//
// THE seed-fix regression for Stage D. Walks the full American vault lifecycle:
//   create(American) → deposit → mint → purchase → claim_premium →
//   withdraw_from_vault (free collateral)
//
// The two payout steps (claim_premium, withdraw_from_vault) sign a USDC
// transfer AS THE VAULT PDA. Before Stage D both handlers hardcoded
// SHARED_VAULT_SEED in their signer seeds, so on an American vault — whose PDA
// is derived from SHARED_VAULT_AMERICAN_SEED — the re-derived signer did not
// match the account and the CPI transfer failed. Stage D routes both through
// state::shared_vault::vault_namespace_seed (the single source of truth), so
// the signer now matches. This test would FAIL on pre-Stage-D code and PASS
// after the fix. The Rust unit tests in state/shared_vault.rs
// (vault_namespace_seed_*) are the primary regression; this is the integration
// proof that the handlers actually consume the helper.
//
// -----------------------------------------------------------------------------
// SKIPPED — describe.skip. Primary blocker: fixture-rot (same issue that skips
// zzz-mint-from-vault-american-pricing.ts and causes the existing cascading
// `before all` failures — the validator's Pyth PriceUpdateV2 fixtures are not
// loaded). Un-skip at fixture-rot remediation, which is scheduled BEFORE
// Stage F.
//
// Two further preconditions also apply at un-skip time:
//   1. Program must be built with `--features american-enabled` (the Stage D
//      AMERICAN_ENABLED gate reverts create/mint with AmericanVaultsDisabled
//      otherwise). The .test-fixtures launcher passes this alongside
//      test-fast-vol once the American suite is turned on.
//   2. A warmed VolOracle (>= 168 hourly samples) is needed to get past the
//      American mint without VolOracleWarmup — feasible via the future
//      test-synth-vol synth instruction (same blocker noted in
//      zzz-mint-from-vault-american-pricing.ts skipped cases a/c/d/f).
//
// -----------------------------------------------------------------------------
// Test-count delta (this file):
//   pre : 0 cases here
//   post: 1 describe.skip block, 1 it() (pending/skipped — contributes 0 to
//         the passing count until fixture-rot + american-enabled + warmed
//         oracle land).
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
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount as getTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import BN from "bn.js";
import { fixturePubkey, AMER_LIFE_FEED_HEX } from "./_pyth_fixtures";
import { synthWarmVolOracle, spotScaled } from "./_vol_oracle_helpers";

// Dedicated isolated feed: warming this oracle must not pollute the real SOL
// oracle that zzz-vol-oracle.ts initializes + inspects with cold-field asserts.
const SOL_FEED_ID = Array.from(Buffer.from(AMER_LIFE_FEED_HEX, "hex"));
const SOL_180_FRESH = fixturePubkey("amer-life-fresh");

// Suite-specific asset name avoids collision with concurrent test suites.
const TEST_ASSET = "AMERLIFETEST";

const HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG",
);

const EXTRA_CU_400K = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const EXTRA_CU_1_4M = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

// UN-SKIPPED by the fixture-rot remediation arc. Runs under the harness built
// with test-fast-vol,american-enabled,test-synth-vol: american-enabled makes the
// American arms reachable (no 6052), test-synth-vol warms the oracle below.
describe("zzz-american-vault-lifecycle (Stage D seed-fix proof)", function () {
  this.timeout(180_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.opta as Program<Opta>;
  const wallet = provider.wallet as anchor.Wallet;
  const payer = (wallet as any).payer as Keypair;

  let usdcMint: PublicKey;
  let protocolStatePda: PublicKey;
  let treasuryPda: PublicKey;
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

  async function setupFundedWallet(): Promise<{ kp: Keypair; usdcAta: PublicKey }> {
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
    [protocolStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_v2")],
      program.programId,
    );
    [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury_v2")],
      program.programId,
    );
    // Reuse the singleton protocol's USDC mint when it already exists (other
    // files initialize it first); create_shared_vault enforces usdc_mint ==
    // protocol_state.usdc_mint. All test files share the provider wallet as
    // mint authority, so funding wallets from the reused mint still works.
    if (await provider.connection.getAccountInfo(protocolStatePda)) {
      const protocolState = await (program.account as any).protocolState.fetch(
        protocolStatePda,
      );
      usdcMint = protocolState.usdcMint;
    } else {
      usdcMint = await createMint(
        provider.connection, payer, payer.publicKey, null, 6,
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
        .createMarket(TEST_ASSET, SOL_FEED_ID, 0, 0)
        .accounts({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: payer.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          priceUpdate: SOL_180_FRESH,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // Initialize then WARM the oracle. The American mint reads
    // realized_vol_annualized, which gates on sample_count >= 168 + 6h
    // freshness. test-synth-vol's synth_warm_vol_oracle plants 720 samples,
    // fresh ts, and a $100 spot (SCALE 1e12) directly — no 168 rate-limited
    // pushes needed (infeasible on solana-test-validator; see scope doc).
    [volOraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vol_oracle"), Buffer.from(SOL_FEED_ID)],
      program.programId,
    );
    if (!(await provider.connection.getAccountInfo(volOraclePda))) {
      await (program.methods as any)
        .initializeVolOracle(SOL_FEED_ID, 0, new BN(0))
        .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          initializer: payer.publicKey,
          priceUpdate: SOL_180_FRESH,
          volOracle: volOraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    // Warm to 720 samples with spot $100 (≈ strike for sane ATM moneyness).
    await synthWarmVolOracle(program, SOL_FEED_ID, spotScaled(100), payer.publicKey);
  });

  it("full American lifecycle: create → deposit → mint → purchase → claim_premium → withdraw_from_vault", async () => {
    const { kp: writer, usdcAta: writerUsdc } = await setupFundedWallet();
    const { kp: buyer, usdcAta: buyerUsdc } = await setupFundedWallet();

    const strike = usdc(100);
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7200);

    // --- create(American) — derives under SHARED_VAULT_AMERICAN_SEED ---------
    const vault = deriveSharedVault("shared_vault_american", strike, expiry, 0);
    const vaultUsdc = deriveVaultUsdc(vault);
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

    const amerVault = await (program.account as any).sharedVault.fetch(vault);
    assert.exists(amerVault.exerciseStyle.american, "vault must be American");

    // --- deposit (writer-signed; unaffected by seed bug) --------------------
    // Deposit $2000 so that after minting 10 CALL contracts (1× strike =
    // $100 each = $1000 committed) there is $1000 of FREE collateral left for
    // the withdraw_from_vault seed-fix proof below.
    const writerPos = deriveWriterPos(vault, writer.publicKey);
    await (program.methods as any)
      .depositToVault(usdc(2000))
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

    // --- mint (American on-chain pricing; requires warmed oracle) -----------
    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const optMint = deriveVaultOptionMint(vault, writer.publicKey, createdAt);
    const escrow = deriveVaultPurchaseEscrow(vault, writer.publicKey, createdAt);
    const vaultMint = deriveVaultMintRecord(optMint);
    await (program.methods as any)
      .mintFromVault(new BN(10), usdc(1) /* sentinel; AMER ignores arg */, createdAt)
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
      .preInstructions([EXTRA_CU_1_4M])
      .signers([writer])
      .rpc();

    const mintRecord = await (program.account as any).vaultMint.fetch(vaultMint);
    const premiumPerContract: BN = mintRecord.premiumPerContract;
    assert.isTrue(premiumPerContract.gtn(0), "American premium computed on-chain > 0");

    // --- purchase (buyer pays premium → vault; routes premium accumulator) --
    const buyerOptionAta = getAssociatedTokenAddressSync(
      optMint, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID,
    );
    const createAtaIx = createAssociatedTokenAccountInstruction(
      buyer.publicKey, buyerOptionAta, buyer.publicKey, optMint, TOKEN_2022_PROGRAM_ID,
    );
    const buyQty = new BN(10);
    const maxPremium = premiumPerContract.mul(buyQty).muln(2); // generous slippage cap
    await (program.methods as any)
      .purchaseFromVault(buyQty, maxPremium)
      .accounts({
        buyer: buyer.publicKey,
        sharedVault: vault,
        writerPosition: writerPos,
        vaultMintRecord: vaultMint,
        protocolState: protocolStatePda,
        market: marketPda,
        optionMint: optMint,
        purchaseEscrow: escrow,
        buyerOptionAccount: buyerOptionAta,
        buyerUsdcAccount: buyerUsdc,
        vaultUsdcAccount: vaultUsdc,
        treasury: treasuryPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        transferHookProgram: HOOK_PROGRAM_ID,
        extraAccountMetaList: deriveExtraMetaList(optMint),
        hookState: deriveHookState(optMint),
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([createAtaIx])
      .signers([buyer])
      .rpc();

    // === SEED-FIX PROOF #1 — claim_premium signs as the American vault PDA ===
    // Pre-Stage-D this reverted (signer derived from SHARED_VAULT_SEED ≠
    // the American vault account). Must now succeed.
    const writerUsdcBefore = (await getTokenAccount(
      provider.connection, writerUsdc, undefined, TOKEN_PROGRAM_ID,
    )).amount;
    await (program.methods as any)
      .claimPremium()
      .accounts({
        writer: writer.publicKey,
        sharedVault: vault,
        writerPosition: writerPos,
        vaultUsdcAccount: vaultUsdc,
        writerUsdcAccount: writerUsdc,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([writer])
      .rpc();
    const writerUsdcAfterClaim = (await getTokenAccount(
      provider.connection, writerUsdc, undefined, TOKEN_PROGRAM_ID,
    )).amount;
    assert.isTrue(
      writerUsdcAfterClaim > writerUsdcBefore,
      "claim_premium on American vault must pay the writer (signer matched)",
    );

    // === SEED-FIX PROOF #2 — withdraw_from_vault signs as the American vault PDA ===
    // Withdraw free (uncommitted) collateral. With 10 contracts minted+sold,
    // only the uncommitted remainder is withdrawable; redeem a small share that
    // is provably free, proving the vault-PDA signer matches the American vault.
    const writerUsdcBeforeWithdraw = (await getTokenAccount(
      provider.connection, writerUsdc, undefined, TOKEN_PROGRAM_ID,
    )).amount;
    await (program.methods as any)
      .withdrawFromVault(new BN(1_000_000)) // 1 share of free collateral
      .accounts({
        writer: writer.publicKey,
        sharedVault: vault,
        writerPosition: writerPos,
        vaultUsdcAccount: vaultUsdc,
        writerUsdcAccount: writerUsdc,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([writer])
      .rpc();
    const writerUsdcAfterWithdraw = (await getTokenAccount(
      provider.connection, writerUsdc, undefined, TOKEN_PROGRAM_ID,
    )).amount;
    assert.isTrue(
      writerUsdcAfterWithdraw > writerUsdcBeforeWithdraw,
      "withdraw_from_vault on American vault must return collateral (signer matched)",
    );
  });
});
