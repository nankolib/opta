import type { FC } from "react";
import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { usePaperPalette } from "../../hooks";
import { PaperGrain } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { MoneyAmount } from "../../components/MoneyAmount";
import { SummaryBand, type SummaryCell } from "../portfolio/SummaryBand";
import { MarketsStatementHeader, type Denomination } from "./MarketsStatementHeader";
import { MarketsSection } from "./MarketsSection";
import { NewMarketModal } from "./NewMarketModal";
import { useMarketsData } from "./useMarketsData";

/**
 * MarketsPage — the trader's market browser.
 *
 * Composition mirrors PortfolioPage's Stage 2 shape: paper palette
 * shell + AppNav + statement header + 4-cell summary band + numbered
 * section. The section owns the filter row + table; the page owns the
 * data fetch (via useMarketsData) and the New Market modal.
 *
 * NEW MARKET CTA is permissionless — anyone with a connected wallet
 * can create a market. When disconnected, the click triggers the
 * wallet modal so the user can connect first.
 */
export const MarketsPage: FC = () => {
  usePaperPalette();
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [denomination, setDenomination] = useState<Denomination>("USDC");
  const [showNewMarket, setShowNewMarket] = useState(false);

  const { rows, summary, refetch } = useMarketsData();

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

  const cells: [SummaryCell, SummaryCell, SummaryCell, SummaryCell] = [
    {
      label: "Active Markets",
      value: summary.loaded ? summary.activeMarkets.toString() : "—",
      sub: summary.loaded
        ? `${summary.underlyings} ${summary.underlyings === 1 ? "underlying" : "underlyings"}`
        : "Loading",
    },
    {
      label: "Open Interest",
      value: summary.loaded ? summary.openInterest.toLocaleString() : "—",
      sub: "Contracts · All sides",
    },
    {
      label: "Vault TVL",
      value: summary.loaded ? <MoneyAmount value={summary.vaultTvl} /> : "—",
      sub: "USDC · Collateral",
    },
    {
      label: "Premia Written",
      value: summary.loaded ? <MoneyAmount value={summary.premiaWritten} /> : "—",
      sub: "USDC · Cumulative",
    },
  ];

  const handleNewMarket = () => {
    if (!connected) {
      setVisible(true);
      return;
    }
    setShowNewMarket(true);
  };

  return (
    <div className="relative bg-paper text-ink overflow-x-hidden min-h-screen">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
        <MarketsStatementHeader
          monthLabel={monthLabel}
          timestampLabel={timestampLabel}
          denomination={denomination}
          onDenominationChange={setDenomination}
          onNewMarket={handleNewMarket}
        />
        <SummaryBand cells={cells} />
        <MarketsSection rows={rows} />
      </main>

      {showNewMarket && (
        <NewMarketModal
          onClose={() => setShowNewMarket(false)}
          onCreated={() => {
            setShowNewMarket(false);
            refetch();
          }}
        />
      )}
    </div>
  );
};

export default MarketsPage;
