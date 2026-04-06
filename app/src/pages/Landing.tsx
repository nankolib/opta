import { FC } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export const Landing: FC = () => {
  const { connected } = useWallet();

  return (
    <div className="min-h-screen bg-bg-primary">
      {/* ===== Hero Section ===== */}
      <section className="relative flex flex-col items-center justify-center px-4 pt-32 pb-20 overflow-hidden">
        {/* Background glow effects */}
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-gold/5 blur-[120px] pointer-events-none" />
        <div className="absolute top-40 left-1/3 w-[300px] h-[300px] rounded-full bg-sol-purple/5 blur-[100px] pointer-events-none" />

        {/* Protocol badge */}
        <div className="mb-6 flex items-center gap-2 rounded-full bg-bg-surface border border-border px-4 py-1.5">
          <div className="h-2 w-2 rounded-full bg-sol-green animate-pulse" />
          <span className="text-xs font-medium text-text-secondary tracking-wide uppercase">
            Live on Solana Devnet
          </span>
        </div>

        {/* Main heading */}
        <h1 className="text-center text-5xl sm:text-7xl font-bold tracking-tight text-text-primary max-w-5xl leading-[1.1]">
          The First
          <br />
          <span className="bg-gradient-to-r from-gold via-gold to-gold-dim bg-clip-text text-transparent">
            Living Financial Instrument
          </span>
          <br />
          on Any Blockchain
        </h1>

        {/* Subtitle */}
        <p className="mt-6 max-w-2xl text-center text-lg text-text-secondary leading-relaxed">
          Self-expiring, any-asset options on Solana. The hedging layer that makes Solana institutionally complete.
        </p>

        {/* CTA buttons */}
        <div className="mt-10 flex items-center gap-4">
          {connected ? (
            <Link
              to="/markets"
              className="inline-flex items-center gap-2 rounded-xl bg-gold px-8 py-3.5 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors no-underline"
            >
              Launch App
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </Link>
          ) : (
            <WalletMultiButton
              style={{
                backgroundColor: "#D4A843",
                color: "#0A0A0B",
                fontFamily: '"Inter", system-ui, sans-serif',
                fontWeight: 600,
                fontSize: "14px",
                height: "48px",
                borderRadius: "12px",
                padding: "0 32px",
              }}
            />
          )}
          <a
            href="https://github.com/nankolib/butter_options"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-bg-surface px-8 py-3.5 text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-light transition-all no-underline"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            View Source
          </a>
        </div>

        {/* Stats strip */}
        <div className="mt-16 flex items-center gap-8 sm:gap-16">
          {[
            { label: "Global Derivatives Market", value: "$846T" },
            { label: "Crypto Volume = Derivatives", value: "74%" },
            { label: "Options Protocols on Solana", value: "0" },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-2xl font-bold text-text-primary">{stat.value}</div>
              <div className="text-xs text-text-muted mt-1 max-w-[120px]">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ===== Feature Cards ===== */}
      <section className="mx-auto max-w-6xl px-4 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <FeatureCard
            icon={
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
              </svg>
            }
            title="Living Option Token"
            description="The first financial instrument that knows it's a financial instrument. Token-2022 TransferHook enforces expiry. PermanentDelegate enables auto-burn. MetadataExtension carries full terms on-chain. The token IS the term sheet."
            accent="gold"
          />

          <FeatureCard
            icon={
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
              </svg>
            }
            title="Any Asset, Institutional Pricing"
            description="Permissionless options on any Pyth-priced asset — crypto, gold, oil, stocks, forex, tokenized funds. 5 asset-class-aware Black-Scholes pricing profiles. Not a one-size-fits-all model."
            accent="green"
          />

          <FeatureCard
            icon={
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            }
            title="Isolated Escrow, Zero Pool Risk"
            description="Every option has its own PDA escrow. No shared pool. Structurally immune to Drift/Mango-style exploits. Built-in P2P secondary marketplace with three-price discovery."
            accent="purple"
          />
        </div>
      </section>

      {/* ===== Supported Assets ===== */}
      <section className="border-t border-border bg-bg-surface/50 py-16">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-sm font-medium uppercase tracking-widest text-text-muted mb-10">
            Supported Assets
          </h2>
          <div className="flex flex-wrap justify-center gap-6">
            {[
              { name: "SOL", label: "Solana" },
              { name: "BTC", label: "Bitcoin" },
              { name: "ETH", label: "Ethereum" },
              { name: "XAU", label: "Gold" },
              { name: "WTI", label: "Crude Oil" },
            ].map((asset) => (
              <div
                key={asset.name}
                className="flex items-center gap-3 rounded-xl border border-border bg-bg-surface px-6 py-4 hover:border-gold/30 transition-colors"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gold/10 text-gold font-bold text-sm">
                  {asset.name}
                </div>
                <div>
                  <div className="text-sm font-medium text-text-primary">{asset.label}</div>
                  <div className="text-xs text-text-muted">{asset.name}/USD</div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-text-secondary mt-6">
            Plus any asset Pyth supports — equities, forex, tokenized funds
          </p>
        </div>
      </section>

      {/* ===== How It Works ===== */}
      <section className="mx-auto max-w-4xl px-4 py-24">
        <h2 className="text-center text-3xl font-bold text-text-primary mb-4">
          How It Works
        </h2>
        <p className="text-center text-text-secondary mb-12 max-w-2xl mx-auto">
          European-style, cash-settled options. No actual assets change hands
          — everything settles in USDC based on oracle prices at expiry.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {[
            {
              step: "01",
              title: "Create Market",
              desc: "Anyone can create an options market for any Pyth-priced asset. Select asset class for calibrated pricing.",
            },
            {
              step: "02",
              title: "Write & Trade",
              desc: "Writers lock USDC collateral and mint Living Option Tokens. Buyers purchase at the writer's premium. B-S fair value shown as reference.",
            },
            {
              step: "03",
              title: "Resale or Exercise",
              desc: "Trade positions on the built-in secondary market before expiry. At settlement, holders exercise for USDC payout. Tokens self-destruct.",
            },
          ].map((item) => (
            <div
              key={item.step}
              className="rounded-xl border border-border bg-bg-surface p-6"
            >
              <div className="text-gold text-xs font-mono font-bold mb-3">
                {item.step}
              </div>
              <h3 className="text-lg font-semibold text-text-primary mb-2">
                {item.title}
              </h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== Why Butter Options ===== */}
      <section className="border-t border-border bg-bg-surface/30 py-20">
        <div className="mx-auto max-w-3xl px-4">
          <h2 className="text-center text-3xl font-bold text-text-primary mb-6">
            Why Butter Options?
          </h2>
          <div className="text-text-secondary leading-relaxed space-y-4 text-[15px]">
            <p>
              The global derivatives market is <span className="text-gold font-semibold">$846 trillion</span> — 8x global GDP. In crypto, derivatives do <span className="text-gold font-semibold">74% of all volume</span>. The #1 use case is hedging.
            </p>
            <p>
              Solana is building Internet Capital Markets — tokenized assets are arriving via Securitize, BlackRock-backed JupUSD, and the broader RWA wave. But institutions don't just buy assets — they hedge. No hedging infrastructure means no institutional money.
            </p>
            <p>
              Every previous options protocol on Solana has died or pivoted. Butter Options is the hedging layer that makes Solana institutionally complete.
            </p>
          </div>
        </div>
      </section>

      {/* ===== Footer ===== */}
      <footer className="border-t border-border py-8">
        <div className="mx-auto max-w-6xl px-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-sm text-text-muted">
              Butter Options — Colosseum Frontier Hackathon 2026
            </div>
            <div className="text-xs text-text-muted text-center">
              Built entirely with Claude Code. Zero traditional developers.
            </div>
            <div className="text-xs text-text-muted">
              Programs: <code className="text-gold/70 bg-bg-surface px-2 py-0.5 rounded text-[11px]">CtzJ...z9Cq</code>{" "}
              <code className="text-gold/70 bg-bg-surface px-2 py-0.5 rounded text-[11px]">83EW...fZMAG</code>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

/* ===== Feature Card Component ===== */

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  accent: "gold" | "green" | "purple";
}

const FeatureCard: FC<FeatureCardProps> = ({ icon, title, description, accent }) => {
  const accentStyles = {
    gold: {
      iconBg: "bg-gold/10",
      iconText: "text-gold",
      border: "hover:border-gold/30",
    },
    green: {
      iconBg: "bg-sol-green/10",
      iconText: "text-sol-green",
      border: "hover:border-sol-green/30",
    },
    purple: {
      iconBg: "bg-sol-purple/10",
      iconText: "text-sol-purple",
      border: "hover:border-sol-purple/30",
    },
  };

  const styles = accentStyles[accent];

  return (
    <div
      className={`
        rounded-2xl border border-border bg-bg-surface p-8
        transition-all duration-300 ${styles.border}
      `}
    >
      <div className={`mb-5 inline-flex rounded-xl p-3 ${styles.iconBg} ${styles.iconText}`}>
        {icon}
      </div>
      <h3 className="mb-3 text-lg font-semibold text-text-primary">{title}</h3>
      <p className="text-sm leading-relaxed text-text-secondary">{description}</p>
    </div>
  );
};
