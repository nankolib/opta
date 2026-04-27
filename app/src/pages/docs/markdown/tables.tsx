import type { ComponentPropsWithoutRef, FC } from "react";

/**
 * Table wrapper. Renders inside an overflow-x-auto div so wide
 * tables (e.g. the Comparison With Prior Art table in section 12,
 * which has seven columns) scroll horizontally on narrow viewports
 * rather than blowing out the reading column.
 */
export const Table: FC<ComponentPropsWithoutRef<"table">> = ({ children, ...rest }) => (
  <div className="overflow-x-auto my-8">
    <table className="w-full text-[15px] border-collapse" {...rest}>
      {children}
    </table>
  </div>
);

export const THead: FC<ComponentPropsWithoutRef<"thead">> = ({ children, ...rest }) => (
  <thead className="border-b border-rule" {...rest}>
    {children}
  </thead>
);

export const TBody: FC<ComponentPropsWithoutRef<"tbody">> = ({ children, ...rest }) => (
  <tbody {...rest}>{children}</tbody>
);

export const Tr: FC<ComponentPropsWithoutRef<"tr">> = ({ children, ...rest }) => (
  <tr {...rest}>{children}</tr>
);

/**
 * Header cell — uppercase mono with wide tracking, low opacity.
 * Same typographic register as MetaLabel and SectionNumber.
 */
export const Th: FC<ComponentPropsWithoutRef<"th">> = ({ children, ...rest }) => (
  <th
    className="text-left font-mono text-[11px] uppercase tracking-[0.18em] py-3 pr-4 opacity-70 align-bottom"
    {...rest}
  >
    {children}
  </th>
);

/**
 * Data cell — body typography slightly smaller than <p> (15px vs
 * 17px) so dense rows stay legible without wrapping. Rule-soft
 * row dividers visually separate without competing with content.
 */
export const Td: FC<ComponentPropsWithoutRef<"td">> = ({ children, ...rest }) => (
  <td
    className="py-3 pr-4 border-b border-rule-soft align-top text-[15px] text-ink"
    {...rest}
  >
    {children}
  </td>
);
