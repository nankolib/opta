import type { ComponentPropsWithoutRef, FC } from "react";

/**
 * Unordered list — em-dash markers in mono crimson, set via the
 * descendant ::before selector so the Li component stays
 * parent-agnostic (the same Li renders for both ul and ol items).
 *
 * The em-dash mirrors the SectionNumber's crimson interpoint — the
 * paper-surface design's recurring "·" / "—" punctuation.
 */
export const Ul: FC<ComponentPropsWithoutRef<"ul">> = ({ children, ...rest }) => (
  <ul
    className={
      "list-none my-6 max-w-[68ch] space-y-2 " +
      "[&>li]:relative [&>li]:pl-6 " +
      "[&>li]:before:content-['—'] [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-0 " +
      "[&>li]:before:font-mono [&>li]:before:text-crimson"
    }
    {...rest}
  >
    {children}
  </ul>
);

/**
 * Ordered list — native decimal markers styled mono-crimson via
 * the ::marker pseudo-element. Indented further than ul so the
 * two-digit markers don't crowd the body.
 */
export const Ol: FC<ComponentPropsWithoutRef<"ol">> = ({ children, ...rest }) => (
  <ol
    className="list-decimal pl-8 space-y-2 max-w-[68ch] my-6 marker:font-mono marker:text-crimson marker:text-[0.85em]"
    {...rest}
  >
    {children}
  </ol>
);

/**
 * List item — body typography matching <p>. Parent-agnostic; ul/ol
 * handle their own marker rendering through descendant selectors
 * and the native ::marker pseudo-element respectively.
 */
export const Li: FC<ComponentPropsWithoutRef<"li">> = ({ children, ...rest }) => (
  <li className="font-sans text-[17px] leading-[1.7] text-ink" {...rest}>
    {children}
  </li>
);
