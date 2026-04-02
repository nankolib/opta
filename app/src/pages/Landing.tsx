import { FC } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

/**
 * Landing page — the first thing hackathon judges see.
 *
 * Layout:
 * 1. Hero section with tagline and CTA
 * 2. Three feature cards explaining the protocol
 * 3. Supported assets strip
 * 4. Architecture preview
 */
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
        <h1 className="text-center text-5xl sm:text-7xl font-bold tracking-tight text-text-primary max-w-4xl leading-[1.1]">
          The Composable
          <br />
          <span className="bg-gradient-to-r from-gold via-gold to-gold-dim bg-clip-text text-transparent">
            Options Primitive
          </span>
          <br />
          for Solana
        </h1>

        {/* Subtitle */}
        <p className="mt-6 max-w-2xl text-center text-lg text-text-secondary leading-relaxed">
          Peer-to-peer, cash-settled options for every asset with an oracle feed.
          Create markets for any token, stock, commodity, or forex pair
          — all settled in USDC on Solana.
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
            { label: "Assets", value: "Any" },
            { label: "Option Types", value: "2" },
            { label: "Settlement", value: "USDC" },
            { label: "Oracle", value: "Pyth" },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-2xl font-bold text-text-primary">{stat.value}</div>
              <div className="text-xs text-text-muted mt-1">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ===== Feature Cards ===== */}
      <section className="mx-auto max-w-6xl px-4 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Peer-to-Peer */}
          <FeatureCard
            icon={
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
            }
            title="Peer-to-Peer"
            description="No order books, no market makers. Writers set their own premiums and buyers choose directly. Fully decentralized option creation and trading."
            accent="gold"
          />

          {/* Oracle-Priced */}
          <FeatureCard
            icon={
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6" />
              </svg>
            }
            title="Oracle-Priced"
            description="Settlement prices powered by Pyth Network price feeds. Supports SOL, BTC, ETH, Gold (XAU), and Oil (WTI) with reliable, decentralized oracles."
            accent="green"
          />

          {/* Composable */}
          <FeatureCard
            icon={
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.421 48.421 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 01-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 005.427-.63 48.05 48.05 0 00.582-4.717.532.532 0 00-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.959.401v0a.656.656 0 00.658-.663 48.422 48.422 0 00-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 01-.61-.58v0z" />
              </svg>
            }
            title="Composable via CPI"
            description="Other Solana programs can call Butter Options directly. Build structured products, vaults, or automated strategies on top of the protocol."
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
              { name: "WTI", label: "Oil" },
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
              title: "Write",
              desc: "Lock USDC collateral to create an option. Set your own premium and contract size.",
            },
            {
              step: "02",
              title: "Trade",
              desc: "Browse available options and buy by paying the premium. Fee split: 99.5% to writer, 0.5% protocol.",
            },
            {
              step: "03",
              title: "Settle",
              desc: "At expiry, the oracle price determines the payout. In-the-money options pay the buyer automatically.",
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

      {/* ===== Footer ===== */}
      <footer className="border-t border-border py-8">
        <div className="mx-auto max-w-6xl px-4 flex items-center justify-between">
          <div className="text-sm text-text-muted">
            Butter Options — Colosseum Frontier Hackathon 2026
          </div>
          <div className="text-xs text-text-muted">
            Program: <code className="text-gold/70 bg-bg-surface px-2 py-0.5 rounded text-[11px]">CtzJ...z9Cq</code>
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
