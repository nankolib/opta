import type { FC } from "react";
import { useMemo, useState } from "react";
import { SectionNumber } from "../../components/layout";
import { PositionsTable } from "./PositionsTable";
import { FilterPills, type FilterId } from "./FilterPills";
import type { Position, PositionAction } from "./positions";

type OpenPositionsSectionProps = {
  /** Positions already pre-filtered to "open" by the parent. */
  positions: Position[];
  onAction: (p: Position, action: PositionAction) => void;
  busyId: string | null;
};

/**
 * § 01 · Open positions section.
 *
 * Renders the section eyebrow + count, the filter pill row, and the
 * PositionsTable for the positions that match the current filter.
 *
 * Filter state is local — the parent passes ALL open positions; this
 * component derives the visible subset via matchesFilter(). Parent
 * doesn't need to know the filter exists.
 */
export const OpenPositionsSection: FC<OpenPositionsSectionProps> = ({
  positions,
  onAction,
  busyId,
}) => {
  const [filter, setFilter] = useState<FilterId>("all");

  const filtered = useMemo(
    () => positions.filter((p) => matchesFilter(p, filter)),
    [positions, filter],
  );

  const count = positions.length;

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="flex items-baseline gap-4">
          <SectionNumber number="01" label="Open positions" />
          <span className="font-mono text-[11.5px] uppercase tracking-[0.18em] opacity-55">
            {count} {count === 1 ? "contract" : "contracts"}
          </span>
        </div>
        <FilterPills active={filter} onChange={setFilter} />
      </div>

      <PositionsTable
        positions={filtered}
        onAction={onAction}
        busyId={busyId}
        emptyState={
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(15px,1.2vw,17px)] m-0">
              {count === 0
                ? "No open positions yet."
                : `No positions match "${filterLabel(filter)}".`}
            </p>
          </div>
        }
      />
    </section>
  );
};

function matchesFilter(p: Position, filter: FilterId): boolean {
  if (filter === "all") return true;
  if (filter === "calls") return p.side === "call";
  if (filter === "puts") return p.side === "put";
  if (filter === "expiring-7d") {
    if (p.state !== "active") return false;
    const days = (p.expiry - Date.now() / 1000) / 86400;
    return days < 7;
  }
  return true;
}

function filterLabel(id: FilterId): string {
  switch (id) {
    case "calls":
      return "Calls";
    case "puts":
      return "Puts";
    case "expiring-7d":
      return "Expiring < 7d";
    default:
      return "All";
  }
}

export default OpenPositionsSection;
