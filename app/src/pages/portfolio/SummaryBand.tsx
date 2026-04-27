import type { FC, ReactNode } from "react";

export type SummaryCell = {
  /** Mono uppercase eyebrow label, e.g. "Open Positions" */
  label: string;
  /** Big numeral — typically a <MoneyAmount /> or a plain string */
  value: ReactNode;
  /** Mono uppercase context line below the value */
  sub: ReactNode;
};

type SummaryBandProps = {
  cells: [SummaryCell, SummaryCell, SummaryCell, SummaryCell];
};

/**
 * Four-cell horizontal summary band with hairline rules.
 *
 * Layout uses the `gap-px bg-rule` trick: 1px gap between cells
 * with the rule color showing through, so visual rules render as a
 * single pixel without per-cell border duplication. Each cell is
 * paper-bg so the gap reads as a hairline. Outer top + bottom rules
 * frame the whole band against the page background.
 *
 * Mobile (<md): 2 columns. Desktop: 4 columns. The hairlines adapt
 * automatically — vertical between cells in a row, horizontal
 * between rows when the grid wraps.
 */
export const SummaryBand: FC<SummaryBandProps> = ({ cells }) => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-rule border-y border-rule">
    {cells.map((cell, i) => (
      <SummaryCellEl key={i} cell={cell} />
    ))}
  </div>
);

const SummaryCellEl: FC<{ cell: SummaryCell }> = ({ cell }) => (
  <div className="bg-paper p-6 md:p-8">
    <div className="font-mono text-[11px] uppercase tracking-[0.2em] opacity-60 mb-5">
      {cell.label}
    </div>
    <div className="font-mono font-normal text-[clamp(28px,3.4vw,40px)] leading-[0.95] text-ink mb-3">
      {cell.value}
    </div>
    <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-55">
      {cell.sub}
    </div>
  </div>
);

export default SummaryBand;
