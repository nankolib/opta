// =============================================================================
// useSpotPrices.ts — source-aware spot prices (wraps usePythPrices)
// =============================================================================
//
// A market carries an `oracle_source` byte. Source 0 markets price off the
// existing off-chain pull path (usePythPrices, unchanged). Source 1 markets
// price off a same-origin spot-simulate proxy when configured, else fall back
// to the market's on-chain last recorded sample.
//
// This wrapper keeps the EXACT usePythPrices output contract
//   { prices: Record<string, number>; loading; error; stale }
// and ADDS a per-ticker `asOf?: Record<string, number>` (unix secs) populated
// ONLY for markets whose spot came from the on-chain sample fallback — the UI
// renders a muted "as of HH:MM UTC" beside those. For an input that is entirely
// source-0, the returned object is byte-identical to calling usePythPrices
// directly (prices/loading/error/stale pass through, asOf is undefined).
//
// Provenance rule: no oracle-vendor names in any user-visible string. The proxy
// base is a neutral env var (VITE_XBAR_BASE); the on-chain sample is described
// generically ("as of …").
//
// Caller shape: `Array<{ ticker, feedIdHex, oracleSource: 0 | 1 }>`. For a
// source-1 market the 32-byte `feedIdHex` doubles as BOTH the proxy simulate key
// AND the seed for the on-chain sample account, so one hex threads both paths.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { useConnection } from "@solana/wallet-adapter-react";
import { usePythPrices } from "./usePythPrices";
import { useProgram } from "./useProgram";
import { VOL_ORACLE_SEED } from "../utils/constants";
import { getXbarBase } from "../utils/env";
import { parseSimulate, decodeVolSpot, resolveSbSpots, splitBySource, normFeed } from "./spotSources";
import { optaPriceFeedPda, decodeOptaFeed } from "../utils/oracleArm";

const REFRESH_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 4000;

export type SpotRequest = {
  /** Display key the price is returned under. */
  ticker: string;
  /** 64-char lowercase hex, no `0x` prefix. */
  feedIdHex: string;
  /** 0 = off-chain pull path; 1 = proxy-simulate with on-chain sample fallback. */
  oracleSource: 0 | 1 | 2;
};

export type SpotPricesResult = {
  prices: Record<string, number>;
  loading: boolean;
  error: string | null;
  stale: boolean;
  /** Sample timestamp (unix secs) per ticker, ONLY for on-chain-fallback markets. */
  asOf?: Record<string, number>;
};

function deriveSamplePda(feedIdHex: string, programId: PublicKey): PublicKey {
  const bytes = Buffer.from(normFeed(feedIdHex), "hex");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), bytes],
    programId,
  );
  return pda;
}

/** Try the same-origin simulate proxy for one feed. Returns null on any
 *  failure (unset base, non-200, timeout, empty/invalid results) so the caller
 *  falls back to the on-chain sample. */
async function fetchProxySpot(base: string, feedIdHex: string): Promise<number | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}/simulate/${feedIdHex}`, { signal: ac.signal });
    if (!resp.ok) return null;
    return parseSimulate(await resp.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short-TTL cache + single-flight around the spot proxy.
 *
 * Two separate wastes, both measured on a cold /trade:
 *   - the same feed is requested by more than one mounted component at once, and
 *   - a remount re-requests a price fetched moments ago.
 * Neither survives a few seconds of memory.
 *
 * DISPLAY PATH ONLY. Spot here feeds the chain, the spot marker and estimates —
 * never an instruction argument (those are quantity / max premium / limit price,
 * all user input). Any tx-affecting resolution reads fresh and does not come
 * through here; a stale mark is a cosmetic annoyance, a stale tx input is money.
 * The TTL is deliberately far below REFRESH_INTERVAL_MS so the 30s refresh still
 * does real work rather than re-reading its own cache.
 */
const SPOT_TTL_MS = 5_000;
const spotCache = new Map<string, { value: number | null; at: number }>();
const spotInflight = new Map<string, Promise<number | null>>();

async function cachedProxySpot(base: string, feedIdHex: string): Promise<number | null> {
  const now = Date.now();
  const hit = spotCache.get(feedIdHex);
  // A negative age means the clock moved backwards; treat it as a miss rather
  // than trusting an entry that could otherwise look fresh indefinitely.
  if (hit && now - hit.at >= 0 && now - hit.at < SPOT_TTL_MS) return hit.value;

  const flying = spotInflight.get(feedIdHex);
  if (flying) return flying;

  const p = fetchProxySpot(base, feedIdHex)
    .then((value) => {
      // Cache misses too: a feed the proxy cannot serve should not be retried by
      // every other caller in the same burst, which is what turned one dead feed
      // into dozens of 4s timeouts.
      spotCache.set(feedIdHex, { value, at: Date.now() });
      return value;
    })
    .finally(() => {
      if (spotInflight.get(feedIdHex) === p) spotInflight.delete(feedIdHex);
    });
  spotInflight.set(feedIdHex, p);
  return p;
}

export function useSpotPrices(
  entries: SpotRequest[],
  /** Tickers to resolve first — normally the asset currently on screen. */
  priority: readonly string[] = [],
): SpotPricesResult {
  // ---- Split by source. Both branches run every render (hooks rules). --------
  const { pythFeeds, sbFeeds, optaFeeds } = useMemo(() => {
    return splitBySource(entries);
  }, [entries]);

  // Source-0 subset flows through the existing path BYTE-IDENTICALLY.
  const pyth = usePythPrices(pythFeeds);

  // ---- Source-1 subset: proxy-simulate with on-chain sample fallback --------
  const { connection } = useConnection();
  const { program } = useProgram();
  const programId = program?.programId ?? null;

  // Stable fingerprint so the effect only re-fires on membership change.
  const sbKey = useMemo(
    () => sbFeeds.map((f) => `${f.ticker}:${f.feedIdHex}`).sort().join(","),
    [sbFeeds],
  );

  // Stable string so a freshly-allocated priority array each render does not
  // restart the fetch loop.
  const priorityKey = useMemo(() => priority.join(","), [priority.join(",")]);

  const [sbPrices, setSbPrices] = useState<Record<string, number>>({});
  const [sbAsOf, setSbAsOf] = useState<Record<string, number>>({});
  const [sbLoading, setSbLoading] = useState(false);
  const [sbError, setSbError] = useState<string | null>(null);

  // ---- ORACLE_SOURCE_OPTA (plug wave 1): read the OptaPriceFeed account ----
  // No proxy, no simulate: the price IS the account. Display path only.
  const optaKey = useMemo(
    () => optaFeeds.map((f) => `${f.ticker}:${f.feedIdHex}`).sort().join(","),
    [optaFeeds],
  );
  const [optaPrices, setOptaPrices] = useState<Record<string, number>>({});
  const [optaAsOf, setOptaAsOf] = useState<Record<string, number>>({});
  const [optaLoading, setOptaLoading] = useState(false);
  useEffect(() => {
    if (optaFeeds.length === 0 || !programId) {
      setOptaPrices({}); setOptaAsOf({}); setOptaLoading(false);
      return;
    }
    let cancelled = false;
    setOptaLoading(true);
    const run = async () => {
      try {
        const pdas = optaFeeds.map((f) => optaPriceFeedPda(f.feedIdHex, programId));
        const infos = await connection.getMultipleAccountsInfo(pdas, "confirmed");
        const prices: Record<string, number> = {};
        const asOf: Record<string, number> = {};
        for (let i = 0; i < optaFeeds.length; i++) {
          const info = infos[i];
          if (!info) continue;
          const d = decodeOptaFeed(info.data as Uint8Array);
          if (d) { prices[optaFeeds[i].ticker] = d.spot; asOf[optaFeeds[i].ticker] = d.asOf; }
        }
        if (!cancelled) { setOptaPrices(prices); setOptaAsOf(asOf); setOptaLoading(false); }
      } catch {
        if (!cancelled) setOptaLoading(false);
      }
    };
    run();
    const id = setInterval(run, REFRESH_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [optaKey, connection, programId?.toBase58()]);

  useEffect(() => {
    if (sbFeeds.length === 0) {
      setSbPrices({});
      setSbAsOf({});
      setSbLoading(false);
      setSbError(null);
      return;
    }
    let cancelled = false;
    setSbLoading(true);

    // Batched on-chain sample read + decode. Empty Map when the program isn't
    // ready yet (leaves those tickers absent, no error) — matches prior behavior.
    const onChainDecode = async (
      hexes: string[],
    ): Promise<Map<string, { spot: number; asOf: number }>> => {
      const out = new Map<string, { spot: number; asOf: number }>();
      if (!programId) return out;
      const pdas = hexes.map((h) => deriveSamplePda(h, programId));
      const infos = await connection.getMultipleAccountsInfo(pdas, "confirmed");
      for (let i = 0; i < hexes.length; i++) {
        const info = infos[i];
        if (!info) continue;
        const d = decodeVolSpot(info.data as Uint8Array);
        if (d) out.set(hexes[i], d);
      }
      return out;
    };

    const run = async () => {
      const { prices, asOf, error } = await resolveSbSpots(
        sbFeeds,
        getXbarBase(),
        cachedProxySpot,
        onChainDecode,
        { priority: priorityKey ? priorityKey.split(",") : [] },
      );
      if (!cancelled) {
        setSbPrices(prices);
        setSbAsOf(asOf);
        setSbLoading(false);
        setSbError(error);
      }
    };

    run();
    const id = setInterval(run, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // sbKey is the membership fingerprint; connection/programId are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sbKey, priorityKey, connection, programId?.toBase58()]);

  // ---- Merge. Pyth-only inputs return byte-identically. ----------------------
  return useMemo(() => {
    const hasSb = sbFeeds.length > 0 || optaFeeds.length > 0;
    if (!hasSb) {
      return {
        prices: pyth.prices,
        loading: pyth.loading,
        error: pyth.error,
        stale: pyth.stale,
      };
    }
    const mergedAsOf = { ...sbAsOf, ...optaAsOf };
    const asOf = Object.keys(mergedAsOf).length > 0 ? mergedAsOf : undefined;
    return {
      prices: { ...pyth.prices, ...sbPrices, ...optaPrices },
      loading: pyth.loading || sbLoading || optaLoading,
      error: pyth.error ?? sbError,
      stale: pyth.stale,
      asOf,
    };
  }, [pyth.prices, pyth.loading, pyth.error, pyth.stale, sbPrices, sbAsOf, sbLoading, sbError, sbFeeds.length, optaPrices, optaAsOf, optaLoading, optaFeeds.length]);
}
