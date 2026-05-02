import type { FC } from "react";

export type Denomination = "USDC" | "SOL";

type MarketplaceStatementHeaderProps = {
  /** Eyebrow month/year label, e.g. "May 2026". Computed at render time by the parent. */
  monthLabel: string;
  /** Right-side timestamp label, e.g. "02 May 2026 · 14:32 UTC". Computed at render time by the parent. */
  timestampLabel: string;
  /** Currently selected denomination. Visual-only (matches Portfolio Stage 1 convention). */
  denomination: Denomination;
  /** Toggle handler. */
  onDenominationChange: (d: Denomination) => void;
};

/**
 * Marketplace statement header. Forked from portfolio/StatementHeader
 * with the "New Position" CTA removed (per OQ#8 — marketplace is a
 * buyer/manage surface, sending users to /write would be incongruous).
 *
 * Eyebrow follows the SectionNumber rhythm (italic-serif pilcrow,
 * crimson italic interpoint, mono uppercase metadata). Giant title
 * "Marketplace." uses Fraunces display at clamp(72,10vw,144); trailing
 * period renders crimson italic — same crimson punctuation as the
 * wordmark dot and SectionNumber's interpoint.
 *
 * Right cluster: as-of timestamp + USDC|SOL toggle. The toggle is
 * visual-only — actual FX conversion lands in a later stage. Same
 * convention as Portfolio's Stage 1 implementation.
 */
export const MarketplaceStatementHeader: FC<MarketplaceStatementHeaderProps> = ({
  monthLabel,
  timestampLabel,
  denomination,
  onDenominationChange,
}) => (
  <header className="border-b border-rule pb-12 mb-12">
    <div className="flex items-center flex-wrap gap-x-[14px] gap-y-2 font-mono text-[11.5px] uppercase tracking-[0.22em] opacity-85 mb-8">
      <span className="font-serif italic font-normal opacity-55 normal-case tracking-normal">§</span>
      <span className="text-ink">
        Statement<em className="font-serif italic text-crimson px-[1px]">·</em>
      </span>
      <span className="opacity-75">{monthLabel}</span>
      <span className="opacity-30">·</span>
      <span className="opacity-75">Mainnet · Solana</span>
      <span className="opacity-30">·</span>
      <span className="opacity-75">v0.1.4</span>
    </div>

    <div className="flex flex-wrap items-end justify-between gap-8">
      <h1 className="m-0 font-fraunces-display font-light text-ink leading-[0.92] tracking-[-0.04em] text-[clamp(72px,10vw,144px)]">
        Marketplace<span className="italic font-fraunces-display-em text-crimson">.</span>
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
      </div>
    </div>
  </header>
);

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

export default MarketplaceStatementHeader;
