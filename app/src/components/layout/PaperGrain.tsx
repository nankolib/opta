import type { FC } from "react";

const NOISE_DATA_URI =
  "data:image/svg+xml;utf8," +
  "<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'>" +
  "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/>" +
  "<feColorMatrix values='0 0 0 0 0.04  0 0 0 0 0.04  0 0 0 0 0.03  0 0 0 0.55 0'/></filter>" +
  "<rect width='100%' height='100%' filter='url(%23n)' opacity='.55'/></svg>";

/**
 * Fixed full-viewport SVG-noise overlay that lends the paper-cream
 * surface its grain. Sits at z-index 9000 over everything (with
 * pointer-events: none), blended with multiply at 42% opacity.
 *
 * Mounted once near the top of any paper-surface page. Visible on
 * solid color areas; subtle but real — what stops the page from
 * looking like a flat CSS gradient.
 */
export const PaperGrain: FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none fixed inset-0 z-[9000] mix-blend-multiply opacity-[0.42]"
    style={{ backgroundImage: `url("${NOISE_DATA_URI}")` }}
  />
);

export default PaperGrain;
