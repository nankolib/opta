import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { usePythPrices } from "../../hooks/usePythPrices";
import { showToast } from "../../components/Toast";
import { decodeError } from "../../utils/errorDecoder";
import {
  applyVolSmile,
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { HairlineRule } from "../../components/layout";
import {
  getCatalog,
  searchAssets,
  lookupByFeedId,
  type CatalogEntry,
} from "../../utils/hermesCatalog";

type NewMarketModalProps = {
  onClose: () => void;
  onCreated: () => void;
};

type ExpiryPreset = "7D" | "14D" | "30D" | "FRIDAY" | "CUSTOM";

const EXPIRY_PRESETS: ReadonlyArray<{ id: ExpiryPreset; label: string }> = [
  { id: "7D", label: "7D" },
  { id: "14D", label: "14D" },
  { id: "30D", label: "30D" },
  { id: "FRIDAY", label: "Next Fri" },
  { id: "CUSTOM", label: "Custom" },
];

const ASSET_CLASS_LABEL: Record<number, string> = {
  0: "Crypto",
  1: "Commodity",
  2: "Equity",
  3: "FX",
  4: "ETF",
};

type CatalogState =
  | { kind: "loading" }
  | { kind: "fresh"; entries: CatalogEntry[] }
  | { kind: "stale"; entries: CatalogEntry[]; lastRefresh: number }
  | { kind: "failed"; error: string };

/**
 * Paper-aesthetic New Market modal.
 *
 * Stage P4b: asset picker is driven by a live Hermes-Beta catalog instead
 * of a hardcoded 5-asset table. Users search the catalog by ticker or
 * full Hermes symbol; an Advanced toggle lets them paste a feed_id hex
 * directly for assets the catalog can't surface (or as a fallback when
 * Hermes is unreachable). asset_name is auto-derived from the symbol but
 * remains editable; submit logic stays stubbed until P4c.
 *
 * Esc and click-outside dismiss the modal.
 */
export const NewMarketModal: FC<NewMarketModalProps> = ({
  onClose,
  onCreated: _onCreated,
}) => {
  const { program, provider } = useProgram();
  const { publicKey } = useWallet();

  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [assetName, setAssetName] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pastedHex, setPastedHex] = useState("");
  const [pastedClass, setPastedClass] = useState<number>(0);

  const [side, setSide] = useState<"call" | "put">("call");
  const [strikeStr, setStrikeStr] = useState("");
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>("7D");
  const [customExpiry, setCustomExpiry] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Resolve the active (feedIdHex, assetClass) pair from either the
  // catalog selection or the advanced paste-feed-id form.
  const activeFeed: { feedIdHex: string; assetClass: number } | null = useMemo(() => {
    if (advancedOpen) {
      const hex = pastedHex.trim().toLowerCase().replace(/^0x/, "");
      if (!/^[0-9a-f]{64}$/.test(hex)) return null;
      return { feedIdHex: hex, assetClass: pastedClass };
    }
    if (!selected) return null;
    return { feedIdHex: selected.feedIdHex, assetClass: selected.suggestedAssetClass };
  }, [advancedOpen, pastedHex, pastedClass, selected]);

  // Load catalog on mount.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    getCatalog()
      .then((res) => {
        if (cancelled) return;
        if (res.isStale) {
          setCatalogState({
            kind: "stale",
            entries: res.entries,
            lastRefresh: res.lastRefresh,
          });
        } else {
          setCatalogState({ kind: "fresh", entries: res.entries });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setCatalogState({ kind: "failed", error: err?.message ?? "unknown" });
        // Force advanced mode open when catalog is dead.
        setAdvancedOpen(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc to dismiss.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Sync assetName from selection, but only when the user hasn't started
  // editing it. Once they've typed anything, leave their value alone.
  const userEditedRef = useRef(false);
  useEffect(() => {
    if (advancedOpen) {
      // In advanced mode, suggest a ticker if the pasted feed_id is a
      // known catalog entry; otherwise leave assetName user-editable.
      const entries = entriesFromState(catalogState);
      if (entries) {
        const hex = pastedHex.trim().toLowerCase().replace(/^0x/, "");
        const known = /^[0-9a-f]{64}$/.test(hex)
          ? lookupByFeedId(entries, hex)
          : null;
        if (known && !userEditedRef.current) {
          setAssetName(known.suggestedTicker);
        }
      }
      return;
    }
    if (selected && !userEditedRef.current) {
      setAssetName(selected.suggestedTicker);
    }
  }, [advancedOpen, pastedHex, selected, catalogState]);

  const filtered = useMemo(() => {
    const entries = entriesFromState(catalogState);
    if (!entries) return [];
    return searchAssets(entries, query).slice(0, 12);
  }, [catalogState, query]);

  // Live spot for the chosen feed (single-element batch).
  const spotFeeds = useMemo(() => {
    if (!activeFeed || !assetName) return [];
    return [{ ticker: assetName, feedIdHex: activeFeed.feedIdHex }];
  }, [activeFeed, assetName]);
  const { prices } = usePythPrices(spotFeeds);
  const spot: number = assetName ? prices[assetName] ?? 0 : 0;

  const expiryUnix = useMemo(
    () => computeExpiryUnix(expiryPreset, customExpiry),
    [expiryPreset, customExpiry],
  );

  const strike = parseFloat(strikeStr) || 0;
  const moneyness = useMemo(
    () => computeMoneyness(side, spot, strike),
    [side, spot, strike],
  );

  const assetNameValid = /^[A-Z0-9]{1,16}$/.test(assetName);

  const premiumPreview = useMemo(() => {
    if (!expiryUnix || strike <= 0 || spot <= 0 || !assetName) return null;
    const days = Math.max(0, (expiryUnix - Date.now() / 1000) / 86400);
    if (days <= 0) return null;
    const baseVol = getDefaultVolatility(assetName);
    const vol = applyVolSmile(baseVol, spot, strike, assetName);
    return side === "call"
      ? calculateCallPremium(spot, strike, days, vol)
      : calculatePutPremium(spot, strike, days, vol);
  }, [assetName, side, spot, strike, expiryUnix]);

  const canSubmit =
    !submitting &&
    !!program &&
    !!provider &&
    !!publicKey &&
    !!activeFeed &&
    assetNameValid &&
    strike > 0 &&
    !!expiryUnix &&
    expiryUnix > Date.now() / 1000;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // P4a stub preserved: real createMarket call lands in P4c.
      throw new Error("Disabled until P4c — Pyth Pull migration in progress");
    } catch (err: any) {
      showToast({ type: "error", title: "Create market failed", message: decodeError(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-paper border border-rule rounded-md p-8 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="m-0 font-fraunces-mid font-light text-ink leading-tight tracking-[-0.01em] text-[24px]">
            New market
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="font-mono text-[14px] opacity-60 hover:opacity-100 transition-opacity duration-200"
          >
            ✕
          </button>
        </div>

        {catalogState.kind === "stale" && (
          <div className="border border-rule-soft rounded-sm p-3 mb-5 text-[11px] font-mono uppercase tracking-[0.16em] opacity-75">
            ⚠ Hermes unreachable — showing cached catalog from{" "}
            {new Date(catalogState.lastRefresh).toLocaleString()}
          </div>
        )}
        {catalogState.kind === "failed" && (
          <div className="border border-rule-soft rounded-sm p-3 mb-5 text-[11px] font-mono uppercase tracking-[0.16em] text-crimson">
            Hermes unreachable & no cached catalog. Use Advanced → paste feed_id hex.
            <div className="opacity-65 normal-case mt-1.5 tracking-normal">
              {catalogState.error}
            </div>
          </div>
        )}

        {/* Asset search (hidden when catalog failed cold) */}
        {catalogState.kind !== "failed" && !advancedOpen && (
          <Field label="Asset">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                catalogState.kind === "loading"
                  ? "Loading Hermes catalog…"
                  : "Search by ticker or symbol (e.g. SOL, AAPL, EUR)"
              }
              disabled={catalogState.kind === "loading"}
              className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[13px] text-ink focus:outline-none focus:border-ink transition-colors duration-200 disabled:opacity-50"
            />
            {filtered.length > 0 && (
              <ul className="border border-rule-soft rounded-sm mt-2 max-h-[240px] overflow-y-auto">
                {filtered.map((entry) => {
                  const isSelected = selected?.feedIdHex === entry.feedIdHex;
                  return (
                    <li key={entry.feedIdHex}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(entry);
                          userEditedRef.current = false;
                        }}
                        aria-pressed={isSelected}
                        className={`w-full flex items-center justify-between text-left px-3 py-2 font-mono text-[12px] transition-colors duration-200 ${
                          isSelected
                            ? "bg-ink text-paper"
                            : "text-ink opacity-80 hover:opacity-100 hover:bg-paper-2"
                        }`}
                      >
                        <span>
                          <span className="font-medium">{entry.suggestedTicker}</span>
                          <span className="ml-2 opacity-65">{entry.hermesSymbol}</span>
                        </span>
                        <span className="text-[10px] uppercase tracking-[0.18em] opacity-65">
                          {ASSET_CLASS_LABEL[entry.suggestedAssetClass]}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {catalogState.kind !== "loading" && query && filtered.length === 0 && (
              <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-55 mt-2">
                No matches in catalog
              </div>
            )}
          </Field>
        )}

        {/* Advanced: paste feed_id hex */}
        <Field label="">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-65 hover:opacity-100 hover:text-crimson transition-colors duration-300 ease-opta"
          >
            {advancedOpen ? "← Back to catalog search" : "Advanced — paste feed_id hex"}
          </button>
          {advancedOpen && (
            <div className="border border-rule-soft rounded-sm p-3 mt-2 space-y-2">
              <input
                type="text"
                value={pastedHex}
                onChange={(e) => setPastedHex(e.target.value)}
                placeholder="64-char hex (no 0x)"
                className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[12px] text-ink focus:outline-none focus:border-ink"
                spellCheck={false}
              />
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2, 3, 4].map((cls) => (
                  <button
                    key={cls}
                    type="button"
                    onClick={() => setPastedClass(cls)}
                    aria-pressed={pastedClass === cls}
                    className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
                      pastedClass === cls
                        ? "border-ink text-ink"
                        : "border-rule text-ink opacity-55 hover:opacity-100 hover:border-ink"
                    }`}
                  >
                    {ASSET_CLASS_LABEL[cls]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Field>

        {/* asset_name (editable, validated) */}
        {activeFeed && (
          <Field label="Asset name (on-chain identifier)">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={assetName}
                onChange={(e) => {
                  userEditedRef.current = true;
                  setAssetName(e.target.value.toUpperCase());
                }}
                placeholder="e.g. SOL"
                maxLength={16}
                className="flex-1 bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[13px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
              />
              <span
                className={`font-mono text-[12px] ${assetNameValid ? "text-emerald-700" : "text-crimson"}`}
                aria-label={assetNameValid ? "valid" : "invalid"}
              >
                {assetNameValid ? "✓" : "✕"}
              </span>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
              1-16 chars · A-Z, 0-9 only · Class:{" "}
              {ASSET_CLASS_LABEL[activeFeed.assetClass]}
            </div>
          </Field>
        )}

        {/* Side */}
        <Field label="Side">
          <div className="flex gap-2">
            <SideButton active={side === "call"} onClick={() => setSide("call")}>
              Call
            </SideButton>
            <SideButton active={side === "put"} onClick={() => setSide("put")}>
              Put
            </SideButton>
          </div>
        </Field>

        {/* Strike */}
        <Field label="Strike (USDC)">
          <input
            type="number"
            value={strikeStr}
            onChange={(e) => setStrikeStr(e.target.value)}
            placeholder="0.00"
            step="0.01"
            min="0"
            className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[14px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
          />
          {moneyness && (
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
              {moneyness}
            </div>
          )}
        </Field>

        {/* Expiry */}
        <Field label="Expiry">
          <div className="flex flex-wrap gap-2 mb-2">
            {EXPIRY_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setExpiryPreset(p.id)}
                aria-pressed={expiryPreset === p.id}
                className={`rounded-full border px-[14px] py-[6px] font-mono text-[10.5px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
                  expiryPreset === p.id
                    ? "border-crimson text-ink"
                    : "border-rule text-ink opacity-55 hover:opacity-100 hover:border-ink"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {expiryPreset === "CUSTOM" && (
            <input
              type="datetime-local"
              value={customExpiry}
              onChange={(e) => setCustomExpiry(e.target.value)}
              className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[13px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
            />
          )}
          {expiryUnix && (
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
              Settles {new Date(expiryUnix * 1000).toUTCString()}
            </div>
          )}
        </Field>

        <HairlineRule className="my-6" />

        {/* Spot + Premium preview */}
        <div className="border border-rule-soft rounded-sm p-4 mb-6 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
              Spot · Hermes
            </span>
            <span className="font-mono text-[14px] text-ink">
              {spot > 0 ? `$${spot.toLocaleString()}` : "—"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
              Indicative premium · B-S
            </span>
            <span className="font-mono text-[16px] text-ink">
              {premiumPreview != null ? `$${premiumPreview.toFixed(4)}` : "—"}
            </span>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full border border-rule px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-ink/65 hover:text-ink hover:border-ink transition-colors duration-300 ease-opta"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex-1 rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink disabled:hover:text-paper"
          >
            {submitting ? "Creating…" : "Create Market"}
          </button>
        </div>
      </div>
    </div>
  );
};

const Field: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="mb-5">
    {label && (
      <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
        {label}
      </div>
    )}
    {children}
  </div>
);

const SideButton: FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`flex-1 rounded-sm border py-2.5 font-mono text-[11.5px] uppercase tracking-[0.2em] transition-colors duration-300 ease-opta ${
      active
        ? "border-ink bg-ink text-paper"
        : "border-rule text-ink opacity-65 hover:opacity-100 hover:border-ink"
    }`}
  >
    <span className="inline-flex items-center gap-2 justify-center">
      <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
      {children}
    </span>
  </button>
);

function entriesFromState(state: CatalogState): CatalogEntry[] | null {
  if (state.kind === "fresh") return state.entries;
  if (state.kind === "stale") return state.entries;
  return null;
}

function computeExpiryUnix(preset: ExpiryPreset, customISO: string): number | null {
  if (preset === "CUSTOM") {
    if (!customISO) return null;
    const ts = Math.floor(new Date(customISO).getTime() / 1000);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (preset === "7D") return now + 7 * 86400;
  if (preset === "14D") return now + 14 * 86400;
  if (preset === "30D") return now + 30 * 86400;
  if (preset === "FRIDAY") return nextFridayUnix();
  return null;
}

function nextFridayUnix(): number {
  // Friday 16:00 UTC, mirroring scripts/seed-demo-fresh.ts conventions.
  const d = new Date();
  d.setUTCHours(16, 0, 0, 0);
  const day = d.getUTCDay(); // Sun=0, Fri=5
  let delta = (5 - day + 7) % 7;
  if (delta === 0 && d.getTime() <= Date.now()) delta = 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return Math.floor(d.getTime() / 1000);
}

function computeMoneyness(side: "call" | "put", spot: number, strike: number): string | null {
  if (spot <= 0 || strike <= 0) return null;
  const diff = (strike - spot) / spot;
  const absPct = Math.abs(diff * 100);
  if (absPct < 0.5) return "ATM";
  // For calls: strike > spot ⇒ OTM. For puts: strike < spot ⇒ OTM.
  const callOtm = side === "call" && strike > spot;
  const putOtm = side === "put" && strike < spot;
  const isOtm = callOtm || putOtm;
  return `${absPct.toFixed(1)}% ${isOtm ? "OTM" : "ITM"}`;
}

export default NewMarketModal;
