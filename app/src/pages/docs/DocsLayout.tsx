import type { FC } from "react";
import { Outlet } from "react-router-dom";
import { DocsNav } from "./DocsNav";
import { DocsSidebar } from "./DocsSidebar";
import { PaperGrain } from "../../components/layout";
import { usePaperPalette } from "../../hooks";

/**
 * DocsLayout — paper-surface page shell shared by every Docs route.
 *
 * Three foundational concerns wired here:
 *
 * 1. `usePaperPalette()` flips data-paper="true" on <html> in a
 *    layout effect so the document background is cream. The wrapper
 *    div also sets bg-paper to cover the global AppShell's
 *    bg-bg-primary surface.
 *
 * 2. `<PaperGrain />` mounts the z-9000 SVG-noise overlay (matches
 *    Landing).
 *
 * 3. `<DocsNav />` is fixed at the top; `<DocsSidebar />` sticks
 *    below the nav at md+ breakpoints and stacks above content at
 *    narrow viewports. Inner routes (DocsIndex, DocsSection) render
 *    into <Outlet />.
 *
 * The body's `pt-[120px]` matches the sidebar's sticky `top-[120px]`
 * so the sidebar is "stuck" from initial render; together they
 * leave room for the ~74px nav plus a 46px breathing strip.
 */
export const DocsLayout: FC = () => {
  usePaperPalette();

  return (
    <div className="relative bg-paper text-ink overflow-x-hidden">
      <PaperGrain />
      <DocsNav />
      <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-x-[clamp(40px,6vw,80px)] gap-y-12">
          <DocsSidebar />
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default DocsLayout;
