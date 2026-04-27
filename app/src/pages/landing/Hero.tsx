import type { FC } from "react";
import { Reveal, Fade } from "../../components/ui";
import { MetaLabel } from "../../components/layout";
import { HeroNativeDot } from "../../components/brand";
import { useHeroParallax } from "../../hooks/useHeroParallax";

/**
 * Hero — page intro with the staggered three-line headline,
 * parallax orb, 12-column hairline grid, drifting radial glow, and
 * the live/version/audit metadata row.
 *
 * Headline reveals fire on mount with a 220ms stagger (l1 at 0ms,
 * l2 at 220ms, l3 at 440ms). HeroNativeDot's animation-delay is
 * 1.6s in CSS — it lands AFTER the third line finishes rising
 * (~440ms reveal start + 1.4s rise transition = ~1.84s). That's
 * the intended cadence per the v3 design.
 *
 * Lede + scroll cue fade in at 1100ms / 1300ms via Fade.
 *
 * Background gradients use rgba derived from --color-crimson
 * (#D7263D) and --color-ink (#0A0A08) at non-token alpha values;
 * documented inline rather than promoted to tokens since they're
 * one-off composition details.
 */
export const Hero: FC = () => {
  const orbRef = useHeroParallax<HTMLDivElement>();

  return (
    <header
      id="top"
      className="relative isolate flex min-h-screen min-h-[100svh] flex-col justify-between pt-[140px] pb-20"
    >
      {/* background layers */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        {/* 12-column hairline rules with feathered top/bottom mask */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--color-rule-soft) 1px, transparent 1px)",
            backgroundSize: "calc(100% / 12) 100%",
            maskImage:
              "linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)",
            WebkitMaskImage:
              "linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)",
          }}
        />
        {/* crimson radial glow drifting */}
        <div
          className="absolute left-[62%] top-[38%] -translate-x-1/2 -translate-y-1/2 h-[55vw] w-[55vw] max-h-[760px] max-w-[760px] animate-hero-glow-drift will-change-transform [filter:blur(40px)]"
          style={{
            background:
              "radial-gradient(closest-side, rgba(215,38,61,.18), rgba(215,38,61,0) 70%)",
          }}
        />
        {/* dark orb (parallax target) */}
        <div
          ref={orbRef}
          className="absolute -right-[8vw] -bottom-[12vw] h-[46vw] w-[46vw] max-h-[640px] max-w-[640px] rounded-full will-change-transform [filter:blur(30px)]"
          style={{
            background:
              "radial-gradient(circle at 30% 30%, rgba(10,10,8,.10), rgba(10,10,8,0) 65%)",
          }}
        />
      </div>

      {/* foreground content */}
      <div className="relative z-[2] mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)]">
        {/* metadata row */}
        <div className="mb-[18svh] flex flex-wrap gap-x-[22px] gap-y-2">
          <MetaLabel className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block h-[6px] w-[6px] rounded-full bg-crimson animate-pulse-live"
            />
            Solana mainnet
          </MetaLabel>
          <MetaLabel>v0.1 — April 2026</MetaLabel>
          <MetaLabel>Audited · OtterSec / Sec3</MetaLabel>
        </div>

        {/* headline */}
        <h1 className="m-0 font-fraunces-display font-light text-ink leading-[0.96] tracking-[-0.035em] text-[clamp(56px,11.5vw,168px)]">
          <Reveal as="span" delay={0} className="block">
            Hedging,
          </Reveal>
          <Reveal as="span" delay={220} className="block pl-[clamp(16px,6vw,96px)]">
            <span>made </span>
            <span className="italic font-fraunces-display-em">native</span>
            <HeroNativeDot />
          </Reveal>
          <Reveal as="span" delay={440} className="block pl-[clamp(32px,12vw,192px)]">
            to&nbsp;Solana.
          </Reveal>
        </h1>

        {/* foot: lede + scroll cue */}
        <div className="mt-[clamp(48px,10vh,120px)] flex flex-wrap items-end justify-between gap-5">
          <Fade
            as="p"
            delay={1100}
            className="font-fraunces-text italic font-light leading-[1.45] text-ink opacity-85 max-w-[38ch] text-[clamp(18px,1.6vw,22px)]"
          >
            An institutional options layer engineered around the Token-2022
            standard — written into the asset itself, not bolted on beside it.
          </Fade>
          <Fade
            as="span"
            delay={1300}
            className="flex items-center gap-[10px] font-mono text-[11px] uppercase tracking-[0.22em] text-ink opacity-70"
          >
            <span
              aria-hidden="true"
              className="inline-block h-px w-[48px] origin-left bg-ink animate-scrollbar"
            />
            Scroll
          </Fade>
        </div>
      </div>
    </header>
  );
};

export default Hero;
