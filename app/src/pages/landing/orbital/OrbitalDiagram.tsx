import type { FC } from "react";
import { OrbitNode } from "./OrbitNode";
import { TokenCore } from "./TokenCore";

/**
 * The orbital diagram — three nested rings, an orbiting crimson
 * dot on the outer ring, five mono-text feature nodes anchored at
 * roughly 12/2/5/7/10 o'clock, and a dark token core at center.
 *
 * Outer ring spins clockwise 36s, middle ring counter-clockwise
 * 28s, inner ring is static. The "Black–Scholes" node carries the
 * lead pip (crimson) per the v3 design.
 *
 * The whole composition is aria-hidden — it's decorative typography,
 * not informational. Screen readers should hear the surrounding
 * mechanics columns, not this diagram.
 */
export const OrbitalDiagram: FC = () => (
  <div
    className="relative mx-auto my-[clamp(20px,4vh,40px)] flex w-full justify-center"
    aria-hidden="true"
  >
    <div className="relative aspect-square w-[min(720px,100%)]">
      {/* outer ring with orbiting crimson dot */}
      <div className="absolute inset-0 rounded-full border border-dashed border-ink/30 animate-spin-slow [transform-origin:50%_50%]">
        <span className="absolute left-0 top-1/2 -ml-[5px] -mt-[5px] h-[10px] w-[10px] rounded-full bg-crimson [box-shadow:0_0_24px_rgba(215,38,61,.7),0_0_0_4px_rgba(215,38,61,.12)]" />
      </div>
      {/* middle ring (counter-rotating) */}
      <div className="absolute inset-[14%] rounded-full border border-dashed border-ink/35 animate-spin-rev [transform-origin:50%_50%]" />
      {/* inner ring (static) */}
      <div className="absolute inset-[28%] rounded-full border border-ink/20" />

      <TokenCore />

      <OrbitNode label="Transfer Hook" position="top" />
      <OrbitNode label="Permanent Delegate" position="right-top" />
      <OrbitNode label="Black–Scholes" position="right-bottom" lead />
      <OrbitNode label="Pyth Oracle" position="left-bottom" />
      <OrbitNode label="EWMA Vol" position="left-top" />
    </div>
  </div>
);

export default OrbitalDiagram;
