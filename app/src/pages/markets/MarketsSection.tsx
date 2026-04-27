import type { FC } from "react";
import { useMemo, useState } from "react";
import { SectionNumber } from "../../components/layout";
import { MarketFilters, type FiltersState } from "./MarketFilters";
import { MarketsTable } from "./MarketsTable";
import type { MarketRow } from "./useMarketsData";

type MarketsSectionProps = {
  rows: MarketRow[];
};

/**
 * § 01 · All markets section.
 *
 * Owns the filter state (side / asset / status / search). Derives the
 * visible row subset by intersecting filter groups and unioning pills
 * within a group. Sort: asset asc, then strike asc.
 */
export const MarketsSection: FC<MarketsSectionProps> = ({ rows }) => {
  const [filters, setFilters] = useState<FiltersState>({
    side: "all",
    assets: new Set(),
    statuses: new Set(),
    search: "",
  });

  const visible = useMemo(() => filterRows(rows, filters), [rows, filters]);

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="flex items-baseline gap-4">
          <SectionNumber number="01" label="All markets" />
          <span className="font-mono text-[11.5px] uppercase tracking-[0.18em] opacity-55">
            Showing {visible.length} of {rows.length}
          </span>
        </div>
      </div>

      <MarketFilters state={filters} onChange={setFilters} />

      <MarketsTable
        rows={visible}
        emptyState={
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(15px,1.2vw,17px)] m-0">
              {rows.length === 0
                ? "No markets yet."
                : "No markets match the current filters."}
            </p>
          </div>
        }
      />
    </section>
  );
};

function filterRows(rows: MarketRow[], f: FiltersState): MarketRow[] {
  const named = new Set(["SOL", "BTC", "ETH"]);
  const now = Date.now() / 1000;

  let result = rows;

  if (f.side !== "all") {
    result = result.filter((r) => (f.side === "calls" ? r.side === "call" : r.side === "put"));
  }

  if (f.assets.size > 0) {
    result = result.filter((r) => {
      if (f.assets.has("SOL") && r.asset === "SOL") return true;
      if (f.assets.has("BTC") && r.asset === "BTC") return true;
      if (f.assets.has("ETH") && r.asset === "ETH") return true;
      if (f.assets.has("ALTS") && !named.has(r.asset)) return true;
      return false;
    });
  }

  if (f.statuses.size > 0) {
    result = result.filter((r) => {
      if (f.statuses.has("settled") && r.status === "settled") return true;
      if (f.statuses.has("expiring-7d") && r.status === "open") {
        const days = (r.expiry - now) / 86400;
        if (days < 7) return true;
      }
      return false;
    });
  }

  const q = f.search.trim().toUpperCase();
  if (q) {
    result = result.filter((r) => r.asset.toUpperCase().includes(q));
  }

  return [...result].sort((a, b) => {
    if (a.asset !== b.asset) return a.asset.localeCompare(b.asset);
    return a.strike - b.strike;
  });
}

export default MarketsSection;
