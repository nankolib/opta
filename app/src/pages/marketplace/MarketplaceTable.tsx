import type { FC, ReactNode } from "react";
import { MoneyAmount } from "../../components/MoneyAmount";
import { truncateAddress } from "../../utils/format";
import type { ResaleListingRow } from "./useMarketplaceData";

const ASSET_FULL_NAME: Record<string, string> = {
  SOL: "Solana",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  AAPL: "Apple",
  XAU: "Gold",
  XAG: "Silver",
  WTI: "Crude Oil",
  TSLA: "Tesla",
  NVDA: "Nvidia",
};

export type MarketplaceTableVariant = "buyable" | "mine";

type MarketplaceTableProps = {
  rows: ResaleListingRow[];
  variant: MarketplaceTableVariant;
  /** Called when the row's action button is clicked (Buy → or Cancel listing). */
  onAction: (row: ResaleListingRow) => void;
  /**
   * Row id (option-mint base58) currently in-flight; that row's button
   * disables. Used by the "mine" variant to surface cancel-in-progress;
   * "buyable" passes undefined since buy submission lives in the modal.
   */
  busyId?: string | null;
  /** Render this when rows is empty. */
  emptyState?: ReactNode;
};

/**
 * Display-only marketplace table. Two variants:
 *   - "buyable": shows others' listings with fair-value comparison +
 *     discount/premium pill + seller pubkey + Buy button. Discount/
 *     premium is colour-coded vs the B-S fair value derived inside
 *     useMarketplaceData (null when Pyth feed didn't resolve).
 *   - "mine": shows the connected wallet's own listings with a Cancel
 *     listing button. busyId disables the row currently being cancelled.
 *
 * Both variants share asset / side / strike / expiry / qty /
 * price-per-contract / total-ask / created columns. All display fields
 * come pre-derived from ResaleListingRow — no computation here beyond
 * formatting. Mobile: overflow-x-auto wrapper lets the wide table scroll
 * horizontally rather than blowing out the reading column.
 */
export const MarketplaceTable: FC<MarketplaceTableProps> = ({
  rows,
  variant,
  onAction,
  busyId,
  emptyState,
}) => {
  if (rows.length === 0 && emptyState !== undefined) {
    return <>{emptyState}</>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-rule">
            <Th>Asset</Th>
            <Th>Side</Th>
            <Th>Strike</Th>
            <Th>Expiry</Th>
            <Th>Qty</Th>
            <Th>Ask / contract</Th>
            <Th>Total ask</Th>
            <Th>Created</Th>
            {variant === "buyable" && (
              <>
                <Th>Fair value</Th>
                <Th>Disc / Prem</Th>
                <Th>Seller</Th>
              </>
            )}
            <Th>{""}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row
              key={row.listing.publicKey.toBase58()}
              row={row}
              variant={variant}
              onAction={onAction}
              isBusy={
                !!busyId &&
                busyId === (row.vaultMint.account.optionMint as { toBase58: () => string }).toBase58()
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Th: FC<{ children: ReactNode }> = ({ children }) => (
  <th className="text-left font-mono text-[10.5px] uppercase tracking-[0.18em] py-3 pr-4 opacity-60 align-bottom whitespace-nowrap">
    {children}
  </th>
);

const Row: FC<{
  row: ResaleListingRow;
  variant: MarketplaceTableVariant;
  onAction: (row: ResaleListingRow) => void;
  isBusy: boolean;
}> = ({ row, variant, onAction, isBusy }) => {
  const fullName = ASSET_FULL_NAME[row.asset];
  const totalAsk = row.pricePerContract * row.qtyAvailable;
  const createdRaw = row.listing.account.createdAt;
  const createdAt =
    typeof createdRaw === "number" ? createdRaw : (createdRaw?.toNumber?.() ?? Number(createdRaw));

  return (
    <tr className="border-b border-rule-soft align-middle">
      {/* Asset */}
      <td className="py-4 pr-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-paper-2 font-mono text-[13px] uppercase"
          >
            {row.asset.charAt(0) || "?"}
          </span>
          <div>
            <div className="font-fraunces-text italic text-[15px] leading-tight text-ink">
              {row.asset || "Unknown"}
            </div>
            {fullName && (
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-50">
                {fullName}
              </div>
            )}
          </div>
        </div>
      </td>

      {/* Side */}
      <td className="py-4 pr-4">
        <span className="inline-flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-[0.18em]">
          <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
          {row.optionType}
        </span>
      </td>

      {/* Strike */}
      <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">
        ${row.strike.toFixed(2)}
      </td>

      {/* Expiry */}
      <td className="py-4 pr-4 whitespace-nowrap">
        <div className="font-mono text-[13px]">{formatTableDate(row.expiry)}</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-55 mt-0.5">
          {formatCountdown(row.expiry)}
        </div>
      </td>

      {/* Qty */}
      <td className="py-4 pr-4 font-mono text-[13px]">
        {row.qtyAvailable.toLocaleString()}
      </td>

      {/* Ask / contract */}
      <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">
        <MoneyAmount value={row.pricePerContract} />
      </td>

      {/* Total ask */}
      <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">
        <MoneyAmount value={totalAsk} />
      </td>

      {/* Created */}
      <td className="py-4 pr-4 whitespace-nowrap">
        <div className="font-mono text-[13px]">{formatTableDate(createdAt)}</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-55 mt-0.5">
          {formatRelative(createdAt)}
        </div>
      </td>

      {variant === "buyable" && (
        <>
          {/* Fair value */}
          <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">
            {row.pricePerContractFairValue != null ? (
              <MoneyAmount value={row.pricePerContractFairValue} />
            ) : (
              <span className="opacity-40">—</span>
            )}
          </td>

          {/* Disc / Prem */}
          <td className="py-4 pr-4 whitespace-nowrap">
            <DiscountPill premiumPct={row.premiumPct} />
          </td>

          {/* Seller */}
          <td className="py-4 pr-4 font-mono text-[12px] whitespace-nowrap opacity-75">
            {truncateAddress(row.seller.toBase58())}
          </td>
        </>
      )}

      {/* Action */}
      <td className="py-4">
        <button
          type="button"
          onClick={() => onAction(row)}
          disabled={isBusy}
          className={`inline-flex items-center gap-2 rounded-full border px-[14px] py-[7px] font-mono text-[10.5px] uppercase tracking-[0.18em] no-underline transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${actionStyle(variant)}`}
        >
          {isBusy ? "…" : actionLabel(variant)}
          {!isBusy && variant === "buyable" && <span aria-hidden="true">→</span>}
        </button>
      </td>
    </tr>
  );
};

const DiscountPill: FC<{ premiumPct: number | null }> = ({ premiumPct }) => {
  if (premiumPct == null) {
    return <span className="opacity-40 font-mono text-[12px]">—</span>;
  }
  const sign = premiumPct > 0 ? "+" : "";
  // Negative premiumPct = discount (ask below fair) = green; positive = premium = red.
  // 0.5% deadband around zero rendered as muted ink (avoids jittery colour for tiny diffs).
  const colorClass =
    premiumPct < -0.5 ? "text-emerald-700" : premiumPct > 0.5 ? "text-crimson" : "text-ink/70";
  return (
    <span className={`font-mono text-[12px] ${colorClass}`}>
      {sign}
      {premiumPct.toFixed(1)}%
    </span>
  );
};

function actionLabel(variant: MarketplaceTableVariant): string {
  return variant === "buyable" ? "Buy" : "Cancel listing";
}

function actionStyle(variant: MarketplaceTableVariant): string {
  return variant === "buyable"
    ? "border-ink bg-ink text-paper hover:bg-transparent hover:text-ink"
    : "border-rule text-ink/70 hover:border-ink hover:text-ink";
}

function formatTableDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatCountdown(unix: number): string {
  const now = Date.now() / 1000;
  const diff = unix - now;
  if (diff <= 0) return "Expired";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  if (days === 0) return `${hours}H`;
  return `${days}D ${hours}H`;
}

function formatRelative(unix: number): string {
  const now = Date.now() / 1000;
  const diff = now - unix;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}M ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}H ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}D ago`;
  return `${Math.floor(diff / (86400 * 30))}MO ago`;
}

export default MarketplaceTable;
