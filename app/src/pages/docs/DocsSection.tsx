import type { FC } from "react";
import { useParams, Navigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import doc from "../../../../Opta_Whitepaper_v1.md?slice";
import { findSection } from "./sections";
import { SectionNumber, MetaLabel } from "../../components/layout";
import { markdownComponents } from "./markdown";
import { SectionFooter } from "./SectionFooter";

/**
 * DocsSection — body content for `/docs/:sectionSlug`.
 *
 * Renders, in order:
 *   1. Section marker — SectionNumber for numbered sections (§ 01),
 *      MetaLabel for appendices (Appendix A · …). The pilcrow `§`
 *      is a sectioning convention that doesn't apply to appendices.
 *   2. Display title — Fraunces display h1 with the section title.
 *   3. Body content — the slug's markdown chunk routed through
 *      ReactMarkdown + remark-gfm with the paper-palette component
 *      map. Every element renders through a styled component; no
 *      raw browser defaults.
 *   4. Section footer — Previous / Next neighbour cards.
 *
 * Unknown slugs redirect to `/docs`.
 */
export const DocsSection: FC = () => {
  const { sectionSlug } = useParams<{ sectionSlug: string }>();
  const section = sectionSlug ? findSection(sectionSlug) : undefined;

  if (!section) {
    return <Navigate to="/docs" replace />;
  }

  const chunk = doc.sections[section.slug] ?? "";

  return (
    <article>
      {section.kind === "appendix" ? (
        <MetaLabel as="div" className="mb-6">
          Appendix {section.number} · {section.title}
        </MetaLabel>
      ) : (
        <SectionNumber number={section.number} label={section.title} className="mb-6" />
      )}
      <h1 className="m-0 mb-12 font-fraunces-display font-light text-ink leading-[0.98] tracking-[-0.025em] text-[clamp(40px,5.6vw,72px)]">
        {section.title}
      </h1>
      <div>
        <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
          {chunk}
        </ReactMarkdown>
      </div>
      <SectionFooter currentSlug={section.slug} />
    </article>
  );
};

export default DocsSection;
