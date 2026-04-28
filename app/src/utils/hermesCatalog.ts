// =============================================================================
// hermesCatalog.ts — Live asset catalog driven by Hermes-Beta
// =============================================================================
//
// Replaces the hardcoded SUPPORTED_ASSETS table. Fetches the full Pyth
// price-feed catalog from hermes-beta.pyth.network at runtime, parses
// each entry into our canonical shape (ticker, feed_id_hex, asset_class),
// and caches the result in localStorage so the modal opens instantly on
// repeat visits.
//
// Asset class mapping (locked Stage P4b decision):
//   Crypto              → 0
//   Equity              → 2  (with ETF heuristic — see ETF_TICKERS)
//   FX                  → 3
//   Commodities | Metal → 1
//   Rates | unknown     → REJECT (filtered out at parse time)
//
// Asset name auto-derivation: strip the dot-prefix and take the chunk
// before the first "/", uppercase, then validate against /^[A-Z0-9]{1,16}$/.
// Symbols that fail validation are filtered out.
// =============================================================================

const HERMES_BASE = "https://hermes-beta.pyth.network";
// Bare `/v2/price_feeds` returns the full multi-class catalog. Hermes
// REJECTS `?asset_type=all` with HTTP 400 — `all` is not a valid variant.
// Valid variants are: crypto, fx, equity, metal, rates, commodities,
// crypto_redemption_rate, crypto_index, crypto_nav, eco, kalshi.
const CATALOG_PATH = "/v2/price_feeds";
const CACHE_KEY = "opta:hermes-catalog-beta";
const FETCH_TIMEOUT_MS = 3000;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

const ETF_TICKERS = new Set([
  "SPY", "QQQ", "IWM", "VTI", "EEM", "XLF", "XLE", "XLK", "XLV",
]);

export type CatalogEntry = {
  /** 64-char lowercase hex, no `0x` prefix. Matches on-chain pyth_feed_id. */
  feedIdHex: string;
  /** Original Hermes symbol (e.g. "Crypto.SOL/USD"). */
  hermesSymbol: string;
  /** Canonical ticker auto-derived from `hermesSymbol` (e.g. "SOL"). */
  suggestedTicker: string;
  /** 0=crypto, 1=commodity, 2=equity, 3=forex, 4=etf. */
  suggestedAssetClass: 0 | 1 | 2 | 3 | 4;
};

export type CatalogResult = {
  entries: CatalogEntry[];
  /** True when we returned cached data because the live fetch failed. */
  isStale: boolean;
  /** Wall-clock timestamp of the data being returned. */
  lastRefresh: number;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type HermesAttributes = {
  asset_type?: string;
  symbol?: string;
  base?: string;
  description?: string;
  display_symbol?: string;
};

type HermesRawEntry = {
  id?: string;
  attributes?: HermesAttributes;
};

/**
 * Strip the dot-prefix and take the chunk before "/", uppercase. Validate.
 * Examples:
 *   "Crypto.SOL/USD"      → "SOL"
 *   "Equity.US.AAPL/USD"  → "AAPL"
 *   "FX.EUR/USD"          → "EUR"
 *   "Metal.XAU/USD"       → "XAU"
 */
function deriveTicker(symbol: string | undefined): string | null {
  if (!symbol) return null;
  const beforeSlash = symbol.split("/")[0];
  const chunks = beforeSlash.split(".");
  const last = chunks[chunks.length - 1];
  const upper = (last ?? "").toUpperCase();
  return /^[A-Z0-9]{1,16}$/.test(upper) ? upper : null;
}

function classifyAsset(
  assetType: string | undefined,
  ticker: string,
): CatalogEntry["suggestedAssetClass"] | null {
  switch (assetType) {
    case "Crypto":
      return 0;
    case "Equity":
      return ETF_TICKERS.has(ticker) ? 4 : 2;
    case "FX":
      return 3;
    case "Commodities":
    case "Metal":
      return 1;
    default:
      return null; // Rates, unknown — reject
  }
}

function parseEntries(raw: unknown): CatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogEntry[] = [];
  let rejected = 0;
  for (const item of raw) {
    const entry = item as HermesRawEntry;
    const id = entry?.id;
    const attrs = entry?.attributes;
    if (typeof id !== "string" || !attrs) {
      rejected++;
      continue;
    }
    const ticker = deriveTicker(attrs.symbol);
    if (!ticker) {
      rejected++;
      continue;
    }
    const cls = classifyAsset(attrs.asset_type, ticker);
    if (cls === null) {
      rejected++;
      continue;
    }
    out.push({
      feedIdHex: id.toLowerCase().replace(/^0x/, ""),
      hermesSymbol: attrs.symbol ?? "",
      suggestedTicker: ticker,
      suggestedAssetClass: cls,
    });
  }
  if (rejected > 0) {
    console.warn(
      `[hermesCatalog] Filtered ${rejected} entries (unmappable asset_type or invalid ticker)`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Network + cache
// ---------------------------------------------------------------------------

type CachedEnvelope = {
  timestamp: number;
  entries: CatalogEntry[];
};

function readCache(): CachedEnvelope | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEnvelope;
    if (
      typeof parsed?.timestamp !== "number" ||
      !Array.isArray(parsed?.entries)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entries: CatalogEntry[]): void {
  try {
    const env: CachedEnvelope = { timestamp: Date.now(), entries };
    localStorage.setItem(CACHE_KEY, JSON.stringify(env));
  } catch {
    // Quota exceeded / private mode — silent.
  }
}

export async function fetchCatalog(
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<CatalogEntry[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(HERMES_BASE + CATALOG_PATH, { signal: ac.signal });
    if (!resp.ok) {
      throw new Error(`Hermes catalog HTTP ${resp.status}`);
    }
    const json = await resp.json();
    return parseEntries(json);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get the catalog with cache + stale fallback semantics.
 *
 *   - Fresh cache (age < maxAge) → return cached, isStale=false (no refetch).
 *   - Otherwise: try fresh fetch with FETCH_TIMEOUT_MS abort.
 *       success → write cache, return fresh, isStale=false.
 *       failure with cache → return cached, isStale=true.
 *       failure no cache  → throw.
 */
export async function getCatalog(
  opts: { maxAge?: number } = {},
): Promise<CatalogResult> {
  const maxAge = opts.maxAge ?? DEFAULT_MAX_AGE_MS;
  const cached = readCache();
  const now = Date.now();

  if (cached && now - cached.timestamp < maxAge) {
    return { entries: cached.entries, isStale: false, lastRefresh: cached.timestamp };
  }

  try {
    const entries = await fetchCatalog();
    writeCache(entries);
    return { entries, isStale: false, lastRefresh: Date.now() };
  } catch (err: any) {
    if (cached) {
      console.warn("[hermesCatalog] live fetch failed, returning cache:", err);
      return {
        entries: cached.entries,
        isStale: true,
        lastRefresh: cached.timestamp,
      };
    }
    // Cold-start no-cache path. Log loudly so DevTools shows the actual
    // network failure instead of leaving the modal looking like it hung.
    console.error("[hermesCatalog] fetch failed (no cache):", err);
    throw new Error(
      `Hermes unreachable, no cached catalog (${err?.message ?? "unknown"}). Use Advanced → paste feed_id hex.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lookups (consumed by NewMarketModal)
// ---------------------------------------------------------------------------

/**
 * Substring match on suggestedTicker + hermesSymbol. Case-insensitive.
 * Empty query returns the full list.
 */
export function searchAssets(
  entries: CatalogEntry[],
  query: string,
): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.suggestedTicker.toLowerCase().includes(q) ||
      e.hermesSymbol.toLowerCase().includes(q),
  );
}

/**
 * Look up a catalog entry by feed_id hex. Used by the paste-feed-id
 * advanced mode to suggest a ticker + asset_class for a known feed.
 */
export function lookupByFeedId(
  entries: CatalogEntry[],
  feedIdHex: string,
): CatalogEntry | null {
  const needle = feedIdHex.toLowerCase().replace(/^0x/, "");
  return entries.find((e) => e.feedIdHex === needle) ?? null;
}
