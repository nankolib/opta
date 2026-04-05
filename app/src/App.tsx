import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Header } from "./components/Header";
import { ToastContainer } from "./components/Toast";
import { Landing } from "./pages/Landing";
import { Markets } from "./pages/Markets";
import { Trade } from "./pages/Trade";
import { Portfolio } from "./pages/Portfolio";
import { DocsPage } from "./pages/DocsPage";

/**
 * App — Root component with routing.
 *
 * The Header is persistent across all pages.
 * Routes:
 *   /           → Landing page (hero + features)
 *   /markets    → Browse active options markets
 *   /trade      → Write/buy options
 *   /portfolio  → View your positions
 */
function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg-primary text-text-primary">
        <Header />
        <ToastContainer />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/markets" element={<Markets />} />
          <Route path="/trade" element={<Trade />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/docs" element={<DocsPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
