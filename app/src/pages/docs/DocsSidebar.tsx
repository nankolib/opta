import type { FC } from "react";
import { NavLink } from "react-router-dom";
import { SECTIONS, type DocsSectionMeta } from "./sections";
import { MetaLabel, HairlineRule } from "../../components/layout";

/**
 * Docs sidebar — table of contents for all 16 whitepaper sections.
 *
 * Layout: sticky left column on md+ (top offset matches the body's
 * pt to align with where the body content begins, so the sidebar
 * is "stuck" from the moment the page loads). Stacks above the
 * body as a static block on narrow viewports (<md).
 *
 * Active route: NavLink's `isActive` callback drives a 2px crimson
 * left bar at `left: -12px` plus full-opacity ink. Same indicator
 * the right rail uses for the active sub-section — section-level
 * here, sub-section-level there.
 */
export const DocsSidebar: FC = () => {
  const sections = SECTIONS.filter((s) => s.kind === "section");
  const appendices = SECTIONS.filter((s) => s.kind === "appendix");

  return (
    <aside className="md:sticky md:top-[120px] md:self-start md:max-h-[calc(100vh-120px-32px)] md:overflow-y-auto">
      <MetaLabel as="div" className="mb-5">Whitepaper v1</MetaLabel>
      <ul className="list-none p-0 m-0 flex flex-col gap-[10px]">
        {sections.map((s) => (
          <SidebarItem key={s.slug} section={s} />
        ))}
      </ul>

      <HairlineRule className="my-7" />

      <MetaLabel as="div" className="mb-5">Appendices</MetaLabel>
      <ul className="list-none p-0 m-0 flex flex-col gap-[10px]">
        {appendices.map((s) => (
          <SidebarItem key={s.slug} section={s} />
        ))}
      </ul>
    </aside>
  );
};

const SidebarItem: FC<{ section: DocsSectionMeta }> = ({ section }) => (
  <li>
    <NavLink
      to={`/docs/${section.slug}`}
      className={({ isActive }) =>
        `relative grid grid-cols-[1.6em_1fr] items-baseline gap-2 no-underline transition-opacity duration-300 ease-opta hover:opacity-100 ${isActive ? "opacity-100" : "opacity-65"}`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden="true"
              className="absolute left-[-12px] top-0 bottom-0 w-[2px] bg-crimson"
            />
          )}
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-crimson">
            {section.number}
          </span>
          <span className="font-fraunces-text italic font-normal text-[14px] leading-snug text-ink">
            {section.title}
          </span>
        </>
      )}
    </NavLink>
  </li>
);

export default DocsSidebar;
