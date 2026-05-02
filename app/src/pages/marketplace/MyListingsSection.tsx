import type { FC } from "react";
import { SectionNumber } from "../../components/layout";
import { MarketplaceTable } from "./MarketplaceTable";
import type { ResaleListingRow } from "./useMarketplaceData";

type MyListingsSectionProps = {
  /** Rows pre-partitioned to the connected wallet's own listings by the parent. */
  rows: ResaleListingRow[];
  /** Called when a row's Cancel listing button is clicked. Parent fires useResaleCancelFlow.submit. */
  onCancelClick: (row: ResaleListingRow) => void;
  /** Row id (option-mint base58) currently being cancelled. Drives that row's button disabled state. */
  busyId: string | null;
};

/**
 * § 02 · My listings section.
 *
 * Shows the connected wallet's own active resale listings. No filters —
 * the table is small enough (one row per (mint, seller) on-chain
 * uniqueness guarantee, so per-wallet listings are bounded by the user's
 * own activity) that filtering adds no value. Cancel actions fire
 * inline via useResaleCancelFlow on the parent; busyId disables the row
 * currently in flight.
 *
 * The parent (MarketplacePage) gates this section's mount on wallet
 * connection (per OQ-D — hide entirely when disconnected). This
 * component assumes a connected wallet; it doesn't render a connect
 * prompt of its own.
 */
export const MyListingsSection: FC<MyListingsSectionProps> = ({
  rows,
  onCancelClick,
  busyId,
}) => {
  const totalContracts = rows.reduce((sum, r) => sum + r.qtyAvailable, 0);

  return (
    <section className="mt-16">
      <div className="flex items-baseline gap-4 mb-6 flex-wrap">
        <SectionNumber number="02" label="My listings" />
        <span className="font-mono text-[11.5px] uppercase tracking-[0.18em] opacity-55">
          {totalContracts} {totalContracts === 1 ? "contract listed" : "contracts listed"}
        </span>
      </div>

      <MarketplaceTable
        rows={rows}
        variant="mine"
        onAction={onCancelClick}
        busyId={busyId}
        emptyState={
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(15px,1.2vw,17px)] m-0">
              No active listings — list one from Portfolio.
            </p>
          </div>
        }
      />
    </section>
  );
};

export default MyListingsSection;
