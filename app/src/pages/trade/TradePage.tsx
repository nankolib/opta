import type { FC } from "react";
import { useMemo, useState } from "react";
import { usePaperPalette } from "../../hooks";
import { PaperGrain } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { MoneyAmount } from "../../components/MoneyAmount";
import { SummaryBand, type SummaryCell } from "../portfolio/SummaryBand";
import { TradeStatementHeader } from "./TradeStatementHeader";
import { MarketContextStrip } from "./MarketContextStrip";
import { ExpiryTabs } from "./ExpiryTabs";
import { OptionsChain } from "./OptionsChain";
import { BuyModal } from "./BuyModal";
import { TradeFooter } from "./TradeFooter";
import { useTradeData, type ChainBest } from "./useTradeData";

/**
 * TradePage — the trader's options chain surface.
 *
 * Composition: AppNav → statement header (title + asset chips) →
 * market context strip → expiry tabs → options chain → summary band →
 * page footer. All wired through useTradeData for state + data fetch.
 *
 * V2-only: chain rows come from active SharedVaults / VaultMints;
 * V1 codepath was dropped tonight (USE_V2_VAULTS has been true in
 * production for some time and the legacy chain build was dead).
 */
export const TradePage: FC = () => {
  usePaperPalette();
  const data = useTradeData();
  const [buyTarget, setBuyTarget] = useState<{ best: ChainBest; side: "call" | "put" } | null>(
    null,
  );

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

  const cells: [SummaryCell, SummaryCell, SummaryCell, SummaryCell, SummaryCell] = [
    {
      label: "Total OI",
      value: data.summary.totalOi > 0 ? data.summary.totalOi.toLocaleString() : "—",
      sub: "Contracts · All sides",
    },
    {
      label: "24H Vol",
      value: data.summary.vol24h != null ? <MoneyAmount value={data.summary.vol24h} /> : "—",
      sub: "Indexer pending",
    },
    {
      label: "Put-Call Ratio",
      value: data.summary.putCallRatio != null ? data.summary.putCallRatio.toFixed(2) : "—",
      sub: "OI weighted",
    },
    {
      label: "25D IV Skew",
      value:
        data.summary.ivSkew25d != null ? (
          <span className="text-crimson">{(data.summary.ivSkew25d * 100).toFixed(1)}%</span>
        ) : (
          <span className="text-crimson">—</span>
        ),
      sub: "Surface pending",
    },
    {
      label: "ATM IV · 7D",
      value:
        data.summary.atmIv7d != null
          ? `${(data.summary.atmIv7d * 100).toFixed(1)}%`
          : "—",
      sub: "Smile-adjusted",
    },
  ];

  // SummaryBand expects exactly 4 cells. Adapt by rendering as a 5-cell
  // grid using its underlying cell-presentation pattern. To keep the
  // reused component intact we build a tiny inline 5-cell variant that
  // matches its hairline rhythm.
  return (
    <div className="relative bg-paper text-ink overflow-x-hidden min-h-screen">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(40px,8vh,80px)]">
        <TradeStatementHeader
          monthLabel={monthLabel}
          timestampLabel={timestampLabel}
          assets={data.availableAssets}
          selectedAsset={data.selectedAsset}
          onAssetChange={data.setSelectedAsset}
        />

        <MarketContextStrip
          spot={data.spot}
          atmBaselineIv={data.atmBaselineIv}
          totalOi={data.summary.totalOi}
        />

        {data.loading ? (
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(15px,1.2vw,17px)] m-0">
              Loading from devnet…
            </p>
          </div>
        ) : data.availableAssets.length === 0 ? (
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(15px,1.2vw,17px)] m-0">
              No active markets — visit Markets to create one.
            </p>
          </div>
        ) : (
          <>
            <ExpiryTabs
              expiries={data.availableExpiries}
              selected={data.selectedExpiry}
              onSelect={data.setSelectedExpiry}
            />

            <OptionsChain
              asset={data.selectedAsset}
              expiry={data.selectedExpiry}
              rows={data.rows}
              atmStrike={data.atmStrike}
              highlightedStrike={data.highlightedStrike}
              onBuyClick={(best, side) => setBuyTarget({ best, side })}
            />

            {/* Hairline-divided 5-cell summary band — same rhythm as the 4-cell
                portfolio SummaryBand, expanded to 5 columns at md+. */}
            <FiveCellBand cells={cells} />
          </>
        )}

        <TradeFooter />
      </main>

      {buyTarget && (
        <BuyModal
          best={buyTarget.best}
          side={buyTarget.side}
          onClose={() => setBuyTarget(null)}
          onSuccess={() => {
            // Refetch chain data so OI / available reflect the buy.
            data.refetch();
          }}
        />
      )}
    </div>
  );
};

/**
 * 5-cell variant of SummaryBand. Mirrors its hairline rhythm
 * (gap-px bg-rule trick) but with 5 columns at md+ so the trade
 * stats fit without the 2x2 wrap that the 4-cell SummaryBand uses
 * on smaller screens.
 *
 * Kept inline rather than forking SummaryBand into a configurable
 * column count so Portfolio's single-purpose 4-cell band stays
 * untouched per "do not touch Portfolio" working norm.
 */
const FiveCellBand: FC<{ cells: SummaryCell[] }> = ({ cells }) => (
  <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-rule border-y border-rule mt-12">
    {cells.map((cell, i) => (
      <div key={i} className="bg-paper p-6 md:p-7">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] opacity-60 mb-5">
          {cell.label}
        </div>
        <div className="font-mono font-normal text-[clamp(24px,2.6vw,32px)] leading-[0.95] text-ink mb-3">
          {cell.value}
        </div>
        <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-55">
          {cell.sub}
        </div>
      </div>
    ))}
  </div>
);

export default TradePage;
