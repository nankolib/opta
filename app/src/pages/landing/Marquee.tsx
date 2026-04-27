import type { FC } from "react";

const TAGLINES = [
  "Pricing on-chain",
  "Settlement at expiry, automatic",
  "Composable with every primitive",
  "One token, one option",
];

/**
 * Endless horizontal scroll between the Thesis and Product sections.
 *
 * Track contains the tagline list duplicated once, animated -50%
 * over 42s linear so the loop is seamless. No pause-on-hover by
 * design — the tagline scroll is ambient context, not interactive
 * content.
 */
export const Marquee: FC = () => (
  <div
    aria-hidden="true"
    className="relative overflow-hidden border-y border-rule py-[38px]"
  >
    <div className="flex w-max whitespace-nowrap gap-[64px] animate-marquee">
      {[...TAGLINES, ...TAGLINES].map((line, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-[64px] font-fraunces-mid-em italic font-light text-ink tracking-[-0.02em] text-[clamp(36px,5.4vw,72px)]"
        >
          {line}
          <span
            aria-hidden="true"
            className="inline-block h-[10px] w-[10px] flex-none rounded-full bg-crimson"
          />
        </span>
      ))}
    </div>
  </div>
);

export default Marquee;
