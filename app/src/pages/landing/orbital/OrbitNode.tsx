import type { FC } from "react";

export type OrbitPosition = "top" | "right-top" | "right-bottom" | "left-bottom" | "left-top";

type OrbitNodeProps = {
  label: string;
  position: OrbitPosition;
  /** When true, the leading pip renders crimson — the v3 design's "lead" feature. */
  lead?: boolean;
};

/**
 * A single mono-text node anchored to the outer orbit ring.
 *
 * Five positions map to roughly the 12, 2, 5, 7, 10 o'clock anchor
 * points the v3 design uses — `top` = 12 o'clock, `right-top` = 2,
 * `right-bottom` = 5, `left-bottom` = 7, `left-top` = 10.
 */
export const OrbitNode: FC<OrbitNodeProps> = ({ label, position, lead = false }) => {
  const positionClasses = {
    top: "top-[-2%] left-1/2 -translate-x-1/2 -translate-y-1/2",
    "right-top": "top-[18%] right-[-2%] translate-x-1/2 -translate-y-1/2",
    "right-bottom": "bottom-[18%] right-[-2%] translate-x-1/2 translate-y-1/2",
    "left-bottom": "bottom-[18%] left-[-2%] -translate-x-1/2 translate-y-1/2",
    "left-top": "top-[18%] left-[-2%] -translate-x-1/2 -translate-y-1/2",
  }[position];

  return (
    <span
      className={`absolute inline-flex items-center gap-[10px] whitespace-nowrap rounded-[2px] border border-rule bg-paper px-[10px] py-[6px] font-mono text-[10.5px] uppercase tracking-[0.2em] ${positionClasses}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-[6px] w-[6px] rounded-full ${lead ? "bg-crimson" : "bg-ink"}`}
      />
      {label}
    </span>
  );
};

export default OrbitNode;
