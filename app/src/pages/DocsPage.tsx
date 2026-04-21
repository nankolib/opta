import { FC, useState, useRef, useEffect } from "react";

const SECTIONS = [
  { id: "living-token", label: "The Living Option Token" },
  { id: "pricing", label: "How Pricing Works" },
  { id: "three-price", label: "Three-Price Discovery" },
  { id: "security", label: "Security" },
  { id: "architecture", label: "Architecture" },
  { id: "program-ids", label: "Program IDs" },
] as const;

export const DocsPage: FC = () => {
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0.1 }
    );
    Object.values(sectionRefs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-bg-primary pt-24 px-4 pb-16">
      <div className="mx-auto max-w-6xl flex gap-8">
        {/* Sidebar */}
        <aside className="hidden lg:block w-56 shrink-0">
          <div className="sticky top-24 space-y-1">
            <h3 className="text-xs font-medium uppercase tracking-widest text-text-muted mb-3">Protocol Docs</h3>
            {SECTIONS.map((s) => (
              <button key={s.id} onClick={() => scrollTo(s.id)}
                className={`block w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${
                  activeSection === s.id
                    ? "bg-gold/10 text-gold font-medium"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-surface"
                }`}>
                {s.label}
              </button>
            ))}
          </div>
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0">
          <h1 className="text-4xl font-bold text-text-primary mb-2">Opta Protocol</h1>
          <p className="text-text-secondary mb-12">Complete technical reference for the Living Option Token protocol on Solana.</p>

          {/* Living Option Token */}
          <section id="living-token" ref={(el) => { sectionRefs.current["living-token"] = el; }} className="mb-16 scroll-mt-24">
            <h2 className="text-2xl font-bold text-text-primary mb-4">The Living Option Token</h2>
            <p className="text-text-secondary mb-6 leading-relaxed">
              Every option minted on Opta is a real Token-2022 token with three extensions:
            </p>
            <div className="space-y-4">
              <DocCard title="TransferHook" accent="gold"
                description="Enforces expiry on every transfer. Expired options cannot move. The hook program is invoked automatically by the Token-2022 runtime on every transfer — no way to bypass it." />
              <DocCard title="PermanentDelegate" accent="green"
                description="Protocol burns dead tokens automatically. Tokens self-destruct at settlement. The protocol holds permanent delegate authority to burn expired or exercised tokens without holder permission." />
              <DocCard title="MetadataExtension" accent="purple"
                description="Strike, expiry, asset, oracle feed stored on-chain. The token IS the term sheet. Any wallet or explorer can read the full option terms directly from the mint account." />
            </div>
          </section>

          {/* How Pricing Works */}
          <section id="pricing" ref={(el) => { sectionRefs.current["pricing"] = el; }} className="mb-16 scroll-mt-24">
            <h2 className="text-2xl font-bold text-text-primary mb-4">How Pricing Works</h2>
            <p className="text-text-secondary mb-6 leading-relaxed">
              Opta uses asset-class-aware Black-Scholes pricing with 5 profiles:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {[
                { name: "Crypto", desc: "High volatility, 1.15x jump risk, 24/7 time decay (8,760 hrs/yr)", color: "text-gold" },
                { name: "Commodity", desc: "Low-moderate vol, weekend gap awareness, 23hr weekday decay", color: "text-sol-green" },
                { name: "Equity", desc: "Variable vol, earnings spike multiplier, market hours (1,638 hrs/yr)", color: "text-sol-purple" },
                { name: "Forex", desc: "Lowest vol, central bank event awareness, weekday 24hr decay", color: "text-blue-400" },
                { name: "Tokenized Fund", desc: "Low vol, depeg risk premium for NAV protection", color: "text-pink-400" },
              ].map((p) => (
                <div key={p.name} className="rounded-xl border border-border bg-bg-surface p-4">
                  <div className={`text-sm font-semibold ${p.color} mb-1`}>{p.name}</div>
                  <p className="text-xs text-text-secondary leading-relaxed">{p.desc}</p>
                </div>
              ))}
            </div>
            <h3 className="text-lg font-semibold text-text-primary mb-3">Four improvements over standard Black-Scholes</h3>
            <ol className="space-y-2 text-sm text-text-secondary list-decimal list-inside">
              <li>Realized volatility from Pyth oracle data</li>
              <li>Jump risk premium for spike-prone assets</li>
              <li>Vault utilization surge pricing</li>
              <li>24/7 continuous time decay for crypto</li>
            </ol>
          </section>

          {/* Three-Price Discovery */}
          <section id="three-price" ref={(el) => { sectionRefs.current["three-price"] = el; }} className="mb-16 scroll-mt-24">
            <h2 className="text-2xl font-bold text-text-primary mb-4">Three-Price Discovery</h2>
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-bg-surface p-5">
                <div className="text-sm font-semibold text-gold mb-1">B-S Fair Value</div>
                <p className="text-sm text-text-secondary">Protocol calculates mathematical reference, displayed on every listing.</p>
              </div>
              <div className="rounded-xl border border-border bg-bg-surface p-5">
                <div className="text-sm font-semibold text-sol-green mb-1">Writer's Premium</div>
                <p className="text-sm text-text-secondary">Seller sets their own price based on market view.</p>
              </div>
              <div className="rounded-xl border border-border bg-bg-surface p-5">
                <div className="text-sm font-semibold text-sol-purple mb-1">Resale Market Price</div>
                <p className="text-sm text-text-secondary">Supply and demand on secondary market.</p>
              </div>
            </div>
          </section>

          {/* Security */}
          <section id="security" ref={(el) => { sectionRefs.current["security"] = el; }} className="mb-16 scroll-mt-24">
            <h2 className="text-2xl font-bold text-text-primary mb-4">Security</h2>
            <ul className="space-y-3 text-sm text-text-secondary">
              {[
                "Isolated PDA escrow per option — no shared pool",
                "Self-buy prevention on primary and secondary markets",
                "European-style settlement — exercise only after expiry",
                "USDC-only collateral — no collateral volatility risk",
                "0.5% protocol fee on all trades",
              ].map((item, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-gold shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          {/* Architecture */}
          <section id="architecture" ref={(el) => { sectionRefs.current["architecture"] = el; }} className="mb-16 scroll-mt-24">
            <h2 className="text-2xl font-bold text-text-primary mb-4">Architecture</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { value: "2", label: "On-chain Programs" },
                { value: "11", label: "Instructions" },
                { value: "27/27", label: "Tests Passing" },
                { value: "Token-2022", label: "Token Standard" },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-border bg-bg-surface p-4 text-center">
                  <div className="text-xl font-bold text-gold">{s.value}</div>
                  <div className="text-xs text-text-muted mt-1">{s.label}</div>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-xl border border-border bg-bg-surface p-5 text-sm text-text-secondary">
              <div className="font-medium text-text-primary mb-2">Stack</div>
              Anchor 0.32.1 &middot; Solana CLI 2.3.0 &middot; Rust 1.89.0 &middot; spl-token-2022 v8.0.1
            </div>
          </section>

          {/* Program IDs */}
          <section id="program-ids" ref={(el) => { sectionRefs.current["program-ids"] = el; }} className="mb-16 scroll-mt-24">
            <h2 className="text-2xl font-bold text-text-primary mb-4">Program IDs</h2>
            <div className="space-y-3">
              <div className="rounded-xl border border-border bg-bg-surface p-4">
                <div className="text-xs text-text-muted mb-1">Main Program</div>
                <code className="text-sm text-gold font-mono break-all">CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq</code>
              </div>
              <div className="rounded-xl border border-border bg-bg-surface p-4">
                <div className="text-xs text-text-muted mb-1">Transfer Hook</div>
                <code className="text-sm text-gold font-mono break-all">83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG</code>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
};

/* ===== Doc Card Component ===== */
const DocCard: FC<{ title: string; description: string; accent: "gold" | "green" | "purple" }> = ({ title, description, accent }) => {
  const colors = {
    gold: "border-gold/20 bg-gold/5",
    green: "border-sol-green/20 bg-sol-green/5",
    purple: "border-sol-purple/20 bg-sol-purple/5",
  };
  const titleColors = { gold: "text-gold", green: "text-sol-green", purple: "text-sol-purple" };
  return (
    <div className={`rounded-xl border ${colors[accent]} p-5`}>
      <div className={`text-sm font-semibold ${titleColors[accent]} mb-2`}>{title}</div>
      <p className="text-sm text-text-secondary leading-relaxed">{description}</p>
    </div>
  );
};
