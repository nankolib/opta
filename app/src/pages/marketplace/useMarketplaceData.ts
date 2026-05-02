import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { usePythPrices } from "../../hooks/usePythPrices";
import {
  applyVolSmile,
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { hexFromBytes, usdcToNumber } from "../../utils/format";

type AccountWithKey = { publicKey: PublicKey; account: any };

export type ResaleListingRow = {
  // ---- Raw on-chain accounts (needed by the BuyListingModal for tx building) ----
  listing: AccountWithKey;   // VaultResaleListing
  vault: AccountWithKey;     // SharedVault (parent of the option mint's vault)
  vaultMint: AccountWithKey; // VaultMint (per-(writer, vault) mint record)
  market: any;               // OptionsMarket account (asset registry)

  // ---- Display fields (pre-derived for the table) ----
  asset: string;
  strike: number;
  expiry: number;
  optionType: "call" | "put";
  qtyAvailable: number;       // listing.listedQuantity (decremented by partial fills)
  pricePerContract: number;   // USD (scaled out of micros)
  seller: PublicKey;

  // ---- Fair-value comparison (B-S derived) ----
  pricePerContractFairValue: number | null;  // null if asset has no Pyth feed
  /** Signed: positive = ask ABOVE fair (premium); negative = ask BELOW fair (discount). */
  premiumPct: number | null;
};

export type UseMarketplaceData = {
  rows: ResaleListingRow[];
  /** Total non-zero listings on-chain BEFORE the settled/expired filter — for "Showing N of M" UX. */
  totalCount: number;
  loading: boolean;
  /** Spot-price map keyed by asset, surfaced for callers (BuyListingModal reuses). */
  spotPrices: Record<string, number>;
  refetch: () => Promise<void>;
};

const DAY = 86400;

/**
 * Fetches all V2 resale listings on-chain, joins each with its parent
 * vault / vaultMint / market, derives display + fair-value fields, and
 * hides listings whose parent vault is either settled OR past expiry
 * (both states are rejected on-chain by buy_v2_resale, so showing them
 * would only produce confused click → revert UX).
 *
 * Composition mirrors useTradeData: useVaults supplies vaults+vaultMints,
 * safeFetchAll supplies the listings + markets, usePythPrices supplies
 * spot for fair-value derivation. Same convention as every other hook
 * here: caller invokes refetch after a buy/cancel succeeds. No automatic
 * polling. No SWR-style cache invalidation.
 */
export function useMarketplaceData(): UseMarketplaceData {
  const { program } = useProgram();
  const { vaults, vaultMints } = useVaults();
  const [listingsRaw, setListingsRaw] = useState<AccountWithKey[]>([]);
  const [markets, setMarkets] = useState<AccountWithKey[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    try {
      const [lists, mkts] = await Promise.all([
        safeFetchAll(program, "vaultResaleListing"),
        safeFetchAll(program, "optionsMarket"),
      ]);
      setListingsRaw(lists as AccountWithKey[]);
      setMarkets(mkts as AccountWithKey[]);
    } catch (err) {
      console.error("Marketplace fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const marketByPda = useMemo(() => {
    const m = new Map<string, any>();
    markets.forEach((x) => m.set(x.publicKey.toBase58(), x.account));
    return m;
  }, [markets]);

  const vaultByPda = useMemo(() => {
    const m = new Map<string, AccountWithKey>();
    vaults.forEach((v) => m.set(v.publicKey.toBase58(), v));
    return m;
  }, [vaults]);

  const vaultMintByOptionMint = useMemo(() => {
    const m = new Map<string, AccountWithKey>();
    vaultMints.forEach((vm) =>
      m.set((vm.account.optionMint as PublicKey).toBase58(), vm),
    );
    return m;
  }, [vaultMints]);

  // Build (ticker, feedIdHex) pairs for every market that backs at least one
  // live listing — same shape useTradeData/useMarketsData use; usePythPrices
  // batches them into one Hermes call.
  const feeds = useMemo(() => {
    const out: { ticker: string; feedIdHex: string }[] = [];
    const seen = new Set<string>();
    for (const l of listingsRaw) {
      const v = vaultByPda.get((l.account.vault as PublicKey).toBase58());
      if (!v) continue;
      const market = marketByPda.get((v.account.market as PublicKey).toBase58());
      if (!market) continue;
      const ticker = market.assetName as string;
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({ ticker, feedIdHex: hexFromBytes(market.pythFeedId as number[]) });
    }
    return out;
  }, [listingsRaw, vaultByPda, marketByPda]);
  const { prices: spotPrices } = usePythPrices(feeds);

  const rows = useMemo<ResaleListingRow[]>(() => {
    const now = Math.floor(Date.now() / 1000);
    const out: ResaleListingRow[] = [];

    for (const listing of listingsRaw) {
      const vault = vaultByPda.get((listing.account.vault as PublicKey).toBase58());
      if (!vault) continue;
      const va = vault.account;

      // OQ#6 + on-chain handler symmetry: hide both settled AND expired
      // vaults. buy_v2_resale rejects both server-side; surfacing them
      // client-side would yield click → revert with no recovery.
      if (va.isSettled) continue;
      const expiryRaw = va.expiry;
      const expiry =
        typeof expiryRaw === "number" ? expiryRaw : (expiryRaw?.toNumber?.() ?? Number(expiryRaw));
      if (expiry <= now) continue;

      const optionMint = (listing.account.optionMint as PublicKey).toBase58();
      const vaultMint = vaultMintByOptionMint.get(optionMint);
      if (!vaultMint) continue;

      const market = marketByPda.get((va.market as PublicKey).toBase58());
      if (!market) continue;

      const asset = market.assetName as string;
      const strike = usdcToNumber(va.strikePrice);
      const optionType: "call" | "put" = "call" in va.optionType ? "call" : "put";
      const lq = listing.account.listedQuantity;
      const qtyAvailable = typeof lq === "number" ? lq : (lq?.toNumber?.() ?? Number(lq));
      const pricePerContract = usdcToNumber(listing.account.pricePerContract);

      // Fair value via B-S — null when the asset's Pyth feed didn't resolve.
      const spot = spotPrices[asset];
      let pricePerContractFairValue: number | null = null;
      let premiumPct: number | null = null;
      if (typeof spot === "number" && spot > 0) {
        const baseVol = getDefaultVolatility(asset);
        const smiledVol = applyVolSmile(baseVol, spot, strike, asset);
        const days = Math.max(0, (expiry - now) / DAY);
        pricePerContractFairValue =
          optionType === "call"
            ? calculateCallPremium(spot, strike, days, smiledVol)
            : calculatePutPremium(spot, strike, days, smiledVol);
        if (pricePerContractFairValue > 0) {
          premiumPct = (pricePerContract / pricePerContractFairValue - 1) * 100;
        }
      }

      out.push({
        listing,
        vault,
        vaultMint,
        market,
        asset,
        strike,
        expiry,
        optionType,
        qtyAvailable,
        pricePerContract,
        seller: listing.account.seller as PublicKey,
        pricePerContractFairValue,
        premiumPct,
      });
    }

    // Default sort per OQ#9 lock: expiry ascending (Hermes-fail-safe). Stable
    // tiebreakers: strike asc, then created_at asc.
    out.sort((a, b) => {
      if (a.expiry !== b.expiry) return a.expiry - b.expiry;
      if (a.strike !== b.strike) return a.strike - b.strike;
      const acRaw = a.listing.account.createdAt;
      const bcRaw = b.listing.account.createdAt;
      const ac = typeof acRaw === "number" ? acRaw : (acRaw?.toNumber?.() ?? Number(acRaw));
      const bc = typeof bcRaw === "number" ? bcRaw : (bcRaw?.toNumber?.() ?? Number(bcRaw));
      return ac - bc;
    });

    return out;
  }, [listingsRaw, vaultByPda, vaultMintByOptionMint, marketByPda, spotPrices]);

  return {
    rows,
    totalCount: listingsRaw.length,
    loading,
    spotPrices,
    refetch,
  };
}
