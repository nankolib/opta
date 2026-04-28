import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { usePythPrices } from "../../hooks/usePythPrices";
import { applyVolSmile, getDefaultVolatility } from "../../utils/blackScholes";
import { hexFromBytes, usdcToNumber } from "../../utils/format";

export type MarketStatus = "open" | "settled" | "expired";

interface MarketAccount {
  publicKey: PublicKey;
  account: any;
}

export type MarketRow = {
  /** Vault PDA — post-P1 each row corresponds to one SharedVault, since
   *  Markets are per-asset and strike/expiry/type live on the vault. */
  publicKey: PublicKey;
  /** SharedVault account (NOT market). */
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
  /** Always true post-P1 — vault rows are v2 by definition. Kept for
   *  call-site compatibility with the existing MarketsTable. */
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
 * Bundles markets + vaults + vault mints + prices for the Markets page.
 *
 * Post-P1 shape: OptionsMarket is a per-asset registry (no strike, expiry,
 * or type), so each table row corresponds to a SharedVault rather than a
 * market. Strike/expiry/optionType/isSettled/settlementPrice are sourced
 * from the vault; the assetName is sourced from the market the vault
 * points at.
 *
 * Open interest per row is the sum of `quantityMinted` across vault mints
 * belonging to that specific vault. Vault TVL is the vault's
 * `totalCollateral`. Premia Written is `totalPremiumReceived` (cumulative
 * since vault creation; no per-day indexer).
 */
export function useMarketsData(): UseMarketsData {
  const { program } = useProgram();
  const { vaults, vaultMints } = useVaults();
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    try {
      const mkts = await safeFetchAll(program, "optionsMarket");
      setMarkets(mkts as MarketAccount[]);
    } catch (err) {
      console.error("Markets fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Map market PDA → asset name for fast lookup during row build.
  const assetByMarket = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of markets) {
      map.set(m.publicKey.toBase58(), m.account.assetName as string);
    }
    return map;
  }, [markets]);

  // Map vault PDA → sum of quantityMinted across that vault's mints, for
  // per-row open interest. Vaults whose mints sum to zero still appear as
  // rows — empty vaults are valid liquidity offers.
  const oiByVault = useMemo(() => {
    const map = new Map<string, number>();
    for (const vm of vaultMints) {
      const key = (vm.account.vault as PublicKey).toBase58();
      const minted = vm.account.quantityMinted?.toNumber?.() ?? 0;
      map.set(key, (map.get(key) ?? 0) + minted);
    }
    return map;
  }, [vaultMints]);

  // Feeds — one entry per (asset, feed_id) pair for assets with at least
  // one live vault. usePythPrices batches them into one Hermes call.
  const feeds = useMemo(() => {
    const out: { ticker: string; feedIdHex: string }[] = [];
    const seen = new Set<string>();
    for (const v of vaults) {
      const market = markets.find((m) =>
        m.publicKey.equals(v.account.market as PublicKey),
      );
      if (!market) continue;
      const ticker = market.account.assetName as string;
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({
        ticker,
        feedIdHex: hexFromBytes(market.account.pythFeedId as number[]),
      });
    }
    return out;
  }, [vaults, markets]);
  const { prices: spotPrices } = usePythPrices(feeds);

  const rows = useMemo<MarketRow[]>(() => {
    const now = Math.floor(Date.now() / 1000);
    const out: MarketRow[] = [];
    for (const v of vaults) {
      const asset = assetByMarket.get((v.account.market as PublicKey).toBase58());
      if (!asset) continue; // vault's market dropped by safeFetchAll's strict validator

      const isCall = "call" in v.account.optionType;
      const strike = usdcToNumber(v.account.strikePrice);
      const expiry =
        typeof v.account.expiry === "number"
          ? v.account.expiry
          : v.account.expiry.toNumber();
      const isSettled = !!v.account.isSettled;
      const isPastExpiry = expiry <= now;
      const status: MarketStatus = isSettled ? "settled" : isPastExpiry ? "expired" : "open";

      const spot = spotPrices[asset] ?? null;
      let iv: number | null = null;
      if (spot && spot > 0 && strike > 0) {
        const baseVol = getDefaultVolatility(asset);
        iv = applyVolSmile(baseVol, spot, strike, asset);
      }

      out.push({
        publicKey: v.publicKey,
        account: v.account,
        asset,
        side: isCall ? "call" : "put",
        strike,
        expiry,
        spot,
        iv,
        openInterest: oiByVault.get(v.publicKey.toBase58()) ?? 0,
        vaultTvl: usdcToNumber(v.account.totalCollateral),
        status,
        isV2: true,
      });
    }
    return out;
  }, [vaults, assetByMarket, oiByVault, spotPrices]);

  const summary = useMemo<MarketsSummary>(() => {
    const now = Math.floor(Date.now() / 1000);
    let activeMarkets = 0;
    let totalOi = 0;
    let totalTvl = 0;
    let totalPremia = 0;
    const underlyingsSet = new Set<string>();

    for (const r of rows) {
      totalOi += r.openInterest;
      if (r.status === "open" && r.expiry > now) {
        activeMarkets += 1;
        underlyingsSet.add(r.asset);
      }
    }

    for (const v of vaults) {
      totalTvl += usdcToNumber(v.account.totalCollateral);
      const premia = v.account.totalPremiumReceived;
      if (premia) totalPremia += usdcToNumber(premia);
    }

    return {
      activeMarkets,
      underlyings: underlyingsSet.size,
      openInterest: totalOi,
      vaultTvl: totalTvl,
      premiaWritten: totalPremia,
      loaded: !loading,
    };
  }, [rows, vaults, loading]);

  return { rows, summary, spotPrices, loading, refetch };
}
