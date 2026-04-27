export type DocsSectionMeta = {
  /** kebab-case URL slug — `/docs/:sectionSlug` */
  slug: string;
  /** Display number — "01"–"13" for sections, "A"/"B"/"C" for appendices */
  number: string;
  /** Display title (without any "Appendix X —" prefix; appendix prefix is supplied by the renderer) */
  title: string;
  /** Distinguishes numbered sections (with §) from appendices (with "Appendix X" prefix) */
  kind: "section" | "appendix";
};

/**
 * Whitepaper section map for the Docs page TOC and routing.
 *
 * Order matches Opta_Whitepaper_v1.md's table of contents (sections
 * 1–13 then appendices A–C). Each entry drives both the sidebar TOC
 * and the `/docs/:sectionSlug` route in App.tsx.
 */
export const SECTIONS: readonly DocsSectionMeta[] = [
  { slug: "executive-summary", number: "01", title: "Executive Summary", kind: "section" },
  { slug: "the-market-thesis", number: "02", title: "The Market Thesis", kind: "section" },
  { slug: "why-on-chain-options-have-not-yet-worked", number: "03", title: "Why On-Chain Options Have Not Yet Worked", kind: "section" },
  { slug: "the-living-option-token", number: "04", title: "The Living Option Token", kind: "section" },
  { slug: "architecture", number: "05", title: "Architecture", kind: "section" },
  { slug: "pricing", number: "06", title: "Pricing", kind: "section" },
  { slug: "the-three-layer-liquidity-model", number: "07", title: "The Three-Layer Liquidity Model", kind: "section" },
  { slug: "security", number: "08", title: "Security", kind: "section" },
  { slug: "current-state-and-honest-limitations", number: "09", title: "Current State and Honest Limitations", kind: "section" },
  { slug: "progressive-decentralisation-roadmap", number: "10", title: "Progressive Decentralisation Roadmap", kind: "section" },
  { slug: "the-fourth-primitive-claim", number: "11", title: "The Fourth Primitive Claim", kind: "section" },
  { slug: "comparison-with-prior-art", number: "12", title: "Comparison With Prior Art", kind: "section" },
  { slug: "conclusion", number: "13", title: "Conclusion", kind: "section" },
  { slug: "appendix-a-instruction-set", number: "A", title: "Instruction Set", kind: "appendix" },
  { slug: "appendix-b-account-structures", number: "B", title: "Account Structures", kind: "appendix" },
  { slug: "appendix-c-references", number: "C", title: "References", kind: "appendix" },
];

export function findSection(slug: string): DocsSectionMeta | undefined {
  return SECTIONS.find((s) => s.slug === slug);
}
