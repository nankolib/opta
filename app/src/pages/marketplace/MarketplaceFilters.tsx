import type { FC } from "react";

export type SideFilter = "all" | "calls" | "puts";
export type AssetFilter = "SOL" | "BTC" | "ETH" | "ALTS";
export type StatusFilter = "expiring-7d";

export type FiltersState = {
  side: SideFilter;
  assets: Set<AssetFilter>;
  statuses: Set<StatusFilter>;
  search: string;
};

type MarketplaceFiltersProps = {
  state: FiltersState;
  onChange: (next: FiltersState) => void;
};

const SIDE_PILLS: ReadonlyArray<{ id: SideFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "calls", label: "Calls" },
  { id: "puts", label: "Puts" },
];

const ASSET_PILLS: ReadonlyArray<{ id: AssetFilter; label: string }> = [
  { id: "SOL", label: "SOL" },
  { id: "BTC", label: "BTC" },
  { id: "ETH", label: "ETH" },
  { id: "ALTS", label: "Alts" },
];

const STATUS_PILLS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: "expiring-7d", label: "Expiring < 7d" },
];

/**
 * Three-group filter row + search field for the marketplace section.
 *
 * Forked from markets/MarketFilters.tsx with the "Settled" status pill
 * removed — useMarketplaceData hides settled-vault listings client-side
 * (per OQ#6), so a Settled toggle would always be a no-op. Keeps Side /
 * Asset / "Expiring < 7d" / Search.
 *
 * Side is single-select; Asset and Status are multi-select. Empty
 * multi-select sets mean "no filter applied" so filters compose by
 * intersection across groups and union within. The Status group with a
 * single pill is intentional — keeps the API parameterised so future
 * status pills can be added without an API break.
 *
 * Search ⌘K affordance is decorative — focusing via click is the only
 * interaction wired (matches MarketFilters convention).
 */
export const MarketplaceFilters: FC<MarketplaceFiltersProps> = ({ state, onChange }) => {
  const setSide = (id: SideFilter) => onChange({ ...state, side: id });

  const toggleAsset = (id: AssetFilter) => {
    const next = new Set(state.assets);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...state, assets: next });
  };

  const toggleStatus = (id: StatusFilter) => {
    const next = new Set(state.statuses);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ ...state, statuses: next });
  };

  const setSearch = (value: string) => onChange({ ...state, search: value });

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4 mb-6">
      <FilterGroup label="Side">
        {SIDE_PILLS.map((p) => (
          <Pill key={p.id} active={state.side === p.id} onClick={() => setSide(p.id)}>
            {p.label}
          </Pill>
        ))}
      </FilterGroup>

      <Divider />

      <FilterGroup label="Asset">
        {ASSET_PILLS.map((p) => (
          <Pill
            key={p.id}
            active={state.assets.has(p.id)}
            onClick={() => toggleAsset(p.id)}
          >
            {p.label}
          </Pill>
        ))}
      </FilterGroup>

      <Divider />

      <FilterGroup label="Status">
        {STATUS_PILLS.map((p) => (
          <Pill
            key={p.id}
            active={state.statuses.has(p.id)}
            onClick={() => toggleStatus(p.id)}
          >
            {p.label}
          </Pill>
        ))}
      </FilterGroup>

      <div className="flex-1 min-w-[200px] flex justify-end">
        <SearchField value={state.search} onChange={setSearch} />
      </div>
    </div>
  );
};

const FilterGroup: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-2">
    <span className="font-mono text-[10px] uppercase tracking-[0.2em] opacity-50 mr-1">
      {label}
    </span>
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  </div>
);

const Divider: FC = () => (
  <span aria-hidden="true" className="hidden md:inline-block w-px h-5 bg-rule opacity-60" />
);

const Pill: FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-full border px-[14px] py-[6px] font-mono text-[10.5px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
      active
        ? "border-crimson text-ink"
        : "border-rule text-ink opacity-55 hover:opacity-100 hover:border-ink"
    }`}
  >
    {children}
  </button>
);

const SearchField: FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => (
  <label className="inline-flex items-center gap-2 border border-rule rounded-full pl-4 pr-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] focus-within:border-ink transition-colors duration-300 ease-opta">
    <span aria-hidden="true" className="opacity-55">Search</span>
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder=""
      className="bg-transparent outline-none border-0 w-32 md:w-44 text-ink placeholder:opacity-40 font-mono text-[11px] uppercase tracking-[0.18em]"
    />
    <span
      aria-hidden="true"
      className="opacity-50 border border-rule rounded-sm px-1.5 py-[1px] text-[9.5px] tracking-[0.2em]"
    >
      ⌘K
    </span>
  </label>
);

export default MarketplaceFilters;
