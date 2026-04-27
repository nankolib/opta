import type { ReactNode } from "react";
import { useReveal } from "../../hooks/useReveal";

type StrikeProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Inline span with an animated 2px crimson strikethrough — the
 * thesis statement uses it to cross out "credible institutional
 * scale". The line draws across (scaleX 0 → 1) over 1.6s with the
 * built-in 0.6s lead-in encoded in the `.opta-strike` CSS.
 *
 * No `delay` prop because the CSS already encodes the v3 cadence;
 * timing tweaks should happen in index.css, not at the call site.
 */
export function Strike({ children, className = "" }: StrikeProps) {
  // High threshold (0.85) so the strike fires only when the phrase
  // is essentially fully in view. With the default 0.18 the line
  // animates while the surrounding sentence is still scrolling in,
  // crossing out copy the reader hasn't read yet.
  const [ref, isVisible] = useReveal<HTMLSpanElement>({ threshold: 0.85 });
  return (
    <span
      ref={ref}
      className={`opta-strike ${isVisible ? "is-in" : ""} ${className}`.trim()}
    >
      {children}
    </span>
  );
}

export default Strike;
