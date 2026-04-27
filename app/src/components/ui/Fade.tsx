import { useEffect, useState, type ElementType, type ReactNode, type Ref } from "react";
import { useReveal } from "../../hooks/useReveal";

type FadeProps = {
  children: ReactNode;
  delay?: number;
  threshold?: number;
  as?: ElementType;
  className?: string;
};

/**
 * Soft reveal: opacity 0 + translateY 14px → opacity 1 on
 * intersection. Backed by the `.opta-fade` CSS pattern. Pair with
 * the `opta-stag` helper class plus an inline `--i` style for
 * staggered groups — see ThesisSection's three-stat pattern in 3b.
 */
export function Fade({
  children,
  delay = 0,
  threshold = 0.18,
  as: Tag = "div",
  className = "",
}: FadeProps) {
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
      className={`opta-fade ${isIn ? "is-in" : ""} ${className}`.trim()}
    >
      {children}
    </Tag>
  );
}

export default Fade;
