import type { FC } from "react";
import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { DocsSidebar } from "./DocsSidebar";
import { DocsOnThisPage } from "./DocsOnThisPage";
import { DocsContext, type OutlineItem } from "./docsContext";
import { PaperGrain } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { usePaperPalette } from "../../hooks";

/**
 * DocsLayout — paper-surface page shell shared by every Docs route.
 *
 * Three foundational concerns wired here:
 *
 * 1. `usePaperPalette()` flips data-paper="true" on <html> so the
 *    document background is cream. The wrapper div also sets
 *    bg-paper to cover the global AppShell's bg-bg-primary surface.
 *
 * 2. `<PaperGrain />` mounts the z-9000 SVG-noise overlay (matches
 *    Landing).
 *
 * 3. `<AppNav />` is fixed at the top — the canonical 5-link app
 *    nav (Markets / Trade / Write / Portfolio / Docs); DOCS lights
 *    up on /docs and /docs/<slug> via NavLink's default partial
 *    match. `<DocsSidebar />` sticks below the nav at md+
 *    breakpoints; `<DocsOnThisPage />` sticks on the right at lg+.
 *    Inner routes (DocsIndex, DocsSection) render into <Outlet />
 *    in the middle column.
 *
 * Grid template adapts:
 *   mobile (<md):    1 column   — sidebar stacks above body
 *   md (no rail):    2 columns  — sidebar | body
 *   lg + has-outline: 3 columns — sidebar | body | rail
 *
 * The third column appears only when the current route has an
 * outline (populated by DocsSection after its markdown chunk
 * renders). On `/docs` index and on sections without h3 headings,
 * the rail collapses entirely and the body widens.
 */
export const DocsLayout: FC = () => {
  usePaperPalette();
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const location = useLocation();

  const isIndex = location.pathname === "/docs" || location.pathname === "/docs/";
  const showRail = !isIndex && outline.length > 0;
  const gridCols = showRail
    ? "md:grid-cols-[260px_1fr] lg:grid-cols-[260px_1fr_220px]"
    : "md:grid-cols-[260px_1fr]";

  return (
    <DocsContext.Provider value={{ outline, setOutline }}>
      <div className="relative bg-paper text-ink overflow-x-hidden">
        <PaperGrain />
        <AppNav />
        <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
          <div className={`grid grid-cols-1 ${gridCols} gap-x-[clamp(40px,6vw,80px)] gap-y-12`}>
            <DocsSidebar />
            <Outlet />
            {showRail && <DocsOnThisPage />}
          </div>
        </main>
      </div>
    </DocsContext.Provider>
  );
};

export default DocsLayout;
