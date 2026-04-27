import type { FC } from "react";

export type FilterId = "all" | "calls" | "puts" | "expiring-7d";

const PILLS: ReadonlyArray<{ id: FilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "calls", label: "Calls" },
  { id: "puts", label: "Puts" },
  { id: "expiring-7d", label: "Expiring < 7d" },
];

type FilterPillsProps = {
  active: FilterId;
  onChange: (id: FilterId) => void;
};

/**
 * Single-select filter pill cluster for the open-positions table.
 *
 * Active pill renders with a 1px crimson outline + full-opacity ink;
 * inactive pills are muted to ~55% and warm to full ink on hover.
 * Click any pill to switch — ALL is the reset state.
 *
 * Filtering logic itself lives in OpenPositionsSection; this
 * component is purely presentational.
 */
export const FilterPills: FC<FilterPillsProps> = ({ active, onChange }) => (
  <div
    role="group"
    aria-label="Filter positions"
    className="inline-flex flex-wrap items-center gap-2"
  >
    {PILLS.map((pill) => {
      const isActive = pill.id === active;
      return (
        <button
          key={pill.id}
          type="button"
          onClick={() => onChange(pill.id)}
          aria-pressed={isActive}
          className={`rounded-full border px-[14px] py-[6px] font-mono text-[10.5px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
            isActive
              ? "border-crimson text-ink"
              : "border-rule text-ink opacity-55 hover:opacity-100 hover:border-ink"
          }`}
        >
          {pill.label}
        </button>
      );
    })}
  </div>
);

export default FilterPills;
