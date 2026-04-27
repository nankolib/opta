import type { FC } from "react";

/**
 * Trade page footer. Left: copyright + version label. Right: three
 * dead navigation links (CHAIN METHODOLOGY / SURFACE / AUDITS).
 *
 * Dead links render with `cursor-default` so users get no affordance
 * suggesting they're clickable. Kept in markup so the design slot
 * exists for future routes.
 */
export const TradeFooter: FC = () => (
  <footer className="mt-20 pt-6 border-t border-rule flex flex-wrap items-center justify-between gap-y-3 gap-x-6 font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-60">
    <span>© 2026 Opta Labs · Trade Terminal v0.1</span>
    <span className="flex flex-wrap gap-6">
      <DeadLink>Chain Methodology</DeadLink>
      <DeadLink>Surface</DeadLink>
      <DeadLink>Audits</DeadLink>
    </span>
  </footer>
);

const DeadLink: FC<{ children: React.ReactNode }> = ({ children }) => (
  <span aria-disabled="true" className="cursor-default select-none">
    {children}
  </span>
);

export default TradeFooter;
