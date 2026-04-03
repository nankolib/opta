import { FC, useEffect, useState, useMemo } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { useProgram } from "../hooks/useProgram";
import { safeFetchAll } from "../hooks/useFetchAccounts";
import { showToast } from "../components/Toast";
import { formatUsdc, formatExpiry, getMarketStatus, truncateAddress, toUsdcBN } from "../utils/format";

interface MarketAccount {
  publicKey: PublicKey;
  account: {
    assetName: string;
    strikePrice: BN;
    expiryTimestamp: BN;
    optionType: { call: {} } | { put: {} };
    isSettled: boolean;
    settlementPrice: BN;
    pythFeed: PublicKey;
    bump: number;
  };
}

export const Markets: FC = () => {
  const { program } = useProgram();
  const { publicKey, connected } = useWallet();
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("All");
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    if (!program) return;
    setLoading(true);
    safeFetchAll<MarketAccount["account"]>(program, "optionsMarket")
      .then((results) => setMarkets(results as MarketAccount[]))
      .catch((err) => console.error("Failed to fetch markets:", err))
      .finally(() => setLoading(false));
  }, [program]);

  // Deduplicate: keep only the newest market per (asset + strike + type) combo
  const dedupedMarkets = useMemo(() => {
    const map = new Map<string, MarketAccount>();
    for (const m of markets) {
      const isCall = "call" in m.account.optionType;
      const key = `${m.account.assetName}-${m.account.strikePrice.toString()}-${isCall ? "C" : "P"}`;
      const existing = map.get(key);
      if (!existing || m.account.expiryTimestamp.gt(existing.account.expiryTimestamp)) {
        map.set(key, m);
      }
    }
    return Array.from(map.values());
  }, [markets]);

  const assetNames = useMemo(() => {
    return [...new Set(dedupedMarkets.map((m) => m.account.assetName))].sort();
  }, [dedupedMarkets]);

  const filteredMarkets = useMemo(() => {
    if (filter === "All") return dedupedMarkets;
    return dedupedMarkets.filter((m) => m.account.assetName === filter);
  }, [dedupedMarkets, filter]);

  const refetchMarkets = async () => {
    if (!program) return;
    const results = await safeFetchAll(program, "optionsMarket");
    setMarkets(results as MarketAccount[]);
  };

  return (
    <div className="min-h-screen bg-bg-primary pt-24 px-4 pb-12">
      <div className="mx-auto max-w-6xl">
        {/* Header — always visible */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Markets</h1>
            <p className="text-text-secondary mt-1">Browse active options markets across all supported assets.</p>
          </div>
          {connected && (
            <button onClick={() => setShowCreateModal(true)}
              className="rounded-xl bg-gold px-6 py-2.5 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors">
              + Create Market
            </button>
          )}
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-2">
          {["All", ...assetNames].map((name) => (
            <button key={name} onClick={() => setFilter(name)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
                filter === name ? "bg-gold/15 text-gold border border-gold/30" : "bg-bg-surface text-text-secondary border border-border hover:text-text-primary"
              }`}>{name}</button>
          ))}
        </div>

        {/* Markets table */}
        {loading ? (
          <div className="rounded-xl border border-border bg-bg-surface p-12 text-center">
            <div className="text-text-muted animate-pulse">Loading markets from devnet...</div>
          </div>
        ) : filteredMarkets.length === 0 ? (
          <div className="rounded-xl border border-border bg-bg-surface p-12 text-center">
            <div className="text-text-muted text-lg mb-2">No markets created yet</div>
            <p className="text-text-secondary text-sm">{connected ? 'Click "Create Market" to create the first options market.' : "Connect your wallet to create a market."}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-bg-surface overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Asset</th>
                  <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Type</th>
                  <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Strike</th>
                  <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Expiry</th>
                  <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Status</th>
                  <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-text-muted">Oracle</th>
                </tr>
              </thead>
              <tbody>
                {filteredMarkets.map((m) => {
                  const status = getMarketStatus(m.account);
                  const isCall = "call" in m.account.optionType;
                  return (
                    <tr key={m.publicKey.toBase58()} className="border-b border-border/50 hover:bg-bg-surface-hover transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gold/10 text-gold font-bold text-xs">{m.account.assetName.slice(0, 3)}</div>
                          <span className="text-sm font-medium text-text-primary">{m.account.assetName}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>{isCall ? "Call" : "Put"}</span>
                      </td>
                      <td className="px-6 py-4 text-sm text-text-primary">${formatUsdc(m.account.strikePrice)}</td>
                      <td className="px-6 py-4 text-sm text-text-secondary">{formatExpiry(m.account.expiryTimestamp)}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${status === "Active" ? "text-sol-green" : status === "Settled" ? "text-gold" : "text-text-muted"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${status === "Active" ? "bg-sol-green" : status === "Settled" ? "bg-gold" : "bg-text-muted"}`} />
                          {status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-xs text-text-muted font-mono">{truncateAddress(m.account.pythFeed.toBase58())}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && dedupedMarkets.length > 0 && (
          <div className="mt-4 text-sm text-text-muted">{filteredMarkets.length} market{filteredMarkets.length !== 1 ? "s" : ""}{filter !== "All" ? ` (${filter})` : ""}</div>
        )}
      </div>

      {showCreateModal && (
        <CreateMarketModal onClose={() => setShowCreateModal(false)} onCreated={() => { setShowCreateModal(false); refetchMarkets(); }} />
      )}
    </div>
  );
};

// =============================================================================
// Create Market Modal
// =============================================================================
const CreateMarketModal: FC<{ onClose: () => void; onCreated: () => void }> = ({ onClose, onCreated }) => {
  const { program, provider } = useProgram();
  const { publicKey } = useWallet();
  const [assetName, setAssetName] = useState("");
  const [strikePrice, setStrikePrice] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [optionType, setOptionType] = useState<"call" | "put">("call");
  const [pythFeed, setPythFeed] = useState("");
  const [assetClass, setAssetClass] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!program || !provider || !publicKey) return;
    if (!assetName || assetName.length > 16) { showToast({ type: "error", title: "Asset name must be 1-16 chars" }); return; }
    const strike = parseFloat(strikePrice);
    if (isNaN(strike) || strike <= 0) { showToast({ type: "error", title: "Invalid strike price" }); return; }
    const expiryTs = Math.floor(new Date(expiryDate).getTime() / 1000);
    if (isNaN(expiryTs) || expiryTs <= Date.now() / 1000) { showToast({ type: "error", title: "Expiry must be in the future" }); return; }
    let feedPubkey: PublicKey;
    try { feedPubkey = new PublicKey(pythFeed); } catch { showToast({ type: "error", title: "Invalid Pyth feed address" }); return; }

    setSubmitting(true);
    try {
      const strikeBN = toUsdcBN(strike);
      const expiryBN = new BN(expiryTs);
      const [marketPda] = PublicKey.findProgramAddressSync([
        Buffer.from("market"), Buffer.from(assetName),
        strikeBN.toArrayLike(Buffer, "le", 8), expiryBN.toArrayLike(Buffer, "le", 8),
        Buffer.from([optionType === "call" ? 0 : 1]),
      ], program.programId);
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);

      const tx = await program.methods
        .createMarket(assetName, strikeBN, expiryBN, optionType === "call" ? { call: {} } : { put: {} } as any, feedPubkey, assetClass)
        .accountsStrict({ creator: publicKey, protocolState: protocolStatePda, market: marketPda, systemProgram: SystemProgram.programId })
        .rpc({ commitment: "confirmed" });
      showToast({ type: "success", title: "Market created!", message: `${assetName} ${optionType.toUpperCase()} at $${strike}`, txSignature: tx });
      onCreated();
    } catch (err: any) {
      showToast({ type: "error", title: "Failed to create market", message: err?.message?.slice(0, 100) });
    } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-text-primary">Create Market</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-lg">✕</button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Asset Name (max 16 chars)</label>
            <input type="text" value={assetName} onChange={(e) => setAssetName(e.target.value.toUpperCase())} maxLength={16} placeholder="SOL, BTC, AAPL..."
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-gold/50 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Strike Price (USDC)</label>
            <input type="number" value={strikePrice} onChange={(e) => setStrikePrice(e.target.value)} placeholder="200.00"
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-gold/50 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Expiry Date</label>
            <input type="datetime-local" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Option Type</label>
            <div className="flex gap-2">
              <button onClick={() => setOptionType("call")} className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-all ${optionType === "call" ? "bg-sol-green/15 text-sol-green border border-sol-green/30" : "bg-bg-primary text-text-secondary border border-border"}`}>Call</button>
              <button onClick={() => setOptionType("put")} className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-all ${optionType === "put" ? "bg-sol-purple/15 text-sol-purple border border-sol-purple/30" : "bg-bg-primary text-text-secondary border border-border"}`}>Put</button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Asset Class</label>
            <select value={assetClass} onChange={(e) => setAssetClass(parseInt(e.target.value))}
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none">
              <option value={0}>Crypto</option>
              <option value={1}>Commodity</option>
              <option value={2}>Equity</option>
              <option value={3}>Forex</option>
              <option value={4}>ETF / Fund</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Pyth Oracle Feed</label>
            <input type="text" value={pythFeed} onChange={(e) => setPythFeed(e.target.value)} placeholder="Pyth price feed pubkey..."
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-xs text-text-primary placeholder:text-text-muted focus:border-gold/50 focus:outline-none font-mono" />
          </div>
          <button onClick={handleSubmit} disabled={submitting || !assetName || !strikePrice || !expiryDate || !pythFeed}
            className="w-full rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2">
            {submitting ? "Creating..." : "Create Market"}
          </button>
        </div>
      </div>
    </div>
  );
};
