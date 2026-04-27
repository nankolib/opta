import type { ElementType, FC, ReactNode } from "react";

type MetaLabelProps = {
  children: ReactNode;
  as?: "span" | "div" | "p";
  size?: "xs" | "sm";
  tone?: "default" | "muted" | "paper";
  className?: string;
};

/**
 * Uppercase mono label with wide letter-spacing — the "Solana
 * mainnet", "v0.1 — April 2026", "Q1 '26" pattern.
 *
 * `tone="default"` (~70% ink) for primary cream-surface labels;
 * `tone="muted"` (~55% ink) for footnote-style annotations on cream;
 * `tone="paper"` (~50% paper) for the same pattern over dark
 * sections — the MarketSection sources attribution is the canonical
 * caller. Adding tone="paper" instead of letting consumers reach
 * for `className="text-paper opacity-50"` overrides keeps tone
 * decisions inside the primitive, where they belong.
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
  const colorClass = tone === "paper" ? "text-paper" : "text-ink";
  const opacityClass =
    tone === "muted" ? "opacity-55" : tone === "paper" ? "opacity-50" : "opacity-70";
  return (
    <Tag
      className={`inline-block font-mono uppercase tracking-[0.2em] ${colorClass} ${opacityClass} ${sizeClass} ${className}`.trim()}
    >
      {children}
    </Tag>
  );
};

export default MetaLabel;
