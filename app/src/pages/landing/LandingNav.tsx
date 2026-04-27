import type { FC } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "../../components/brand";
import { useLandingNav } from "./landingNavContext";

/**
 * Fixed page nav — wordmark left, mid-link cluster center, "Launch
 * app" CTA right. Reads `isOverDark` from the LandingNav context to
 * flip text color, wordmark dot color (light → dark), and CTA
 * border behavior when the dark MarketSection enters the nav's
 * hot-zone.
 *
 * Mid-link `Docs` exception: the v3 design's secondary "Docs" link
 * targets an in-page anchor on the static demo. Since this app has
 * a real /docs route, that link uses React Router instead. The
 * other mid-links (#thesis / #product / #market) remain in-page
 * anchor links to scroll to those sections of Landing.
 *
 * `pointer-events: none` on the nav itself + `pointer-events: auto`
 * on its children is the v3 trick to keep the nav transparent to
 * scroll-trapping while letting the wordmark / links / CTA stay
 * clickable.
 */
export const LandingNav: FC = () => {
  const { isOverDark } = useLandingNav();
  const colorClass = isOverDark ? "text-paper" : "text-ink";
  const ctaBorderClass = isOverDark
    ? "border-paper hover:bg-paper hover:text-ink"
    : "border-ink hover:bg-ink hover:text-paper";

  return (
    <nav
      aria-label="Primary"
      className={`pointer-events-none fixed inset-x-0 top-0 z-[200] flex items-center justify-between font-mono text-[11.5px] uppercase tracking-[0.18em] py-[22px] px-[clamp(20px,4vw,56px)] transition-colors duration-500 ease-opta [&>*]:pointer-events-auto ${colorClass}`}
    >
      <Wordmark context={isOverDark ? "dark" : "light"} />

      <div className="hidden sm:flex gap-7">
        <a
          href="#thesis"
          className="opacity-75 transition-opacity duration-500 ease-opta hover:opacity-100"
        >
          Thesis
        </a>
        <a
          href="#product"
          className="opacity-75 transition-opacity duration-500 ease-opta hover:opacity-100"
        >
          Product
        </a>
        <a
          href="#market"
          className="opacity-75 transition-opacity duration-500 ease-opta hover:opacity-100"
        >
          Market
        </a>
        <Link
          to="/docs"
          className="opacity-75 no-underline transition-opacity duration-500 ease-opta hover:opacity-100"
        >
          Docs
        </Link>
      </div>

      <Link
        to="/markets"
        className={`group inline-flex items-center gap-2 rounded-full border px-[14px] py-[9px] no-underline transition-[background-color,color] duration-500 ease-opta ${ctaBorderClass}`}
      >
        Launch app
        <span className="transition-transform duration-500 ease-opta group-hover:translate-x-[3px]">
          →
        </span>
      </Link>
    </nav>
  );
};

export default LandingNav;
