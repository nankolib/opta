import type { FC } from "react";
import { MetaLabel } from "../../components/layout";
import { useScrollSpy } from "../../hooks";
import { useDocs } from "./docsContext";
import { smoothScrollToId } from "./scrollUtils";

/**
 * Right rail — "On this page" sub-section TOC.
 *
 * Reads the current section's outline from DocsContext (populated
 * by DocsSection after its markdown chunk renders). Runs scroll-spy
 * over the heading ids and renders each as a clickable anchor.
 *
 * Active item gets full-opacity ink + a 2px crimson left bar at
 * `left: -12px` — the same indicator the sidebar uses for the
 * current route, mirroring the design across both surfaces.
 *
 * Renders `null` if the outline is empty. DocsLayout still
 * collapses to a 2-column grid on those routes; this null is a
 * defence-in-depth in case the layout ever forgets to gate.
 */
export const DocsOnThisPage: FC = () => {
  const { outline } = useDocs();
  const ids = outline.map((o) => o.id);
  const activeId = useScrollSpy(ids);

  if (outline.length === 0) return null;

  return (
    <aside
      aria-label="On this page"
      className="hidden lg:block lg:sticky lg:top-[120px] lg:self-start lg:max-h-[calc(100vh-120px-32px)] lg:overflow-y-auto"
    >
      <MetaLabel as="div" className="mb-5">On this page</MetaLabel>
      <ul className="list-none p-0 m-0 flex flex-col gap-3">
        {outline.map((item) => {
          const isActive = activeId === item.id;
          return (
            <li key={item.id} className="relative">
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute left-[-12px] top-0 bottom-0 w-[2px] bg-crimson"
                />
              )}
              <a
                href={`#${item.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  smoothScrollToId(item.id);
                }}
                className={`block font-fraunces-text italic text-[14px] leading-snug text-ink no-underline transition-opacity duration-300 ease-opta hover:opacity-100 ${isActive ? "opacity-100" : "opacity-65"}`}
              >
                {item.text}
              </a>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};

export default DocsOnThisPage;
