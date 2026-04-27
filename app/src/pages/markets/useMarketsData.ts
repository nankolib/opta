import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { usePythPrices } from "../../hooks/usePythPrices";
import { applyVolSmile, getDefaultVolatility } from "../../utils/blackScholes";
import { usdcToNumber } from "../../utils/format";

export type MarketStatus = "open" | "settled" | "expired";

interface MarketAccount {
  publicKey: PublicKey;
  account: any;
}
interface PositionAccount {
  publicKey: PublicKey;
  account: any;
}

export type MarketRow = {
  publicKey: PublicKey;
  account: any;
  asset: string;
  side: "call" | "put";
  strike: number;
  expiry: number;
  spot: number | null;
  iv: number | null;
  openInterest: number;
  vaultTvl: number | null;
  status: MarketStatus;
  isV2: boolean;
};

export type MarketsSummary = {
  activeMarkets: number;
  underlyings: number;
  openInterest: number;
  vaultTvl: number;
  premiaWritten: number;
  loaded: boolean;
};

export type UseMarketsData = {
  rows: MarketRow[];
  summary: MarketsSummary;
  spotPrices: Record<string, number>;
  loading: boolean;
  refetch: () => Promise<void>;
};

/**
 * Bundles markets + vaults + positions + prices fetching for the
 * Markets page. Produces the normalised MarketRow[] shape the table
 * consumes plus the four summary aggregates the band displays.
 *
 * Open interest is computed from totalSupply across both v1 positions
 * and v2 vaultMints — both arrays already in memory after fetch, so
 * the aggregation is a cheap pass with no extra RPC.
 *
 * Vault TVL aggregates `totalCollateral` (USDC) across v2 vaults.
 * Premia Written aggregates `totalPremiumReceived` across v2 vaults
 * (cumulative since vault creation; no per-day indexer exists).
 */
export function useMarketsData(): UseMarketsData {
  const { program } = useProgram();
  const { vaults } = useVaults();
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [positions, setPositions] = useState<PositionAccount[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    try {
      const [mkts, posns] = await Promise.all([
        safeFetchAll(program, "optionsMarket"),
        safeFetchAll(program, "optionPosition"),
      ]);
      setMarkets(mkts as MarketAccount[]);
      setPositions(posns as PositionAccount[]);
    } catch (err) {
      console.error("Markets fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Deduplicate markets by (asset, strike, type), keeping the latest expiry —
  // mirrors the legacy Markets.tsx behaviour so multiple weekly expiries on
  // the same asset/strike collapse into one row.
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

  // V2-only filter: keep only markets with at least one vault.
  const vaultsByMarket = useMemo(() => {
    const map = new Map<string, { count: number; tvl: number; premia: number }>();
    for (const v of vaults) {
      const key = (v.account.market as PublicKey).toBase58();
      const existing = map.get(key) ?? { count: 0, tvl: 0, premia: 0 };
      existing.count += 1;
      existing.tvl += usdcToNumber(v.account.totalCollateral);
      const premia = v.account.totalPremiumReceived;
      if (premia) existing.premia += usdcToNumber(premia);
      map.set(key, existing);
    }
    return map;
  }, [vaults]);

  const v2Markets = useMemo(
    () => dedupedMarkets.filter((m) => vaultsByMarket.has(m.publicKey.toBase58())),
    [dedupedMarkets, vaultsByMarket],
  );

  // Open interest per market — sum of v1 position totalSupply + v2 vaultMint
  // totalSupply, indexed by market base58. v2 mints come via useVaults' own
  // hook (vaultMints, available below).
  const positionsByMarket = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of positions) {
      const key = (p.account.market as PublicKey).toBase58();
      const supply = p.account.totalSupply?.toNumber?.() ?? 0;
      map.set(key, (map.get(key) ?? 0) + supply);
    }
    return map;
  }, [positions]);

  // We need vaultMints too — useVaults exposes them via its hook return.
  // Re-fetch via a thin subscription so we stay reactive to vault changes.
  const vaultMintsByMarket = useVaultMintsByMarket();

  const assetNames = useMemo(
    () => [...new Set(v2Markets.map((m) => m.account.assetName as string))].sort(),
    [v2Markets],
  );
  const { prices: spotPrices } = usePythPrices(assetNames);

  const rows = useMemo<MarketRow[]>(() => {
    const now = Math.floor(Date.now() / 1000);
    return v2Markets.map((m) => {
      const isCall = "call" in m.account.optionType;
      const strike = usdcToNumber(m.account.strikePrice);
      const expiry =
        typeof m.account.expiryTimestamp === "number"
          ? m.account.expiryTimestamp
          : m.account.expiryTimestamp.toNumber();
      const isSettled = !!m.account.isSettled;
      const isPastExpiry = expiry <= now;
      const status: MarketStatus = isSettled ? "settled" : isPastExpiry ? "expired" : "open";

      const asset = m.account.assetName as string;
      const spot = spotPrices[asset] ?? null;

      let iv: number | null = null;
      if (spot && spot > 0 && strike > 0) {
        const baseVol = getDefaultVolatility(asset);
        iv = applyVolSmile(baseVol, spot, strike, asset);
      }

      const key = m.publicKey.toBase58();
      const v1Oi = positionsByMarket.get(key) ?? 0;
      const v2Oi = vaultMintsByMarket.get(key) ?? 0;

      const vaultStats = vaultsByMarket.get(key);
      const vaultTvl = vaultStats?.tvl ?? null;

      return {
        publicKey: m.publicKey,
        account: m.account,
        asset,
        side: isCall ? "call" : "put",
        strike,
        expiry,
        spot,
        iv,
        openInterest: v1Oi + v2Oi,
        vaultTvl,
        status,
        isV2: !!vaultStats,
      };
    });
  }, [v2Markets, spotPrices, positionsByMarket, vaultMintsByMarket, vaultsByMarket]);

  const summary = useMemo<MarketsSummary>(() => {
    const now = Math.floor(Date.now() / 1000);
    const active = rows.filter((r) => r.status === "open" && r.expiry > now);
    const underlyingsSet = new Set(active.map((r) => r.asset));
    const totalOi = rows.reduce((s, r) => s + r.openInterest, 0);
    let totalTvl = 0;
    let totalPremia = 0;
    for (const stats of vaultsByMarket.values()) {
      totalTvl += stats.tvl;
      totalPremia += stats.premia;
    }
    return {
      activeMarkets: active.length,
      underlyings: underlyingsSet.size,
      openInterest: totalOi,
      vaultTvl: totalTvl,
      premiaWritten: totalPremia,
      loaded: !loading,
    };
  }, [rows, vaultsByMarket, loading]);

  return { rows, summary, spotPrices, loading, refetch };
}

/**
 * Sums vaultMint.totalSupply per market base58. Lives in its own
 * tiny hook so useMarketsData stays focused on its primary concerns;
 * useVaults is the single source of truth for vault accounts.
 */
function useVaultMintsByMarket(): Map<string, number> {
  const { vaults, vaultMints } = useVaults();
  return useMemo(() => {
    // Index vault → market once.
    const vaultToMarket = new Map<string, string>();
    for (const v of vaults) {
      vaultToMarket.set(v.publicKey.toBase58(), (v.account.market as PublicKey).toBase58());
    }
    const result = new Map<string, number>();
    for (const vm of vaultMints) {
      const vaultKey = (vm.account.vault as PublicKey).toBase58();
      const marketKey = vaultToMarket.get(vaultKey);
      if (!marketKey) continue;
      const supply = vm.account.totalSupply?.toNumber?.() ?? 0;
      result.set(marketKey, (result.get(marketKey) ?? 0) + supply);
    }
    return result;
  }, [vaults, vaultMints]);
}
