// =============================================================================
// spotSources.ts — pure, React-free helpers for the source-1 spot path.
// =============================================================================
//
// Extracted from useSpotPrices.ts so the parse / decode / fallback-selection
// logic is unit-testable without a browser, React, or a live RPC. The hook
// imports these and injects the impure edges (fetch, getMultipleAccountsInfo).
//
// No React, no @solana/web3.js, no wallet-adapter imports here — only Buffer —
// so a test can `import` this module under plain node/tsx.
// =============================================================================

import { Buffer } from "buffer";

// On-chain sample-account byte layout (little-endian i64 fields). The sample
// timestamp sits at 5832 and the sample spot (scaled 1e12) at 5840.
export const SAMPLE_TS_OFFSET = 5832;
export const SAMPLE_SPOT_OFFSET = 5840;
export const SPOT_SCALE = 1e12;
export const MIN_ACCOUNT_LEN = SAMPLE_SPOT_OFFSET + 8; // must cover both fields

/** Canonical feed-id form: lowercase hex, no `0x` prefix. */
export function normFeed(hex: string): string {
  return hex.replace(/^0x/, "").toLowerCase();
}

export type SpotEntry = { ticker: string; feedIdHex: string; oracleSource: 0 | 1 | 2 };

/**
 * Route entries by oracle source. Source-0 (Pyth) feeds pass through UNCHANGED
 * (feedIdHex byte-identical — the off-chain path normalizes internally). Source-1
 * (SB) feeds are normalized here since the same hex keys both the proxy and the
 * on-chain sample account. Entries missing ticker/feedIdHex are dropped.
 */
export function splitBySource(entries: SpotEntry[]): { pythFeeds: SbFeed[]; sbFeeds: SbFeed[]; optaFeeds: SbFeed[] } {
  const pythFeeds: SbFeed[] = [];
  const sbFeeds: SbFeed[] = [];
  const optaFeeds: SbFeed[] = [];
  for (const e of entries) {
    if (!e?.ticker || !e?.feedIdHex) continue;
    if (e.oracleSource === 1) sbFeeds.push({ ticker: e.ticker, feedIdHex: normFeed(e.feedIdHex) });
    else if (e.oracleSource === 2) optaFeeds.push({ ticker: e.ticker, feedIdHex: normFeed(e.feedIdHex) });
    else pythFeeds.push({ ticker: e.ticker, feedIdHex: e.feedIdHex });
  }
  return { pythFeeds, sbFeeds, optaFeeds };
}

/**
 * Parse a same-origin simulate-proxy response into a spot number.
 * Shape: `[{ results: [...] }]` → `Number(results[0])`. Returns null on any
 * unexpected shape / empty results / non-finite value so the caller falls back
 * to the on-chain sample.
 */
export function parseSimulate(json: unknown): number | null {
  const results = Array.isArray(json) ? (json as any[])[0]?.results : undefined;
  if (!Array.isArray(results) || results.length === 0) return null;
  const spot = Number(results[0]);
  return Number.isFinite(spot) ? spot : null;
}

/**
 * Decode a VolOracle sample account: i64 LE ts@5832, i64 LE spot@5840 (scaled
 * 1e12). Returns null when the buffer is too short. Value sanity (spot > 0,
 * ts > 0) is applied by the caller, not here.
 */
export function decodeVolSpot(data: Uint8Array): { spot: number; asOf: number } | null {
  if (data.length < MIN_ACCOUNT_LEN) return null;
  const buf = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const asOf = Number(buf.readBigInt64LE(SAMPLE_TS_OFFSET));
  const rawSpot = Number(buf.readBigInt64LE(SAMPLE_SPOT_OFFSET));
  return { spot: rawSpot / SPOT_SCALE, asOf };
}

export type SbFeed = { ticker: string; feedIdHex: string };
export type SbResolve = {
  prices: Record<string, number>;
  asOf: Record<string, number>;
  error: string | null;
};

/**
 * Fallback-selection logic for the source-1 subset (pure orchestration; the
 * impure edges are injected):
 *   - base SET   → try the proxy per feed; a miss (null) falls through.
 *   - base UNSET → every feed goes straight to the on-chain sample.
 *   - remaining feeds → one batched on-chain decode; spot must be finite & > 0,
 *     asOf recorded only when finite & > 0.
 * An error from `onChainDecode` is captured into `error` (prices/asOf hold
 * whatever resolved before the failure).
 *
 * @param proxyFetch   (base, hex) → spot or null. Injected fetch+parse.
 * @param onChainDecode (hexes)    → Map<hex, {spot, asOf}>. Injected RPC+decode.
 */
/**
 * Run an async map with a bounded number in flight, preserving input order.
 *
 * WHY THIS EXISTS (measured, 2026-08-18)
 *
 *   The proxy pass used to be `feeds.map(...)` inside a Promise.all — 46 fetches
 *   released at once. A browser opens ~6 connections per host, so requests 7..46
 *   sat in the queue and spent their 4s abort budget WAITING FOR A SOCKET rather
 *   than waiting for the proxy. The measurement is unambiguous: a cluster of
 *   calls all completing at 4,312-4,313ms, which is the AbortController firing,
 *   not a slow server.
 *
 *   So the eager fan-out did not just fail to be faster, it converted most of
 *   the proxy pass into guaranteed timeouts and pushed those feeds onto the
 *   on-chain fallback. Bounding concurrency to roughly what the transport can
 *   actually carry means each request gets its full budget spent on the request.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

/** Matches the browser's per-host connection budget. Higher just rebuilds the
 *  queue inside the browser, where we cannot see it or bound its wait. */
export const PROXY_CONCURRENCY = 6;

export interface ResolveOpts {
  /** Tickers to resolve FIRST. The asset actually on screen should not wait
   *  behind 45 boards the user is not looking at. */
  priority?: readonly string[];
  concurrency?: number;
}

export async function resolveSbSpots(
  feeds: SbFeed[],
  base: string | null,
  proxyFetch: (base: string, hex: string) => Promise<number | null>,
  onChainDecode: (hexes: string[]) => Promise<Map<string, { spot: number; asOf: number }>>,
  opts: ResolveOpts = {},
): Promise<SbResolve> {
  const prices: Record<string, number> = {};
  const asOf: Record<string, number> = {};
  let error: string | null = null;

  // 1) Proxy pass (only when configured). A miss leaves the ticker for the
  //    on-chain fallback below.
  const needOnChain: SbFeed[] = [];
  if (base) {
    // Priority feeds first, then the rest — same set, useful order. Sorting is
    // stable, so feeds keep their relative order within each group.
    const pri = new Set(opts.priority ?? []);
    const ordered = pri.size
      ? [...feeds].sort((a, b) => Number(pri.has(b.ticker)) - Number(pri.has(a.ticker)))
      : feeds;
    const settled = await mapWithLimit(
      ordered,
      opts.concurrency ?? PROXY_CONCURRENCY,
      async (f) => ({ f, spot: await proxyFetch(base, f.feedIdHex) }),
    );
    for (const { f, spot } of settled) {
      if (spot != null) prices[f.ticker] = spot;
      else needOnChain.push(f);
    }
  } else {
    needOnChain.push(...feeds);
  }

  // 2) On-chain sample fallback — one batched multi-account read.
  if (needOnChain.length > 0) {
    try {
      const decoded = await onChainDecode(needOnChain.map((f) => f.feedIdHex));
      for (const f of needOnChain) {
        const d = decoded.get(f.feedIdHex);
        if (!d) continue;
        if (!Number.isFinite(d.spot) || d.spot <= 0) continue;
        prices[f.ticker] = d.spot;
        if (Number.isFinite(d.asOf) && d.asOf > 0) asOf[f.ticker] = d.asOf;
      }
    } catch (err: any) {
      error = err?.message ?? "spot sample fetch failed";
    }
  }

  return { prices, asOf, error };
}
