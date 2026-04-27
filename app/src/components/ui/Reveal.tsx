import { useEffect, useState, type ElementType, type ReactNode, type Ref } from "react";
import { useReveal } from "../../hooks/useReveal";

type RevealProps = {
  children: ReactNode;
  /** Delay in ms after the element enters view before the rise fires. Used for the staggered hero headline. */
  delay?: number;
  /** IntersectionObserver threshold. Default 0.18. */
  threshold?: number;
  as?: ElementType;
  className?: string;
};

/**
 * Reveal-from-below primitive: container clips overflow, child rises
 * from translateY(110%) → 0 on intersection. Backed by the
 * `.opta-reveal > .opta-rise` CSS pattern in index.css.
 *
 * `delay` defers the `is-in` toggle by N ms after the element first
 * enters view — used for the staggered three-line reveal in the
 * hero headline (~220ms between lines).
 */
export function Reveal({
  children,
  delay = 0,
  threshold = 0.18,
  as: Tag = "div",
  className = "",
}: RevealProps) {
  const [ref, isVisible] = useReveal<HTMLElement>({ threshold });
  const [isIn, setIsIn] = useState(false);

  useEffect(() => {
    if (!isVisible) return;
    if (delay === 0) {
      setIsIn(true);
      return;
    }
    const t = window.setTimeout(() => setIsIn(true), delay);
    return () => window.clearTimeout(t);
  }, [isVisible, delay]);

  return (
    <Tag
      ref={ref as Ref<HTMLElement>}
      className={`opta-reveal ${isIn ? "is-in" : ""} ${className}`.trim()}
    >
      <span className="opta-rise">{children}</span>
    </Tag>
  );
}

export default Reveal;
