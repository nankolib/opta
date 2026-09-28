import { Suspense, lazy, useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import posthog from "posthog-js";
import { Header } from "./components/Header";
import { FreezeBanner } from "./components/FreezeBanner";
import { ToastContainer } from "./components/Toast";
import { useVersionCheck } from "./hooks/useVersionCheck";
import { Landing } from "./pages/Landing";
import { MarketsPage as Markets } from "./pages/markets";
import { TradePage as Trade } from "./pages/trade";
import { WritePage as Write } from "./pages/write";
import { PortfolioPage } from "./pages/portfolio";
import { DocsLayout, DocsIndex, DocsSection, DocsRules } from "./pages/docs";
import { Privacy } from "./pages/Privacy";
import { Support } from "./pages/Support";
import { Terms } from "./pages/Terms";
import { EPOCH0_UI } from "./utils/epoch0";
import { TourOverlay } from "./components/tour/TourOverlay";

/**
 * EPOCH 0 campaign surface — flag-gated (VITE_EPOCH0_UI, default OFF).
 * `lazy` keeps it out of the entry chunk, and the <Route> below is never
 * created when the flag is off, so /leaderboard falls through exactly as it
 * does today. A production deploy with the flag unset is unchanged.
 */
const LeaderboardPage = lazy(() => import("./pages/leaderboard"));

/**
 * Routes that hide the persistent global Header.
 *
 * Listed paths and any descendants (segments after a "/") are gated.
 * Pages on these routes render their own navigation — typically the
 * paper-surface routes which supply a brand-specific nav bar.
 *
 * Currently:
 *   /            — Landing (paper-surface; supplies its own nav)
 *   /docs        — Docs index + every /docs/<section> (paper-surface)
 *   /portfolio   — Paper-surface trader page; supplies AppNav
 *   /markets     — Paper-surface trader page; supplies AppNav
 *   /write       — Paper-surface trader page; supplies AppNav
 *   /trade       — Paper-surface trader page; supplies AppNav
 *   /leaderboard — EPOCH 0 campaign board; supplies TerminalAppBar.
 *   /marketplace — Soft-redirect to /trade (Slice 6 of the merge arc).
 *                  Kept in HEADER_HIDDEN_PATHS for one release cycle to
 *                  suppress the global Header during the brief redirect
 *                  frame; remove this line + the route + the path entry
 *                  together when the redirect itself retires.
 *
 * All logged-in trader pages (Markets / Trade / Write / Portfolio)
 * have migrated to AppNav. The global Header is now only shown on
 * routes not listed above (currently none).
 */
const HEADER_HIDDEN_PATHS = [
  "/", "/docs", "/portfolio", "/markets", "/write", "/trade", "/marketplace",
  "/privacy", "/support", "/terms",
  // Gated on the flag, not added unconditionally: with EPOCH0_UI off no Route
  // matches /leaderboard, so hiding the header there would render a completely
  // blank page instead of today's header-only fallthrough. Flag off must stay
  // byte-identical to production.
  ...(EPOCH0_UI ? ["/leaderboard"] : []),
];

/**
 * True iff `path` exactly matches one of `patterns` or is a descendant
 * of one. The "+ '/'" guard keeps "/" from matching every path while
 * letting "/docs" correctly match "/docs/architecture" etc.
 */
const matchesAny = (path: string, patterns: readonly string[]) =>
  patterns.some((p) => p === path || path.startsWith(p + "/"));

/**
 * AppShell — rendered inside <BrowserRouter> so useLocation() works.
 * The persistent Header is gated per route via HEADER_HIDDEN_PATHS.
 */
function AppShell() {
  const location = useLocation();
  useVersionCheck();
  const showHeader = !matchesAny(location.pathname, HEADER_HIDDEN_PATHS);

  // PostHog wallet analytics — identify by pubkey (public) on connect, reset on
  // disconnect. Ref guard avoids a false "disconnected" on the initial null.
  const { publicKey, wallet } = useWallet();
  const prevWalletKey = useRef<string | null>(null);
  useEffect(() => {
    const key = publicKey?.toBase58() ?? null;
    if (key && key !== prevWalletKey.current) {
      posthog.identify(key);
      posthog.capture("wallet_connected", { walletName: wallet?.adapter?.name });
    } else if (!key && prevWalletKey.current) {
      posthog.capture("wallet_disconnected");
      posthog.reset();
    }
    prevWalletKey.current = key;
  }, [publicKey, wallet]);

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      {/* Global incident notice. Mounted above the router so it is genuinely
          on every route, including the paper surfaces that hide <Header />. */}
      <FreezeBanner />
      {showHeader && <Header />}
      <ToastContainer />
      {/* Shaded tutorial. Self-gates on EPOCH0_UI, dismissal and quest state, so
          mounting it here costs nothing when the campaign is off. */}
      <TourOverlay />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/markets" element={<Markets />} />
        <Route path="/trade" element={<Trade />} />
        <Route path="/marketplace" element={<Navigate replace to="/trade" />} />
        <Route path="/write" element={<Write />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        {EPOCH0_UI && (
          <Route
            path="/leaderboard"
            element={
              <Suspense fallback={null}>
                <LeaderboardPage />
              </Suspense>
            }
          />
        )}
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/support" element={<Support />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/docs" element={<DocsLayout />}>
          <Route index element={<DocsIndex />} />
          {/* Static segment declared before the catch-all: /docs/rules is the
              live scoring page, NOT a whitepaper section, so it must not reach
              the build-time slicer (findSection would miss and 404). */}
          <Route path="rules" element={<DocsRules />} />
          <Route path=":sectionSlug" element={<DocsSection />} />
        </Route>
      </Routes>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

export default App;
