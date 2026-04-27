import type { ComponentPropsWithoutRef, FC } from "react";

/**
 * Code element. Detects block context by the presence of a
 * `language-*` className (which ReactMarkdown attaches when the
 * code lives inside a fenced block); in that case the wrapper
 * <pre> handles all visual styling and Code passes through. For
 * inline `<code>...</code>` snippets, applies the paper-2 wash and
 * mono pill treatment.
 *
 * Edge case — fenced code blocks without a language hint produce
 * an unmarked `<code>` whose render path falls through to the
 * inline branch. The whitepaper has no such blocks; if a future
 * revision adds one we'll see oversized-inline rendering and can
 * tighten the detection heuristic then.
 */
export const Code: FC<ComponentPropsWithoutRef<"code">> = ({ className, children, ...rest }) => {
  const isBlockCode = typeof className === "string" && className.startsWith("language-");
  if (isBlockCode) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  return (
    <code
      className="font-mono text-[0.92em] bg-paper-2 px-[6px] py-[1px] rounded-[3px] text-ink"
      {...rest}
    >
      {children}
    </code>
  );
};

/**
 * Code block container — dark slate (--color-ink-soft), paper text,
 * scrollable on horizontal overflow. The deliberate inversion
 * matches the mockup's `console.log(...)` block — code reads as a
 * distinct artifact rather than continuous prose. No syntax
 * highlighting in Stage 2; Stage 3 may layer it on if needed.
 */
export const Pre: FC<ComponentPropsWithoutRef<"pre">> = ({ children, ...rest }) => (
  <pre
    className="font-mono text-[14px] leading-[1.6] bg-ink-soft text-paper p-5 rounded-md my-6 overflow-x-auto"
    {...rest}
  >
    {children}
  </pre>
);
