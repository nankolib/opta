import type { FC } from "react";
import { useMemo, useState } from "react";
import { SectionNumber } from "../../components/layout";
import { MarketplaceFilters, type FiltersState } from "./MarketplaceFilters";
import { MarketplaceTable } from "./MarketplaceTable";
import type { ResaleListingRow } from "./useMarketplaceData";

type BuyableListingsSectionProps = {
  /** Rows pre-partitioned to buyable (seller !== connected wallet) by the parent. */
  rows: ResaleListingRow[];
  /**
   * Marketplace-wide listing count BEFORE the settled/expired hook filter
   * AND before the page-level partition. Used in the empty-state copy to
   * differentiate "no listings exist on-chain" from "all current listings
   * are yours / settled / expired" (so the user sees the right call to
   * action — write a contract, vs. wait/connect a different wallet).
   */
  totalCount: number;
  /** Called when a buyable row's Buy → button is clicked. Parent opens BuyListingModal. */
  onBuyClick: (row: ResaleListingRow) => void;
};

const DAY = 86400;

/**
 * § 01 · Open listings section.
 *
 * Owns filter state (side / asset / status / search). Filter logic lives
 * in a single useMemo that intersects across groups and unions within
 * (matches MarketsSection convention). Sort is fixed to expiry-asc from
 * useMarketplaceData (per OQ#9 — Hermes-fail-safe); a sort selector is
 * deferred to a future enhancement.
 *
 * The "{N} contracts" header label sums qtyAvailable across all buyable
 * rows (not visible) — so the user always sees how many contracts exist
 * to potentially buy, regardless of how filters narrow the visible set.
 * The "Showing X of Y" sublabel only appears when filters are actively
 * narrowing (visible.length !== rows.length) to avoid redundancy.
 *
 * Search matches case-insensitive substrings against the row's asset
 * name AND the seller pubkey base58 — so users can paste a seller
 * address to find their listings, or type "SOL" to narrow by asset.
 */
export const BuyableListingsSection: FC<BuyableListingsSectionProps> = ({
  rows,
  totalCount,
  onBuyClick,
}) => {
  const [filters, setFilters] = useState<FiltersState>({
    side: "all",
    assets: new Set(),
    statuses: new Set(),
    search: "",
  });

  const visible = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const totalContracts = useMemo(
    () => rows.reduce((sum, r) => sum + r.qtyAvailable, 0),
    [rows],
  );

  const fullyEmptyMessage =
    totalCount === 0
      ? "No marketplace listings yet — write some contracts on Write to seed the secondary market."
      : "No buyable listings right now — you own everything currently on the market.";
  const filteredEmptyMessage = "No listings match your filters.";

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="flex items-baseline gap-4 flex-wrap">
          <SectionNumber number="01" label="Open listings" />
          <span className="font-mono text-[11.5px] uppercase tracking-[0.18em] opacity-55">
            {totalContracts} {totalContracts === 1 ? "contract" : "contracts"}
          </span>
          {rows.length > 0 && visible.length !== rows.length && (
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] opacity-40">
              Showing {visible.length} of {rows.length}
            </span>
          )}
        </div>
      </div>

      <MarketplaceFilters state={filters} onChange={setFilters} />

      <MarketplaceTable
        rows={visible}
        variant="buyable"
        onAction={onBuyClick}
        emptyState={
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(15px,1.2vw,17px)] m-0">
              {rows.length === 0 ? fullyEmptyMessage : filteredEmptyMessage}
            </p>
          </div>
        }
      />
    </section>
  );
};

/**
 * Filter buyable rows against the active filter state. Empty multi-select
 * Sets mean "no filter applied" → all rows pass. Filters compose by
 * intersection across groups.
 */
function filterRows(rows: ResaleListingRow[], f: FiltersState): ResaleListingRow[] {
  const named = new Set(["SOL", "BTC", "ETH"]);
  const now = Date.now() / 1000;

  let result = rows;

  if (f.side !== "all") {
    result = result.filter((r) =>
      f.side === "calls" ? r.optionType === "call" : r.optionType === "put",
    );
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

  if (f.statuses.has("expiring-7d")) {
    result = result.filter((r) => {
      const days = (r.expiry - now) / DAY;
      return days < 7;
    });
  }

  const q = f.search.trim().toLowerCase();
  if (q) {
    result = result.filter((r) => {
      const asset = r.asset.toLowerCase();
      const seller = r.seller.toBase58().toLowerCase();
      return asset.includes(q) || seller.includes(q);
    });
  }

  return result;
}

export default BuyableListingsSection;
