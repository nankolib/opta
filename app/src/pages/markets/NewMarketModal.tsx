import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
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

type NewMarketModalProps = {
  onClose: () => void;
  onCreated: () => void;
};

type SupportedAsset = {
  ticker: "SOL" | "BTC" | "ETH" | "XAU" | "AAPL";
  fullName: string;
  pythFeed: PublicKey;
  /** 0 = crypto, 1 = commodity, 2 = equity */
  assetClass: number;
};

// Devnet Pyth pull-oracle pubkeys, mirrored from scripts/seed-demo-fresh.ts.
// These are the only 5 assets with known oracle accounts wired to the
// deployed program — free-form pubkey entry is intentionally dropped in
// favour of a curated dropdown for the polished demo.
const SUPPORTED_ASSETS: SupportedAsset[] = [
  {
    ticker: "SOL",
    fullName: "Solana",
    pythFeed: new PublicKey("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"),
    assetClass: 0,
  },
  {
    ticker: "BTC",
    fullName: "Bitcoin",
    pythFeed: new PublicKey("HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J"),
    assetClass: 0,
  },
  {
    ticker: "ETH",
    fullName: "Ethereum",
    pythFeed: new PublicKey("EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9GvYRk4HY7y44"),
    assetClass: 0,
  },
  {
    ticker: "XAU",
    fullName: "Gold",
    pythFeed: new PublicKey("8y3WWjvmSmVGWVKH1rCA7VTRmuU7QbJ9axMK6JUUuCyi"),
    assetClass: 1,
  },
  {
    ticker: "AAPL",
    fullName: "Apple",
    pythFeed: new PublicKey("5yKHAuiDWKUGRgs3s6mYGdfZjFmTfgHVDBwFBDfMuZJH"),
    assetClass: 2,
  },
];

type ExpiryPreset = "7D" | "14D" | "30D" | "FRIDAY" | "CUSTOM";

const EXPIRY_PRESETS: ReadonlyArray<{ id: ExpiryPreset; label: string }> = [
  { id: "7D", label: "7D" },
  { id: "14D", label: "14D" },
  { id: "30D", label: "30D" },
  { id: "FRIDAY", label: "Next Fri" },
  { id: "CUSTOM", label: "Custom" },
];

/**
 * Paper-aesthetic New Market modal.
 *
 * Creates a markets PDA via the permissionless `create_market`
 * instruction. Inputs: asset (5-asset dropdown), side (call/put),
 * strike (with live moneyness hint), expiry (preset pills + datetime
 * picker on Custom), and a live B-S premium preview that updates as
 * the user fills in fields.
 *
 * Esc and click-outside dismiss the modal.
 */
export const NewMarketModal: FC<NewMarketModalProps> = ({ onClose, onCreated: _onCreated }) => {
  const { program, provider } = useProgram();
  const { publicKey } = useWallet();

  const [asset, setAsset] = useState<SupportedAsset>(SUPPORTED_ASSETS[0]);
  const [side, setSide] = useState<"call" | "put">("call");
  const [strikeStr, setStrikeStr] = useState("");
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>("7D");
  const [customExpiry, setCustomExpiry] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { prices } = usePythPrices([asset.ticker]);
  const spot = prices[asset.ticker] ?? 0;

  // Esc to dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const expiryUnix = useMemo(() => computeExpiryUnix(expiryPreset, customExpiry), [
    expiryPreset,
    customExpiry,
  ]);

  const strike = parseFloat(strikeStr) || 0;
  const moneyness = useMemo(() => computeMoneyness(side, spot, strike), [side, spot, strike]);

  const premiumPreview = useMemo(() => {
    if (!expiryUnix || strike <= 0 || spot <= 0) return null;
    const days = Math.max(0, (expiryUnix - Date.now() / 1000) / 86400);
    if (days <= 0) return null;
    const baseVol = getDefaultVolatility(asset.ticker);
    const vol = applyVolSmile(baseVol, spot, strike, asset.ticker);
    return side === "call"
      ? calculateCallPremium(spot, strike, days, vol)
      : calculatePutPremium(spot, strike, days, vol);
  }, [asset.ticker, side, spot, strike, expiryUnix]);

  const canSubmit =
    !submitting &&
    !!program &&
    !!provider &&
    !!publicKey &&
    strike > 0 &&
    !!expiryUnix &&
    expiryUnix > Date.now() / 1000;

  const handleSubmit = async () => {
    if (!program || !provider || !publicKey || !expiryUnix) return;
    if (strike <= 0) {
      showToast({ type: "error", title: "Strike must be positive" });
      return;
    }

    setSubmitting(true);
    try {
      // P4a stub: createMarket signature changed in stage P1 (now 3 args:
      // assetName, pythFeedId [u8;32], assetClass). Hardcoded SUPPORTED_ASSETS
      // table holds legacy push-oracle pubkeys. Full rewrite lands in P4c.
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

        {/* Asset */}
        <Field label="Asset">
          <div className="grid grid-cols-5 gap-2">
            {SUPPORTED_ASSETS.map((a) => (
              <button
                key={a.ticker}
                type="button"
                onClick={() => setAsset(a)}
                aria-pressed={asset.ticker === a.ticker}
                className={`rounded-sm border py-2 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
                  asset.ticker === a.ticker
                    ? "border-ink bg-ink text-paper"
                    : "border-rule text-ink opacity-65 hover:opacity-100 hover:border-ink"
                }`}
              >
                {a.ticker}
              </button>
            ))}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-2">
            {asset.fullName} · spot {spot > 0 ? `$${spot.toLocaleString()}` : "—"}
          </div>
        </Field>

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

        {/* Premium preview */}
        <div className="border border-rule-soft rounded-sm p-4 mb-6 flex items-center justify-between">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
            Indicative premium · B-S
          </span>
          <span className="font-mono text-[16px] text-ink">
            {premiumPreview != null ? `$${premiumPreview.toFixed(4)}` : "—"}
          </span>
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
    <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
      {label}
    </div>
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
