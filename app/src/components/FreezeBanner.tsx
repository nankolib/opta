import { useLayoutEffect, useRef, useState } from "react";

// =============================================================================
// FreezeBanner — persistent global incident notice
// =============================================================================
//
// Shown on EVERY route (mounted in AppShell, above <Routes>). Announces that
// on-chain pricing is paused while the Switchboard oracle lane is frozen.
//
// COPY IS VERBATIM AND APPROVED — do not reword, re-case, or re-punctuate.
// No `uppercase`/`capitalize` utility is applied for the same reason.
//
// LAYOUT CONTRACT
//   The bar is `fixed` at the very top, so it takes no space in normal flow.
//   To stop it covering content it publishes its measured height as the
//   `--opta-banner-h` custom property on <html>; index.css consumes that in
//   exactly four places:
//       body          padding-top   (pushes normal flow down)
//       .h-screen     height        (the 4 terminal pages pin to viewport)
//       .min-h-screen min-height    (the paper pages)
//       AppNav        top           (the one fixed bar that must sit below us)
//   Every one of those is `calc(... - var(--opta-banner-h))` or a bare
//   `var(--opta-banner-h)`, and the property defaults to `0px`. So when the
//   banner is dismissed or removed the CSS collapses to exactly what shipped
//   before it existed — no dead padding to clean up later.
//
//   Height is measured, not hardcoded, because the copy wraps to two lines on
//   narrow viewports. A ResizeObserver keeps the property correct across
//   rotation and font-size changes.
//
// Z-ORDER
//   z-[500]. Deliberately above AppNav (200), modals (300) and the tour
//   overlay (400): an incident notice that a modal can hide is not a notice.
//   Below PaperGrain (9000), which is pointer-events-none decoration.
//
// DISMISSAL
//   Per SESSION, via sessionStorage — a new tab or a fresh visit shows it
//   again, which is the point: this is a live-incident notice, not a
//   changelog. Reads/writes are wrapped because sessionStorage throws outright
//   in some privacy modes rather than returning null.
// =============================================================================

const DISMISS_KEY = "opta.freezeBanner.dismissed";

/** Approved copy. Verbatim — see header. */
const COPY = "pricing temporarily paused (precautionary). funds & positions unaffected.";

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false; // storage blocked → show the notice, fail loud not silent
  }
}

function writeDismissed(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* non-fatal: the banner still hides for this render, just not on reload */
  }
}

export function FreezeBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const barRef = useRef<HTMLDivElement | null>(null);

  // Publish/retract --opta-banner-h. useLayoutEffect so the offset lands in the
  // same frame as the bar itself — a useEffect here shows one frame of content
  // sitting under the banner on first paint.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const clear = () => root.style.setProperty("--opta-banner-h", "0px");

    if (dismissed) {
      clear();
      return;
    }
    const el = barRef.current;
    if (!el) return;

    const apply = () =>
      root.style.setProperty("--opta-banner-h", `${el.offsetHeight}px`);
    apply();

    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      clear();
    };
  }, [dismissed]);

  if (dismissed) return null;

  return (
    <div
      ref={barRef}
      role="status"
      aria-live="polite"
      data-testid="freeze-banner"
      // Inverted against the active palette (l-text on l-bg): a near-black bar
      // on the paper surfaces, a cream bar on the terminal ones. Both are the
      // designed text/background pair, so contrast is AA by construction and
      // the bar reads as a system band rather than page furniture.
      className="fixed inset-x-0 top-0 z-[500] flex items-center justify-center gap-3 bg-l-text px-4 py-[9px] font-mono text-[11.5px] leading-[1.45] text-l-bg"
    >
      <span
        aria-hidden="true"
        className="inline-block h-[6px] w-[6px] shrink-0 rounded-full bg-l-dot"
      />
      <span className="text-center">{COPY}</span>
      <button
        type="button"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
        aria-label="Dismiss notice"
        className="absolute right-3 grid h-[20px] w-[20px] place-items-center rounded-full text-l-bg/70 transition-colors duration-200 hover:bg-l-bg/15 hover:text-l-bg"
      >
        <svg viewBox="0 0 10 10" className="h-[9px] w-[9px]" aria-hidden="true">
          <path
            d="M1 1l8 8M9 1l-8 8"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
}
