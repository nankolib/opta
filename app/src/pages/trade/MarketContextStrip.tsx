import type { FC } from "react";
import { MoneyAmount } from "../../components/MoneyAmount";

type MarketContextStripProps = {
  spot: number | null;
  /** ATM baseline IV (smile-adjusted) for the selected expiry. */
  atmBaselineIv: number | null;
  /** Total OI for the selected asset across all expiries. */
  totalOi: number;
};

/**
 * Mono context strip below the title. Shows: SPOT, 24H delta (always
 * — for now), IV · BASELINE, 24H VOL (— pending indexer), OPEN
 * INTEREST. Right side shows a PRICE FEED LIVE indicator with a
 * crimson pulsing dot.
 *
 * The "PRICE FEED LIVE" copy intentionally avoids saying "PYTH" —
 * the underlying hook (`usePythPrices`) actually uses CoinGecko +
 * Jupiter + static fallbacks, not Pyth. Honesty fix scoped to this
 * page only.
 */
export const MarketContextStrip: FC<MarketContextStripProps> = ({
  spot,
  atmBaselineIv,
  totalOi,
}) => (
  <div className="flex flex-wrap items-center justify-between gap-y-3 gap-x-6 border-y border-rule py-3 mb-8">
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11.5px] uppercase tracking-[0.18em]">
      <Stat label="Spot">
        {spot != null ? <MoneyAmount value={spot} /> : "—"}
      </Stat>
      <Stat label="24H">
        <span className="opacity-55">—</span>
      </Stat>
      <Stat label="IV · Baseline">
        {atmBaselineIv != null ? `${(atmBaselineIv * 100).toFixed(1)}%` : "—"}
      </Stat>
      <Stat label="24H Vol">
        <span className="opacity-55">—</span>
      </Stat>
      <Stat label="Open Interest">
        {totalOi > 0 ? totalOi.toLocaleString() : "—"}
      </Stat>
    </div>

    <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.2em] text-crimson">
      <PulsingDot />
      Price Feed Live
    </div>
  </div>
);

const Stat: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <span className="inline-flex items-baseline gap-2">
    <span className="opacity-55">{label}</span>
    <span className="text-ink">{children}</span>
  </span>
);

const PulsingDot: FC = () => (
  <span aria-hidden="true" className="relative inline-flex w-[7px] h-[7px]">
    <span className="absolute inset-0 rounded-full bg-crimson opacity-60 animate-ping" />
    <span className="relative inline-block w-[7px] h-[7px] rounded-full bg-crimson" />
  </span>
);

export default MarketContextStrip;
