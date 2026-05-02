import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import { MoneyAmount } from "../../components/MoneyAmount";
import type { ChainRow, Offering } from "./useTradeData";

/**
 * Click-target shape passed up to TradePage when a premium cell is
 * clicked. Carries the per-row data TradePage needs to construct its
 * widened buyTarget — strike + fairPremium + ivSmiled live on
 * ChainRow only; asset/expiry/spot are page-level state TradePage
 * merges in itself.
 */
export type BuyClickTarget = {
  offerings: Offering[];
  strike: number;
  fairPremium: number;
  ivSmiled: number;
};

type OptionsChainProps = {
  asset: string;
  expiry: number;
  rows: ChainRow[];
  atmStrike: number | null;
  highlightedStrike: number | null;
  onBuyClick: (target: BuyClickTarget, side: "call" | "put") => void;
  /** Empty-state copy when no rows. Defensive — expiries are pre-filtered to ones that have markets. */
  emptyState?: ReactNode;
};

/**
 * Symmetric options chain: Calls (left) | Strike (centre) | Puts (right).
 *
 * Column order:
 *   Calls toward strike: OI · PREMIUM
 *   Centre: STRIKE
 *   Puts away from strike: PREMIUM · OI
 *
 * Premium cells are buttons that open the BuyModal for the cheapest
 * vault mint at that (strike, side). A `·N` depth badge appears next
 * to the headline price when the unified offerings array (vault tier
 * plus active resale listings) has more than one entry — N counts
 * everything beyond the headline.
 *
 * Visual rhythm:
 *   - ATM row gets a hairline above + below + a small ATM label.
 *   - Deep OTM/ITM rows fade to ~70% opacity; near-ATM rows are full
 *     opacity. Dimming weight = distance from spot in % (clamped).
 *   - Strike column uses italic Fraunces — the visual anchor.
 */
export const OptionsChain: FC<OptionsChainProps> = ({
  asset,
  expiry,
  rows,
  atmStrike,
  highlightedStrike,
  onBuyClick,
  emptyState,
}) => {
  const expiryLabel = useMemo(() => formatHeaderDate(expiry), [expiry]);

  if (rows.length === 0) {
    return (
      <>
        <ChainCaption asset={asset} expiryLabel={expiryLabel} />
        {emptyState ?? (
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(15px,1.2vw,17px)] m-0">
              No markets at this expiry — create one on Markets.
            </p>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <ChainCaption asset={asset} expiryLabel={expiryLabel} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-rule">
              <Th align="right">OI</Th>
              <Th align="right">Premium</Th>
              <Th align="center">Strike</Th>
              <Th align="left">Premium</Th>
              <Th align="left">OI</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ChainRowEl
                key={r.strike}
                row={r}
                isAtm={atmStrike != null && r.strike === atmStrike}
                isHighlighted={highlightedStrike != null && r.strike === highlightedStrike}
                onBuyClick={onBuyClick}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

const ChainCaption: FC<{ asset: string; expiryLabel: string }> = ({ asset, expiryLabel }) => (
  <div className="grid grid-cols-2 gap-4 mb-3">
    <div>
      <h2 className="m-0 font-fraunces-text italic font-light text-ink text-[22px] leading-tight">
        Calls
      </h2>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-crimson italic mt-1">
        {asset} · {expiryLabel}
      </div>
    </div>
    <div className="text-right">
      <h2 className="m-0 font-fraunces-text italic font-light text-ink text-[22px] leading-tight">
        Puts
      </h2>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-crimson italic mt-1">
        {asset} · {expiryLabel}
      </div>
    </div>
  </div>
);

const Th: FC<{ children: ReactNode; align: "left" | "center" | "right" }> = ({
  children,
  align,
}) => (
  <th
    className={`font-mono text-[10.5px] uppercase tracking-[0.18em] py-3 px-3 opacity-60 align-bottom whitespace-nowrap ${
      align === "right"
        ? "text-right"
        : align === "center"
          ? "text-center"
          : "text-left"
    }`}
  >
    {children}
  </th>
);

const ChainRowEl: FC<{
  row: ChainRow;
  isAtm: boolean;
  isHighlighted: boolean;
  onBuyClick: (target: BuyClickTarget, side: "call" | "put") => void;
}> = ({ row, isAtm, isHighlighted, onBuyClick }) => {
  // Dimming weight: 1.0 at ATM, fades to ~0.55 at >= ±15% from spot.
  const opacity = useMemo(() => {
    const dist = Math.min(Math.abs(row.moneynessPct), 15);
    return 1 - (dist / 15) * 0.45;
  }, [row.moneynessPct]);

  // Scroll into view if highlighted (deep-link target).
  const ref = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (isHighlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [isHighlighted]);

  const rowBgClass = isHighlighted
    ? "bg-paper-2"
    : isAtm
      ? ""
      : "";

  return (
    <tr
      ref={ref}
      className={`border-t border-b ${
        isAtm ? "border-rule" : "border-rule-soft"
      } align-middle ${rowBgClass}`}
      style={{ opacity: isAtm ? 1 : opacity }}
    >
      {/* CALLS — toward strike */}
      <Td align="right">{row.callOi > 0 ? row.callOi.toLocaleString() : "—"}</Td>
      <Td align="right">
        {row.callOfferings.length > 0 ? (
          <PremiumButton
            value={row.callOfferings[0].premium}
            depthCount={Math.max(0, row.callOfferings.length - 1)}
            onClick={() =>
              onBuyClick(
                {
                  offerings: row.callOfferings,
                  strike: row.strike,
                  fairPremium: row.callPremium,
                  ivSmiled: row.ivSmiled,
                },
                "call",
              )
            }
          />
        ) : (
          <FairPremium value={row.callPremium} />
        )}
      </Td>

      {/* STRIKE */}
      <td className="px-3 py-4 text-center align-middle">
        <div className="font-fraunces-text italic font-light text-ink text-[18px] leading-tight">
          ${formatStrike(row.strike)}
        </div>
        {isAtm && (
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-crimson mt-1">
            ATM
          </div>
        )}
      </td>

      {/* PUTS — away from strike */}
      <Td align="left">
        {row.putOfferings.length > 0 ? (
          <PremiumButton
            value={row.putOfferings[0].premium}
            depthCount={Math.max(0, row.putOfferings.length - 1)}
            onClick={() =>
              onBuyClick(
                {
                  offerings: row.putOfferings,
                  strike: row.strike,
                  fairPremium: row.putPremium,
                  ivSmiled: row.ivSmiled,
                },
                "put",
              )
            }
          />
        ) : (
          <FairPremium value={row.putPremium} />
        )}
      </Td>
      <Td align="left">{row.putOi > 0 ? row.putOi.toLocaleString() : "—"}</Td>
    </tr>
  );
};

const Td: FC<{
  children: ReactNode;
  align: "left" | "center" | "right";
  muted?: boolean;
}> = ({ children, align, muted = false }) => (
  <td
    className={`font-mono text-[12.5px] py-4 px-3 whitespace-nowrap ${
      align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
    } ${muted ? "opacity-50" : ""}`}
  >
    {children}
  </td>
);

const PremiumButton: FC<{
  value: number;
  /** Count of OTHER offerings beyond the headline. 0 hides the badge. */
  depthCount: number;
  onClick: () => void;
}> = ({ value, depthCount, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="font-mono text-[12.5px] text-ink hover:text-crimson border-b border-transparent hover:border-crimson transition-colors duration-200 inline-flex items-baseline gap-1.5"
  >
    <MoneyAmount value={value} />
    {depthCount > 0 && (
      <span
        title={`${depthCount} more offering${depthCount === 1 ? "" : "s"}`}
        className="font-mono text-[10.5px] opacity-55"
      >
        ·{depthCount}
      </span>
    )}
  </button>
);

const FairPremium: FC<{ value: number }> = ({ value }) => (
  <span className="opacity-50">
    <MoneyAmount value={value} />
  </span>
);

function formatStrike(strike: number): string {
  return strike % 1 === 0
    ? strike.toLocaleString()
    : strike.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

function formatHeaderDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default OptionsChain;
