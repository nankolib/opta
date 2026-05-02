import type { FC } from "react";
import { useMemo } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { inferClusterFromUrl, getClusterDisplayLabel } from "../../utils/env";

export type Denomination = "USDC" | "SOL";

type MarketsStatementHeaderProps = {
  monthLabel: string;
  timestampLabel: string;
  denomination: Denomination;
  onDenominationChange: (d: Denomination) => void;
  /** Wired to NEW MARKET CTA — opens the modal in the parent. */
  onNewMarket: () => void;
};

/**
 * Statement header for the Markets page — same shape as
 * portfolio/StatementHeader but eyebrow says "Markets" and the right
 * cluster CTA opens the New Market modal instead of routing to /write.
 *
 * USDC/SOL denomination toggle is visual-only — actual FX conversion
 * is out of scope for this stage.
 *
 * Stage Secondary 7.5: cluster label is derived at render time from
 * the active connection RPC URL via inferClusterFromUrl.
 */
export const MarketsStatementHeader: FC<MarketsStatementHeaderProps> = ({
  monthLabel,
  timestampLabel,
  denomination,
  onDenominationChange,
  onNewMarket,
}) => {
  const { connection } = useConnection();
  const clusterLabel = useMemo(
    () => getClusterDisplayLabel(inferClusterFromUrl(connection.rpcEndpoint)),
    [connection.rpcEndpoint],
  );
  return (
    <header className="border-b border-rule pb-12 mb-12">
      <div className="flex items-center flex-wrap gap-x-[14px] gap-y-2 font-mono text-[11.5px] uppercase tracking-[0.22em] opacity-85 mb-8">
        <span className="font-serif italic font-normal opacity-55 normal-case tracking-normal">§</span>
        <span className="text-ink">
          Markets<em className="font-serif italic text-crimson px-[1px]">·</em>
        </span>
        <span className="opacity-75">{monthLabel}</span>
        <span className="opacity-30">·</span>
        <span className="opacity-75">{clusterLabel}</span>
        <span className="opacity-30">·</span>
        <span className="opacity-75">v0.1.4</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-8">
        <h1 className="m-0 font-fraunces-display font-light text-ink leading-[0.92] tracking-[-0.04em] text-[clamp(72px,10vw,144px)]">
          Markets<span className="italic font-fraunces-display-em text-crimson">.</span>
        </h1>

        <div className="flex flex-wrap items-center gap-6">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] opacity-60">
            As of {timestampLabel}
          </span>

          <div className="inline-flex items-center gap-1 border border-rule rounded-full p-1 font-mono text-[10.5px] uppercase tracking-[0.18em]">
            <DenomButton
              active={denomination === "USDC"}
              onClick={() => onDenominationChange("USDC")}
            >
              USDC
            </DenomButton>
            <DenomButton
              active={denomination === "SOL"}
              onClick={() => onDenominationChange("SOL")}
            >
              SOL
            </DenomButton>
          </div>

          <button
            type="button"
            onClick={onNewMarket}
            className="group inline-flex items-center gap-2 rounded-full border border-ink bg-ink text-paper px-[18px] py-[10px] font-mono text-[11px] uppercase tracking-[0.2em] no-underline transition-[background-color,color] duration-500 ease-opta hover:bg-transparent hover:text-ink"
          >
            New Market
            <span className="transition-transform duration-500 ease-opta group-hover:translate-x-[3px]">→</span>
          </button>
        </div>
      </div>
    </header>
  );
};

const DenomButton: FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-full px-3 py-1 transition-colors duration-300 ease-opta ${
      active ? "bg-ink text-paper" : "opacity-60 hover:opacity-100"
    }`}
  >
    {children}
  </button>
);

export default MarketsStatementHeader;
