import type { FC } from "react";

type WordmarkDotProps = {
  context: "light" | "dark";
  size?: "sm" | "lg";
  className?: string;
};

/**
 * The small dot adjacent to "opta" in the Wordmark.
 *
 * "light" context renders teal-green (`--color-dot-teal`). "dark"
 * context renders crimson with a soft glow (`--shadow-dot-glow`).
 * Wordmark passes its own `context` through; the LandingNav also
 * passes `context="dark"` down when its `useNavOverDark` hook flips.
 *
 * One of three crimson dots on Landing — see also HeroNativeDot
 * (animated, hero) and CtaThesisDot (static, final CTA).
 */
export const WordmarkDot: FC<WordmarkDotProps> = ({ context, size = "sm", className = "" }) => {
  const dimensions =
    size === "lg" ? "h-[14px] w-[14px] ml-[9px] -translate-y-[2px]" : "h-[7px] w-[7px] ml-[5px]";
  const colorClass = context === "dark" ? "bg-crimson shadow-dot-glow" : "bg-dot-teal";

  return (
    <span
      aria-hidden="true"
      className={`inline-block rounded-full transition-[background-color,box-shadow] duration-500 ease-opta ${dimensions} ${colorClass} ${className}`.trim()}
    />
  );
};

export default WordmarkDot;
