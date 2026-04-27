/**
 * Vertical offset (in px) reserved for the fixed DocsNav at the top
 * of the page. Anchor scrolls subtract this from the target's
 * absolute Y so the heading lands BELOW the nav, not underneath it.
 *
 * Mirrors the `pt-[120px]` on DocsLayout's main element — a heading
 * scrolled to viewport top would otherwise be hidden by the nav,
 * which is fixed at z-200 over the document.
 */
const NAV_OFFSET_PX = 120;

/**
 * Scroll the viewport so the element with the given id sits at
 * NAV_OFFSET_PX from the viewport top.
 *
 * `behavior="smooth"` (default) uses the browser's native
 * smooth-scroll easing. On platforms / browsers that don't support
 * it the scroll is instant — acceptable graceful degradation.
 *
 * `behavior="instant"` is used by the page-load hash-restore path
 * (DocsSection) so the user doesn't watch a smooth scroll happen
 * after the page paints.
 *
 * Always updates `location.hash` via `history.replaceState` —
 * keeps the URL in sync without spamming back/forward navigation.
 * Passive scroll-spy MUST NOT call this; only explicit user clicks.
 */
export function smoothScrollToId(id: string, behavior: ScrollBehavior = "smooth") {
  const el = document.getElementById(id);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - NAV_OFFSET_PX;
  window.scrollTo({ top, behavior });
  history.replaceState(null, "", `#${id}`);
}
