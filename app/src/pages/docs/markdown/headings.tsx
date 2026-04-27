import type { ComponentPropsWithoutRef, FC } from "react";

/**
 * Sub-section heading inside a Docs section body. Display weight,
 * upright, generous top margin to break visual rhythm. Top-level
 * h1 is stripped during slicing, so h2 is effectively the deepest
 * heading the content fence will produce.
 */
export const H2: FC<ComponentPropsWithoutRef<"h2">> = ({ children, ...rest }) => (
  <h2
    className="font-fraunces-mid font-light leading-[1.1] tracking-[-0.02em] text-[clamp(28px,3.4vw,40px)] mt-16 mb-6 text-ink"
    {...rest}
  >
    {children}
  </h2>
);

/**
 * Sub-sub heading. Italicized step-down from h2; smaller margin
 * reflects a shallower hierarchy. Uses the mid-em axis (SOFT 100,
 * WONK 1) which is italic-tuned.
 */
export const H3: FC<ComponentPropsWithoutRef<"h3">> = ({ children, ...rest }) => (
  <h3
    className="font-fraunces-mid-em italic font-normal leading-[1.25] tracking-[-0.01em] text-[clamp(20px,2vw,24px)] mt-12 mb-4 text-ink"
    {...rest}
  >
    {children}
  </h3>
);

/**
 * h4 — minimal styling; the whitepaper barely uses it but the
 * mapping must exist so any incidental h4 in the content renders
 * through paper-palette typography rather than browser defaults.
 */
export const H4: FC<ComponentPropsWithoutRef<"h4">> = ({ children, ...rest }) => (
  <h4
    className="font-fraunces-text italic font-medium text-[18px] leading-[1.3] mt-8 mb-3 text-ink"
    {...rest}
  >
    {children}
  </h4>
);
