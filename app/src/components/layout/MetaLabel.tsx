import type { ElementType, FC, ReactNode } from "react";

type MetaLabelProps = {
  children: ReactNode;
  as?: "span" | "div" | "p";
  size?: "xs" | "sm";
  tone?: "default" | "muted";
  className?: string;
};

/**
 * Uppercase mono label with wide letter-spacing — the "Solana
 * mainnet", "v0.1 — April 2026", "Q1 '26" pattern.
 *
 * `tone="default"` (~70% opacity ink) for primary labels (live
 * indicator, scroll cue); `tone="muted"` (~55%) for footnote-style
 * annotations (source attributions, tracer end labels). A "paper"
 * tone for use on dark sections will land in 3b once we have one.
 */
export const MetaLabel: FC<MetaLabelProps> = ({
  children,
  as = "span",
  size = "xs",
  tone = "default",
  className = "",
}) => {
  const Tag = as as ElementType;
  const sizeClass = size === "sm" ? "text-[12px]" : "text-[11.5px]";
  const toneClass = tone === "muted" ? "opacity-55" : "opacity-70";
  return (
    <Tag
      className={`inline-block font-mono uppercase tracking-[0.2em] text-ink ${sizeClass} ${toneClass} ${className}`.trim()}
    >
      {children}
    </Tag>
  );
};

export default MetaLabel;
