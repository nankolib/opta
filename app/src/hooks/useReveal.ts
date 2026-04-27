import { useEffect, useRef, useState } from "react";

type UseRevealOptions = {
  /** IntersectionObserver `threshold`. Default 0.18 — matches v3 design's reveal trigger. */
  threshold?: number;
  /** IntersectionObserver `rootMargin`. Default "0px 0px -8% 0px" so reveals fire just before the element fully enters. */
  rootMargin?: string;
  /** When true (default), the observer disconnects after the first reveal — animations play once and stay. */
  once?: boolean;
};

/**
 * Observe a DOM element and report when it has entered the viewport.
 *
 * Used internally by Reveal, Fade, Strike, and Tracer; also exported
 * for any paper-surface component that needs intersection-driven
 * state without one of those wrappers.
 *
 * Reduced-motion users still get the state flip — the CSS-side
 * transitions snap to ~0ms via the global prefers-reduced-motion rule
 * in index.css.
 */
export function useReveal<T extends HTMLElement = HTMLElement>(
  options: UseRevealOptions = {},
): readonly [React.RefObject<T | null>, boolean] {
  const { threshold = 0.18, rootMargin = "0px 0px -8% 0px", once = true } = options;
  const ref = useRef<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setIsVisible(true);
            if (once) observer.unobserve(entry.target);
          } else if (!once) {
            setIsVisible(false);
          }
        }
      },
      { threshold, rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, rootMargin, once]);

  return [ref, isVisible] as const;
}

export default useReveal;
