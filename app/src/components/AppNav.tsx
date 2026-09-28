import type { FC, ReactNode } from "react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Wordmark } from "./brand";
import { NewMarketModal } from "../pages/markets/NewMarketModal";
import { DevnetSolButton } from "./DevnetSolButton";
import { DevnetFaucetButton } from "./DevnetFaucetButton";

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
 * Fixed, opaque top bar: `bg-paper` (#F1ECE2) + a hairline bottom border,
 * `z-[200]` above all page content (modals z-[300] and the grain overlay sit
 * higher by design). Pages offset their content with `pt-[120px]`, so content
 * scrolls UNDER the bar, never through it. The bar owns pointer events over its
 * whole area (previously `pointer-events-none` for a transparent overlay, which
 * let scrolled content show + click through).
 */
export const AppNav: FC = () => {
  const { publicKey, connected, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const [showNewMarket, setShowNewMarket] = useState(false);

  // Mirrors MarketsPage's handler: prompt wallet connection first if
  // disconnected; otherwise open the modal. Edge case: when the user is
  // already on /markets, MarketsPage's local data doesn't refetch on close
  // (different state owner) — they'll need to refresh to see the new
  // market. Acceptable for P4e; would need a context refactor to fix
  // cleanly.
  const handleNewMarket = () => {
    if (!connected) {
      setVisible(true);
      return;
    }
    setShowNewMarket(true);
  };

  return (
    <>
    {/* `top` is driven by --opta-banner-h (see components/FreezeBanner.tsx),
        which defaults to 0px — so with no incident banner this is exactly
        `top-0`. AppNav is the only FIXED bar that must sit below the banner;
        the terminal pages carry TerminalAppBar in normal flow, which the body
        padding already moves. */}
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 top-[var(--opta-banner-h,0px)] z-[200] flex flex-wrap items-center justify-between font-mono text-[11.5px] uppercase tracking-[0.18em] text-ink py-[22px] px-[clamp(20px,4vw,56px)] bg-paper border-b border-rule"
    >
      <Wordmark context="light" />

      <div className="order-last w-full mt-2 flex flex-wrap gap-x-4 gap-y-1 md:order-none md:w-auto md:mt-0 md:flex-nowrap md:gap-7">
        <AppNavLink to="/markets">Markets</AppNavLink>
        <AppNavLink to="/trade">Trade</AppNavLink>
        <AppNavLink to="/write">Write</AppNavLink>
        <AppNavLink to="/portfolio">Portfolio</AppNavLink>
        <AppNavLink to="/docs">Docs</AppNavLink>
      </div>

      <div className="flex items-center gap-4">
        <DevnetSolButton className="hidden sm:inline-flex items-center no-underline transition-opacity duration-300 ease-opta opacity-65 hover:opacity-100 disabled:opacity-40 disabled:cursor-wait" />
        <DevnetFaucetButton className="hidden sm:inline-flex items-center no-underline transition-opacity duration-300 ease-opta opacity-65 hover:opacity-100 disabled:opacity-40 disabled:cursor-wait" />
        <button
          type="button"
          onClick={handleNewMarket}
          className="hidden sm:inline-flex items-center no-underline transition-opacity duration-300 ease-opta opacity-65 hover:opacity-100"
        >
          + New Market
        </button>
        {connected && publicKey ? (
          <>
            <span data-ph-mask className="hidden sm:inline-flex items-center gap-2 text-ink opacity-85">
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
    {showNewMarket && (
      <NewMarketModal
        onClose={() => setShowNewMarket(false)}
        onCreated={() => setShowNewMarket(false)}
      />
    )}
    </>
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
      `relative inline-block py-2 md:py-0 no-underline transition-opacity duration-300 ease-opta hover:opacity-100 ${isActive ? "opacity-100" : "opacity-65"}`
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
