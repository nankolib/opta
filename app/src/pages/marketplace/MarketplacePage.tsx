import type { FC } from "react";
import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePaperPalette } from "../../hooks";
import { PaperGrain } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { MoneyAmount } from "../../components/MoneyAmount";
import { showToast } from "../../components/Toast";
import { SummaryBand, type SummaryCell } from "../portfolio/SummaryBand";
import { MarketplaceStatementHeader, type Denomination } from "./MarketplaceStatementHeader";
import { BuyableListingsSection } from "./BuyableListingsSection";
import { MyListingsSection } from "./MyListingsSection";
import { BuyListingModal } from "./BuyListingModal";
import { useMarketplaceData, type ResaleListingRow } from "./useMarketplaceData";
import { useResaleCancelFlow } from "./useResaleCancelFlow";

/**
 * MarketplacePage — V2 secondary listing browse + buy + cancel surface.
 *
 * Composition mirrors MarketsPage / PortfolioPage: paper palette shell,
 * AppNav, statement header, 4-cell summary band, two numbered sections,
 * and an on-demand modal at the bottom.
 *
 * Two sections (per OQ#2 lock — buyable / mine split):
 *   § 01 · Open listings — others' active listings, filterable, Buy →
 *   § 02 · My listings — connected wallet's own listings, inline Cancel
 *
 * § 02 is mounted only when wallet is connected (per OQ-D). Browse-as-
 * guest works in § 01 — table renders, but Buy → swaps to Connect Wallet
 * inside the modal.
 *
 * A single useMarketplaceData() instance is the source of truth for rows;
 * page-level useMemos partition into buyable vs mine. useResaleCancelFlow
 * is page-scoped because cancel actions live on row buttons (no modal).
 * useResaleBuyFlow is modal-scoped (instantiated inside BuyListingModal).
 */
export const MarketplacePage: FC = () => {
  usePaperPalette();
  const { publicKey, connected } = useWallet();
  const { rows, totalCount, loading, spotPrices, refetch } = useMarketplaceData();
  const cancelFlow = useResaleCancelFlow();

  const [denomination, setDenomination] = useState<Denomination>("USDC");
  const [buyTarget, setBuyTarget] = useState<ResaleListingRow | null>(null);

  const monthLabel = useMemo(
    () => new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    [],
  );
  const timestampLabel = useMemo(() => {
    const now = new Date();
    const datePart = now.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const timePart = now.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
    return `${datePart} · ${timePart} UTC`;
  }, []);

  // Partition rows into buyable (others') vs mine (own listings). When
  // disconnected, EVERYTHING is buyable (no own listings to extract).
  const buyableRows = useMemo(
    () => rows.filter((r) => !publicKey || !r.seller.equals(publicKey)),
    [rows, publicKey],
  );
  const myRows = useMemo(
    () => (publicKey ? rows.filter((r) => r.seller.equals(publicKey)) : []),
    [rows, publicKey],
  );

  // Median premiumPct across buyable rows where Pyth feed resolved. Sorted
  // ascending; midpoint average for even counts.
  const medianDiscount = useMemo(() => {
    const valid = buyableRows
      .map((r) => r.premiumPct)
      .filter((p): p is number => p != null)
      .sort((a, b) => a - b);
    if (valid.length === 0) return null;
    const mid = Math.floor(valid.length / 2);
    return valid.length % 2 === 1
      ? valid[mid]
      : (valid[mid - 1] + valid[mid]) / 2;
  }, [buyableRows]);

  const totalNotional = useMemo(
    () => buyableRows.reduce((sum, r) => sum + r.qtyAvailable * r.pricePerContract, 0),
    [buyableRows],
  );

  const cells: [SummaryCell, SummaryCell, SummaryCell, SummaryCell] = [
    {
      label: "Open Listings",
      value: loading ? "—" : buyableRows.length.toString(),
      sub: "Available to buy",
    },
    {
      label: "Total Notional",
      value: loading ? "—" : <MoneyAmount value={totalNotional} />,
      sub: "USDC · Across listings",
    },
    {
      label: "Median Discount",
      value:
        loading || medianDiscount === null ? (
          "—"
        ) : (
          <span
            className={
              medianDiscount < -0.5
                ? "text-emerald-700"
                : medianDiscount > 0.5
                  ? "text-crimson"
                  : ""
            }
          >
            {medianDiscount > 0 ? "+" : ""}
            {medianDiscount.toFixed(1)}%
          </span>
        ),
      sub: "vs B-S fair value",
    },
    {
      label: "My Listings",
      value: !connected ? "—" : loading ? "—" : myRows.length.toString(),
      sub: !connected ? "Connect wallet" : "Active resale listings",
    },
  ];

  const handleBuyClick = useCallback((row: ResaleListingRow) => {
    setBuyTarget(row);
  }, []);

  const handleCancelClick = useCallback(
    async (row: ResaleListingRow) => {
      try {
        const result = await cancelFlow.submit({ row });
        if (result) {
          showToast({
            type: "success",
            title: "Listing cancelled",
            message: `${row.qtyAvailable} ${row.asset} ${row.optionType.toUpperCase()} returned to your wallet`,
            txSignature: result.txSignature,
          });
          refetch();
        }
      } catch (err: any) {
        showToast({
          type: "error",
          title: "Cancel failed",
          message: err?.message ?? "Unknown error",
        });
      }
    },
    [cancelFlow, refetch],
  );

  const handleBuyClose = useCallback(() => setBuyTarget(null), []);
  const handleBuySuccess = useCallback(() => {
    refetch();
    setBuyTarget(null);
  }, [refetch]);

  return (
    <div className="relative bg-paper text-ink overflow-x-hidden min-h-screen">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
        <MarketplaceStatementHeader
          monthLabel={monthLabel}
          timestampLabel={timestampLabel}
          denomination={denomination}
          onDenominationChange={setDenomination}
        />
        <SummaryBand cells={cells} />

        <BuyableListingsSection
          rows={buyableRows}
          totalCount={totalCount}
          onBuyClick={handleBuyClick}
        />

        {connected && (
          <MyListingsSection
            rows={myRows}
            onCancelClick={handleCancelClick}
            busyId={cancelFlow.busyId}
          />
        )}
      </main>

      {buyTarget && (
        <BuyListingModal
          row={buyTarget}
          spotPrice={spotPrices[buyTarget.asset]}
          onClose={handleBuyClose}
          onSuccess={handleBuySuccess}
        />
      )}
    </div>
  );
};

export default MarketplacePage;
