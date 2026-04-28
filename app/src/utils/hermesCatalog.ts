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
// Asset class mapping (locked Stage P4b/P4c-fix2 decisions):
//   Crypto                 → 0
//   Crypto Redemption Rate → 0  (yield-bearing wrappers — same as crypto)
//   Crypto NAV             → 0  (tokenized RWA NAVs)
//   Crypto Index           → 0  (basket indices)
//   Equity                 → 2  (with ETF heuristic — see ETF_TICKERS → 4)
//   FX                     → 3
//   Commodities | Metal    → 1
//   ECO | Kalshi | Rates | unknown → REJECT (logged, filtered out)
//
// Asset name auto-derivation prefers `attributes.base` (a dedicated,
// structured field) over parsing the dotted symbol string. For FX pairs
// the base alone collides (USD/HUF and USD/BZD both → "USD"), so we
// concatenate base+quote_currency. Non-alphanumeric characters are
// stripped before validation against /^[A-Z0-9]{1,16}$/ so that legit
// tickers like "1606-HK" or "USD0++" survive as "1606HK"/"USD0".
// =============================================================================

const HERMES_BASE = "https://hermes-beta.pyth.network";
// Bare `/v2/price_feeds` returns the full multi-class catalog. Hermes
// REJECTS `?asset_type=all` with HTTP 400 — `all` is not a valid variant.
// Valid variants are: crypto, fx, equity, metal, rates, commodities,
// crypto_redemption_rate, crypto_index, crypto_nav, eco, kalshi.
const CATALOG_PATH = "/v2/price_feeds";
// v2: bumped to invalidate stale caches written by the broken pre-fix
// parser (which dropped ALL FX pairs to a few colliding tickers and
// rejected hyphenated equity tickers + the 5 unmapped asset_type variants).
const CACHE_KEY = "opta:hermes-catalog-beta-v2";
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
  /** Canonical ticker auto-derived from `attributes.base` (e.g. "SOL"). */
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
  quote_currency?: string;
  description?: string;
  display_symbol?: string;
};

type HermesRawEntry = {
  id?: string;
  attributes?: HermesAttributes;
};

/**
 * Derive a canonical [A-Z0-9]{1,16} ticker from Hermes attributes.
 *
 * Source of truth is `attributes.base` (a dedicated structured field).
 * For FX pairs the base alone collides across pairs (USD/HUF and USD/BZD
 * would both produce "USD"), so we concatenate `base + quote_currency`.
 * Non-alphanumeric characters are stripped before length validation so
 * legit tickers with hyphens/plusses (`1606-HK`, `USD0++`) survive.
 */
function deriveTicker(attrs: HermesAttributes | undefined): string | null {
  if (!attrs) return null;
  const base = attrs.base?.toUpperCase();
  if (!base) return null;
  let raw: string;
  if (attrs.asset_type === "FX") {
    const quote = attrs.quote_currency?.toUpperCase();
    raw = quote ? `${base}${quote}` : base;
  } else {
    raw = base;
  }
  const stripped = raw.replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{1,16}$/.test(stripped) ? stripped : null;
}

function classifyAsset(
  assetType: string | undefined,
  ticker: string,
): CatalogEntry["suggestedAssetClass"] | null {
  switch (assetType) {
    case "Crypto":
    case "Crypto Redemption Rate":
    case "Crypto NAV":
    case "Crypto Index":
      return 0;
    case "Equity":
      return ETF_TICKERS.has(ticker) ? 4 : 2;
    case "FX":
      return 3;
    case "Commodities":
    case "Metal":
      return 1;
    default:
      // Rates, ECO, Kalshi, unknown — explicitly rejected.
      return null;
  }
}

function parseEntries(raw: unknown): CatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogEntry[] = [];
  // Per-bucket diagnostics: track count + first 3 sample symbols per
  // rejected asset_type so we can spot new Hermes additions immediately.
  const droppedByType = new Map<string, number>();
  const samplesByType = new Map<string, string[]>();
  let droppedTicker = 0;
  const tickerSamples: string[] = [];

  for (const item of raw) {
    const entry = item as HermesRawEntry;
    const id = entry?.id;
    const attrs = entry?.attributes;
    if (typeof id !== "string" || !attrs) continue;

    const ticker = deriveTicker(attrs);
    const cls = classifyAsset(attrs.asset_type, ticker ?? "");

    if (cls === null) {
      const t = attrs.asset_type ?? "<missing>";
      droppedByType.set(t, (droppedByType.get(t) ?? 0) + 1);
      const samples = samplesByType.get(t) ?? [];
      if (samples.length < 3) {
        samples.push(attrs.symbol ?? "<no symbol>");
        samplesByType.set(t, samples);
      }
      continue;
    }
    if (!ticker) {
      droppedTicker++;
      if (tickerSamples.length < 3) {
        tickerSamples.push(
          `${attrs.symbol ?? "<no sym>"} (base="${attrs.base ?? ""}")`,
        );
      }
      continue;
    }

    out.push({
      feedIdHex: id.toLowerCase().replace(/^0x/, ""),
      hermesSymbol: attrs.symbol ?? "",
      suggestedTicker: ticker,
      suggestedAssetClass: cls,
    });
  }

  // Differential logging — distinguishes the two failure modes so we know
  // which to chase if the catalog ever shrinks.
  const totalByType = Array.from(droppedByType.values()).reduce((a, b) => a + b, 0);
  if (totalByType > 0) {
    console.warn(
      `[hermesCatalog] Filtered ${totalByType} entries: unmappable asset_type`,
    );
    for (const [type, count] of droppedByType.entries()) {
      const samples = samplesByType.get(type) ?? [];
      console.warn(
        `  "${type}": ${count} entries (e.g. ${samples.map((s) => `"${s}"`).join(", ") || "—"})`,
      );
    }
  }
  if (droppedTicker > 0) {
    console.warn(
      `[hermesCatalog] Filtered ${droppedTicker} entries: ticker derivation produced invalid string`,
    );
    console.warn(
      `  e.g. ${tickerSamples.map((s) => `"${s}"`).join(", ") || "—"}`,
    );
  }
  console.info(`[hermesCatalog] Accepted ${out.length} entries from Hermes catalog`);
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
 *   - Fresh non-empty cache (age < maxAge) → return cached, isStale=false.
 *   - Empty cache is treated as no cache (likely from a previous broken
 *     parser run) and forces a refetch.
 *   - Otherwise: try fresh fetch with FETCH_TIMEOUT_MS abort.
 *       success + entries.length > 0 → write cache, return fresh, isStale=false.
 *       success but parser produced 0 entries → throw (don't cache empty).
 *       failure with non-empty cache → return cached, isStale=true.
 *       failure no cache              → throw.
 *
 * Throws route through the modal's `kind: "failed"` path which forces
 * the Advanced paste-feed-id flow open with a visible banner.
 */
export async function getCatalog(
  opts: { maxAge?: number } = {},
): Promise<CatalogResult> {
  const maxAge = opts.maxAge ?? DEFAULT_MAX_AGE_MS;
  const cached = readCache();
  const now = Date.now();

  // Treat empty cache as "no cache" — never return zero entries via the
  // happy path; force a refetch so a future-fixed parser can repopulate.
  if (cached && cached.entries.length > 0 && now - cached.timestamp < maxAge) {
    return {
      entries: cached.entries,
      isStale: false,
      lastRefresh: cached.timestamp,
    };
  }

  try {
    const entries = await fetchCatalog();
    if (entries.length === 0) {
      // 200 OK from Hermes but parser found nothing usable. Don't cache
      // — force a future re-attempt — and surface a clear UI failure.
      throw new Error("Hermes returned 0 usable assets after parsing");
    }
    writeCache(entries);
    return { entries, isStale: false, lastRefresh: Date.now() };
  } catch (err: any) {
    if (cached && cached.entries.length > 0) {
      console.warn("[hermesCatalog] live fetch failed, returning cache:", err);
      return {
        entries: cached.entries,
        isStale: true,
        lastRefresh: cached.timestamp,
      };
    }
    // Cold-start no-usable-cache path. Log loudly so DevTools shows the
    // actual network/parse failure instead of leaving the modal hanging.
    console.error("[hermesCatalog] fetch failed (no cache):", err);
    throw new Error(
      `Hermes catalog unavailable (${err?.message ?? "unknown"}). Use Advanced → paste feed_id hex.`,
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
