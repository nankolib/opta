import { createContext, useContext } from "react";

type LandingNavContextValue = {
  /**
   * Ref callback for the sentinel element — placed at the top of
   * the dark MarketSection. The hook observes this element to
   * determine when the nav is over a dark surface.
   */
  setSentinelRef: (el: HTMLElement | null) => void;
  /** True while the dark MarketSection occupies the nav's hot-zone. */
  isOverDark: boolean;
};

/**
 * Carries the `useNavOverDark` hook's state across the Landing page.
 *
 * Provided once at the top of <LandingPage> (in 3b.ii), consumed by
 * <LandingNav> (reads `isOverDark`) and <MarketSection> (mounts the
 * sentinel via `setSentinelRef`). MarketSection deliberately does
 * not import the hook — the hook owns the state, MarketSection just
 * hosts the sentinel that drives it.
 */
export const LandingNavContext = createContext<LandingNavContextValue | null>(null);

export function useLandingNav(): LandingNavContextValue {
  const ctx = useContext(LandingNavContext);
  if (!ctx) {
    throw new Error("useLandingNav must be used within a <LandingNavContext.Provider>");
  }
  return ctx;
}
