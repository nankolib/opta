import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Detect when a dark section occupies the top zone of the viewport.
 *
 * The caller places a sentinel element at the very top of the dark
 * section (typically a 1px-tall <span> at the top of the dark
 * MarketSection on Landing). This hook observes the sentinel and
 * reports `isOverDark = true` while it sits inside a hot-zone aligned
 * with where the persistent nav lives.
 *
 * The rootMargin "-60px 0px -85% 0px" is taken verbatim from the v3
 * design — it crops the IntersectionObserver root to a 100px-tall
 * band starting 60px below the top of the viewport, so the sentinel
 * only intersects that band when its dark section is currently behind
 * the nav.
 *
 * Use the returned `setSentinelRef` as a React ref callback on the
 * sentinel element, and read `isOverDark` from anywhere in the nav.
 */
export function useNavOverDark() {
  const [isOverDark, setIsOverDark] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const setSentinelRef = useCallback((el: HTMLElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!el) {
      setIsOverDark(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setIsOverDark(entry.isIntersecting);
        }
      },
      { rootMargin: "-60px 0px -85% 0px", threshold: 0 },
    );
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    return () => {
      if (observerRef.current) observerRef.current.disconnect();
    };
  }, []);

  return { setSentinelRef, isOverDark };
}

export default useNavOverDark;
