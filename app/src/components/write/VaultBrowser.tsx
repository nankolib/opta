import { FC, useState, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { formatUsdc, formatExpiry, usdcToNumber } from "../../utils/format";

interface VaultBrowserProps {
  vaults: { publicKey: PublicKey; account: any }[];
  markets: { publicKey: PublicKey; account: any }[];
  myPositions: { publicKey: PublicKey; account: any }[];
  onDeposit: (vaultKey: PublicKey) => void;
  onBack: () => void;
  onRefresh?: () => void;
  onCreateEpoch?: () => void;
}

export const VaultBrowser: FC<VaultBrowserProps> = ({ vaults, markets, myPositions, onDeposit, onBack, onRefresh, onCreateEpoch }) => {
  const [assetFilter, setAssetFilter] = useState("all");

  // Build market lookup
  const marketMap = useMemo(() => {
    const map = new Map<string, any>();
    markets.forEach((m) => map.set(m.publicKey.toBase58(), m.account));
    return map;
  }, [markets]);

  // Only show epoch vaults that aren't settled
  const epochVaults = useMemo(() =>
    vaults.filter((v) => v.account.vaultType && "epoch" in v.account.vaultType && !v.account.isSettled),
  [vaults]);

  // Get unique asset names from markets linked to vaults
  const assetNames = useMemo(() => {
    const names = new Set<string>();
    for (const v of epochVaults) {
      const mkt = marketMap.get((v.account.market as PublicKey).toBase58());
      if (mkt) names.add(mkt.assetName);
    }
    return Array.from(names).sort();
  }, [epochVaults, marketMap]);

  // Filter vaults by asset
  const filtered = useMemo(() => {
    if (assetFilter === "all") return epochVaults;
    return epochVaults.filter((v) => {
      const mkt = marketMap.get((v.account.market as PublicKey).toBase58());
      return mkt?.assetName === assetFilter;
    });
  }, [epochVaults, assetFilter, marketMap]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-sm text-text-secondary hover:text-text-primary transition-colors">&larr; Back</button>
          <h2 className="text-lg font-semibold text-text-primary">Epoch Pools</h2>
          <span className="text-xs px-2 py-0.5 rounded-full bg-sol-purple/10 text-sol-purple">{filtered.length} vaults</span>
          {onRefresh && (
            <button onClick={onRefresh} className="text-xs text-text-muted hover:text-text-primary transition-colors">&#x21bb; Refresh</button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onCreateEpoch && (
            <button onClick={onCreateEpoch}
              className="rounded-lg bg-gold/15 border border-gold/30 px-4 py-1.5 text-xs font-semibold text-gold hover:bg-gold/25 transition-colors">
              + Create Epoch Vault
            </button>
          )}
          <select value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)}
            className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none">
            <option value="all">All assets</option>
            {assetNames.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-bg-surface p-12 text-center">
          <p className="text-text-muted text-sm">No epoch vaults found. Create one or wait for the next epoch.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-bg-surface overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-text-muted text-xs">
                <th className="text-left px-4 py-3 font-medium">Asset</th>
                <th className="text-right px-4 py-3 font-medium">Strike</th>
                <th className="text-center px-4 py-3 font-medium">Type</th>
                <th className="text-right px-4 py-3 font-medium">Expiry</th>
                <th className="text-right px-4 py-3 font-medium">Total Pooled</th>
                <th className="text-right px-4 py-3 font-medium">Your Shares</th>
                <th className="text-right px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => {
                const mkt = marketMap.get((v.account.market as PublicKey).toBase58());
                if (!mkt) return null;
                const isCall = "call" in v.account.optionType;
                const myPos = myPositions.find((wp) => (wp.account.vault as PublicKey).equals(v.publicKey));
                const myShares = myPos ? myPos.account.shares.toNumber() : 0;
                const totalShares = v.account.totalShares.toNumber();
                const pct = totalShares > 0 ? ((myShares / totalShares) * 100).toFixed(1) : "0";

                return (
                  <tr key={v.publicKey.toBase58()} className="border-b border-border/50 hover:bg-bg-surface-hover transition-colors">
                    <td className="px-4 py-3 font-medium text-text-primary">{mkt.assetName}</td>
                    <td className="px-4 py-3 text-right text-text-primary">${formatUsdc(v.account.strikePrice)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>
                        {isCall ? "Call" : "Put"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-text-secondary text-xs">{formatExpiry(v.account.expiry)}</td>
                    <td className="px-4 py-3 text-right text-text-primary">${formatUsdc(v.account.totalCollateral)}</td>
                    <td className="px-4 py-3 text-right text-text-secondary">
                      {myShares > 0 ? <span className="text-gold">{myShares.toLocaleString()} ({pct}%)</span> : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => onDeposit(v.publicKey)}
                        className="rounded-lg bg-gold/15 border border-gold/30 px-4 py-1.5 text-xs font-semibold text-gold hover:bg-gold/25 transition-colors">
                        Deposit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
