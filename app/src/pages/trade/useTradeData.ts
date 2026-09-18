import { spotSourceOf } from "../../utils/oracleArm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useSearchParams } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { useSpotPrices } from "../../hooks/useSpotPrices";
import {
  applyVolSmile,
  calculateCallGreeks,
  calculatePutGreeks,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { hexFromBytes, usdcToNumber } from "../../utils/format";
import { canonicalAsset } from "../../utils/assetDisplay";

export type ChainBest = {
  vaultMint: { publicKey: PublicKey; account: any };
  vault: { publicKey: PublicKey; account: any };
  market: any;
  premium: number;
};

/**
 * A single buyable offering at a (strike, expiry, side) cell. Two
 * variants:
 *
 *   - vault: protocol-issued primary mint, live B-S premium, inventory
 *     drawn from `quantityMinted - quantitySold` on the parent VaultMint.
 *   - resale: a holder's secondary listing, fixed price, qty drawn from
 *     `listing.listedQuantity` (decremented by partial fills).
 *
 * `isSelfListing` is true when the connected wallet equals
 * `listing.seller`. Slice 5 uses this flag to dim the row in the panel
 * and to attach the cell-level "·your listing" tag. Slice 1 sets the
 * flag but does not yet use it to gate UI behavior.
 */
export type Offering =
  | {
      kind: "vault";
      premium: number;
      inventory: number;
      /** Parent vault's exercise style — drives the on-chain (American) vs
       *  Black-Scholes (European) preview path in BuyModal/OfferingsPanel. */
      exerciseStyle: "european" | "american";
      vaultMint: { publicKey: PublicKey; account: any };
      vault: { publicKey: PublicKey; account: any };
      market: any;
    }
  | {
      kind: "resale";
      premium: number;
      qty: number;
      exerciseStyle: "european" | "american";
      seller: PublicKey;
      createdAt: number;
      isSelfListing: boolean;
      listing: { publicKey: PublicKey; account: any };
      vaultMint: { publicKey: PublicKey; account: any };
      vault: { publicKey: PublicKey; account: any };
      market: any;
    };

export type ChainRow = {
  strike: number;
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
  /**
   * Smile-adjusted IV at this strike (decimal, e.g. 0.78 = 78%). Same
   * value for call and put — the smile is symmetric per strike. Slice 4
   * added this field so the BuyModal's OfferingsPanel header strip can
   * render IV without re-deriving it page-side.
   */
  ivSmiled: number;
  /**
   * Sorted ascending by premium. Includes the vault tier (when
   * unsold > 0) and every active resale listing whose option_mint maps
   * to a vaultMint at this strike+side. Self-listings ARE included and
   * tagged via Offering.isSelfListing — Slice 5 filters them out of
   * the headline-display path; Slice 1 leaves them in for completeness.
   */
  callOfferings: Offering[];
  putOfferings: Offering[];
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
  /** Market pubkey for the selected asset; null while it resolves. */
  selectedMarket: string | null;
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
  /** Sample timestamp (unix secs) for the selected asset's spot when it comes
   *  from the on-chain sample fallback; null for live-fed assets. */
  spotAsOf: number | null;
  /** True when displayed spot is sourced from cache > 60s old (feed outage). */
  stale: boolean;
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
 * Sort an offerings array ascending by premium, then partition
 * self-listings to the back. After this call:
 *   - arr[0] is the cheapest non-self offering when any non-self exists
 *   - arr[0].isSelfListing === true only when every offering is self
 *
 * Slice 5 partition strategy. The OfferingsPanel re-partitions by kind
 * (vault vs resale), so the inner panel layout is unaffected; this
 * function only controls which entry is at index 0 (the cell headline)
 * and the order resale rows render in the panel's resale section
 * (non-self before self, both ascending within their group).
 */
function sortAndPartition(arr: Offering[]): void {
  arr.sort((a, b) => a.premium - b.premium);
  const isSelf = (o: Offering) => o.kind === "resale" && o.isSelfListing;
  const nonSelf = arr.filter((o) => !isSelf(o));
  const self = arr.filter((o) => isSelf(o));
  arr.length = 0;
  arr.push(...nonSelf, ...self);
}

/**
 * Bundles all data the Trade page needs:
 *   - Markets, vaults, vault mints, positions
 *   - pull-fed spot prices
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
  const { publicKey: connectedWallet } = useWallet();
  const [markets, setMarkets] = useState<{ publicKey: PublicKey; account: any }[]>([]);
  const [listingsRaw, setListingsRaw] = useState<{ publicKey: PublicKey; account: any }[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAsset, setSelectedAsset] = useState<string>("");
  const [selectedExpiry, setSelectedExpiry] = useState<number>(0);
  const [highlightedStrike, setHighlightedStrike] = useState<number | null>(null);
  const [searchParams] = useSearchParams();
  const appliedUrlRef = useRef(false);

  // /trade draws exactly ONE board, so it reads exactly one board. The market
  // pubkey is derived from RENDERING state — which asset is selected — and is
  // never used to assemble a transaction.
  //
  // null while the asset is still resolving, so useVaults waits instead of
  // pulling all 4,655 vaults and then fetching the board anyway.
  const selectedMarket = useMemo<string | null>(() => {
    if (!selectedAsset || markets.length === 0) return null;
    const m = markets.find((x) => canonicalAsset(x.account.assetName) === selectedAsset);
    return m ? m.publicKey.toBase58() : null;
  }, [markets, selectedAsset]);

  const { vaults, vaultMints } = useVaults(selectedMarket);

  const refetch = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    try {
      const [mkts, lists] = await Promise.all([
        safeFetchAll(program, "optionsMarket"),
        safeFetchAll(program, "vaultResaleListing"),
      ]);
      setMarkets(mkts as any);
      setListingsRaw(lists as any);
    } catch (err) {
      console.error("Trade fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Active markets dedupe block removed in P4a — markets are now per-asset
  // (no strike/expiry/type), so dedupe is meaningless and the block read
  // now-gone fields (m.account.optionType / strikePrice / expiryTimestamp).
  // The rest of this hook already sources strike/expiry/type from vaults.

  // Available assets — only assets with at least one ACTIVE shared vault.
  const availableAssets = useMemo(() => {
    const names = new Set<string>();
    for (const v of vaults) {
      if (v.account.isSettled) continue;
      const mkt = markets.find((m) => m.publicKey.equals(v.account.market as PublicKey));
      const asset = mkt ? canonicalAsset(mkt.account.assetName) : null;
      if (asset) names.add(asset);
    }
    // SLICE 2B item 9 — REGISTERED assets with no vault yet also belong here.
    //
    // This list used to be vault-derived only, so a market was absent from the
    // asset dropdown until somebody wrote it. The person most likely to look for
    // it is the person who just created it, and for them the app behaved as if
    // their market did not exist. An asset with no supply has an empty chain,
    // which is a true and useful thing to show — the chain's own empty state
    // then points at writing it.
    for (const m of markets) {
      const asset = canonicalAsset(m.account.assetName);
      if (asset) names.add(asset);
    }
    return Array.from(names).sort();
  }, [vaults, markets]);

  // Auto-select ONLY when nothing is selected yet. Previously this reset the
  // selection to availableAssets[0] whenever the current asset wasn't in THIS
  // hook's (strict, sometimes partially-loaded) list — which fought the Trade
  // shell's chain-sourced selection and could bounce a valid asset (e.g. SOL)
  // back to an alphabetical default. The shell owns the default now; this only
  // seeds V1 / an unset state.
  useEffect(() => {
    if (availableAssets.length > 0 && !selectedAsset) {
      setSelectedAsset(availableAssets[0]);
    }
  }, [availableAssets, selectedAsset]);

  // Available expiries for the selected asset (day-rounded so timestamps
  // seconds apart collapse into one tab).
  const availableExpiries = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const dayMap = new Map<number, number>();
    for (const v of vaults) {
      if (v.account.isSettled) continue;
      const mkt = markets.find((m) => m.publicKey.equals(v.account.market as PublicKey));
      if (!mkt || canonicalAsset(mkt.account.assetName) !== selectedAsset) continue;
      const t =
        typeof v.account.expiry === "number" ? v.account.expiry : v.account.expiry.toNumber();
      // Exclude PAST expiries — a non-settled-but-expired vault must not become the
      // default tab (it sorts earliest and shows dead/empty contracts, e.g. BTC).
      if (t <= nowSec) continue;
      const rounded = roundToDay(t);
      if (!dayMap.has(rounded)) dayMap.set(rounded, t);
    }
    return Array.from(dayMap.values()).sort((a, b) => a - b);
  }, [vaults, markets, selectedAsset]);

  // Seed the expiry only when unset (the shell drives expiry from the unified
  // chain, so don't bounce a shell-selected expiry that isn't in this hook's
  // possibly-partial list).
  useEffect(() => {
    if (availableExpiries.length > 0 && !selectedExpiry) {
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

  // Spot prices for all assets with active vaults. Caller passes
  // (ticker, feedIdHex, oracleSource) tuples so useSpotPrices routes each
  // market to the correct source.
  const feeds = useMemo(() => {
    const out: { ticker: string; feedIdHex: string; oracleSource: 0 | 1 | 2 }[] = [];
    const seen = new Set<string>();
    for (const v of vaults) {
      if (v.account.isSettled) continue;
      const market = markets.find((m) =>
        m.publicKey.equals(v.account.market as PublicKey),
      );
      if (!market) continue;
      const ticker = canonicalAsset(market.account.assetName);
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({
        ticker,
        feedIdHex: hexFromBytes(market.account.pythFeedId as number[]),
        oracleSource: spotSourceOf(market.account.oracleSource),
      });
    }
    return out;
  }, [vaults, markets]);
  // The board on screen resolves FIRST. Without this its spot sat behind ~45
  // other feeds in the queue and routinely hit the 4s abort, so the one price
  // the user is actually looking at was the last to arrive.
  const spotPriority = useMemo(() => (selectedAsset ? [selectedAsset] : []), [selectedAsset]);
  const { prices: spotPrices, stale, asOf: spotAsOfMap } = useSpotPrices(feeds, spotPriority);

  const spot = selectedAsset ? spotPrices[selectedAsset] ?? null : null;
  const spotAsOf = selectedAsset ? spotAsOfMap?.[selectedAsset] ?? null : null;

  // Index resale listings by option_mint for O(1) per-cell lookup
  // during the chain row build. Each option_mint can have 0..N active
  // listings (one per (mint, seller) pair, enforced by the on-chain
  // PDA seed). Sorting happens per-cell during the row build, ascending
  // by premium.
  const listingsByOptionMint = useMemo(() => {
    const m = new Map<string, { publicKey: PublicKey; account: any }[]>();
    for (const l of listingsRaw) {
      const mintKey = (l.account.optionMint as PublicKey).toBase58();
      const arr = m.get(mintKey);
      if (arr) arr.push(l);
      else m.set(mintKey, [l]);
    }
    return m;
  }, [listingsRaw]);

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

      let callOi = 0;
      let putOi = 0;
      const callOfferings: Offering[] = [];
      const putOfferings: Offering[] = [];

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
        if (!parentMkt || canonicalAsset(parentMkt.account.assetName) !== selectedAsset) continue;

        const vIsCall = "call" in parentVault.account.optionType;
        // ExerciseStyle Anchor enum: { european:{} } | { american:{} }. Same
        // guarded shape-check as optionType; default european for any legacy
        // vault that decoded without the field.
        const vStyle: "european" | "american" =
          parentVault.account.exerciseStyle &&
          "american" in parentVault.account.exerciseStyle
            ? "american"
            : "european";
        const minted = vm.account.quantityMinted?.toNumber?.() ?? 0;
        const sold = vm.account.quantitySold?.toNumber?.() ?? 0;
        const unsold = minted - sold;
        if (vIsCall) callOi += minted;
        else putOi += minted;

        // Resale offerings keyed off this vaultMint's option_mint. Built
        // BEFORE the unsold gate below so resale offerings light up cells
        // whose vault is fully written-out (vault.unsold == 0 but listings
        // remain). Slice 2 will surface this through the headline.
        const optionMintB58 = (vm.account.optionMint as PublicKey).toBase58();
        const listingsForMint = listingsByOptionMint.get(optionMintB58) ?? [];
        for (const listing of listingsForMint) {
          const lq = listing.account.listedQuantity;
          const qty = typeof lq === "number" ? lq : (lq?.toNumber?.() ?? Number(lq));
          if (qty <= 0) continue;
          const seller = listing.account.seller as PublicKey;
          const createdAtRaw = listing.account.createdAt;
          const createdAt =
            typeof createdAtRaw === "number"
              ? createdAtRaw
              : (createdAtRaw?.toNumber?.() ?? Number(createdAtRaw));
          const resaleOffering: Offering = {
            kind: "resale",
            premium: usdcToNumber(listing.account.pricePerContract),
            qty,
            exerciseStyle: vStyle,
            seller,
            createdAt,
            isSelfListing: connectedWallet ? seller.equals(connectedWallet) : false,
            listing,
            vaultMint: vm,
            vault: parentVault,
            market: parentMkt.account,
          };
          if (vIsCall) callOfferings.push(resaleOffering);
          else putOfferings.push(resaleOffering);
        }

        if (unsold <= 0) continue;
        const price = usdcToNumber(vm.account.premiumPerContract);
        // premium_per_contract == 0 is the American series SENTINEL (priced
        // dynamically via peg/book), NOT a real $0 ask. Never surface it as a
        // legacy buyable vault offering — purchase_from_vault has no >0 guard and
        // would hand out a real, collateral-backed option for $0. Those trade via
        // the peg/book flow instead. (On-chain guard parked to the protocol backlog.)
        if (price <= 0) continue;

        // Vault Offering for the unified panel — pushed only when there's
        // actual unsold inventory. The cheapest vault offering is also
        // tracked separately as `callBest`/`putBest` for back-compat with
        // the existing BuyModal consumer; Slice 4 deprecates that path
        // when onBuyClick widens to take Offering[].
        const vaultOffering: Offering = {
          kind: "vault",
          premium: price,
          inventory: unsold,
          exerciseStyle: vStyle,
          vaultMint: vm,
          vault: parentVault,
          market: parentMkt.account,
        };
        if (vIsCall) callOfferings.push(vaultOffering);
        else putOfferings.push(vaultOffering);
      }

      // V1 OI contribution loop removed in P4a — read now-gone market
      // fields (expiryTimestamp / strikePrice / optionType). V2-only product
      // post-migration; v1 contributes nothing in production.

      // Sort ascending by premium, then partition self-listings to the
      // back so callOfferings[0] / putOfferings[0] is always the cheapest
      // THIRD-PARTY offering when one exists. The all-self edge case
      // leaves a self-listing at index 0; OptionsChain catches that and
      // renders FairPremium fallback (cell muted, not buyable).
      sortAndPartition(callOfferings);
      sortAndPartition(putOfferings);

      const moneynessPct = liveSpot > 0 ? ((strike - liveSpot) / liveSpot) * 100 : 0;

      return {
        strike,
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
        ivSmiled: smiledVol,
        callOfferings,
        putOfferings,
      };
    });
  }, [
    vaults,
    vaultMints,
    markets,
    selectedAsset,
    selectedExpiry,
    spot,
    listingsByOptionMint,
    connectedWallet,
  ]);

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
      if (!parentMkt || canonicalAsset(parentMkt.account.assetName) !== selectedAsset) continue;
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
    selectedMarket,
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
    spotAsOf,
    stale,
    atmStrike,
    atmBaselineIv,
    rows,
    summary,
    refetch,
  };
}
