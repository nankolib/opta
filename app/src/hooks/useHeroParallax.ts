import { useEffect, useRef } from "react";

type UseHeroParallaxOptions = {
  enabled?: boolean;
};

/**
 * Subtle scroll-driven parallax on the hero orb.
 *
 * Translates the orb downward at 18% of scrollY, capped at 220px,
 * RAF-batched so the listener never dirties layout per scroll
 * event. The effect is intentionally barely-perceptible — enough
 * to make the page feel three-dimensional, not enough to call
 * attention to itself.
 *
 * Honors prefers-reduced-motion by attaching no listener at all.
 *
 * Returns a ref to attach to the orb element.
 */
export function useHeroParallax<T extends HTMLElement = HTMLDivElement>(
  options: UseHeroParallaxOptions = {},
): React.RefObject<T | null> {
  const { enabled = true } = options;
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    const node = ref.current;
    if (!node) return;

    let ticking = false;
    function update() {
      if (!node) return;
      const y = window.scrollY;
      const t = Math.min(y * 0.18, 220);
      node.style.transform = `translateY(${t}px)`;
      ticking = false;
    }
    function onScroll() {
      if (!ticking) {
        window.requestAnimationFrame(update);
        ticking = true;
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, [enabled]);

  return ref;
}

export default useHeroParallax;
