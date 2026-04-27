import { useEffect, useState } from "react";

type UseScrollSpyOptions = {
  /** IntersectionObserver `rootMargin`. Default tuned to upper-30% hot zone. */
  rootMargin?: string;
};

/**
 * Track which heading from a list of element ids is currently "in view"
 * and report it as the active id. Used by the Docs right rail to
 * highlight the sub-section the reader is currently reading.
 *
 * The default rootMargin "-20% 0px -70% 0px" defines an upper-30%
 * viewport hot zone — a heading enters "active" when its top edge
 * crosses below 20% from viewport top and exits when its top edge
 * crosses above 30%. That keeps the highlight one or two items
 * ahead of the reader's eye, which feels natural.
 *
 * If multiple headings sit in the zone simultaneously (a short
 * sub-section), the most-recently-intersecting one wins. If no
 * heading is in the zone (page scrolled past all of them, or above
 * the first), the active id stays at the last one observed — the
 * UI keeps something highlighted rather than blanking.
 */
export function useScrollSpy(
  ids: readonly string[],
  options: UseScrollSpyOptions = {},
): string | null {
  const { rootMargin = "-20% 0px -70% 0px" } = options;
  const [activeId, setActiveId] = useState<string | null>(null);

  // Joining the array gives a stable string identity for the deps
  // array — React's exhaustive-deps lint doesn't track array contents
  // by reference.
  const idsKey = ids.join("|");

  useEffect(() => {
    if (ids.length === 0) {
      setActiveId(null);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin, threshold: 0 },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, rootMargin]);

  return activeId;
}

export default useScrollSpy;
