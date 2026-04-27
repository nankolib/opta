import type { Components } from "react-markdown";
import { H2, H3, H4 } from "./headings";
import { P, A, Strong, Em, Blockquote, Hr } from "./prose";
import { Ul, Ol, Li } from "./lists";
import { Code, Pre } from "./code";
import { Table, THead, TBody, Tr, Th, Td } from "./tables";

/**
 * Component map passed to <ReactMarkdown components={...} />.
 *
 * Every markdown element the whitepaper produces routes through
 * a paper-palette React component here — no element falls back to
 * the browser's default rendering. h1 is intentionally omitted:
 * top-level headings are stripped by the Vite slicer (DocsSection
 * renders the section title via SectionNumber/MetaLabel + a
 * separate Fraunces display h1).
 */
export const markdownComponents: Components = {
  h2: H2,
  h3: H3,
  h4: H4,
  p: P,
  a: A,
  strong: Strong,
  em: Em,
  blockquote: Blockquote,
  hr: Hr,
  ul: Ul,
  ol: Ol,
  li: Li,
  code: Code,
  pre: Pre,
  table: Table,
  thead: THead,
  tbody: TBody,
  tr: Tr,
  th: Th,
  td: Td,
};
