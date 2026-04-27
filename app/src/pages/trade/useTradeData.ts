import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useSearchParams } from "react-router-dom";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { usePythPrices } from "../../hooks/usePythPrices";
import {
  applyVolSmile,
  calculateCallGreeks,
  calculatePutGreeks,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { isExpired, usdcToNumber } from "../../utils/format";

export type ChainBest = {
  vaultMint: { publicKey: PublicKey; account: any };
  vault: { publicKey: PublicKey; account: any };
  market: any;
  premium: number;
};

export type ChainRow = {
  strike: number;
  callBest: ChainBest | null;
  putBest: ChainBest | null;
  callPremium: number;
  putPremium: number;
  callDelta: number;
  putDelta: number;
  callOi: number;
  putOi: number;
  callBid: number | null;
  putBid: number | null;
  callLast: number | null;
  putLast: number | null;
  /** Distance from spot in % (signed). Drives row dimming + ATM detection. */
  moneynessPct: number;
};

export type TradeSummary = {
  totalOi: number;
  /** No on-chain volume index — always null in current state. */
  vol24h: number | null;
  /** Put OI / Call OI across all expiries for selected asset. */
  putCallRatio: number | null;
  /** Surface-derived; no source — always null. */
  ivSkew25d: number | null;
  /** Computed from applyVolSmile for the ~7d expiry's ATM strike. */
  atmIv7d: number | null;
};

export type UseTradeData = {
  loading: boolean;
  availableAssets: string[];
  availableExpiries: number[];
  selectedAsset: string;
  selectedExpiry: number;
  /** Highlighted strike from a deep-link, if any. Cleared after the user clicks anything. */
  highlightedStrike: number | null;
  setSelectedAsset: (asset: string) => void;
  setSelectedExpiry: (expiry: number) => void;
  clearHighlightedStrike: () => void;
  /** Spot price for the currently selected asset. */
  spot: number | null;
  /** ATM strike for the current chain — used for the rule + label. */
  atmStrike: number | null;
  /** Baseline IV (smile-adjusted) at the ATM strike — used by MarketContextStrip. */
  atmBaselineIv: number | null;
  rows: ChainRow[];
  summary: TradeSummary;
  refetch: () => Promise<void>;
};

const DAY = 86400;
const roundToDay = (ts: number) => Math.floor(ts / DAY) * DAY;

/**
 * Bundles all data the Trade page needs:
 *   - Markets, vaults, vault mints, positions
 *   - Pyth-fed spot prices
 *   - Selected asset / expiry state
 *   - Computed chain rows + summary stats for the selection
 *
 * V2-only: vault mints are the source of truth for available chains
 * and best-asks. V1 positions contribute to OI only (degrades to 0
 * in current production where USE_V2_VAULTS=true).
 *
 * Deep-link: applies ?asset, ?expiry, ?strike, ?type from the URL
 * once on mount via a ref-locked effect, retrying until the asset
 * appears in the available list (vaults may still be loading).
 * Critical for the Markets → Trade row "Trade →" button.
 */
export function useTradeData(): UseTradeData {
  const { program } = useProgram();
  const { vaults, vaultMints } = useVaults();
  const [markets, setMarkets] = useState<{ publicKey: PublicKey; account: any }[]>([]);
  const [positions, setPositions] = useState<{ publicKey: PublicKey; account: any }[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState<string>("");
  const [selectedExpiry, setSelectedExpiry] = useState<number>(0);
  const [highlightedStrike, setHighlightedStrike] = useState<number | null>(null);
  const [searchParams] = useSearchParams();
  const appliedUrlRef = useRef(false);

  const refetch = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    try {
      const [mkts, posns] = await Promise.all([
        safeFetchAll(program, "optionsMarket"),
        safeFetchAll(program, "optionPosition"),
      ]);
      setMarkets(mkts as any);
      setPositions(posns as any);
    } catch (err) {
      console.error("Trade fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Active markets: dedupe by (asset, strike, expiry-day, type), keep deterministic pubkey winner.
  const activeMarkets = useMemo(() => {
    const active = markets.filter((m) => !isExpired(m.account.expiryTimestamp));
    const map = new Map<string, typeof active[0]>();
    for (const m of active) {
      const isCall = "call" in m.account.optionType;
      const expTs =
        typeof m.account.expiryTimestamp === "number"
          ? m.account.expiryTimestamp
          : m.account.expiryTimestamp.toNumber();
      const key = `${m.account.assetName}-${m.account.strikePrice.toString()}-${roundToDay(expTs)}-${isCall ? "C" : "P"}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, m);
      } else if (m.publicKey.toBase58() > existing.publicKey.toBase58()) {
        map.set(key, m);
      }
    }
    return Array.from(map.values());
  }, [markets]);

  // Available assets — only assets with at least one ACTIVE shared vault.
  const availableAssets = useMemo(() => {
    const names = new Set<string>();
    for (const v of vaults) {
      if (v.account.isSettled) continue;
      const mkt = markets.find((m) => m.publicKey.equals(v.account.market as PublicKey));
      if (mkt) names.add(mkt.account.assetName as string);
    }
    return Array.from(names).sort();
  }, [vaults, markets]);

  // Auto-select first asset when the list materialises and the current
  // selection is gone.
  useEffect(() => {
    if (availableAssets.length > 0 && !availableAssets.includes(selectedAsset)) {
      setSelectedAsset(availableAssets[0]);
    }
  }, [availableAssets, selectedAsset]);

  // Available expiries for the selected asset (day-rounded so timestamps
  // seconds apart collapse into one tab).
  const availableExpiries = useMemo(() => {
    const dayMap = new Map<number, number>();
    for (const v of vaults) {
      if (v.account.isSettled) continue;
      const mkt = markets.find((m) => m.publicKey.equals(v.account.market as PublicKey));
      if (!mkt || mkt.account.assetName !== selectedAsset) continue;
      const t =
        typeof v.account.expiry === "number" ? v.account.expiry : v.account.expiry.toNumber();
      const rounded = roundToDay(t);
      if (!dayMap.has(rounded)) dayMap.set(rounded, t);
    }
    return Array.from(dayMap.values()).sort((a, b) => a - b);
  }, [vaults, markets, selectedAsset]);

  useEffect(() => {
    if (availableExpiries.length > 0 && !availableExpiries.includes(selectedExpiry)) {
      setSelectedExpiry(availableExpiries[0]);
    }
  }, [availableExpiries, selectedExpiry]);

  // Apply URL deep-link params (asset/expiry/strike/type) once on mount.
  // Critical for the Markets → Trade row link. Retries until asset appears
  // in availableAssets (vaults load asynchronously), then locks via ref.
  useEffect(() => {
    if (appliedUrlRef.current) return;
    const urlAsset = searchParams.get("asset");
    const urlExpiry = searchParams.get("expiry");
    const urlStrike = searchParams.get("strike");
    if (!urlAsset && !urlExpiry && !urlStrike) {
      appliedUrlRef.current = true;
      return;
    }
    if (urlAsset && !availableAssets.includes(urlAsset)) return;
    if (urlAsset) setSelectedAsset(urlAsset);
    if (urlExpiry && availableExpiries.length > 0) {
      const targetDay = roundToDay(parseInt(urlExpiry, 10));
      const match = availableExpiries.find((e) => roundToDay(e) === targetDay);
      if (match !== undefined) setSelectedExpiry(match);
    }
    if (urlStrike) {
      const s = parseFloat(urlStrike);
      if (!isNaN(s)) setSelectedStrike(s);
    }
    appliedUrlRef.current = true;
    function setSelectedStrike(strike: number) {
      setHighlightedStrike(strike);
    }
  }, [availableAssets, availableExpiries, searchParams]);

  // Pyth spot prices for all available assets (so chip selection doesn't
  // re-fetch every time).
  const { prices: spotPrices } = usePythPrices(availableAssets);

  const spot = selectedAsset ? spotPrices[selectedAsset] ?? null : null;

  // ---- Chain row build (V2-only) ----
  const rows = useMemo<ChainRow[]>(() => {
    if (!selectedAsset || !selectedExpiry) return [];
    const selectedDay = roundToDay(selectedExpiry);

    // Collect strikes for the (asset, expiry) combo from active vaults.
    const strikeSet = new Set<number>();
    for (const v of vaults) {
      if (v.account.isSettled) continue;
      const vExpiry =
        typeof v.account.expiry === "number" ? v.account.expiry : v.account.expiry.toNumber();
      if (roundToDay(vExpiry) !== selectedDay) continue;
      const mkt = markets.find((m) => m.publicKey.equals(v.account.market as PublicKey));
      if (mkt?.account.assetName === selectedAsset) {
        strikeSet.add(usdcToNumber(v.account.strikePrice));
      }
    }
    const strikes = Array.from(strikeSet).sort((a, b) => a - b);

    const liveSpot = spot ?? (strikes.length > 0 ? strikes[Math.floor(strikes.length / 2)] : 0);
    const baseVol = getDefaultVolatility(selectedAsset);
    const days = Math.max(0, (selectedExpiry - Date.now() / 1000) / DAY);

    return strikes.map<ChainRow>((strike) => {
      const smiledVol =
        liveSpot > 0 ? applyVolSmile(baseVol, liveSpot, strike, selectedAsset) : baseVol;
      const callGreeks = calculateCallGreeks(liveSpot, strike, days, smiledVol);
      const putGreeks = calculatePutGreeks(liveSpot, strike, days, smiledVol);

      let callBest: ChainBest | null = null;
      let putBest: ChainBest | null = null;
      let callOi = 0;
      let putOi = 0;

      // Walk vault mints for this strike + expiry-day under the selected asset.
      for (const vm of vaultMints) {
        const parentVault = vaults.find((v) => v.publicKey.equals(vm.account.vault as PublicKey));
        if (!parentVault || parentVault.account.isSettled) continue;
        const vExpiry =
          typeof parentVault.account.expiry === "number"
            ? parentVault.account.expiry
            : parentVault.account.expiry.toNumber();
        if (roundToDay(vExpiry) !== selectedDay) continue;
        if (usdcToNumber(parentVault.account.strikePrice) !== strike) continue;
        const parentMkt = markets.find((m) =>
          m.publicKey.equals(parentVault.account.market as PublicKey),
        );
        if (!parentMkt || parentMkt.account.assetName !== selectedAsset) continue;

        const vIsCall = "call" in parentVault.account.optionType;
        const minted = vm.account.quantityMinted?.toNumber?.() ?? 0;
        const sold = vm.account.quantitySold?.toNumber?.() ?? 0;
        const unsold = minted - sold;
        if (vIsCall) callOi += minted;
        else putOi += minted;
        if (unsold <= 0) continue;
        const price = usdcToNumber(vm.account.premiumPerContract);
        const candidate: ChainBest = {
          vaultMint: vm,
          vault: parentVault,
          market: parentMkt.account,
          premium: price,
        };
        if (vIsCall) {
          if (!callBest || price < callBest.premium) callBest = candidate;
        } else {
          if (!putBest || price < putBest.premium) putBest = candidate;
        }
      }

      // Add v1 OI contribution (always 0 with USE_V2_VAULTS=true, but
      // structurally correct for when the flag flips).
      for (const p of positions) {
        const pMkt = markets.find((m) => m.publicKey.equals(p.account.market as PublicKey));
        if (!pMkt || pMkt.account.assetName !== selectedAsset) continue;
        const pExpiry =
          typeof pMkt.account.expiryTimestamp === "number"
            ? pMkt.account.expiryTimestamp
            : pMkt.account.expiryTimestamp.toNumber();
        if (roundToDay(pExpiry) !== selectedDay) continue;
        if (usdcToNumber(pMkt.account.strikePrice) !== strike) continue;
        const supply = p.account.totalSupply?.toNumber?.() ?? 0;
        if ("call" in pMkt.account.optionType) callOi += supply;
        else putOi += supply;
      }

      const moneynessPct = liveSpot > 0 ? ((strike - liveSpot) / liveSpot) * 100 : 0;

      return {
        strike,
        callBest,
        putBest,
        callPremium: callGreeks.premium,
        putPremium: putGreeks.premium,
        callDelta: callGreeks.delta,
        putDelta: putGreeks.delta,
        callOi,
        putOi,
        callBid: null,
        putBid: null,
        callLast: null,
        putLast: null,
        moneynessPct,
      };
    });
  }, [vaults, vaultMints, markets, positions, selectedAsset, selectedExpiry, spot]);

  const atmStrike = useMemo(() => {
    if (rows.length === 0) return null;
    if (spot == null || spot <= 0) {
      // Fall back to the median row in the absence of a spot price.
      return rows[Math.floor(rows.length / 2)].strike;
    }
    let best = rows[0];
    let bestDiff = Math.abs(rows[0].strike - spot);
    for (const r of rows) {
      const diff = Math.abs(r.strike - spot);
      if (diff < bestDiff) {
        best = r;
        bestDiff = diff;
      }
    }
    return best.strike;
  }, [rows, spot]);

  const atmBaselineIv = useMemo(() => {
    if (atmStrike == null || spot == null || spot <= 0 || !selectedAsset) return null;
    return applyVolSmile(getDefaultVolatility(selectedAsset), spot, atmStrike, selectedAsset);
  }, [atmStrike, spot, selectedAsset]);

  // ---- Summary stats (across ALL expiries for the selected asset) ----
  const summary = useMemo<TradeSummary>(() => {
    if (!selectedAsset) {
      return { totalOi: 0, vol24h: null, putCallRatio: null, ivSkew25d: null, atmIv7d: null };
    }

    let totalCallOi = 0;
    let totalPutOi = 0;
    for (const vm of vaultMints) {
      const parentVault = vaults.find((v) => v.publicKey.equals(vm.account.vault as PublicKey));
      if (!parentVault || parentVault.account.isSettled) continue;
      const parentMkt = markets.find((m) =>
        m.publicKey.equals(parentVault.account.market as PublicKey),
      );
      if (!parentMkt || parentMkt.account.assetName !== selectedAsset) continue;
      const minted = vm.account.quantityMinted?.toNumber?.() ?? 0;
      if ("call" in parentVault.account.optionType) totalCallOi += minted;
      else totalPutOi += minted;
    }
    const totalOi = totalCallOi + totalPutOi;
    const putCallRatio = totalCallOi > 0 ? totalPutOi / totalCallOi : null;

    // ATM IV at ~7d expiry: pick the expiry whose distance from now+7d is
    // minimum, then compute baseline IV at that expiry's ATM strike.
    let atmIv7d: number | null = null;
    if (availableExpiries.length > 0 && spot && spot > 0) {
      const target = Date.now() / 1000 + 7 * DAY;
      let nearest = availableExpiries[0];
      let nearestDiff = Math.abs(availableExpiries[0] - target);
      for (const e of availableExpiries) {
        const diff = Math.abs(e - target);
        if (diff < nearestDiff) {
          nearest = e;
          nearestDiff = diff;
        }
      }
      // Find ATM strike for `nearest` expiry under the selected asset.
      const nearestStrikes: number[] = [];
      for (const v of vaults) {
        if (v.account.isSettled) continue;
        const vExpiry =
          typeof v.account.expiry === "number"
            ? v.account.expiry
            : v.account.expiry.toNumber();
        if (roundToDay(vExpiry) !== roundToDay(nearest)) continue;
        const mkt = markets.find((m) => m.publicKey.equals(v.account.market as PublicKey));
        if (mkt?.account.assetName !== selectedAsset) continue;
        nearestStrikes.push(usdcToNumber(v.account.strikePrice));
      }
      if (nearestStrikes.length > 0) {
        let nearestAtmStrike = nearestStrikes[0];
        let bestDiff = Math.abs(nearestStrikes[0] - spot);
        for (const s of nearestStrikes) {
          const d = Math.abs(s - spot);
          if (d < bestDiff) {
            bestDiff = d;
            nearestAtmStrike = s;
          }
        }
        atmIv7d = applyVolSmile(
          getDefaultVolatility(selectedAsset),
          spot,
          nearestAtmStrike,
          selectedAsset,
        );
      }
    }

    return {
      totalOi,
      vol24h: null,
      putCallRatio,
      ivSkew25d: null,
      atmIv7d,
    };
  }, [vaults, vaultMints, markets, selectedAsset, availableExpiries, spot]);

  const clearHighlightedStrike = useCallback(() => setHighlightedStrike(null), []);

  return {
    loading,
    availableAssets,
    availableExpiries,
    selectedAsset,
    selectedExpiry,
    highlightedStrike,
    setSelectedAsset: (a: string) => {
      setSelectedAsset(a);
      setHighlightedStrike(null);
    },
    setSelectedExpiry: (e: number) => {
      setSelectedExpiry(e);
      setHighlightedStrike(null);
    },
    clearHighlightedStrike,
    spot,
    atmStrike,
    atmBaselineIv,
    rows,
    summary,
    refetch,
  };
}
