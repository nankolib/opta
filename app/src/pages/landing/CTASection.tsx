import type { FC } from "react";
import { Link } from "react-router-dom";
import { Fade } from "../../components/ui";
import { CtaThesisDot } from "../../components/brand";

/**
 * Closing CTA — "Trade the thesis·" with the static CtaThesisDot,
 * sub-line, and two pill buttons.
 *
 * "Launch app" routes to /markets via React Router (the post-landing
 * entry point). "Read the docs" routes to /docs (the existing Docs
 * page). The v3 design's secondary button targets an in-page #docs
 * anchor on the static demo, but since this app has a real /docs
 * route, linking there directly is the right call.
 */
export const CTASection: FC = () => (
  <section
    id="launch"
    className="relative overflow-hidden text-center py-[clamp(120px,22vh,240px)]"
  >
    {/* breathing crimson glow */}
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 z-0 -translate-x-1/2 -translate-y-1/2 h-[min(1100px,90vw)] w-[min(1100px,90vw)] [filter:blur(50px)] animate-cta-breathe"
      style={{
        background:
          "radial-gradient(closest-side, rgba(215,38,61,.20), rgba(215,38,61,0) 70%)",
      }}
    />

    <div className="relative z-[2] mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)]">
      <h2 className="m-0 mb-3 inline-flex items-baseline font-fraunces-display font-light leading-[0.98] tracking-[-0.035em] text-[clamp(56px,10vw,152px)]">
        <span>Trade the&nbsp;</span>
        <em className="italic font-fraunces-display-em">thesis</em>
        <CtaThesisDot />
      </h2>
      <Fade
        as="p"
        className="mx-auto mb-14 mt-6 max-w-[50ch] font-fraunces-text italic font-light opacity-75 text-[clamp(16px,1.4vw,20px)]"
      >
        Mainnet, today. Audits and SDK below.
      </Fade>
      <Fade className="inline-flex flex-wrap justify-center gap-[14px]">
        <Link
          to="/markets"
          className="group inline-flex items-center gap-[10px] rounded-full border border-ink bg-ink px-[22px] py-[14px] font-mono text-[11.5px] uppercase tracking-[0.2em] text-paper no-underline transition-[background-color,color] duration-500 ease-opta hover:bg-transparent hover:text-ink"
        >
          Launch app
          <span className="transition-transform duration-500 ease-opta group-hover:translate-x-[3px]">
            →
          </span>
        </Link>
        <Link
          to="/docs"
          className="group inline-flex items-center gap-[10px] rounded-full border border-ink bg-transparent px-[22px] py-[14px] font-mono text-[11.5px] uppercase tracking-[0.2em] text-ink no-underline transition-[background-color,color] duration-500 ease-opta hover:bg-ink hover:text-paper"
        >
          Read the docs
          <span className="transition-transform duration-500 ease-opta group-hover:translate-x-[3px]">
            →
          </span>
        </Link>
      </Fade>
    </div>
  </section>
);

export default CTASection;
