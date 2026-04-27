import type { FC } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useParams, Navigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import doc from "../../../../Opta_Whitepaper_v1.md?slice";
import { findSection } from "./sections";
import { SectionNumber, MetaLabel } from "../../components/layout";
import { Fade } from "../../components/ui";
import { markdownComponents } from "./markdown";
import { SectionFooter } from "./SectionFooter";
import { useDocs, type OutlineItem } from "./docsContext";
import { smoothScrollToId } from "./scrollUtils";

/**
 * DocsSection — body content for `/docs/:sectionSlug`.
 *
 * Renders, in order:
 *   1. Section marker (SectionNumber for sections, MetaLabel for appendices)
 *   2. Display title (Fraunces display h1)
 *   3. Body — markdown chunk via ReactMarkdown + remark-gfm + rehype-slug
 *   4. SectionFooter — Previous / Next neighbour cards
 *
 * Three Stage 3 additions on top of the Stage 2 baseline:
 *
 * - rehype-slug attaches `id` attributes to every h2/h3 in the
 *   rendered output (uses github-slugger; handles diacritics and
 *   collisions). The right rail's anchor links and scroll-spy use
 *   those ids.
 * - useLayoutEffect extracts h3 headings from the rendered DOM
 *   after each route change and writes them to DocsContext, where
 *   DocsOnThisPage reads them. Layout-effect (vs. plain effect)
 *   keeps the third-column reflow under one frame.
 * - <Fade key={section.slug}> wraps the article so each route
 *   navigation remounts the Fade and replays the animation
 *   (useReveal's once:true would otherwise stick after the first
 *   nav).
 *
 * Bonus: if the URL carries a hash on initial mount (page refresh
 * on a deep link), scroll instantly to that heading once content
 * has rendered. Smooth scroll on user clicks; instant on refresh.
 */
export const DocsSection: FC = () => {
  const { sectionSlug } = useParams<{ sectionSlug: string }>();
  const section = sectionSlug ? findSection(sectionSlug) : undefined;
  const { setOutline } = useDocs();
  const articleRef = useRef<HTMLElement>(null);

  // Extract h3 outline after each route change. useLayoutEffect runs
  // synchronously after DOM commit so the third column appears in
  // the same paint as the new content.
  useLayoutEffect(() => {
    if (!section || !articleRef.current) {
      setOutline([]);
      return;
    }
    const headings = Array.from(
      articleRef.current.querySelectorAll<HTMLHeadingElement>("h3"),
    );
    const items: OutlineItem[] = headings.map((h) => ({
      id: h.id,
      text: h.textContent ?? "",
      level: 3 as const,
    }));
    setOutline(items);
  }, [section?.slug, setOutline]);

  // Refresh-with-hash: jump (instant) to the hash target once the
  // headings exist in the DOM. rAF defers until the next frame, by
  // which time rehype-slug's ids are committed.
  useEffect(() => {
    if (!section) return;
    if (!window.location.hash) return;
    const id = window.location.hash.slice(1);
    requestAnimationFrame(() => smoothScrollToId(id, "instant"));
  }, [section?.slug]);

  if (!section) {
    return <Navigate to="/docs" replace />;
  }

  const chunk = doc.sections[section.slug] ?? "";

  return (
    <Fade key={section.slug}>
      <article ref={articleRef}>
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
          <ReactMarkdown
            components={markdownComponents}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSlug]}
          >
            {chunk}
          </ReactMarkdown>
        </div>
        <SectionFooter currentSlug={section.slug} />
      </article>
    </Fade>
  );
};

export default DocsSection;
