import { useReveal } from "../../hooks/useReveal";

type TracerProps = {
  className?: string;
};

/**
 * 1px crimson line that draws 0% → 100% width over 2.4s when its
 * container scrolls into view. Self-positioning is the caller's
 * responsibility — Tracer renders an absolutely-positioned aria-
 * hidden div via the `.opta-tracer` CSS rule.
 *
 * In v3 the thesis section places Tracer at the top edge of the
 * section with five sibling tick marks and a right-aligned mono
 * end-label rendered alongside.
 */
export function Tracer({ className = "" }: TracerProps) {
  const [ref, isVisible] = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`opta-tracer ${isVisible ? "is-in" : ""} ${className}`.trim()}
    />
  );
}

export default Tracer;
