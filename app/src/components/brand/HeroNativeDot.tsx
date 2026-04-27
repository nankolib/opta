import type { FC } from "react";

/**
 * The crimson dot that pops in next to "native" in the hero headline.
 *
 * Animation is the named `animate-dot-pop` keyframe with a 1.6s
 * delay, timed to fire after the staggered three-line headline
 * reveal completes. The keyframe uses `both` fill-mode so the dot
 * starts at scale(0) during the delay and ends at scale(1) after.
 *
 * One of three crimson dots on Landing — see also WordmarkDot
 * (color-aware, nav/footer) and CtaThesisDot (static, final CTA).
 */
export const HeroNativeDot: FC = () => (
  <span
    aria-hidden="true"
    className="inline-block rounded-full bg-crimson w-[clamp(10px,1.4vw,18px)] h-[clamp(10px,1.4vw,18px)] ml-[clamp(6px,0.8vw,12px)] animate-dot-pop [animation-delay:1.6s]"
  />
);

export default HeroNativeDot;
