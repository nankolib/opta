import type { FC } from "react";
import { Link } from "react-router-dom";
import { SECTIONS, type DocsSectionMeta } from "./sections";

type SectionFooterProps = {
  /** The current section's slug — used to compute neighbour positions. */
  currentSlug: string;
};

/**
 * Previous / Next neighbour cards rendered at the bottom of every
 * section page (NOT the /docs index).
 *
 * Two-column grid on md+, single column below. First section
 * (executive-summary) has no Previous; last appendix
 * (appendix-c-references) has no Next — the missing card collapses
 * via `display: none` on mobile and remains an empty grid cell on
 * desktop so the present card stays in its lane.
 */
export const SectionFooter: FC<SectionFooterProps> = ({ currentSlug }) => {
  const idx = SECTIONS.findIndex((s) => s.slug === currentSlug);
  if (idx === -1) return null;
  const prev = idx > 0 ? SECTIONS[idx - 1] : null;
  const next = idx < SECTIONS.length - 1 ? SECTIONS[idx + 1] : null;

  return (
    <nav
      aria-label="Section navigation"
      className="mt-20 grid grid-cols-1 md:grid-cols-2 gap-4 max-w-[68ch]"
    >
      {prev ? (
        <FooterCard section={prev} direction="prev" />
      ) : (
        <div className="hidden md:block" aria-hidden="true" />
      )}
      {next ? (
        <FooterCard section={next} direction="next" />
      ) : (
        <div className="hidden md:block" aria-hidden="true" />
      )}
    </nav>
  );
};

type FooterCardProps = {
  section: DocsSectionMeta;
  direction: "prev" | "next";
};

const FooterCard: FC<FooterCardProps> = ({ section, direction }) => {
  const isPrev = direction === "prev";
  const eyebrow = isPrev ? "← Previous" : "Next →";
  const alignClass = isPrev ? "text-left" : "text-right";

  return (
    <Link
      to={`/docs/${section.slug}`}
      className={`group block border border-rule rounded-md p-5 no-underline transition-colors duration-300 ease-opta hover:border-ink ${alignClass}`}
    >
      <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-60 mb-2 transition-opacity duration-300 ease-opta group-hover:opacity-100">
        {eyebrow}
      </div>
      <div className="font-fraunces-text italic text-[18px] leading-snug text-ink">
        {section.title}
      </div>
    </Link>
  );
};

export default SectionFooter;
