import type { FC } from "react";

/**
 * The static crimson dot in the final CTA's "Trade the thesis·"
 * headline. Smaller than HeroNativeDot, no animation — it
 * punctuates the line rather than landing into it.
 *
 * One of three crimson dots on Landing — see also HeroNativeDot
 * (animated, hero) and WordmarkDot (color-aware, nav/footer).
 */
export const CtaThesisDot: FC = () => (
  <span
    aria-hidden="true"
    className="inline-block rounded-full bg-crimson w-[clamp(10px,1.2vw,16px)] h-[clamp(10px,1.2vw,16px)] ml-[clamp(6px,0.7vw,10px)] -translate-y-[0.06em]"
  />
);

export default CtaThesisDot;
