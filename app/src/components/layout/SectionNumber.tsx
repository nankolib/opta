import type { FC } from "react";

type SectionNumberProps = {
  number: string;
  label: string;
  /**
   * "default" — number renders in ink (cream surfaces).
   * "paper"   — number renders in paper-cream (dark surfaces).
   *
   * Mirrors MetaLabel's tone API. The pilcrow and label inherit text
   * color from their parent, so they adapt automatically; only the
   * number span needs an explicit color rule, and the previous
   * hardcoded text-ink rendered the "03" invisible on bg-ink.
   */
  tone?: "default" | "paper";
  className?: string;
};

/**
 * The "§ 01 · The Market Thesis" mono section marker.
 *
 * Three parts: italic-serif pilcrow, mono numeral with crimson italic
 * interpoint, and a lowered-opacity mono section title. Used at the
 * top of every numbered section on Landing; will be reused on Docs.
 */
export const SectionNumber: FC<SectionNumberProps> = ({
  number,
  label,
  tone = "default",
  className = "",
}) => {
  const numColorClass = tone === "paper" ? "text-paper" : "text-ink";
  return (
    <div
      className={`flex items-center gap-[14px] font-mono text-[11.5px] uppercase tracking-[0.22em] opacity-85 ${className}`.trim()}
    >
      <span className="font-serif italic font-normal opacity-55 normal-case tracking-normal">§</span>
      <span className={numColorClass}>
        {number}
        <em className="font-serif italic text-crimson px-[1px]">·</em>
      </span>
      <span className="opacity-75">{label}</span>
    </div>
  );
};

export default SectionNumber;
