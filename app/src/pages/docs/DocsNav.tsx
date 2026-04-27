import type { FC } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "../../components/brand";

/**
 * Docs page top nav — Wordmark left, "Launch app →" CTA right.
 *
 * Mirrors LandingNav's rhythm (fixed-positioned, mono uppercase
 * with wide tracking, paper-surface styling) but without the
 * mid-links cluster (the sidebar handles section navigation) and
 * without the over-dark color flip (Docs has no dark inversion).
 *
 * `pointer-events: none` on the nav with `[&>*]:pointer-events-auto`
 * on its children keeps the nav transparent to scroll-trapping
 * while leaving the wordmark and CTA clickable.
 */
export const DocsNav: FC = () => (
  <nav
    aria-label="Primary"
    className="pointer-events-none fixed inset-x-0 top-0 z-[200] flex items-center justify-between font-mono text-[11.5px] uppercase tracking-[0.18em] text-ink py-[22px] px-[clamp(20px,4vw,56px)] [&>*]:pointer-events-auto"
  >
    <Wordmark context="light" />
    <Link
      to="/markets"
      className="group inline-flex items-center gap-2 rounded-full border border-ink px-[14px] py-[9px] no-underline transition-[background-color,color] duration-500 ease-opta hover:bg-ink hover:text-paper"
    >
      Launch app
      <span className="transition-transform duration-500 ease-opta group-hover:translate-x-[3px]">
        →
      </span>
    </Link>
  </nav>
);

export default DocsNav;
