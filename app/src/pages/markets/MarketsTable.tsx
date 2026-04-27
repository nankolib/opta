import type { FC, ReactNode } from "react";
import { Link } from "react-router-dom";
import { MoneyAmount } from "../../components/MoneyAmount";
import type { MarketRow } from "./useMarketsData";

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

type MarketsTableProps = {
  rows: MarketRow[];
  emptyState?: ReactNode;
};

/**
 * Display-only markets table. Mirrors PositionsTable's hairline
 * rhythm — letter chip + italic Fraunces ticker, mono numerals,
 * crimson dot on side cell, status pill on the right.
 *
 * Settled and expired rows render at lower visual weight via a
 * row-level opacity-70; the Trade button is hidden entirely on
 * non-OPEN rows so the action column simply collapses for them.
 */
export const MarketsTable: FC<MarketsTableProps> = ({ rows, emptyState }) => {
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
            <Th>Spot</Th>
            <Th>IV</Th>
            <Th>Open Interest</Th>
            <Th>Vault TVL</Th>
            <Th>Status</Th>
            <Th>{""}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <MarketRowEl key={r.publicKey.toBase58()} row={r} />
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

const MarketRowEl: FC<{ row: MarketRow }> = ({ row: r }) => {
  const fullName = ASSET_FULL_NAME[r.asset];
  const isOpen = r.status === "open";
  const rowOpacity = isOpen ? "" : "opacity-70";
  const tradeHref = `/trade?market=${r.publicKey.toBase58()}&asset=${encodeURIComponent(r.asset)}&strike=${r.strike}&type=${r.side}&expiry=${r.expiry}`;

  return (
    <tr className={`border-b border-rule-soft align-middle ${rowOpacity}`}>
      {/* Asset */}
      <td className="py-4 pr-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-paper-2 font-mono text-[13px] uppercase"
          >
            {r.asset.charAt(0) || "?"}
          </span>
          <div>
            <div className="font-fraunces-text italic text-[15px] leading-tight text-ink">
              {r.asset || "Unknown"}
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
          {r.side}
        </span>
      </td>

      {/* Strike */}
      <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">
        ${r.strike.toFixed(2)}
      </td>

      {/* Expiry — date + countdown */}
      <td className="py-4 pr-4 whitespace-nowrap">
        <div className="font-mono text-[13px]">{formatTableDate(r.expiry)}</div>
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-55 mt-0.5">
          {formatCountdown(r.expiry)}
        </div>
      </td>

      {/* Spot */}
      <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">
        {r.spot != null ? <MoneyAmount value={r.spot} /> : "—"}
      </td>

      {/* IV */}
      <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">
        {r.iv != null ? `${(r.iv * 100).toFixed(1)}%` : "—"}
      </td>

      {/* Open Interest */}
      <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">
        {r.openInterest > 0 ? r.openInterest.toLocaleString() : "—"}
      </td>

      {/* Vault TVL */}
      <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">
        {r.vaultTvl != null ? <MoneyAmount value={r.vaultTvl} /> : "—"}
      </td>

      {/* Status */}
      <td className="py-4 pr-4">
        <StatusPill status={r.status} />
      </td>

      {/* Trade — hidden on non-OPEN rows */}
      <td className="py-4">
        {isOpen && (
          <Link
            to={tradeHref}
            className="inline-flex items-center gap-2 rounded-full border border-ink bg-ink text-paper px-[14px] py-[7px] font-mono text-[10.5px] uppercase tracking-[0.18em] no-underline transition-colors duration-300 ease-opta hover:bg-transparent hover:text-ink whitespace-nowrap"
          >
            Trade
            <span aria-hidden="true">→</span>
          </Link>
        )}
      </td>
    </tr>
  );
};

const StatusPill: FC<{ status: MarketRow["status"] }> = ({ status }) => {
  const label = status === "open" ? "Open" : status === "settled" ? "Settled" : "Expired";
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] whitespace-nowrap">
      <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
      {label}
    </span>
  );
};

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

export default MarketsTable;
