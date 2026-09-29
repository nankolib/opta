// =============================================================================
// app/src/pages/trade/useTradeDockData.ts — Trade bottom-dock data layer (hook)
// =============================================================================
//
// Single hook that assembles every value the Trade bottom dock renders, from
// REAL on-chain sources only. Where a source doesn't exist yet (full order/
// trade history needs an indexer) the hook exposes a bounded "recent activity"
// scan and flags `historyBounded = true` so the UI can label it honestly. No
// value here is fabricated — unloaded/absent data is null or [].
//
// Assembly mirrors PortfolioPage (buyer/writer ledgers) so the position math is
// computed in exactly one place (buildPositions / buildWriterRows are reused,
// never re-implemented):
//   - markets/listings/held-balances : safeFetchAll + getTokenAccountsByOwner
//   - vaults/writer positions        : useVaults()
//   - spot                           : usePythPrices() (multi-provider pull feed)
//   - open orders                    : useBook() filtered to owner === wallet
//   - order/trade history            : scanRecentActivity() (bounded, no indexer)
//   - balances                       : USDC ATA balance + SOL + derived locked
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { useSpotPrices } from "../../hooks/useSpotPrices";
import { spotEntriesFromMarkets } from "../../hooks/spotSources";
import { useTokenMetadata } from "../../hooks/useTokenMetadata";
import { useBook, type BookOrder } from "../../hooks/useBook";
import { DEVNET_USDC_MINT, TOKEN_2022_PROGRAM_ID } from "../../utils/constants";
import { buildPositions, type Position } from "../portfolio/positions";
import type { PotFundingView } from "../../utils/earlyExerciseAvailability";
import { buildWriterRows, type WriterRow } from "../portfolio/writerRows";
import { scanRecentActivity, type ActivityEvent } from "./tradeHistory";
import { subscribeMutations } from "../../utils/mutationBus";

interface AccountWrapper {
  publicKey: PublicKey;
  account: any;
}

export interface TradeBalances {
  usdcFree: number | null;
  usdcLocked: number | null;
  sol: number | null;
}

export interface TradeDockData {
  holderPositions: Position[]; // buildPositions (active + settled; caller filters)
  writerRows: WriterRow[]; // buildWriterRows
  openOrders: BookOrder[]; // useBook orders where owner === wallet (ALL mints), newest first
  orderHistory: ActivityEvent[]; // scanRecentActivity → posted|cancelled|swept
  tradeHistory: ActivityEvent[]; // scanRecentActivity → filled
  balances: TradeBalances;
  loading: { positions: boolean; history: boolean; balances: boolean };
  historyBounded: boolean; // always true today (no indexer) → UI shows "recent · full history pending indexer"
  refetch: () => void;
}

const EMPTY_BALANCES: TradeBalances = { usdcFree: null, usdcLocked: null, sol: null };

/**
 * useTradeDockData — real-data backing for the Trade bottom dock.
 *
 * Guards every branch on `!publicKey` / `!program`: with no wallet the hook
 * returns honest empties (arrays [], balances null, loading false) and never
 * throws to render.
 */
export function useTradeDockData(): TradeDockData {
  const { publicKey, connected } = useWallet();
  const { program } = useProgram();

  const {
    vaults,
    vaultMints,
    myPositions,
    getUnclaimedPremium,
    isLoading: vaultsLoading,
    refetch: refetchVaults,
  } = useVaults(undefined, { deferUntilIdle: true });
  const { orders: bookOrders } = useBook();

  // ---- markets / listings / held balances (mirror PortfolioPage) ----
  const [markets, setMarkets] = useState<AccountWrapper[]>([]);
  const [listingsRaw, setListingsRaw] = useState<AccountWrapper[]>([]);
  const [potsRaw, setPotsRaw] = useState<AccountWrapper[]>([]);
  const [heldBalances, setHeldBalances] = useState<Map<string, number>>(new Map());
  const [positionsLoading, setPositionsLoading] = useState(true);

  const refetchPositions = useCallback(async () => {
    if (!program) {
      setPositionsLoading(false);
      return;
    }
    setPositionsLoading(true);
    try {
      const [mkts, lists, pots] = await Promise.all([
        safeFetchAll(program, "optionsMarket"),
        safeFetchAll(program, "vaultResaleListing"),
        // Writer-ask collateral pots — without them the early-exercise gate
        // cannot tell a funded writer-ask series from an unfunded one.
        safeFetchAll(program, "writerAskPot"),
      ]);
      setMarkets(mkts as AccountWrapper[]);
      setListingsRaw(lists as AccountWrapper[]);
      setPotsRaw(pots as AccountWrapper[]);
      if (publicKey) {
        const accts = await program.provider.connection.getTokenAccountsByOwner(publicKey, {
          programId: TOKEN_2022_PROGRAM_ID,
        });
        const m = new Map<string, number>();
        for (const a of accts.value) {
          // Raw byte read: the getTokenAccountsByOwner programId filter guarantees
          // every result is a Token-2022 account, so mint 0..32 / amount 64..72
          // are pre-validated by the RPC (mirrors PortfolioPage MED-4).
          const mint = new PublicKey(a.account.data.slice(0, 32)).toBase58();
          const balance = Number(a.account.data.readBigUInt64LE(64));
          if (balance > 0) m.set(mint, balance);
        }
        setHeldBalances(m);
      } else {
        setHeldBalances(new Map());
      }
      await refetchVaults();
    } catch (err) {
      console.error("Trade dock positions refetch failed", err);
    } finally {
      setPositionsLoading(false);
    }
  }, [program, publicKey, refetchVaults]);

  useEffect(() => {
    if (!program) return;
    refetchPositions();
  }, [program, publicKey, refetchPositions]);

  // ---- spot prices (feeds derived from markets) ----
  // Each market keeps its own oracle source (0, 1 or 2): see spotEntriesFromMarkets.
  const feeds = useMemo(() => spotEntriesFromMarkets(markets), [markets]);
  const { prices: spotPrices } = useSpotPrices(feeds);

  // ---- marketMap + token-metadata fallback (mirror PortfolioPage) ----
  const marketMap = useMemo(() => {
    const map = new Map<string, any>();
    markets.forEach((m) => map.set(m.publicKey.toBase58(), m.account));
    return map;
  }, [markets]);

  const v2MintKeys = useMemo(
    () => vaultMints.map((vm) => vm.account.optionMint as PublicKey),
    [vaultMints],
  );
  const tokenMetadata = useTokenMetadata(v2MintKeys);
  const metadataSymbolByMint = useMemo(() => {
    const m = new Map<string, string>();
    tokenMetadata.forEach((meta, mint) => {
      if (meta?.symbol) m.set(mint, meta.symbol);
    });
    return m;
  }, [tokenMetadata]);

  // ---- my resale listings + v2Held (mirror PortfolioPage exactly) ----
  const myListings = useMemo(() => {
    if (!connected || !publicKey) return [];
    return listingsRaw.filter((l) => (l.account.seller as PublicKey).equals(publicKey));
  }, [listingsRaw, connected, publicKey]);

  const v2Held = useMemo(() => {
    if (!connected || !publicKey) return [];
    const listedByMint = new Map<string, number>();
    for (const l of myListings) {
      const mk = (l.account.optionMint as PublicKey).toBase58();
      const lq = l.account.listedQuantity;
      const qty = typeof lq === "number" ? lq : (lq?.toNumber?.() ?? Number(lq));
      listedByMint.set(mk, (listedByMint.get(mk) ?? 0) + qty);
    }
    const found: { vaultMint: any; vault: any; balance: number; market: any | null }[] = [];
    for (const vm of vaultMints) {
      const mintKey = (vm.account.optionMint as PublicKey).toBase58();
      const heldBal = heldBalances.get(mintKey) ?? 0;
      const listedQty = listedByMint.get(mintKey) ?? 0;
      const totalBal = heldBal + listedQty;
      if (totalBal <= 0) continue;
      const vault = vaults.find((v) => v.publicKey.equals(vm.account.vault as PublicKey));
      if (!vault) continue;
      const market = marketMap.get((vault.account.market as PublicKey).toBase58()) ?? null;
      found.push({ vaultMint: vm, vault, balance: totalBal, market });
    }
    return found;
  }, [vaultMints, vaults, marketMap, heldBalances, connected, publicKey, myListings]);

  // option_mint base58 -> pot, keyed to match the pot PDA seed.
  const potByMint = useMemo(() => {
    const m = new Map<string, PotFundingView>();
    for (const p of potsRaw) {
      m.set((p.account.optionMint as PublicKey).toBase58(), {
        totalCollateral: p.account.totalCollateral,
      });
    }
    return m;
  }, [potsRaw]);

  const holderPositions = useMemo(
    () => buildPositions({ v2Held, spotPrices, metadataSymbolByMint, listings: myListings, potByMint }),
    [v2Held, spotPrices, metadataSymbolByMint, myListings, potByMint],
  );

  const writerRows = useMemo(
    () => buildWriterRows({ myPositions, vaults, vaultMints, marketMap, getUnclaimedPremium }),
    [myPositions, vaults, vaultMints, marketMap, getUnclaimedPremium],
  );

  // ---- open orders: my resting orders across ALL mints, newest first ----
  const openOrders = useMemo(() => {
    if (!publicKey) return [];
    const mine = publicKey.toBase58();
    return bookOrders
      .filter((o) => o.owner === mine)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [bookOrders, publicKey]);

  // ---- history: bounded recent-activity scan (no indexer) ----
  const [orderHistory, setOrderHistory] = useState<ActivityEvent[]>([]);
  const [tradeHistory, setTradeHistory] = useState<ActivityEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const refetchHistory = useCallback(async () => {
    if (!program || !publicKey) {
      setOrderHistory([]);
      setTradeHistory([]);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const events = await scanRecentActivity(program, publicKey);
      setOrderHistory(events.filter((e) => e.kind !== "filled"));
      setTradeHistory(events.filter((e) => e.kind === "filled"));
    } catch (err) {
      console.error("Trade dock history scan failed", err);
    } finally {
      setHistoryLoading(false);
    }
  }, [program, publicKey]);

  useEffect(() => {
    refetchHistory();
  }, [refetchHistory]);

  // ---- balances: USDC free (ATA) + locked (own book + writer collateral) + SOL ----
  const [balances, setBalances] = useState<TradeBalances>(EMPTY_BALANCES);
  const [balancesLoading, setBalancesLoading] = useState(false);

  // Locked USDC is pure & synchronous: own bids lock price*qty; own writer-asks
  // lock collateralPerContract*qty; plus collateral already deposited into vaults.
  const usdcLocked = useMemo(() => {
    if (!publicKey) return null;
    const mine = publicKey.toBase58();
    let locked = 0;
    for (const o of bookOrders) {
      if (o.owner !== mine) continue;
      if (o.kind === "bid") locked += o.price * o.qty;
      else if (o.kind === "writerAsk") locked += o.collateralPerContract * o.qty;
    }
    for (const r of writerRows) locked += r.collateralDeposited;
    return locked;
  }, [bookOrders, writerRows, publicKey]);

  useEffect(() => {
    let cancelled = false;
    if (!program || !publicKey) {
      setBalances(EMPTY_BALANCES);
      setBalancesLoading(false);
      return;
    }
    setBalancesLoading(true);
    const conn = program.provider.connection;
    (async () => {
      // USDC free: SPL-token (classic) ATA uiAmount. A missing ATA means the
      // wallet holds 0 USDC — honest 0, not a fabricated figure.
      let usdcFree: number | null = null;
      try {
        const ata = getAssociatedTokenAddressSync(
          DEVNET_USDC_MINT,
          publicKey,
          false,
          TOKEN_PROGRAM_ID,
        );
        const bal = await conn.getTokenAccountBalance(ata);
        usdcFree = bal.value.uiAmount ?? 0;
      } catch {
        usdcFree = 0; // no USDC token account → 0 free balance
      }
      let sol: number | null = null;
      try {
        sol = (await conn.getBalance(publicKey)) / 1e9;
      } catch {
        sol = null; // genuine RPC failure — stay honest, don't claim 0
      }
      if (cancelled) return;
      setBalances({ usdcFree, usdcLocked, sol });
      setBalancesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [program, publicKey, usdcLocked]);

  const refetch = useCallback(() => {
    void refetchPositions();
    void refetchHistory();
  }, [refetchPositions, refetchHistory]);

  // A confirmed order mutation refreshes positions/balances/history (open orders
  // update via useBook's own subscription). refreshAfterMutation invalidated the
  // vault caches, so the reconcile scan is chain-fresh.
  useEffect(() => subscribeMutations(refetch), [refetch]);

  return {
    holderPositions,
    writerRows,
    openOrders,
    orderHistory,
    tradeHistory,
    balances,
    loading: {
      positions: positionsLoading || vaultsLoading,
      history: historyLoading,
      balances: balancesLoading,
    },
    historyBounded: true,
    refetch,
  };
}
