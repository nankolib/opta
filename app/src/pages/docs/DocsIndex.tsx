import type { FC } from "react";

/**
 * DocsIndex — body content for the `/docs` index route.
 *
 * Stage 1: minimal title card with the whitepaper title and a
 * single short tagline. The real abstract paragraph from the
 * whitepaper lands in Stage 2; for now this is placeholder copy
 * that establishes the page identity without claiming to be the
 * actual abstract.
 */
export const DocsIndex: FC = () => (
  <div>
    <h1 className="m-0 font-fraunces-display font-light text-ink leading-[0.95] tracking-[-0.025em] text-[clamp(48px,7vw,96px)]">
      Opta <em className="italic font-fraunces-display-em">Whitepaper</em> v1
    </h1>
    <p className="mt-8 max-w-[50ch] font-fraunces-text italic font-light leading-[1.5] opacity-75 text-[clamp(17px,1.4vw,20px)]">
      A protocol for tradable, self-aware options on Solana.
    </p>
  </div>
);

export default DocsIndex;
