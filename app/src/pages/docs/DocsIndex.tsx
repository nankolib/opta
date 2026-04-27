import type { FC } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import doc from "../../../../Opta_Whitepaper_v1.md?slice";
import { markdownComponents } from "./markdown";

/**
 * DocsIndex — body content for the `/docs` index route.
 *
 * Title card: the whitepaper title in Fraunces display, plus the
 * abstract paragraph rendered through ReactMarkdown so any inline
 * emphasis edits in the abstract pick up the same paper-palette
 * styling as section bodies. The abstract source lives at the top
 * of Opta_Whitepaper_v1.md (between the first two `---` HR rules)
 * and is sliced by the Vite plugin alongside the section chunks.
 *
 * No section footer here — the index is the entry surface, not a
 * section in the navigation chain.
 */
export const DocsIndex: FC = () => (
  <div>
    <h1 className="m-0 font-fraunces-display font-light text-ink leading-[0.95] tracking-[-0.025em] text-[clamp(48px,7vw,96px)]">
      Opta <em className="italic font-fraunces-display-em">Whitepaper</em> v1
    </h1>
    <div className="mt-8">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {doc.abstract}
      </ReactMarkdown>
    </div>
  </div>
);

export default DocsIndex;
