import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { showToast } from "../../components/Toast";
import { decodeError } from "../../utils/errorDecoder";
import { hexFromBytes, hexToBytes32 } from "../../utils/format";
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

const ASSET_CLASS_LABEL: Record<number, string> = {
  0: "Crypto",
  1: "Commodity",
  2: "Equity",
  3: "FX",
  4: "ETF",
};

// On-chain seed constants — must match Rust (programs/opta/src/state/).
//   MARKET_SEED   = b"market"        (programs/opta/src/state/market.rs:65)
//   PROTOCOL_SEED = b"protocol_v2"   (programs/opta/src/state/protocol.rs:48)
const MARKET_SEED = "market";
const PROTOCOL_SEED = "protocol_v2";

type CatalogState =
  | { kind: "loading" }
  | { kind: "fresh"; entries: CatalogEntry[] }
  | { kind: "stale"; entries: CatalogEntry[]; lastRefresh: number }
  | { kind: "failed"; error: string };

/**
 * Paper-aesthetic New Market modal.
 *
 * Stage P4c: markets are asset-only after Stage 2 — strike/expiry/side
 * live on Write Option, not here. The modal collects exactly three
 * things: (asset_name, pyth_feed_id, asset_class), then calls the
 * permissionless on-chain `create_market` instruction.
 *
 * Asset picker is driven by a live Hermes-Beta catalog (P4b). Submit
 * does a pre-check via getAccountInfo to detect collisions:
 *   - same feed_id    → succeed silently (idempotent — chain agrees)
 *   - different feed_id → friendly error, suggest different name or admin migrate
 *   - none yet         → submit the create_market RPC
 *
 * Esc and click-outside dismiss the modal.
 */
export const NewMarketModal: FC<NewMarketModalProps> = ({
  onClose,
  onCreated,
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

  // Load catalog on mount. React-18-canonical fetch-on-mount: rely on
  // the per-mount `cancelled` flag to suppress stale-mount setter calls.
  // A useRef-based "run once" guard would persist across StrictMode's
  // double-mount and break the cancellation contract — see the failure
  // mode hunted down in the P4c smoke session.
  useEffect(() => {
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

  const assetNameValid = /^[A-Z0-9]{1,16}$/.test(assetName);

  const canSubmit =
    !submitting &&
    !!program &&
    !!provider &&
    !!publicKey &&
    !!activeFeed &&
    assetNameValid;

  const handleSubmit = async () => {
    if (!canSubmit || !program || !provider || !publicKey || !activeFeed) return;
    setSubmitting(true);
    try {
      let feedIdBytes: number[];
      try {
        feedIdBytes = hexToBytes32(activeFeed.feedIdHex);
      } catch (err: any) {
        showToast({
          type: "error",
          title: "Invalid feed_id",
          message: err?.message ?? "feed_id must be 64-char hex",
        });
        return;
      }

      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
        program.programId,
      );
      const [protocolStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from(PROTOCOL_SEED)],
        program.programId,
      );

      // Pre-submit collision check. Avoids burning rent + RPC on a known
      // bad call when the asset name is already taken with a different
      // feed_id, and lets us offer a friendlier message than the chain's
      // raw AssetMismatch error.
      const existing = await program.provider.connection.getAccountInfo(marketPda);
      if (existing) {
        const decoded = program.coder.accounts.decode<{
          assetName: string;
          pythFeedId: number[];
          assetClass: number;
        }>("optionsMarket", existing.data);
        const existingHex = hexFromBytes(decoded.pythFeedId);
        if (existingHex === activeFeed.feedIdHex) {
          showToast({
            type: "success",
            title: "Market already exists",
            message: `${assetName} is already registered with this feed_id.`,
          });
          onCreated();
          onClose();
          return;
        }
        showToast({
          type: "error",
          title: "Asset name taken",
          message: `An asset named "${assetName}" already exists with a different feed_id. Pick a different name or contact admin to migrate.`,
        });
        return;
      }

      const tx = await program.methods
        .createMarket(assetName, feedIdBytes, activeFeed.assetClass)
        .accountsStrict({
          creator: publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      showToast({
        type: "success",
        title: "Market created",
        message: `${assetName} registered on-chain`,
        txSignature: tx,
      });
      onCreated();
      onClose();
    } catch (err: any) {
      const decoded = decodeError(err);
      // Race condition: another tx grabbed the PDA between our pre-check
      // and the RPC. Surface the same friendly text the pre-check would.
      if (typeof decoded === "string" && decoded.includes("AssetMismatch")) {
        showToast({
          type: "error",
          title: "Asset name taken",
          message: `An asset named "${assetName}" already exists with a different feed_id. Pick a different name or contact admin to migrate.`,
        });
      } else {
        showToast({
          type: "error",
          title: "Create market failed",
          message: decoded,
        });
      }
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

function entriesFromState(state: CatalogState): CatalogEntry[] | null {
  if (state.kind === "fresh") return state.entries;
  if (state.kind === "stale") return state.entries;
  return null;
}

export default NewMarketModal;
