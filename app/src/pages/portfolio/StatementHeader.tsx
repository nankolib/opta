import type { FC } from "react";
import { Link } from "react-router-dom";

export type Denomination = "USDC" | "SOL";

type StatementHeaderProps = {
  /** Eyebrow month/year label, e.g. "April 2026". Computed at render time by the parent. */
  monthLabel: string;
  /** Right-side timestamp label, e.g. "27 Apr 2026 · 14:32 UTC". Computed at render time by the parent. */
  timestampLabel: string;
  /** Currently selected denomination. Stage 1 visual-only. */
  denomination: Denomination;
  /** Toggle handler — Stage 1 only persists local state; no FX conversion yet. */
  onDenominationChange: (d: Denomination) => void;
};

/**
 * Statement header band — eyebrow + giant title + right-side cluster.
 *
 * Eyebrow follows the SectionNumber rhythm (italic-serif pilcrow,
 * crimson italic interpoint, mono uppercase metadata) — matches the
 * editorial register established on Landing and Docs.
 *
 * Giant "Portfolio." title uses Fraunces display at clamp(72,10vw,144);
 * the trailing period renders crimson italic — the same crimson
 * punctuation used in SectionNumber's interpoint and the wordmark dot.
 *
 * Right cluster: as-of timestamp / USDC↔SOL toggle / NEW POSITION CTA.
 * The toggle is visual-only in Stage 1 — actual FX conversion lands
 * in a later stage. NEW POSITION routes to /write.
 */
export const StatementHeader: FC<StatementHeaderProps> = ({
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
        Portfolio<span className="italic font-fraunces-display-em text-crimson">.</span>
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

        <Link
          to="/write"
          className="group inline-flex items-center gap-2 rounded-full border border-ink bg-ink text-paper px-[18px] py-[10px] font-mono text-[11px] uppercase tracking-[0.2em] no-underline transition-[background-color,color] duration-500 ease-opta hover:bg-transparent hover:text-ink"
        >
          New Position
          <span className="transition-transform duration-500 ease-opta group-hover:translate-x-[3px]">→</span>
        </Link>
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

export default StatementHeader;
