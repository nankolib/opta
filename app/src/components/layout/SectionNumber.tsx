import type { FC } from "react";

type SectionNumberProps = {
  number: string;
  label: string;
  className?: string;
};

/**
 * The "§ 01 · The Market Thesis" mono section marker.
 *
 * Three parts: italic-serif pilcrow, mono numeral with crimson italic
 * interpoint, and a lowered-opacity mono section title. Used at the
 * top of every numbered section on Landing; will be reused on Docs.
 */
export const SectionNumber: FC<SectionNumberProps> = ({ number, label, className = "" }) => (
  <div
    className={`flex items-center gap-[14px] font-mono text-[11.5px] uppercase tracking-[0.22em] opacity-85 ${className}`.trim()}
  >
    <span className="font-serif italic font-normal opacity-55 normal-case tracking-normal">§</span>
    <span className="text-ink">
      {number}
      <em className="font-serif italic text-crimson px-[1px]">·</em>
    </span>
    <span className="opacity-75">{label}</span>
  </div>
);

export default SectionNumber;
