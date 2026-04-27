import type { FC } from "react";
// Imports use full subpaths into ./landing/* rather than the directory's
// barrel because Windows' case-insensitive filesystem makes `./landing`
// (the directory) collide with `./Landing.tsx` (this file). With a path
// segment after `landing/`, TS resolves the directory traversal cleanly.
import { LandingNav } from "./landing/LandingNav";
import { LandingNavContext } from "./landing/landingNavContext";
import { Hero } from "./landing/Hero";
import { ThesisSection } from "./landing/ThesisSection";
import { Marquee } from "./landing/Marquee";
import { ProductSection } from "./landing/ProductSection";
import { MarketSection } from "./landing/MarketSection";
import { CTASection } from "./landing/CTASection";
import { LandingFooter } from "./landing/LandingFooter";
import { PaperGrain } from "../components/layout";
import { useNavOverDark, usePaperPalette } from "../hooks";

/**
 * Landing — the v3 paper-surface design.
 *
 * Two cross-cutting concerns wired here:
 *
 * 1. Paper palette: `usePaperPalette` flips data-paper="true" on
 *    <html> in a layout effect so the document background is cream
 *    instead of the dark trader-page default. The wrapper div also
 *    sets bg-paper to cover the global AppShell's bg-bg-primary
 *    surface; the html flip on its own catches overscroll and
 *    route-transition flashes that the wrapper can't.
 *
 * 2. Nav-over-dark: `useNavOverDark` observes the sentinel that
 *    MarketSection mounts. Returned { setSentinelRef, isOverDark }
 *    is passed via LandingNavContext so LandingNav flips text and
 *    wordmark-dot colors when the dark MarketSection enters its
 *    hot-zone.
 *
 * PaperGrain renders outside the provider — it's z-9000 fixed and
 * has no relation to nav state.
 */
export const Landing: FC = () => {
  usePaperPalette();
  const navValue = useNavOverDark();

  return (
    <div className="relative bg-paper text-ink overflow-x-hidden">
      <PaperGrain />
      <LandingNavContext.Provider value={navValue}>
        <LandingNav />
        <Hero />
        <ThesisSection />
        <Marquee />
        <ProductSection />
        <MarketSection />
        <CTASection />
        <LandingFooter />
      </LandingNavContext.Provider>
    </div>
  );
};

export default Landing;
