import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { Header } from "./components/Header";
import { ToastContainer } from "./components/Toast";
import { Landing } from "./pages/Landing";
import { MarketsPage as Markets } from "./pages/markets";
import { TradePage as Trade } from "./pages/trade";
import { MarketplacePage } from "./pages/marketplace";
import { WritePage as Write } from "./pages/write";
import { PortfolioPage } from "./pages/portfolio";
import { DocsLayout, DocsIndex, DocsSection } from "./pages/docs";

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
 *   /marketplace — Paper-surface trader page; supplies AppNav
 *
 * All logged-in trader pages (Markets / Trade / Marketplace / Write /
 * Portfolio) have migrated to AppNav. The global Header is now only
 * shown on routes not listed above (currently none).
 */
const HEADER_HIDDEN_PATHS = ["/", "/docs", "/portfolio", "/markets", "/write", "/trade", "/marketplace"];

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
  const showHeader = !matchesAny(location.pathname, HEADER_HIDDEN_PATHS);

  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      {showHeader && <Header />}
      <ToastContainer />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/markets" element={<Markets />} />
        <Route path="/trade" element={<Trade />} />
        <Route path="/marketplace" element={<MarketplacePage />} />
        <Route path="/write" element={<Write />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/docs" element={<DocsLayout />}>
          <Route index element={<DocsIndex />} />
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
