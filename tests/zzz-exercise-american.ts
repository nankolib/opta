// =============================================================================
// tests/zzz-exercise-american.ts — Phase 2 Stage F: early American exercise
// =============================================================================
//
// Exercises the new `exercise_american` instruction end-to-end: warm oracle →
// create American vault → deposit → mint → buyer purchases → buyer exercises
// EARLY (pre-expiry) and receives capped intrinsic USDC; tokens burn; the two
// SharedVault counters (exercised_options / early_exercise_payout) increment.
//
// Runnable cases (need only static price fixtures, no clock control):
//   1. ITM CALL → holder USDC += N×(spot−strike); N burned; counters += N / P.
//   2. Partial → exercise N<M, remaining balance M−N; counters reflect N.
//   3. Deep-ITM CALL (spot ≥ 2·strike) → payout CAPPED at N×collateral_per_token
//      (the (f) lock; integration proof of the Rust unit vector).
//   4. OTM CALL (spot ≤ strike) → reverts OptionNotInTheMoney.
//   5. European vault → reverts NotAmericanOption (6053).
//
// Deferred to Stage G (need bankrun setClock / American settlement):
//   - post-expiry reject (now ≥ expiry → OptionExpired)
//   - American exercise_from_vault end-to-end (post-settlement)
//
// Runs under the harness build (test-fast-vol,american-enabled,test-synth-vol):
// american-enabled makes the American arms reachable; test-synth-vol warms the
// oracle for the MINT (exercise_american itself reads a PriceUpdateV2, not the
// oracle).
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
import { fixturePubkey, AMER_EXEC_FEED_HEX } from "./_pyth_fixtures";
import { synthWarmVolOracle, spotScaled } from "./_vol_oracle_helpers";

const FEED_ID = Array.from(Buffer.from(AMER_EXEC_FEED_HEX, "hex"));
const FEED_FRESH = fixturePubkey("amer-exec-fresh");
const PX_150 = fixturePubkey("amer-exec-150");
const PX_250 = fixturePubkey("amer-exec-250");
const PX_080 = fixturePubkey("amer-exec-080");

const TEST_ASSET = "AMEREXEC";
const HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG",
);

const CU_400K = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const CU_1_4M = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

function usdc(amount: number): BN {
  return new BN(amount * 1_000_000);
}

describe("zzz-exercise-american (Stage F)", function () {
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

  const seedPda = (prefix: string, extra: Buffer[]) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(prefix), ...extra],
      program.programId,
    )[0];

  function deriveVault(seedPrefix: string, strike: BN, expiry: BN, optIdx: number) {
    return seedPda(seedPrefix, [
      marketPda.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([optIdx]),
    ]);
  }
  const deriveVaultUsdc = (v: PublicKey) => seedPda("vault_usdc", [v.toBuffer()]);
  const deriveWriterPos = (v: PublicKey, w: PublicKey) =>
    seedPda("writer_position", [v.toBuffer(), w.toBuffer()]);
  const deriveOptMint = (v: PublicKey, w: PublicKey, t: BN) =>
    seedPda("vault_option_mint", [v.toBuffer(), w.toBuffer(), t.toArrayLike(Buffer, "le", 8)]);
  const deriveEscrow = (v: PublicKey, w: PublicKey, t: BN) =>
    seedPda("vault_purchase_escrow", [v.toBuffer(), w.toBuffer(), t.toArrayLike(Buffer, "le", 8)]);
  const deriveMintRecord = (m: PublicKey) => seedPda("vault_mint_record", [m.toBuffer()]);
  const deriveExtraMetas = (m: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), m.toBuffer()],
      HOOK_PROGRAM_ID,
    )[0];
  const deriveHookState = (m: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("hook-state"), m.toBuffer()],
      HOOK_PROGRAM_ID,
    )[0];

  async function fundedWallet(): Promise<{ kp: Keypair; usdcAta: PublicKey }> {
    const kp = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
    const usdcAta = await createTokenAccount(
      provider.connection, payer, usdcMint, kp.publicKey, undefined, undefined, TOKEN_PROGRAM_ID,
    );
    await mintTo(provider.connection, payer, usdcMint, usdcAta, payer, 10_000_000_000);
    return { kp, usdcAta };
  }

  // Stand up an American vault + minted+sold contracts, returning everything an
  // exercise needs. `style` lets case 5 build a European vault for the reject.
  async function setupHolder(opts: {
    strike: BN;
    expiry: BN;
    mintQty: BN;
    buyQty: BN;
    style: "american" | "european";
  }) {
    const { strike, expiry, mintQty, buyQty, style } = opts;
    const seedPrefix = style === "american" ? "shared_vault_american" : "shared_vault";
    const styleArg = style === "american" ? { american: {} } : { european: {} };

    const writer = (await fundedWallet());
    const buyer = (await fundedWallet());

    const vault = deriveVault(seedPrefix, strike, expiry, 0);
    const vaultUsdc = deriveVaultUsdc(vault);
    const writerPos = deriveWriterPos(vault, writer.kp.publicKey);

    await (program.methods as any)
      .createSharedVault(strike, expiry, { call: {} }, { custom: {} }, usdcMint, 0, styleArg)
      .accounts({
        creator: writer.kp.publicKey, market: marketPda, sharedVault: vault,
        vaultUsdcAccount: vaultUsdc, usdcMint, protocolState: protocolStatePda,
        epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .preInstructions([CU_400K]).signers([writer.kp]).rpc();

    await (program.methods as any)
      .depositToVault(usdc(5000))
      .accounts({
        writer: writer.kp.publicKey, sharedVault: vault, writerPosition: writerPos,
        writerUsdcAccount: writer.usdcAta, vaultUsdcAccount: vaultUsdc,
        protocolState: protocolStatePda, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([writer.kp]).rpc();

    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const optMint = deriveOptMint(vault, writer.kp.publicKey, createdAt);
    const escrow = deriveEscrow(vault, writer.kp.publicKey, createdAt);
    const vaultMint = deriveMintRecord(optMint);

    await (program.methods as any)
      .mintFromVault(mintQty, usdc(1) /* EUR uses verbatim; AMER ignores */, createdAt)
      .accounts({
        writer: writer.kp.publicKey, sharedVault: vault, writerPosition: writerPos,
        market: marketPda, volOracle: volOraclePda, protocolState: protocolStatePda,
        optionMint: optMint, purchaseEscrow: escrow, vaultMintRecord: vaultMint,
        transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: deriveExtraMetas(optMint),
        hookState: deriveHookState(optMint), systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([CU_1_4M]).signers([writer.kp]).rpc();

    const rec = await (program.account as any).vaultMint.fetch(vaultMint);
    const premium: BN = rec.premiumPerContract;

    // Buyer purchases buyQty.
    const buyerOptionAta = getAssociatedTokenAddressSync(
      optMint, buyer.kp.publicKey, false, TOKEN_2022_PROGRAM_ID,
    );
    const createAtaIx = createAssociatedTokenAccountInstruction(
      buyer.kp.publicKey, buyerOptionAta, buyer.kp.publicKey, optMint, TOKEN_2022_PROGRAM_ID,
    );
    await (program.methods as any)
      .purchaseFromVault(buyQty, premium.mul(buyQty).muln(2))
      .accounts({
        buyer: buyer.kp.publicKey, sharedVault: vault, writerPosition: writerPos,
        vaultMintRecord: vaultMint, protocolState: protocolStatePda, market: marketPda,
        optionMint: optMint, purchaseEscrow: escrow, buyerOptionAccount: buyerOptionAta,
        buyerUsdcAccount: buyer.usdcAta, vaultUsdcAccount: vaultUsdc, treasury: treasuryPda,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: deriveExtraMetas(optMint),
        hookState: deriveHookState(optMint), systemProgram: SystemProgram.programId,
      })
      .preInstructions([createAtaIx]).signers([buyer.kp]).rpc();

    return { vault, vaultUsdc, optMint, vaultMint, buyer, buyerOptionAta };
  }

  async function tokenAmount(ata: PublicKey, programId: PublicKey): Promise<bigint> {
    const acc = await getTokenAccount(provider.connection, ata, undefined, programId);
    return acc.amount;
  }

  // Build + send an exercise_american. Returns the buyer USDC delta + counters.
  async function exercise(
    h: Awaited<ReturnType<typeof setupHolder>>,
    qty: BN,
    priceUpdate: PublicKey,
  ) {
    return (program.methods as any)
      .exerciseAmerican(qty)
      .accounts({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            // Pool-funded exercise → the writer-ask pot arm stays null.
            writerAskPot: null, writerAskPotUsdc: null, protocolState: null,
        holder: h.buyer.kp.publicKey,
        sharedVault: h.vault,
        market: marketPda,
        priceUpdate,
        vaultMintRecord: h.vaultMint,
        optionMint: h.optMint,
        holderOptionAccount: h.buyerOptionAta,
        vaultUsdcAccount: h.vaultUsdc,
        holderUsdcAccount: h.buyer.usdcAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([CU_400K])
      .signers([h.buyer.kp])
      .rpc();
  }

  before(async () => {
    [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
    [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], program.programId);

    if (await provider.connection.getAccountInfo(protocolStatePda)) {
      const ps = await (program.account as any).protocolState.fetch(protocolStatePda);
      usdcMint = ps.usdcMint;
    } else {
      usdcMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
      await (program.methods as any)
        .initializeProtocol()
        .accounts({
          admin: payer.publicKey, protocolState: protocolStatePda, treasury: treasuryPda,
          usdcMint, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }

    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(TEST_ASSET)], program.programId,
    );
    if (!(await provider.connection.getAccountInfo(marketPda))) {
      await (program.methods as any)
        .createMarket(TEST_ASSET, FEED_ID, 0, 0)
        .accounts({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: payer.publicKey, protocolState: protocolStatePda, market: marketPda,
          priceUpdate: FEED_FRESH, systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    [volOraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vol_oracle"), Buffer.from(FEED_ID)], program.programId,
    );
    if (!(await provider.connection.getAccountInfo(volOraclePda))) {
      await (program.methods as any)
        .initializeVolOracle(FEED_ID, 0, new BN(0))
        .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          initializer: payer.publicKey, priceUpdate: FEED_FRESH,
          volOracle: volOraclePda, systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    // Warm with $100 spot so the ATM ($100 strike) American MINT prices > 0.
    await synthWarmVolOracle(program, FEED_ID, spotScaled(100), payer.publicKey);
  });

  it("1. ITM CALL: holder paid N×(spot−strike), tokens burned, counters update", async () => {
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7200);
    const h = await setupHolder({ strike: usdc(100), expiry, mintQty: new BN(10), buyQty: new BN(5), style: "american" });

    const usdcBefore = await tokenAmount(h.buyer.usdcAta, TOKEN_PROGRAM_ID);
    const optBefore = await tokenAmount(h.buyerOptionAta, TOKEN_2022_PROGRAM_ID);

    await exercise(h, new BN(5), PX_150); // spot $150, strike $100 → $50/contract

    const usdcAfter = await tokenAmount(h.buyer.usdcAta, TOKEN_PROGRAM_ID);
    const optAfter = await tokenAmount(h.buyerOptionAta, TOKEN_2022_PROGRAM_ID);
    const vault = await (program.account as any).sharedVault.fetch(h.vault);

    const paid = Number(usdcAfter - usdcBefore);
    console.log(`  case1: paid=${paid} burned=${Number(optBefore - optAfter)} exercised=${vault.exercisedOptions} payout=${vault.earlyExercisePayout}`);
    assert.equal(paid, usdc(250).toNumber(), "5 × $50 = $250");
    assert.equal(Number(optBefore - optAfter), 5, "5 tokens burned");
    assert.equal(vault.exercisedOptions.toString(), "5");
    assert.equal(vault.earlyExercisePayout.toString(), usdc(250).toString());
  });

  it("2. Partial: exercise N<M, remaining balance M−N, counters reflect N", async () => {
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7201);
    const h = await setupHolder({ strike: usdc(100), expiry, mintQty: new BN(10), buyQty: new BN(5), style: "american" });

    await exercise(h, new BN(3), PX_150); // exercise 3 of 5

    const remaining = await tokenAmount(h.buyerOptionAta, TOKEN_2022_PROGRAM_ID);
    const vault = await (program.account as any).sharedVault.fetch(h.vault);
    console.log(`  case2: remaining=${Number(remaining)} exercised=${vault.exercisedOptions}`);
    assert.equal(Number(remaining), 2, "5 − 3 = 2 left");
    assert.equal(vault.exercisedOptions.toString(), "3");
    assert.equal(vault.earlyExercisePayout.toString(), usdc(150).toString(), "3 × $50");
  });

  it("3. Deep-ITM CALL (spot ≥ 2·strike): payout CAPPED at N×collateral_per_token", async () => {
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7202);
    const h = await setupHolder({ strike: usdc(100), expiry, mintQty: new BN(10), buyQty: new BN(4), style: "american" });

    const before = await tokenAmount(h.buyer.usdcAta, TOKEN_PROGRAM_ID);
    await exercise(h, new BN(4), PX_250); // spot $250, strike $100 → raw $150, CAPPED at $100
    const after = await tokenAmount(h.buyer.usdcAta, TOKEN_PROGRAM_ID);

    const paid = Number(after - before);
    console.log(`  case3: paid=${paid} (capped=${usdc(400).toNumber()}, uncapped_would_be=${usdc(600).toNumber()})`);
    assert.equal(paid, usdc(400).toNumber(), "4 × min($150,$100)=$100 → $400 (CAPPED)");
    assert.notEqual(paid, usdc(600).toNumber(), "must NOT pay uncapped 4 × $150");
  });

  it("4. OTM CALL (spot ≤ strike) reverts OptionNotInTheMoney", async () => {
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7203);
    const h = await setupHolder({ strike: usdc(100), expiry, mintQty: new BN(10), buyQty: new BN(2), style: "american" });
    try {
      await exercise(h, new BN(2), PX_080); // spot $80 ≤ strike $100 → 0
      assert.fail("expected OptionNotInTheMoney");
    } catch (e: any) {
      assert.include(String(e), "OptionNotInTheMoney", "got: " + String(e));
    }
  });

  it("5. European vault reverts NotAmericanOption (6053)", async () => {
    const expiry = new BN(Math.floor(Date.now() / 1000) + 7204);
    // European mint stores premium=arg verbatim; oracle present but unused.
    const h = await setupHolder({ strike: usdc(100), expiry, mintQty: new BN(10), buyQty: new BN(2), style: "european" });
    try {
      await exercise(h, new BN(2), PX_150);
      assert.fail("expected NotAmericanOption");
    } catch (e: any) {
      assert.include(String(e), "NotAmericanOption", "got: " + String(e));
    }
  });

  // ---------------------------------------------------------------------------
  // Deferred to Stage G (need bankrun setClock / American settlement path).
  // ---------------------------------------------------------------------------
  describe.skip("Stage G deferrals [ported to tests/bankrun/exercise-american-stageg.test.ts — Stage G Pass 3a]", () => {
    it("post-expiry reject: now ≥ expiry → OptionExpired", async () => {
      // The require!(now < expiry) gate ships in Stage F; proving it fires
      // needs a clock advanced past expiry (bankrun setClock), unavailable on
      // solana-test-validator.
    });
    it("American exercise_from_vault end-to-end (post-settlement, seed fix)", async () => {
      // The vault_namespace_seed fix on exercise_from_vault ships in Stage F;
      // the end-to-end proof needs an American settlement (settle past expiry).
    });
  });
});
