// =============================================================================
// optaFeed.ts — first-party price feed (oracle_source 2): pure helpers.
// =============================================================================
//
// A source-2 market is priced from an on-chain feed account the protocol's own
// lane writes roughly every 45 seconds. This module owns three decisions and
// nothing else, so each has exactly one implementation:
//
//   1. which oracle sources the app can show at all (the two market guards);
//   2. where a market's spot is read from, by source (the spot stage);
//   3. how the feed account's bytes become a spot quote, and how old is "live".
//
// No web3.js, no network, no clock of its own: `nowSec` is passed in.
// =============================================================================

/** Sources this build has a quote path for. A new source stays hidden until it
 *  is added here together with its route below. */
export function isSupportedOracleSource(source: unknown): boolean {
  return source === 0 || source === 1 || source === 2;
}

export type SpotRoute = "http" | "volOracle" | "optaFeed";

/** 0 = pull-oracle over HTTP · 1 = hourly on-chain sample · 2 = first-party feed. */
export function spotRouteFor(source: number): SpotRoute | null {
  if (source === 0) return "http";
  if (source === 1) return "volOracle";
  if (source === 2) return "optaFeed";
  return null;
}

// Feed account layout after the 8-byte discriminator (state/opta_price_feed.rs):
// feed_id [u8;32] @8 · price_6dec u64 @40 · conf_6dec u64 @48 · publish_time i64
// @56 · slot u64 @64 · authority @72 · prev_price_6dec @104 · prev_publish_time
// @112 · frozen bool @120 · bump @121. Offsets match the web client's decoder.
export const OPTA_FEED_PRICE_OFFSET = 40;
export const OPTA_FEED_PUBLISH_TIME_OFFSET = 56;
export const OPTA_FEED_FROZEN_OFFSET = 120;
export const OPTA_FEED_MIN_LEN = 122;

/** Mirrors the keeper's own bound for this feed: older than this and the
 *  protocol itself will not use the price, so the app must not call it live. */
export const OPTA_FEED_LIVE_MAX_AGE_SECONDS = 180;
export const OPTA_FEED_FUTURE_TOLERANCE_SECONDS = 30;

export interface OptaFeedFields {
  price6Dec: number;
  publishTime: number;
  frozen: boolean;
}

export type FeedSpot = { value: number; state: "live" | "stale"; publishTime: number };

/** u64 / i64 little-endian as a JS number. Prices (6 dec) and unix times are far
 *  below 2^53; no BigInt, so this runs unchanged on the device runtime. */
function u64Le(data: ArrayLike<number>, offset: number): number {
  let lo = 0;
  let hi = 0;
  for (let i = 3; i >= 0; i -= 1) lo = lo * 256 + (data[offset + i] as number);
  for (let i = 7; i >= 4; i -= 1) hi = hi * 256 + (data[offset + i] as number);
  return hi * 4294967296 + lo;
}

export function parseOptaFeedFields(data: ArrayLike<number>): OptaFeedFields | null {
  if (!data || data.length < OPTA_FEED_MIN_LEN) return null;
  const price6Dec = u64Le(data, OPTA_FEED_PRICE_OFFSET);
  const publishTime = u64Le(data, OPTA_FEED_PUBLISH_TIME_OFFSET);
  if (!Number.isSafeInteger(price6Dec) || !Number.isSafeInteger(publishTime)) return null;
  return { price6Dec, publishTime, frozen: data[OPTA_FEED_FROZEN_OFFSET] !== 0 };
}

/** Fields -> quote. Null for a frozen feed or one that was never pushed. */
export function feedFieldsToSpot(fields: OptaFeedFields | null, nowSec: number): FeedSpot | null {
  if (!fields || fields.frozen || !(fields.price6Dec > 0) || !(fields.publishTime > 0)) return null;
  const age = nowSec - fields.publishTime;
  const state: "live" | "stale" =
    age >= -OPTA_FEED_FUTURE_TOLERANCE_SECONDS && age <= OPTA_FEED_LIVE_MAX_AGE_SECONDS ? "live" : "stale";
  return { value: fields.price6Dec / 1e6, state, publishTime: fields.publishTime };
}

export function decodeOptaFeedSpot(data: ArrayLike<number>, nowSec: number): FeedSpot | null {
  return feedFieldsToSpot(parseOptaFeedFields(data), nowSec);
}

/** The hourly sample standing in for an unreadable feed is up to an hour old.
 *  It may fill the number in; it may never be shown as live. */
export function asFallbackSpot<T extends { value: number; state: "live" | "stale" }>(
  quote: T | null
): { value: number; state: "stale" } | null {
  return quote ? { value: quote.value, state: "stale" } : null;
}
