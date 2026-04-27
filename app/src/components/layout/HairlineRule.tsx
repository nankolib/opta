import type { FC } from "react";

type HairlineRuleProps = {
  weight?: "default" | "soft";
  orientation?: "horizontal" | "vertical";
  className?: string;
};

/**
 * 1px rule using one of the paper-surface rule tokens —
 * `--color-rule` for primary section dividers, `--color-rule-soft`
 * for grid columns and inner subdivisions.
 *
 * Renders as a self-closing aria-hidden span so it can drop between
 * flex/grid children without polluting the accessibility tree.
 */
export const HairlineRule: FC<HairlineRuleProps> = ({
  weight = "default",
  orientation = "horizontal",
  className = "",
}) => {
  const colorClass = weight === "soft" ? "bg-rule-soft" : "bg-rule";
  const sizeClass = orientation === "vertical" ? "w-px h-full" : "h-px w-full";
  return (
    <span aria-hidden="true" className={`block ${sizeClass} ${colorClass} ${className}`.trim()} />
  );
};

export default HairlineRule;
