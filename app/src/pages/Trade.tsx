import { FC, useEffect, useState, useMemo } from "react";
import { PublicKey, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { Link } from "react-router-dom";
import { useProgram } from "../hooks/useProgram";
import { safeFetchAll } from "../hooks/useFetchAccounts";
import { useVaults } from "../hooks/useVaults";
import { usePythPrices } from "../hooks/usePythPrices";
import { showToast } from "../components/Toast";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID, USE_V2_VAULTS, deriveExtraAccountMetaListPda, deriveHookStatePda } from "../utils/constants";
import { formatUsdc, formatExpiryShort, usdcToNumber, daysUntilExpiry, isExpired, truncateAddress } from "../utils/format";
import { calculateCallGreeks, calculatePutGreeks, calculateCallPremium, calculatePutPremium, getDefaultVolatility } from "../utils/blackScholes";
import type { Greeks } from "../utils/blackScholes";
import { BuyVaultModal } from "../components/trade/BuyVaultModal";

interface MarketAccount { publicKey: PublicKey; account: any; }
interface PositionAccount { publicKey: PublicKey; account: any; }

interface ChainRow {
  strike: number;
  callMarket: MarketAccount | null;
  putMarket: MarketAccount | null;
  callGreeks: Greeks;
  putGreeks: Greeks;
  callBestPosition: PositionAccount | null;
  putBestPosition: PositionAccount | null;
  callAsk: number | null;
  putAsk: number | null;
  callVolume: number;
  putVolume: number;
  // V2 vault mint references for the best ask
  callBestVaultMint?: { vaultMint: any; vault: any; market: any } | null;
  putBestVaultMint?: { vaultMint: any; vault: any; market: any } | null;
}

export const Trade: FC = () => {
  const { program, provider } = useProgram();
  const { publicKey, connected } = useWallet();
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [positions, setPositions] = useState<PositionAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState<string>("");
  const [selectedExpiry, setSelectedExpiry] = useState<number>(0);
  const [buyModal, setBuyModal] = useState<{ position: PositionAccount; market: any; isResale: boolean } | null>(null);

  // V2 vault state
  const { vaults, vaultMints, isLoading: vaultsLoading, refetch: refetchVaults } = useVaults();
  const [buyVaultModal, setBuyVaultModal] = useState<{ vaultMint: any; vault: any; market: any } | null>(null);

  useEffect(() => {
    if (!program) return;
    setLoading(true);
    Promise.all([safeFetchAll(program, "optionsMarket"), safeFetchAll(program, "optionPosition")])
      .then(([mkts, posns]) => {
        setMarkets(mkts as MarketAccount[]);
        setPositions(posns as PositionAccount[]);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [program]);

  // Step 1: Filter active markets + deduplicate (keep newest per asset+strike+expiry+type)
  const activeMarkets = useMemo(() => {
    const active = markets.filter((m) => !isExpired(m.account.expiryTimestamp));
    const map = new Map<string, MarketAccount>();
    for (const m of active) {
      const isCall = "call" in m.account.optionType;
      const expTs = typeof m.account.expiryTimestamp === "number" ? m.account.expiryTimestamp : m.account.expiryTimestamp.toNumber();
      const key = `${m.account.assetName}-${m.account.strikePrice.toString()}-${expTs}-${isCall ? "C" : "P"}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, m);
      } else {
        // Keep the one with the higher pubkey as tiebreaker (deterministic)
        if (m.publicKey.toBase58() > existing.publicKey.toBase58()) {
          map.set(key, m);
        }
      }
    }
    return Array.from(map.values());
  }, [markets]);

  // Step 2: Unique asset names → asset tabs (include v2 vault assets)
  const assets = useMemo(() => {
    const names = new Set(activeMarkets.map((m) => m.account.assetName as string));
    if (USE_V2_VAULTS) {
      for (const v of vaults) {
        if (v.account.isSettled) continue;
        const mkt = markets.find((m) => m.publicKey.equals(v.account.market as PublicKey));
        if (mkt) names.add(mkt.account.assetName as string);
      }
    }
    return Array.from(names).sort();
  }, [activeMarkets, vaults, markets]);

  // Auto-select first asset
  useEffect(() => {
    if (assets.length > 0 && !assets.includes(selectedAsset)) {
      setSelectedAsset(assets[0]);
    }
  }, [assets]);

  // Step 3: For selected asset, unique expiry timestamps → expiry tabs
  // Round to nearest day to avoid duplicate tabs from timestamps seconds apart
  const roundToDay = (ts: number) => Math.floor(ts / 86400) * 86400;
  const expiries = useMemo(() => {
    const assetMarkets = activeMarkets.filter((m) => m.account.assetName === selectedAsset);
    const dayMap = new Map<number, number>(); // rounded → first actual timestamp
    for (const m of assetMarkets) {
      const t = typeof m.account.expiryTimestamp === "number" ? m.account.expiryTimestamp : m.account.expiryTimestamp.toNumber();
      const rounded = roundToDay(t);
      if (!dayMap.has(rounded)) dayMap.set(rounded, t);
    }
    // Include vault expiries
    if (USE_V2_VAULTS) {
      for (const v of vaults) {
        if (v.account.isSettled) continue;
        const mkt = markets.find((m) => m.publicKey.equals(v.account.market as PublicKey));
        if (!mkt || mkt.account.assetName !== selectedAsset) continue;
        const t = typeof v.account.expiry === "number" ? v.account.expiry : v.account.expiry.toNumber();
        const rounded = roundToDay(t);
        if (!dayMap.has(rounded)) dayMap.set(rounded, t);
      }
    }
    return Array.from(dayMap.values()).sort((a, b) => a - b);
  }, [activeMarkets, selectedAsset, vaults, markets]);

  // Auto-select first expiry
  useEffect(() => {
    if (expiries.length > 0 && !expiries.includes(selectedExpiry)) {
      setSelectedExpiry(expiries[0]);
    }
  }, [expiries]);

  // Live Pyth prices
  const assetNames = useMemo(() => [...new Set(activeMarkets.map(m => m.account.assetName as string))], [activeMarkets]);
  const { prices: spotPrices } = usePythPrices(assetNames);

  // Step 4-8: Build the chain rows
  const { rows, spotPrice } = useMemo(() => {
    const selectedDay = roundToDay(selectedExpiry);
    const filtered = activeMarkets.filter((m) => {
      const t = typeof m.account.expiryTimestamp === "number" ? m.account.expiryTimestamp : m.account.expiryTimestamp.toNumber();
      return m.account.assetName === selectedAsset && roundToDay(t) === selectedDay;
    });

    // Collect all strikes (from markets + v2 vaults)
    const strikeSet = new Set<number>();
    filtered.forEach((m) => strikeSet.add(usdcToNumber(m.account.strikePrice)));
    if (USE_V2_VAULTS) {
      for (const v of vaults) {
        if (v.account.isSettled) continue;
        const vExpiry = typeof v.account.expiry === "number" ? v.account.expiry : v.account.expiry.toNumber();
        if (roundToDay(vExpiry) !== selectedDay) continue;
        const mkt = markets.find((m) => m.publicKey.equals(v.account.market as PublicKey));
        if (mkt?.account.assetName === selectedAsset) {
          strikeSet.add(usdcToNumber(v.account.strikePrice));
        }
      }
    }
    const strikes = Array.from(strikeSet).sort((a, b) => a - b);

    // Use live Pyth price if available, otherwise fall back to median strike
    const median = strikes.length > 0 ? strikes[Math.floor(strikes.length / 2)] : 0;
    const liveSpot = spotPrices[selectedAsset] || median;

    const vol = getDefaultVolatility(selectedAsset);
    const days = selectedExpiry > 0 ? Math.max(0, (selectedExpiry - Date.now() / 1000) / 86400) : 0;

    const chainRows: ChainRow[] = strikes.map((strike) => {
      // Find call and put markets for this strike
      const callMarket = filtered.find((m) => usdcToNumber(m.account.strikePrice) === strike && "call" in m.account.optionType) || null;
      const putMarket = filtered.find((m) => usdcToNumber(m.account.strikePrice) === strike && "put" in m.account.optionType) || null;

      // Greeks
      const callGreeks = calculateCallGreeks(liveSpot, strike, days, vol);
      const putGreeks = calculatePutGreeks(liveSpot, strike, days, vol);

      // Find available positions for each market
      const findBest = (market: MarketAccount | null): { best: PositionAccount | null; ask: number | null; volume: number } => {
        if (!market) return { best: null, ask: null, volume: 0 };
        const marketKey = market.publicKey.toBase58();
        const available = positions.filter((p) =>
          !p.account.isExercised &&
          !p.account.isExpired &&
          !p.account.isCancelled &&
          !p.account.isListedForResale &&
          p.account.market.toBase58() === marketKey,
        );

        let volume = 0;
        let bestPos: PositionAccount | null = null;
        let bestPrice = Infinity;

        for (const p of available) {
          const sold = p.account.tokensSold?.toNumber?.() || 0;
          const total = p.account.totalSupply?.toNumber?.() || 1;
          volume += sold;
          const unsold = total - sold;
          if (unsold > 0) {
            const perContract = usdcToNumber(p.account.premium) / total;
            if (perContract < bestPrice) {
              bestPrice = perContract;
              bestPos = p;
            }
          }
        }

        return { best: bestPos, ask: bestPos ? bestPrice : null, volume };
      };

      const callResult = findBest(callMarket);
      const putResult = findBest(putMarket);

      // V2: overlay vault mint data if available and cheaper
      let callBestVaultMint: ChainRow["callBestVaultMint"] = null;
      let putBestVaultMint: ChainRow["putBestVaultMint"] = null;
      let callAsk = callResult.ask;
      let putAsk = putResult.ask;
      let callVolume = callResult.volume;
      let putVolume = putResult.volume;

      if (USE_V2_VAULTS) {
        // Find vault mints matching this strike+type from active vaults
        for (const vm of vaultMints) {
          const parentVault = vaults.find((v) => v.publicKey.equals(vm.account.vault as PublicKey));
          if (!parentVault || parentVault.account.isSettled) continue;
          const vExpiry = typeof parentVault.account.expiry === "number" ? parentVault.account.expiry : parentVault.account.expiry.toNumber();
          if (roundToDay(vExpiry) !== selectedDay) continue;
          const vStrike = usdcToNumber(parentVault.account.strikePrice);
          if (vStrike !== strike) continue;
          const parentMkt = markets.find((m) => m.publicKey.equals(parentVault.account.market as PublicKey));
          if (!parentMkt || parentMkt.account.assetName !== selectedAsset) continue;

          const vIsCall = "call" in parentVault.account.optionType;
          const unsold = (vm.account.quantityMinted?.toNumber?.() || 0) - (vm.account.quantitySold?.toNumber?.() || 0);
          if (unsold <= 0) continue;
          const price = usdcToNumber(vm.account.premiumPerContract);
          const sold = vm.account.quantitySold?.toNumber?.() || 0;

          if (vIsCall) {
            callVolume += sold;
            if (callAsk === null || price < callAsk) {
              callAsk = price;
              callBestVaultMint = { vaultMint: vm, vault: parentVault, market: parentMkt?.account };
            }
          } else {
            putVolume += sold;
            if (putAsk === null || price < putAsk) {
              putAsk = price;
              putBestVaultMint = { vaultMint: vm, vault: parentVault, market: parentMkt?.account };
            }
          }
        }
      }

      return {
        strike,
        callMarket,
        putMarket,
        callGreeks,
        putGreeks,
        callBestPosition: callBestVaultMint ? null : callResult.best,
        putBestPosition: putBestVaultMint ? null : putResult.best,
        callAsk,
        putAsk,
        callVolume,
        putVolume,
        callBestVaultMint,
        putBestVaultMint,
      };
    });

    return { rows: chainRows, spotPrice: liveSpot };
  }, [activeMarkets, positions, selectedAsset, selectedExpiry, spotPrices, vaults, vaultMints]);

  // ATM strike (closest to spot)
  const atmStrike = useMemo(() => {
    if (rows.length === 0 || spotPrice === 0) return 0;
    let closest = rows[0].strike;
    let minDiff = Math.abs(rows[0].strike - spotPrice);
    for (const r of rows) {
      const diff = Math.abs(r.strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        closest = r.strike;
      }
    }
    return closest;
  }, [rows, spotPrice]);

  const refetch = async () => {
    if (!program) return;
    const [mkts, posns] = await Promise.all([safeFetchAll(program, "optionsMarket"), safeFetchAll(program, "optionPosition")]);
    setMarkets(mkts as MarketAccount[]);
    setPositions(posns as PositionAccount[]);
  };

  return (
    <div className="min-h-screen bg-bg-primary pt-24 px-4 pb-12">
      <div className="mx-auto max-w-7xl">
        {/* 1. Page header */}
        <h1 className="text-3xl font-bold text-text-primary mb-2">Trade</h1>
        <p className="text-text-secondary mb-8">Select an asset and expiry to view the options chain.</p>

        {loading ? (
          <div className="rounded-xl border border-border bg-bg-surface p-12 text-center">
            <div className="text-text-muted animate-pulse">Loading from devnet...</div>
          </div>
        ) : activeMarkets.length === 0 ? (
          <div className="rounded-xl border border-border bg-bg-surface p-12 text-center">
            <p className="text-text-muted">No active markets found. Create one on the <Link to="/markets" className="text-gold hover:underline">Markets page</Link>.</p>
          </div>
        ) : (
          <>
            {/* 2. Asset tabs */}
            <div className="flex flex-wrap gap-2 mb-4">
              {assets.map((asset) => (
                <button
                  key={asset}
                  onClick={() => setSelectedAsset(asset)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    selectedAsset === asset
                      ? "bg-gold/15 text-gold border border-gold/30"
                      : "bg-bg-surface text-text-secondary border border-border hover:text-text-primary hover:border-border-light"
                  }`}
                >
                  {asset}
                </button>
              ))}
            </div>

            {/* 3. Expiry tabs */}
            <div className="flex flex-wrap gap-2 mb-6">
              {expiries.map((ts) => (
                <button
                  key={ts}
                  onClick={() => setSelectedExpiry(ts)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selectedExpiry === ts
                      ? "bg-gold/15 text-gold border border-gold/30"
                      : "bg-bg-surface text-text-secondary border border-border hover:text-text-primary"
                  }`}
                >
                  {formatExpiryShort(ts)} ({Math.round(daysUntilExpiry(ts))}d)
                </button>
              ))}
            </div>

            {/* 4. Spot price bar */}
            <div className="flex items-center justify-between rounded-lg border border-border bg-bg-surface px-4 py-2 mb-6">
              <span className="text-sm text-text-secondary">
                Spot: <span className="text-text-primary font-medium">${spotPrice.toFixed(2)}</span>{" "}
                <span className="text-text-muted text-xs">{spotPrices[selectedAsset] ? "(live — Pyth)" : "(estimated)"}</span>
              </span>
              <span className="text-xs text-sol-purple">Devnet — not real money</span>
            </div>

            {!publicKey && (
              <div className="rounded-lg border border-gold/20 bg-gold/5 px-4 py-2 mb-4 text-xs text-text-secondary text-center">
                Connect your wallet to buy options. Click any Ask price to purchase.
              </div>
            )}

            {/* 5. CALLS / PUTS labels */}
            <div className="flex items-center justify-between mb-2 px-2">
              <span className="text-xs font-semibold uppercase tracking-wider px-3 py-1 rounded-full bg-sol-green/10 text-sol-green">Calls</span>
              <span className="text-xs font-semibold uppercase tracking-wider px-3 py-1 rounded-full bg-sol-purple/10 text-sol-purple">Puts</span>
            </div>

            {/* 6. The grid table */}
            <div className="rounded-xl border border-border bg-bg-surface overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      {/* Call columns */}
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-green/70 text-right">Delta</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-green/70 text-right">Gamma</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-green/70 text-right">Theta</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-green/70 text-right">Vega</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-green/70 text-right">Fair</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-green/70 text-right">Ask</th>
                      {/* Strike */}
                      <th className="px-3 py-3 text-xs font-medium uppercase tracking-wider text-text-muted bg-bg-primary/50 text-center">Strike</th>
                      {/* Put columns */}
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-purple/70 text-left">Ask</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-purple/70 text-left">Fair</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-purple/70 text-left">Vega</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-purple/70 text-left">Theta</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-purple/70 text-left">Gamma</th>
                      <th className="px-2 py-3 text-xs font-medium uppercase tracking-wider text-sol-purple/70 text-left">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={13} className="px-4 py-8 text-center text-text-muted">
                          No options available for this market yet. <a href="/write" className="text-gold hover:underline">Write some options</a>.
                        </td>
                      </tr>
                    ) : (
                      rows.map((row) => {
                        const isAtm = row.strike === atmStrike;
                        const callItm = row.strike < spotPrice;
                        const putItm = row.strike > spotPrice;

                        return (
                          <tr key={row.strike} className="border-b border-border/50 hover:bg-bg-surface-hover transition-colors">
                            {/* Call side */}
                            <td className={`px-2 py-2.5 text-xs text-right ${callItm ? "bg-sol-green/5" : ""}`}>
                              <span style={{ color: `rgba(74,222,128,${Math.abs(row.callGreeks.delta)})` }}>{row.callGreeks.delta.toFixed(2)}</span>
                            </td>
                            <td className={`px-2 py-2.5 text-xs text-text-muted text-right ${callItm ? "bg-sol-green/5" : ""}`}>{row.callGreeks.gamma.toFixed(4)}</td>
                            <td className={`px-2 py-2.5 text-xs text-right ${callItm ? "bg-sol-green/5" : ""}`}>
                              <span className="text-loss">{row.callGreeks.theta < 0 ? row.callGreeks.theta.toFixed(2) : `-${row.callGreeks.theta.toFixed(2)}`}</span>
                            </td>
                            <td className={`px-2 py-2.5 text-xs text-text-muted text-right ${callItm ? "bg-sol-green/5" : ""}`}>{row.callGreeks.vega.toFixed(2)}</td>
                            <td className={`px-2 py-2.5 text-text-secondary text-right text-xs ${callItm ? "bg-sol-green/5" : ""}`}>${row.callGreeks.premium.toFixed(2)}</td>
                            <td className={`px-2 py-2.5 text-right ${callItm ? "bg-sol-green/5" : ""}`}>
                              {row.callAsk !== null ? (
                                <button onClick={() => { if (row.callBestVaultMint) setBuyVaultModal(row.callBestVaultMint); else if (row.callBestPosition && row.callMarket) setBuyModal({ position: row.callBestPosition, market: row.callMarket.account, isResale: false }); }}
                                  className="cursor-pointer text-xs font-medium text-sol-green hover:text-sol-green/80 hover:underline">${row.callAsk.toFixed(2)}</button>
                              ) : <span className="text-text-muted/50 text-xs">—</span>}
                            </td>

                            {/* Strike */}
                            <td className={`text-center font-medium text-text-primary bg-bg-primary/30 px-3 py-2.5 text-sm ${isAtm ? "text-gold font-bold" : ""}`}>
                              ${row.strike % 1 === 0 ? row.strike.toLocaleString() : row.strike.toFixed(2)}{isAtm ? " ←" : ""}
                            </td>

                            {/* Put side */}
                            <td className={`px-2 py-2.5 ${putItm ? "bg-sol-purple/5" : ""}`}>
                              {row.putAsk !== null ? (
                                <button onClick={() => { if (row.putBestVaultMint) setBuyVaultModal(row.putBestVaultMint); else if (row.putBestPosition && row.putMarket) setBuyModal({ position: row.putBestPosition, market: row.putMarket.account, isResale: false }); }}
                                  className="cursor-pointer text-xs font-medium text-sol-purple hover:text-sol-purple/80 hover:underline">${row.putAsk.toFixed(2)}</button>
                              ) : <span className="text-text-muted/50 text-xs">—</span>}
                            </td>
                            <td className={`px-2 py-2.5 text-text-secondary text-xs ${putItm ? "bg-sol-purple/5" : ""}`}>${row.putGreeks.premium.toFixed(2)}</td>
                            <td className={`px-2 py-2.5 text-xs text-text-muted ${putItm ? "bg-sol-purple/5" : ""}`}>{row.putGreeks.vega.toFixed(2)}</td>
                            <td className={`px-2 py-2.5 text-xs ${putItm ? "bg-sol-purple/5" : ""}`}>
                              <span className="text-loss">{row.putGreeks.theta < 0 ? row.putGreeks.theta.toFixed(2) : `-${row.putGreeks.theta.toFixed(2)}`}</span>
                            </td>
                            <td className={`px-2 py-2.5 text-xs text-text-muted ${putItm ? "bg-sol-purple/5" : ""}`}>{row.putGreeks.gamma.toFixed(4)}</td>
                            <td className={`px-2 py-2.5 text-xs ${putItm ? "bg-sol-purple/5" : ""}`}>
                              <span style={{ color: `rgba(192,132,252,${Math.abs(row.putGreeks.delta)})` }}>{row.putGreeks.delta.toFixed(2)}</span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 7. Legend */}
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-muted px-2">
              <span><strong>Delta</strong> — Price sensitivity per $1 move</span>
              <span><strong>Gamma</strong> — Delta change rate</span>
              <span><strong>Theta</strong> — Daily time decay (USD)</span>
              <span><strong>Vega</strong> — Sensitivity to 1% IV change</span>
              <span><strong>Fair</strong> — B-S theoretical value</span>
              <span><strong>Ask</strong> — Cheapest available (click to buy)</span>
            </div>

            {/* 8. Link to Write page */}
            <div className="mt-6 text-center">
              <Link to="/write" className="text-sm text-text-secondary hover:text-gold transition-colors">
                Want to sell options? Go to Write Options →
              </Link>
            </div>
          </>
        )}
      </div>

      {/* Buy Confirmation Modal (v1) */}
      {buyModal && (
        <BuyConfirmModal
          {...buyModal}
          spotPrices={spotPrices}
          program={program}
          provider={provider}
          publicKey={publicKey}
          onClose={() => setBuyModal(null)}
          onSuccess={() => { setBuyModal(null); refetch(); }}
        />
      )}

      {/* Buy Vault Modal (v2) */}
      {buyVaultModal && publicKey && (
        <BuyVaultModal
          vaultMint={buyVaultModal.vaultMint}
          vault={buyVaultModal.vault}
          market={buyVaultModal.market}
          spotPrice={spotPrices[buyVaultModal.market?.assetName] || 0}
          program={program}
          publicKey={publicKey}
          onClose={() => setBuyVaultModal(null)}
          onSuccess={() => { setBuyVaultModal(null); refetch(); refetchVaults(); }}
        />
      )}
    </div>
  );
};

// =============================================================================
// Buy Confirmation Modal (duplicated from Write.tsx for self-containment)
// =============================================================================
const BuyConfirmModal: FC<{
  position: PositionAccount; market: any; isResale: boolean;
  spotPrices?: Record<string, number>;
  program: any; provider: any; publicKey: PublicKey | null;
  onClose: () => void; onSuccess: () => void;
}> = ({ position, market, isResale, spotPrices, program, provider, publicKey, onClose, onSuccess }) => {
  const [submitting, setSubmitting] = useState(false);
  const [quantity, setQuantity] = useState("");
  const isCall = "call" in market.optionType;
  const totalSupply = position.account.totalSupply?.toNumber?.() || 1_000_000;
  const tokensSold = position.account.tokensSold?.toNumber?.() || 0;
  const available = isResale ? (position.account.resaleTokenAmount?.toNumber?.() || 0) : (totalSupply - tokensSold);
  const price = isResale ? position.account.resalePremium : position.account.premium;
  const pricePerToken = usdcToNumber(price) / (isResale ? (position.account.resaleTokenAmount?.toNumber?.() || 1) : totalSupply);
  const qty = parseInt(quantity) || available;
  const totalCost = pricePerToken * qty;
  const strike = usdcToNumber(market.strikePrice);
  const spot = spotPrices?.[market.assetName] || strike;
  const days = daysUntilExpiry(market.expiryTimestamp);
  const vol = getDefaultVolatility(market.assetName);
  const fair = isCall ? calculateCallPremium(spot, strike, days, vol) : calculatePutPremium(spot, strike, days, vol);

  const handleConfirm = async () => {
    if (!program || !provider || !publicKey) return;
    setSubmitting(true);
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);

      const buyerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, position.account.writer);

      const optionMint = position.account.optionMint;
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
      const [hookState] = deriveHookStatePda(optionMint);
      const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

      const buyerOptionAccount = getAssociatedTokenAddressSync(optionMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
      const createBuyerAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        publicKey, buyerOptionAccount, publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const preIxs = [EXTRA_CU, createBuyerAtaIx];

      if (isResale) {
        const sellerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, position.account.resaleSeller);
        const [resaleEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("resale_escrow"), position.publicKey.toBuffer()], program.programId);

        const tx = await program.methods.buyResale(new BN(qty)).accountsStrict({
          buyer: publicKey, protocolState: protocolStatePda, position: position.publicKey,
          resaleEscrow: resaleEscrowPda, buyerUsdcAccount, sellerUsdcAccount,
          buyerOptionAccount, optionMint, treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID, extraAccountMetaList, hookState,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        }).preInstructions(preIxs).rpc({ commitment: "confirmed" });
        showToast({ type: "success", title: "Resale purchased!", message: `Paid $${formatUsdc(price)}`, txSignature: tx });
      } else {
        const [purchaseEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("purchase_escrow"), position.publicKey.toBuffer()], program.programId);

        const tx = await program.methods.purchaseOption(new BN(qty)).accountsStrict({
          buyer: publicKey, protocolState: protocolStatePda, market: position.account.market,
          position: position.publicKey, purchaseEscrow: purchaseEscrowPda,
          buyerUsdcAccount, writerUsdcAccount,
          buyerOptionAccount, optionMint, treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID, extraAccountMetaList, hookState,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        }).preInstructions(preIxs).rpc({ commitment: "confirmed" });
        showToast({ type: "success", title: "Option purchased!", message: `Paid $${formatUsdc(price)} USDC`, txSignature: tx });
      }
      onSuccess();
    } catch (err: any) {
      const msg = err?.message || err?.toString() || "Unknown error";
      if (msg.includes("User rejected")) {
        showToast({ type: "error", title: "Transaction cancelled", message: "You rejected the transaction in your wallet." });
      } else {
        showToast({ type: "error", title: "Purchase failed", message: msg.slice(0, 120) });
      }
    } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg-surface p-6 shadow-2xl">
        <h2 className="text-lg font-bold text-text-primary mb-4">{isResale ? "Buy Resale" : "Buy Option"}</h2>
        <div className="rounded-xl bg-bg-primary border border-border p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg font-bold text-text-primary">{market.assetName}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>{isCall ? "Call" : "Put"}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-text-muted">Strike:</span> <span className="text-text-primary font-medium">${formatUsdc(market.strikePrice)}</span></div>
            <div><span className="text-text-muted">Expiry:</span> <span className="text-text-primary font-medium">{formatExpiryShort(market.expiryTimestamp)}</span></div>
          </div>
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Contracts to buy</label>
          <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)}
            placeholder={available.toString()} min="1" max={available}
            className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          <div className="text-xs text-text-muted mt-1">Available: {available.toLocaleString()} contracts</div>
        </div>
        <div className="space-y-2 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Price per contract:</span>
            <span className="text-text-secondary">${pricePerToken.toFixed(4)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Total cost:</span>
            <span className="text-gold font-bold text-lg">${totalCost.toFixed(2)} USDC</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">Fair Value (B-S):</span>
            <span className="text-text-secondary">${fair.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">Protocol Fee (0.5%):</span>
            <span className="text-text-secondary">${(totalCost * 0.005).toFixed(4)}</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-border py-3 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
          <button onClick={handleConfirm} disabled={submitting}
            className="flex-1 rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50">
            {submitting ? "Confirm in wallet..." : "Confirm Buy"}
          </button>
        </div>
      </div>
    </div>
  );
};
