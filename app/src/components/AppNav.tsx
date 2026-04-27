import type { FC, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Wordmark } from "./brand";

/**
 * AppNav — shared logged-in app nav for trader-facing surfaces.
 *
 * Wordmark left, center links (MARKETS / PORTFOLIO / RESEARCH / DOCS),
 * wallet chip + DISCONNECT (or CONNECT WALLET) right.
 *
 * Active route gets a 2px crimson bottom-edge bar at `bottom: -8px` —
 * the horizontal sibling of DocsSidebar's left-edge bar (same 2px,
 * same crimson, 90° rotated). Active links also drop the muted
 * opacity for full ink.
 *
 * RESEARCH is intentionally muted/disabled in Stage 1 — placeholder
 * for a future research surface, no route attached, no clicks.
 *
 * Currently mounted only on /portfolio; long-term, all logged-in
 * trader pages (Markets / Trade / Write / Portfolio) will use this
 * nav and the global Header (in components/Header.tsx) will retire.
 *
 * The `pointer-events-none` on the nav with
 * `[&>*]:pointer-events-auto` on direct children matches the
 * Landing/Docs nav idiom: the nav is transparent to scroll-trapping
 * while its children stay clickable.
 */
export const AppNav: FC = () => {
  const { publicKey, connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal();

  return (
    <nav
      aria-label="Primary"
      className="pointer-events-none fixed inset-x-0 top-0 z-[200] flex items-center justify-between font-mono text-[11.5px] uppercase tracking-[0.18em] text-ink py-[22px] px-[clamp(20px,4vw,56px)] [&>*]:pointer-events-auto"
    >
      <Wordmark context="light" />

      <div className="hidden md:flex gap-7">
        <AppNavLink to="/markets">Markets</AppNavLink>
        <AppNavLink to="/trade">Trade</AppNavLink>
        <AppNavLink to="/write">Write</AppNavLink>
        <AppNavLink to="/portfolio">Portfolio</AppNavLink>
        <AppNavLink to="/docs">Docs</AppNavLink>
      </div>

      <div className="flex items-center gap-4">
        {connected && publicKey ? (
          <>
            <span className="hidden sm:inline-flex items-center gap-2 text-ink opacity-85">
              <span aria-hidden="true" className="inline-block h-[6px] w-[6px] rounded-full bg-crimson" />
              {truncatePubkey(publicKey.toBase58())}
            </span>
            <button
              type="button"
              onClick={() => disconnect()}
              className="group inline-flex items-center gap-2 rounded-full border border-ink px-[14px] py-[9px] no-underline transition-[background-color,color] duration-500 ease-opta hover:bg-ink hover:text-paper"
            >
              Disconnect
              <span className="transition-transform duration-500 ease-opta group-hover:translate-x-[3px]">→</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setVisible(true)}
            className="group inline-flex items-center gap-2 rounded-full border border-ink px-[14px] py-[9px] no-underline transition-[background-color,color] duration-500 ease-opta hover:bg-ink hover:text-paper"
          >
            Connect Wallet
            <span className="transition-transform duration-500 ease-opta group-hover:translate-x-[3px]">→</span>
          </button>
        )}
      </div>
    </nav>
  );
};

/**
 * Truncate a base58 pubkey to "FIRST4_LAST4" format. Mirrors the
 * mockup's wallet chip — short enough to fit in the nav, distinctive
 * enough to confirm the connected wallet at a glance.
 */
function truncatePubkey(pk: string): string {
  return `${pk.slice(0, 4)}_${pk.slice(-4)}`;
}

const AppNavLink: FC<{ to: string; children: ReactNode }> = ({ to, children }) => (
  <NavLink
    to={to}
    className={({ isActive }) =>
      `relative no-underline transition-opacity duration-300 ease-opta hover:opacity-100 ${isActive ? "opacity-100" : "opacity-65"}`
    }
  >
    {({ isActive }) => (
      <>
        {isActive && (
          <span
            aria-hidden="true"
            className="absolute left-0 right-0 bottom-[-8px] h-[2px] bg-crimson"
          />
        )}
        {children}
      </>
    )}
  </NavLink>
);

export default AppNav;
