// =============================================================================
// crank/livenessStore.ts — shared in-memory liveness map (Phase 2a)
// =============================================================================
//
// The liveness loop (livenessCrank.ts) WRITES this; the sb-create endpoint's
// GET /liveness route (sbCreateMarketEndpoint.ts) READS it. Plain module state —
// single Node process, no locking needed. Starts as an empty map so the route
// can serve a valid (if empty) response before the loop's first publish; the FE
// degrades to its static default when the map is empty/stale.
// =============================================================================

export interface FeedLiveness {
  /** 0 = Pyth, 1 = Switchboard, 2 = first-party (on-chain feed account). */
  source: 0 | 1 | 2;
  /** Whether this feed is currently considered live (after hysteresis). */
  live: boolean;
  /** unix seconds — Pyth or first-party publish_time, or the SB last-successful-verify time. */
  asOf: number;
  /** SB oracle-sample floor (informational); null for Pyth. */
  samples: number | null;
}

export interface LivenessMap {
  /** unix seconds — when the loop last refreshed the map. */
  updatedAt: number;
  /** Keyed by 64-char lowercase feed id (no 0x) — Pyth feed id OR SB feed hash. */
  feeds: Record<string, FeedLiveness>;
}

let current: LivenessMap = { updatedAt: 0, feeds: {} };

export function getLivenessMap(): LivenessMap {
  return current;
}

export function setLivenessMap(map: LivenessMap): void {
  current = map;
}
