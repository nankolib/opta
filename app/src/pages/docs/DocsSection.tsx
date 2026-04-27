import type { FC } from "react";
import { useParams, Navigate } from "react-router-dom";
import { findSection } from "./sections";
import { SectionNumber, MetaLabel } from "../../components/layout";

/**
 * DocsSection — body content for `/docs/:sectionSlug`.
 *
 * Stage 1: renders the section marker + title + a placeholder
 * paragraph. Stage 2 will pull the actual whitepaper content.
 *
 * Numbered sections render through SectionNumber (with the §
 * pilcrow). Appendices render through MetaLabel with an "Appendix
 * X" prefix instead — `§ A` would mis-apply the sectioning mark
 * since appendices are conventionally outside the main numbering.
 *
 * Unknown slugs redirect to `/docs`.
 */
export const DocsSection: FC = () => {
  const { sectionSlug } = useParams<{ sectionSlug: string }>();
  const section = sectionSlug ? findSection(sectionSlug) : undefined;

  if (!section) {
    return <Navigate to="/docs" replace />;
  }

  return (
    <article>
      {section.kind === "appendix" ? (
        <MetaLabel as="div" className="mb-12">
          Appendix {section.number} · {section.title}
        </MetaLabel>
      ) : (
        <SectionNumber
          number={section.number}
          label={section.title}
          className="mb-12"
        />
      )}
      <p className="max-w-[50ch] font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(16px,1.3vw,18px)]">
        Content coming in Stage 2.
      </p>
    </article>
  );
};

export default DocsSection;
