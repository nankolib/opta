// =============================================================================
// tests/zzz-get-option-price.ts -- Phase 2 Stage C Pass 3 .view() coverage
// =============================================================================
//
// Standalone .view() test for the get_option_price instruction. Owns its
// provider + program + on-chain market/oracle discovery. Does NOT import
// the rotted _pyth_fixtures.ts chain — kept fully outside the legacy
// fixture-rotted suite that is currently failing 97 tests.
//
// Three cases:
//   (a) AMER call  — sane quote OR .skip() on warmup
//   (b) AMER put   — sane quote OR .skip() on warmup
//   (c) EUR call   — must throw ViewNotSupportedForEuropean (code 6051)
//
// Devnet, read-only. .view() does simulateTransaction; no fees, no writes.
//
// Run:
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/id.json \
//   npx ts-mocha -p ./tsconfig.json tests/zzz-get-option-price.ts --timeout 30000
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Opta } from "../target/types/opta";
import { GOP_FEED_HEX, fixturePubkey } from "./_pyth_fixtures";
import { synthWarmVolOracle, spotScaled } from "./_vol_oracle_helpers";

// Stage G Pass 3b: deterministic localnet conversion. Instead of devnet
// discovery + warmup-skips, set up a DEDICATED market + synth-warmed oracle
// (test-synth-vol feature) so the American .view() quote path is deterministic.
const GOP_ASSET = "GOPVIEW";
const GOP_FEED = Array.from(Buffer.from(GOP_FEED_HEX, "hex"));
const GOP_FIXTURE = fixturePubkey("gop-view-fresh");

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const VOL_ORACLE_SEED = Buffer.from("vol_oracle");
const WARMUP_SAMPLES = 168;

// Stage G Pass 3b: the devnet-discovery decoders (OptionsMarket / VolOracle
// light decoders + discriminator) were removed — before() now sets up a
// dedicated warmed oracle directly, so no on-chain scanning is needed.

function deriveVolOracle(feedId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VOL_ORACLE_SEED, feedId], PROGRAM_ID);
}

describe("get_option_price view (Phase 2 Stage C Pass 3)", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<Opta>;
  let bestMarket: PublicKey;
  let bestOracle: PublicKey;
  let bestAsset: string;
  let bestSampleCount: number;
  let bestSpotMicro: bigint;

  before(async function () {
    this.timeout(180_000);

    // Standalone provider — no anchor.workspace dependency, no Anchor.toml
    // assumption. Pulls RPC + wallet from env per Anchor convention.
    const rpc = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
    const walletPath =
      process.env.ANCHOR_WALLET ||
      path.join(process.env.HOME || process.env.USERPROFILE || "~", ".config/solana/id.json");
    const conn = new Connection(rpc, "confirmed");
    const rawKey = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
    const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(rawKey)));
    provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    const idl = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"),
    );
    program = new Program(idl, provider) as Program<Opta>;

    console.log(`  RPC:    ${rpc}`);
    console.log(`  Program: ${PROGRAM_ID.toBase58()}`);

    // Stage G Pass 3b: deterministic dedicated setup (replaces devnet discovery).
    // protocol_state is a session singleton inited by an earlier file under the
    // run-tests.sh suite; reuse it. Create a dedicated market + cold oracle
    // (idempotent), then synth-warm to a full ring so the AMER quote path runs.
    const protocolStatePda = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_v2")], PROGRAM_ID,
    )[0];
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from(GOP_ASSET)], PROGRAM_ID,
    );
    const [oraclePda] = deriveVolOracle(Buffer.from(GOP_FEED));

    try {
      await (program as any).methods
        .createMarket(GOP_ASSET, GOP_FEED, 0, 0)
        .accounts({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          creator: provider.wallet.publicKey,
          protocolState: protocolStatePda,
          priceUpdate: GOP_FIXTURE,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) { /* idempotent: market may already exist */ }

    try {
      await (program as any).methods
        .initializeVolOracle(GOP_FEED, 0, new BN(0))
        .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
          initializer: provider.wallet.publicKey,
          priceUpdate: GOP_FIXTURE,
          volOracle: oraclePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_) { /* idempotent: oracle may already exist */ }

    // Warm to 720 samples @ $100 spot (test-synth-vol). After this the AMER
    // quote path reads Ok deterministically — no devnet/warmup gating.
    await synthWarmVolOracle(program, GOP_FEED, spotScaled(100), provider.wallet.publicKey);

    bestMarket = marketPda;
    bestOracle = oraclePda;
    bestAsset = GOP_ASSET;
    bestSampleCount = WARMUP_SAMPLES;                 // warmed ≥ 168
    bestSpotMicro = BigInt("100000000000000");        // $100 at SCALE 1e12

    console.log(`  Dedicated warmed oracle: ${bestAsset} ${bestOracle.toBase58()} (sample_count=${bestSampleCount})`);
  });

  // Build a strike near current spot. spot is at SCALE 1e12; strike is u64
  // USDC 6-decimal. Convert SCALE -> USDC by dividing by 1e6, then round to
  // the nearest whole dollar so the strike is clean and ATM-ish.
  function strikeNearSpot(): BN {
    const M = BigInt(1_000_000);
    const HALF_M = BigInt(500_000);
    if (bestSpotMicro === BigInt(0)) return new BN(100_000_000); // $100 fallback
    const usdc = bestSpotMicro / M;            // SCALE 1e12 -> USDC 1e6
    const dollars = (usdc + HALF_M) / M;       // round to $1
    const strike = dollars * M;                // back to USDC 1e6
    return new BN(strike.toString());
  }

  function expiry7DaysFromNow(): BN {
    return new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  }

  async function viewQuote(optionType: any, exerciseStyle: any) {
    return program.methods
      .getOptionPrice(
        strikeNearSpot(),
        expiry7DaysFromNow(),
        optionType,
        exerciseStyle,
        0,
      )
      .accounts({ market: bestMarket, volOracle: bestOracle } as any)
      // BS-2002 American pricing exceeds the default 200K sim CU (PUT ~210K+);
      // bump so the .view() simulation completes (the CALL fits under 200K).
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .view();
  }

  // SKIP 2026-05-24: oracle warmup unlock window opens today. First 4 of 11
  // oracles unlock 2026-05-24/05-26 per project_phase2_stage_b.md. If the
  // picked oracle still has sample_count < 168 at run time, both AMER cases
  // skip with a logged note. Re-run any time after the warmup count crosses
  // 168.

  it("(a) AMER call returns sane quote (deterministic, synth-warmed)", async function () {
    this.timeout(30_000);
    const before = Math.floor(Date.now() / 1000);
    const quote: any = await viewQuote({ call: {} }, { american: {} });
    const after = Math.floor(Date.now() / 1000);

    console.log(
      `  AMER CALL  premium=${quote.premiumPerContract.toString()}  vol=${quote.volUsedScaled.toString()}  spot=${quote.spotUsedScaled.toString()}  ts=${quote.computedAtTs.toString()}`,
    );

    expect(quote.premiumPerContract.toNumber()).to.be.greaterThan(0);
    expect(quote.volUsedScaled.toNumber()).to.be.greaterThan(0);
    expect(quote.spotUsedScaled.toNumber()).to.be.greaterThan(0);
    const ts = quote.computedAtTs.toNumber();
    expect(ts).to.be.gte(before - 60);
    expect(ts).to.be.lte(after + 60);
  });

  it("(b) AMER put returns sane quote (deterministic, synth-warmed)", async function () {
    this.timeout(30_000);
    const before = Math.floor(Date.now() / 1000);
    const quote: any = await viewQuote({ put: {} }, { american: {} });
    const after = Math.floor(Date.now() / 1000);

    console.log(
      `  AMER PUT   premium=${quote.premiumPerContract.toString()}  vol=${quote.volUsedScaled.toString()}  spot=${quote.spotUsedScaled.toString()}  ts=${quote.computedAtTs.toString()}`,
    );

    expect(quote.premiumPerContract.toNumber()).to.be.greaterThan(0);
    expect(quote.volUsedScaled.toNumber()).to.be.greaterThan(0);
    expect(quote.spotUsedScaled.toNumber()).to.be.greaterThan(0);
    const ts = quote.computedAtTs.toNumber();
    expect(ts).to.be.gte(before - 60);
    expect(ts).to.be.lte(after + 60);
  });

  it("(c) EUR call throws ViewNotSupportedForEuropean (6051)", async function () {
    this.timeout(30_000);
    let threw = false;
    let logs: string[] = [];
    let msg = "";
    let code: number | null = null;
    let name: string | null = null;
    try {
      await viewQuote({ call: {} }, { european: {} });
    } catch (err: any) {
      threw = true;
      msg = String(err?.message || err);
      code = err?.error?.errorCode?.number ?? err?.code ?? null;
      name = err?.error?.errorCode?.code ?? null;
      logs = err?.logs || err?.simulationResponse?.logs || [];
      console.log(`  EUR view rejected:`);
      console.log(`    name: ${name}`);
      console.log(`    code: ${code}`);
      console.log(`    msg:  ${msg.slice(0, 240)}`);
      if (logs.length) {
        console.log(`    logs (last 6):`);
        for (const l of logs.slice(-6)) console.log(`      ${l}`);
      }
    }
    expect(threw, "EUR .view() should have thrown").to.equal(true);

    // Pass 3b: get_option_price is in the local test-feature build, so the EUR
    // view reaches the handler and reverts 6051 (no not-yet-deployed branch).
    const haystack = [msg, ...(logs || [])].join("\n");
    const matches =
      code === 6051 ||
      name === "ViewNotSupportedForEuropean" ||
      /ViewNotSupportedForEuropean|0x17a3\b|\b6051\b/.test(haystack);
    expect(
      matches,
      `expected 6051 / ViewNotSupportedForEuropean, got msg='${msg}' logs=${logs.length}`,
    ).to.equal(true);
  });
});
