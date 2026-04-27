import type { FC } from "react";

type MoneyAmountProps = {
  /** Signed dollar amount; e.g. 184420.12, -150.00, or 0. */
  value: number;
  /** When true, prefix a positive value with "+". Negative values always prefix "-" regardless. */
  showSign?: boolean;
  className?: string;
};

/**
 * Renders a dollar amount with the v3 paper-surface split treatment —
 * the integer and dollar sign read in full ink, the fractional cents
 * drop to 50% opacity. Visual hierarchy puts the dollars first; cents
 * are present but don't compete for attention.
 *
 *   value=184420.12              → $184,420.<muted>12</muted>
 *   value=27383.35, showSign     → +$27,383.<muted>35</muted>
 *   value=-150                   → -$150.<muted>00</muted>
 *   value=0                      → $0.<muted>00</muted>
 *   value=0, showSign            → $0.<muted>00</muted>   (no "+0")
 *
 * Reused by SummaryBand cells in Stage 1 and the positions table in
 * Stage 2.
 */
export const MoneyAmount: FC<MoneyAmountProps> = ({ value, showSign = false, className = "" }) => {
  const isNegative = value < 0;
  const isPositive = value > 0;

  // Round to cents first to avoid floating-point bleed (e.g. 0.1 + 0.2)
  const cents = Math.round(Math.abs(value) * 100);
  const integer = Math.floor(cents / 100);
  const fractional = (cents % 100).toString().padStart(2, "0");
  const integerFormatted = integer.toLocaleString("en-US");

  let prefix = "";
  if (isNegative) prefix = "-";
  else if (isPositive && showSign) prefix = "+";

  return (
    <span className={className}>
      {prefix}${integerFormatted}
      <span className="opacity-50">.{fractional}</span>
    </span>
  );
};

export default MoneyAmount;
