import { createContext, useContext } from "react";

export type OutlineItem = {
  /** id attribute on the heading element (set by rehype-slug) */
  id: string;
  /** Heading text content, used as the rail link label */
  text: string;
  /** Heading depth — 2 or 3. Stage 3 only emits level 3 (h3). */
  level: 2 | 3;
};

export type DocsContextValue = {
  /** Current section's heading outline. Empty when on /docs index or on a section with no h3 sub-headings. */
  outline: OutlineItem[];
  /** Setter — called by DocsSection's useLayoutEffect after the markdown chunk renders. */
  setOutline: (items: OutlineItem[]) => void;
};

/**
 * Carries the current Docs section's heading outline across the
 * Docs page tree. DocsSection writes the outline after rendering;
 * DocsOnThisPage reads it for the right-rail TOC. DocsLayout reads
 * it to decide whether the third grid column should render.
 *
 * Provided once at the top of <DocsLayout>. Routes that don't host
 * sub-section content (the /docs index, sections without h3s) end
 * up with an empty outline.
 */
export const DocsContext = createContext<DocsContextValue | null>(null);

export function useDocs(): DocsContextValue {
  const ctx = useContext(DocsContext);
  if (!ctx) {
    throw new Error("useDocs must be used within <DocsContext.Provider>");
  }
  return ctx;
}
