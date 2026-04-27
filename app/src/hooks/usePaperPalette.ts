import { useLayoutEffect } from "react";

/**
 * Flip the document to the paper-cream palette while a page is mounted.
 *
 * Sets data-paper="true" on <html> in a layout effect (synchronous,
 * before paint) and clears it on unmount. Pages render their own
 * full-bleed background on top, but the document-root flip prevents
 * a flash of the dark palette on route transitions and during
 * iOS / trackpad rubber-band overscroll.
 *
 * Used by Landing today; Docs will use the same hook.
 */
export function usePaperPalette() {
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-paper", "true");
    return () => {
      document.documentElement.removeAttribute("data-paper");
    };
  }, []);
}
