import { spotSourceOf } from "../../utils/oracleArm";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { useSpotPrices } from "../../hooks/useSpotPrices";
import { applyVolSmile, getDefaultVolatility } from "../../utils/blackScholes";
import { hexFromBytes, usdcToNumber } from "../../utils/format";
import { canonicalAsset } from "../../utils/assetDisplay";
import { fetchBook } from "../../utils/exchangeData";

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
  /** On-chain asset_class: 0 Crypto · 1 Commodity · 2 Equity · 3 FX · 4 ETF. */
  assetClass: number;
  side: "call" | "put";
  strike: number;
  expiry: number;
  spot: number | null;
  iv: number | null;
  openInterest: number;
  vaultTvl: number | null;
  status: MarketStatus;
  /** European or American — drives the inspector's premium path (RFQ vs model). */
  exerciseStyle: "european" | "american";
  /** Oracle settlement price for settled contracts (USDC-scaled), else null. */
  settlementPrice: number | null;
  /** Cumulative net premium collected by this vault (USDC). No per-day indexer. */
  premiaWritten: number;
  /** USDC escrowed behind LIVE resting WriterAsks on this vault
   *  (sum of quantity_remaining x collateral_per_contract). This is maker
   *  collateral held per-order in the ask escrow — it is NOT part of the vault's
   *  own pool, so it must never be summed into vaultTvl. Reported separately as
   *  "book depth". */
  bookDepth: number;
  /** Always true post-P1 — vault rows are v2 by definition. Kept for
   *  call-site compatibility with the existing MarketsTable. */
  isV2: boolean;
};

export type MarketsSummary = {
  activeMarkets: number;
  underlyings: number;
  openInterest: number;
  /** Sum of SharedVault.total_collateral — pooled writer deposits only. */
  vaultTvl: number;
  /** Sum of USDC escrowed behind live resting WriterAsks. Kept SEPARATE from
   *  vaultTvl: pooled deposits and per-order ask escrow are different claims and
   *  merging them would overstate either number. */
  bookDepth: number;
  premiaWritten: number;
  loaded: boolean;
};

/** A registered asset with zero vaults — real on chain, no supply yet. */
export type AssetWithoutSupply = {
  asset: string;
  assetClass: number;
  /** Market PDA, base58. */
  market: string;
};

export type UseMarketsData = {
  rows: MarketRow[];
  /** Registered assets nobody has written yet. Rendered as their own band —
   *  NEVER merged into `rows`, which are vault-shaped. */
  assetsWithoutSupply: AssetWithoutSupply[];
  summary: MarketsSummary;
  spotPrices: Record<string, number>;
  /** Sample timestamp (unix secs) per asset, only for on-chain-fallback spot. */
  asOf: Record<string, number>;
  loading: boolean;
  /** True while a spot price could still arrive for rows that have none.
   *  Consumers MUST distinguish this from "no price exists" — see SpotValue. */
  spotLoading: boolean;
  /** Non-null when the spot read itself failed. Previously swallowed here,
   *  which made a dead feed and a slow feed render identically. */
  spotError: string | null;
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
 * `totalCollateral`. Premia Written is `netPremiumCollected` (cumulative
 * since vault creation; no per-day indexer).
 */
export function useMarketsData(): UseMarketsData {
  const { program } = useProgram();
  const { vaults, vaultMints } = useVaults();
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  // vault58 -> USDC escrowed behind live resting WriterAsks on that vault.
  const [escrowByVault, setEscrowByVault] = useState<Map<string, number>>(new Map());
  // vault58 set with at least one LIVE resting ask (writerAsk or resaleAsk).
  // Drives the "active markets" liveness filter — see the summary memo.
  const [askVaults, setAskVaults] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!program) return;
    setLoading(true);
    try {
      const mkts = await safeFetchAll(program, "optionsMarket");
      setMarkets(mkts as MarketAccount[]);
    } catch (err) {
      console.error("Markets fetch failed", err);
    }
    // Writer-ask escrow. ONE batched getProgramAccounts (discriminator memcmp)
    // via the shared book fetcher — never a per-ask account fetch. Every field
    // needed (vault, qty, collateral_per_contract) is on the RestingOrder
    // itself, so no vault round-trips either. Failure here must not blank the
    // page: escrow degrades to 0 and vault TVL still renders.
    try {
      const book = await fetchBook(program.provider.connection, program.programId);
      const m = new Map<string, number>();
      const live = new Set<string>();
      for (const o of book) {
        // Escrow is WriterAsk-only: resaleAsk/bid carry no collateral_per_contract.
        if (o.kind === "writerAsk") {
          const escrow = o.qty * o.collateralPerContract;
          if (escrow > 0) m.set(o.vault, (m.get(o.vault) ?? 0) + escrow);
        }
        // Liveness counts either ask kind — a resale ask is a real live quote.
        if ((o.kind === "writerAsk" || o.kind === "resaleAsk") && o.qty > 0) live.add(o.vault);
      }
      setEscrowByVault(m);
      setAskVaults(live);
    } catch (err) {
      console.error("Writer-ask escrow fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [program]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Map market PDA → { name, class } for fast lookup during row build.
  const assetByMarket = useMemo(() => {
    const map = new Map<string, { name: string; class: number }>();
    for (const m of markets) {
      // Canonical display symbol; "" hides provenance seeds (SB…/…SPOT) — rows
      // with an empty name are skipped in the row build below.
      const name = canonicalAsset(m.account.assetName) ?? "";
      map.set(m.publicKey.toBase58(), {
        name,
        class: typeof m.account.assetClass === "number" ? m.account.assetClass : 0,
      });
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
  // one live vault. useSpotPrices batches them by oracle source.
  const feeds = useMemo(() => {
    const out: { ticker: string; feedIdHex: string; oracleSource: 0 | 1 | 2 }[] = [];
    const seen = new Set<string>();
    for (const v of vaults) {
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
  const {
    prices: spotPrices,
    asOf: spotAsOf,
    loading: spotFetching,
    error: spotError,
  } = useSpotPrices(feeds);

  // A row can only carry a spot once the account sweep has produced `feeds` AND
  // the spot read has come back. Three things therefore count as "still
  // loading", and the last one is the subtle one:
  //
  //   1. the sweep is running                    → no feeds exist yet
  //   2. the spot read is in flight              → the obvious case
  //   3. feeds exist, nothing resolved, no error → the gap between the sweep
  //      finishing and the spot effect firing. usePythPrices reports
  //      loading:false for an empty feed list, so without this clause there is
  //      a render where every cell is settled-empty and flashes "—" before the
  //      real fetch has even started. That flash is the reported symptom.
  const spotLoading =
    loading ||
    spotFetching ||
    (feeds.length > 0 && Object.keys(spotPrices).length === 0 && !spotError);

  const rows = useMemo<MarketRow[]>(() => {
    const now = Math.floor(Date.now() / 1000);
    const out: MarketRow[] = [];
    for (const v of vaults) {
      const meta = assetByMarket.get((v.account.market as PublicKey).toBase58());
      if (!meta) continue; // vault's market dropped by safeFetchAll's strict validator
      const asset = meta.name;
      if (!asset) continue; // hidden provenance seed (SBXAU / …SPOT) — never surfaced

      const isCall = "call" in v.account.optionType;
      const strike = usdcToNumber(v.account.strikePrice);
      const expiry =
        typeof v.account.expiry === "number"
          ? v.account.expiry
          : v.account.expiry.toNumber();
      const isSettled = !!v.account.isSettled;
      const isPastExpiry = expiry <= now;
      const status: MarketStatus = isSettled ? "settled" : isPastExpiry ? "expired" : "open";
      const exerciseStyle: "european" | "american" =
        v.account.exerciseStyle && "european" in v.account.exerciseStyle ? "european" : "american";
      const settlementPrice = isSettled ? usdcToNumber(v.account.settlementPrice) : null;
      const premiaWritten = v.account.netPremiumCollected
        ? usdcToNumber(v.account.netPremiumCollected)
        : 0;

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
        assetClass: meta.class,
        side: isCall ? "call" : "put",
        strike,
        expiry,
        spot,
        iv,
        openInterest: oiByVault.get(v.publicKey.toBase58()) ?? 0,
        vaultTvl: usdcToNumber(v.account.totalCollateral),
        status,
        exerciseStyle,
        settlementPrice,
        premiaWritten,
        bookDepth: escrowByVault.get(v.publicKey.toBase58()) ?? 0,
        isV2: true,
      });
    }
    return out;
  }, [vaults, assetByMarket, oiByVault, spotPrices, escrowByVault]);

  const summary = useMemo<MarketsSummary>(() => {
    const now = Math.floor(Date.now() / 1000);
    let activeMarkets = 0;
    let totalOi = 0;
    let totalTvl = 0;
    let totalPremia = 0;
    const underlyingsSet = new Set<string>();

    // ACTIVE MARKETS = markets that are actually TRADEABLE, not lifetime mints.
    // "open && not expired" alone counts every SharedVault ever created, and the
    // writer's pre-churn-fix strike wobble left ~1,100 zero-pool shells on chain
    // (see the 2026-07-21 churn arc) — they are unexpired and unsettled, so the
    // headline read 1198 for a board of ~379 real cells. A market is live only if
    // someone can trade it NOW: at least one resting ask, or existing open
    // interest. Both inputs are already client-side (book fetch + OI aggregation),
    // so this costs no extra RPC.
    for (const r of rows) {
      totalOi += r.openInterest;
      const tradeable = askVaults.has(r.publicKey.toBase58()) || r.openInterest > 0;
      if (r.status === "open" && r.expiry > now && tradeable) {
        activeMarkets += 1;
        underlyingsSet.add(r.asset);
      }
    }

    for (const v of vaults) {
      totalTvl += usdcToNumber(v.account.totalCollateral);
      const premia = v.account.netPremiumCollected;
      if (premia) totalPremia += usdcToNumber(premia);
    }

    // Book depth is summed over the escrow map directly, NOT over `rows` — rows
    // are filtered (hidden provenance seeds, undecodable vaults), and the header
    // aggregate must reconcile against the on-chain total.
    let totalBookDepth = 0;
    for (const v of escrowByVault.values()) totalBookDepth += v;

    return {
      activeMarkets,
      underlyings: underlyingsSet.size,
      openInterest: totalOi,
      vaultTvl: totalTvl,
      bookDepth: totalBookDepth,
      premiaWritten: totalPremia,
      loaded: !loading,
    };
  }, [rows, vaults, loading, escrowByVault, askVaults]);

  // ---- SLICE 2B item 9: assets that exist but have NO supply ---------------
  //
  // A market is registered the instant create_market lands, but every surface
  // in this app is built from VAULTS — so a freshly created asset was invisible
  // everywhere. The user who just made it could not find it on /markets, could
  // not find it on /trade, and was told by /trade to "visit Markets to create
  // one" — i.e. to create the thing they had just created.
  //
  // These are not vault rows and must never be faked into `rows`: they have no
  // strike, no expiry, no OI and no TVL, and inventing zeros for those would put
  // fictional contracts in the table. They are a separate, honest list.
  const assetsWithoutSupply = useMemo(() => {
    const withVaults = new Set<string>();
    for (const v of vaults) withVaults.add((v.account.market as PublicKey).toBase58());
    const out: { asset: string; assetClass: number; market: string }[] = [];
    for (const [pda, info] of assetByMarket) {
      if (!info.name || withVaults.has(pda)) continue;
      out.push({ asset: info.name, assetClass: info.class, market: pda });
    }
    return out.sort((a, b) => a.asset.localeCompare(b.asset));
  }, [assetByMarket, vaults]);

  return {
    rows,
    summary,
    spotPrices,
    asOf: spotAsOf ?? {},
    loading,
    spotLoading,
    spotError,
    refetch,
    assetsWithoutSupply,
  };
}
