// =============================================================================
// tests/_vol_oracle_helpers.ts — shared VolOracle test setup
// =============================================================================
//
// Pass 2 made `vol_oracle` a REQUIRED account on mint_from_vault's uniform
// context (the American branch reads it; the European branch carries it but
// never touches it). Loose `.accounts({...})` mint call sites auto-derive the
// PDA from seeds [b"vol_oracle", market.pyth_feed_id], so the account just has
// to EXIST and be program-owned — otherwise the mint reverts 3007
// AccountOwnedByWrongProgram. Pre-Pass-2 vault tests never seeded an oracle,
// which is the fixture-rot remediation's "12× 3007" regression.
//
// `ensureVolOracle` idempotently initializes a (cold) oracle once per validator
// session — enough for EUR mints, which never read it. `synthWarmVolOracle`
// (test-synth-vol feature) plants warmed state so American pricing reads Ok.
// =============================================================================

import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";

const VOL_ORACLE_SEED = Buffer.from("vol_oracle");

export function deriveVolOracle(programId: PublicKey, feedId: number[]): PublicKey {
  return PublicKey.findProgramAddressSync(
    [VOL_ORACLE_SEED, Buffer.from(feedId)],
    programId,
  )[0];
}

/// Idempotently ensure a (cold) VolOracle exists for `feedId`. Safe to call
/// from every minting test's before hook — inits once per validator session,
/// skips silently if already present. `priceUpdate` must be a loaded Pyth
/// fixture whose feed_id == feedId (initialize_vol_oracle's proof-of-feed gate;
/// no freshness gate, so any age works). Returns the oracle PDA.
export async function ensureVolOracle(
  program: any,
  feedId: number[],
  priceUpdate: PublicKey,
  payer: PublicKey,
): Promise<PublicKey> {
  const oracle = deriveVolOracle(program.programId, feedId);
  const info = await program.provider.connection.getAccountInfo(oracle);
  if (!info) {
    await program.methods
      .initializeVolOracle(feedId, 0, new BN(0))
      .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
        initializer: payer,
        priceUpdate,
        volOracle: oracle,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
  return oracle;
}

/// Plant warmed state into an already-initialized VolOracle via the
/// `test-synth-vol` synth_warm_vol_oracle instruction: sample_count=720, fresh
/// last_sample_ts, V2-reference accumulators (~79% vol), and the supplied
/// spot (SCALE 1e12). After this, realized_vol_annualized / price_american
/// read Ok. Call AFTER ensureVolOracle. Requires the program built with the
/// test-synth-vol feature (the harness passes it). Returns the oracle PDA.
export async function synthWarmVolOracle(
  program: any,
  feedId: number[],
  spot: BN,
  payer: PublicKey,
  lastSampleTs?: BN,
): Promise<PublicKey> {
  const oracle = deriveVolOracle(program.programId, feedId);
  const ts = lastSampleTs ?? new BN(Math.floor(Date.now() / 1000));
  await program.methods
    .synthWarmVolOracle(spot, ts)
    .accountsStrict({
      signer: payer,
      volOracle: oracle,
    })
    .rpc();
  return oracle;
}

/// A last_sample_ts that is `hoursAgo` hours older than now — for exercising
/// the 6h staleness gate (e.g. hoursAgo=7 → VolOracleStale).
export function staleTs(hoursAgo: number): BN {
  return new BN(Math.floor(Date.now() / 1000) - hoursAgo * 3600);
}

/// Convenience: spot price at solmath SCALE (1e12) from a whole-dollar amount.
export function spotScaled(dollars: number): BN {
  return new BN(dollars).mul(new BN("1000000000000"));
}
