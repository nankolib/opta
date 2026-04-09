import { FC, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { showToast } from "./Toast";

/**
 * Header — persistent navigation bar across all pages.
 *
 * Features:
 * - Butter Options logo/brand on the left
 * - Navigation links: Markets | Trade | Write | Portfolio
 * - Wallet connect button on the right
 * - "Devnet" network badge
 * - "Get Test SOL" airdrop button (when connected)
 */
export const Header: FC = () => {
  const location = useLocation();
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [airdropping, setAirdropping] = useState(false);

  const navLinks = [
    { path: "/markets", label: "Markets" },
    { path: "/trade", label: "Trade" },
    { path: "/write", label: "Write" },
    { path: "/portfolio", label: "Portfolio" },
    { path: "/docs", label: "Docs" },
  ];

  const isActive = (path: string) => location.pathname === path;

  // TODO: Add devnet USDC mint faucet endpoint
  const handleAirdrop = async () => {
    if (!publicKey || !connection) return;
    setAirdropping(true);
    try {
      const sig = await connection.requestAirdrop(publicKey, 1_000_000_000); // 1 SOL
      await connection.confirmTransaction(sig, "confirmed");
      showToast({ type: "success", title: "Airdropped 1 SOL!", message: "You now have devnet SOL for transaction fees." });
    } catch (err: any) {
      showToast({ type: "error", title: "Airdrop failed", message: "Devnet may be rate-limited. Try again in a minute." });
    } finally {
      setAirdropping(false);
    }
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-bg-primary/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        {/* Logo / Brand */}
        <Link to="/" className="flex items-center gap-3 no-underline">
          {/* Butter icon — a simple gold square with rounded corners */}
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gold/20 border border-gold/30">
            <span className="text-gold font-bold text-sm">B</span>
          </div>
          <span className="text-lg font-semibold text-text-primary tracking-tight">
            Butter
            <span className="text-gold ml-1">Options</span>
          </span>
        </Link>

        {/* Center Nav */}
        <nav className="hidden sm:flex items-center gap-1">
          {navLinks.map((link) => (
            <Link
              key={link.path}
              to={link.path}
              className={`
                px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 no-underline
                ${
                  isActive(link.path)
                    ? "bg-bg-surface text-gold"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-surface-hover"
                }
              `}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Right side: network badge + airdrop + wallet */}
        <div className="flex items-center gap-3">
          {/* Devnet badge */}
          <div className="hidden sm:flex items-center gap-1.5 rounded-full bg-sol-purple/10 border border-sol-purple/20 px-3 py-1">
            <div className="h-1.5 w-1.5 rounded-full bg-sol-purple animate-pulse" />
            <span className="text-xs font-medium text-sol-purple">Devnet</span>
          </div>

          {/* Get Test SOL — only visible when wallet is connected */}
          {connected && (
            <button
              onClick={handleAirdrop}
              disabled={airdropping}
              className="rounded-lg bg-bg-surface border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary hover:border-border-light transition-colors disabled:opacity-50"
            >
              {airdropping ? "Sending..." : "Get Test SOL"}
            </button>
          )}

          {/* Wallet connect button — styled to match our theme */}
          <WalletMultiButton
            style={{
              backgroundColor: "#D4A843",
              color: "#0A0A0B",
              fontFamily: '"Inter", system-ui, sans-serif',
              fontWeight: 600,
              fontSize: "14px",
              height: "40px",
              borderRadius: "10px",
              padding: "0 20px",
            }}
          />
        </div>
      </div>
    </header>
  );
};
