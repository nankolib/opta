import type { FC, ReactNode } from "react";
import { Link } from "react-router-dom";
import { WordmarkDot } from "./WordmarkDot";

type WordmarkProps = {
  size?: "sm" | "lg";
  context?: "light" | "dark";
  as?: "span" | "a" | "div";
  className?: string;
};

/**
 * The Opta wordmark — italic serif "opta" plus a small dot.
 *
 * Used in the LandingNav (size="sm") and LandingFooter (size="lg").
 * `context` controls the dot's color: "light" = teal on cream
 * surfaces, "dark" = crimson with glow when the wordmark sits over
 * the dark MarketSection. When `as="a"` (the default), renders a
 * react-router <Link> to "/" so clicking returns home from anywhere.
 */
export const Wordmark: FC<WordmarkProps> = ({
  size = "sm",
  context = "light",
  as = "a",
  className = "",
}) => {
  const sizeClasses =
    size === "lg"
      ? "text-[64px] tracking-[-0.03em] font-fraunces-mid-em"
      : "text-[22px] tracking-[-0.01em] font-fraunces-text";

  const baseClass =
    `inline-flex items-baseline italic font-medium leading-none no-underline ${sizeClasses} ${className}`.trim();

  const inner: ReactNode = (
    <>
      opta
      <WordmarkDot context={context} size={size} />
    </>
  );

  if (as === "a") {
    return (
      <Link to="/" className={baseClass} aria-label="opta">
        {inner}
      </Link>
    );
  }
  if (as === "span") {
    return (
      <span className={baseClass} aria-label="opta">
        {inner}
      </span>
    );
  }
  return (
    <div className={baseClass} aria-label="opta">
      {inner}
    </div>
  );
};

export default Wordmark;
