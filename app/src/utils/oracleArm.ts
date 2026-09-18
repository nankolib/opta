// ============================================================================
// app/src/utils/oracleArm.ts — the third price arm (ORACLE_SOURCE_OPTA = 2).
// ============================================================================
//
// A market's `oracle_source` byte picks how the FE reads its price and which
// accounts a price-reading instruction carries:
//
//   0  Pyth        post a Hermes update, pass `price_update`
//   1  Switchboard the VPS endpoint builds the tx (ed25519 proof + sb_* accounts)
//   2  Opta        pass the market's OptaPriceFeed PDA in the TRAILING optional
//                  `opta_price_feed`; no off-chain post, no endpoint
//
// The trailing optional was appended LAST on every price-reading instruction
// (plug wave 1, 2026-09-18). Anchor encodes an omitted optional as the program
// id itself, so a source-0/1 instruction built against the new IDL carries the
// SAME data bytes and the SAME leading accounts as before plus one program-id
// sentinel in the last slot, which the program reads as None. That is what
// oracleArm.test.ts proves against the pre-plug IDL, byte for byte.
//
// Vendor names never reach the UI (hide-provenance rule); everything here is
// internal routing.

import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

export const ORACLE_SOURCE_PYTH = 0;
export const ORACLE_SOURCE_SWITCHBOARD = 1;
export const ORACLE_SOURCE_OPTA = 2;
export type OracleArm = "pyth" | "switchboard" | "opta";
export type SpotSource = 0 | 1 | 2;

/** Seed prefix of the OptaPriceFeed PDA: [b"opta_price_feed", feed_id]. */
export const OPTA_PRICE_FEED_SEED = "opta_price_feed";

export class UnknownOracleSourceError extends Error {
  readonly received: unknown;
  constructor(received: unknown) {
    super("This market's price source could not be determined.");
    this.name = "UnknownOracleSourceError";
    this.received = received;
  }
}

/** Pick the arm from a market's `oracle_source`. Throws rather than guessing:
 *  there is no safe default for a price path. */
export function chooseOracleArm(oracleSource: unknown): OracleArm {
  if (oracleSource === ORACLE_SOURCE_PYTH) return "pyth";
  if (oracleSource === ORACLE_SOURCE_SWITCHBOARD) return "switchboard";
  if (oracleSource === ORACLE_SOURCE_OPTA) return "opta";
  throw new UnknownOracleSourceError(oracleSource);
}

/** Narrow a raw on-chain byte to the three sources the display path knows.
 *  Unknown bytes fall back to 0 (the pre-plug behaviour for display only —
 *  a tx path must use chooseOracleArm and refuse). */
export function spotSourceOf(raw: unknown): SpotSource {
  const n = Number(raw ?? 0);
  return n === 1 ? 1 : n === 2 ? 2 : 0;
}

export function normFeedHex(hex: string): string {
  return hex.replace(/^0x/, "").toLowerCase();
}

/** The OptaPriceFeed PDA for a market's feed_id (the same 32 bytes the market
 *  stores in `pyth_feed_id`, whatever its origin). */
export function optaPriceFeedPda(feedIdHex: string, programId: PublicKey): PublicKey {
  const bytes = Buffer.from(normFeedHex(feedIdHex), "hex");
  if (bytes.length !== 32) throw new Error("feed id must be 32 bytes");
  return PublicKey.findProgramAddressSync([Buffer.from(OPTA_PRICE_FEED_SEED), bytes], programId)[0];
}

// OptaPriceFeed account layout (state/opta_price_feed.rs), after the 8-byte
// discriminator: feed_id [u8;32] @8, price_6dec u64 @40, conf_6dec u64 @48,
// publish_time i64 @56, slot u64 @64, authority Pubkey @72, prev_price_6dec u64
// @104, prev_publish_time i64 @112, frozen bool @120, bump u8 @121.
export const OPTA_FEED_PRICE_OFFSET = 40;
export const OPTA_FEED_PUBLISH_TIME_OFFSET = 56;
export const OPTA_FEED_FROZEN_OFFSET = 120;
export const OPTA_FEED_MIN_LEN = 122;

export type OptaFeedSpot = { spot: number; asOf: number; frozen: boolean };

/** Decode the display-relevant fields. Returns null on a short account, a
 *  frozen feed, or a zero price (a feed that exists but was never pushed). */
export function decodeOptaFeed(data: Uint8Array): OptaFeedSpot | null {
  if (data.length < OPTA_FEED_MIN_LEN) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const price6 = view.getBigUint64(OPTA_FEED_PRICE_OFFSET, true);
  const asOf = Number(view.getBigInt64(OPTA_FEED_PUBLISH_TIME_OFFSET, true));
  const frozen = data[OPTA_FEED_FROZEN_OFFSET] !== 0;
  if (frozen || price6 === 0n) return null;
  return { spot: Number(price6) / 1e6, asOf, frozen };
}

// ---- Write-gate through vol warmup (plug wave 1, D2 condition 2) -----------
//
// A source-2 market quotes from a STATIC seed σ until its VolOracle ring holds
// VOL_ORACLE_WARMUP_SAMPLES hourly pushes. The chain serves that seed verbatim
// and has no way to correct a mis-calibrated one, so no NEW exposure is written
// until the ring is warm. Data-driven and self-lifting: the gate reads
// sample_count from the oracle account and opens on its own at 168. Protection
// class: model/σ-accuracy, not liveness — the on-chain staleness gate already
// covers liveness in seed mode. Sources 0/1 are never touched by this gate.
//
// VolOracle layout after the 8-byte discriminator (state/vol_oracle.rs, repr C):
//   sum_log_returns i128 @8 · sum_log_returns_sq i128 @24 · feed_id [u8;32] @40 ·
//   samples [i64;720] @72 · last_sample_ts @5832 · last_spot_price @5840 ·
//   head u16 @5848 · sample_count u16 @5850 · bump @5852 · oracle_source @5853 ·
//   pad @5854 · seed_vol i64 @5856 · total 5864.
// Verified live against the BTC oracle on 2026-09-18 (sample_count 720,
// oracle_source 1, identical to the Anchor coder's decode).
export const VOL_ORACLE_WARMUP_SAMPLES = 168;
export const VOL_ORACLE_SAMPLE_COUNT_OFFSET = 5850;
export const VOL_ORACLE_SOURCE_OFFSET = 5853;
export const VOL_ORACLE_ACCOUNT_LEN = 5864;

export type VolOracleWarmup = { sampleCount: number; oracleSource: number };

/** The two fields the write-gate needs, or null on a short buffer. */
export function decodeVolOracleWarmup(data: Uint8Array): VolOracleWarmup | null {
  if (!data || data.length < VOL_ORACLE_ACCOUNT_LEN) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    sampleCount: view.getUint16(VOL_ORACLE_SAMPLE_COUNT_OFFSET, true),
    oracleSource: data[VOL_ORACLE_SOURCE_OFFSET],
  };
}

/** Write-gate verdict: null = writes allowed, string = the user-facing reason
 *  they are not. Source 2 with an unread sample count is gated (fail closed). */
export function writeWarmupGate(oracleSource: unknown, sampleCount: number | null | undefined): string | null {
  if (Number(oracleSource) !== ORACLE_SOURCE_OPTA) return null;
  if (sampleCount == null) return "Writing opens after this market's first pricing week.";
  if (sampleCount >= VOL_ORACLE_WARMUP_SAMPLES) return null;
  return `Writing opens after this market's first pricing week (${sampleCount} of ${VOL_ORACLE_WARMUP_SAMPLES} hours so far).`;
}
