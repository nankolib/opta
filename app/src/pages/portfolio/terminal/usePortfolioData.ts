// =============================================================================
// usePortfolioData — data assembly + invalidate-before-refetch for the terminal
// Portfolio surface. React hook (owns fetch state), no JSX.
// =============================================================================
//
// Lifts the assembly from the legacy PortfolioPage (markets · held balances ·
// v2 positions · writer rows · spot · vault state) into one hook the terminal
// page consumes, and CLOSES the settle/claim mutation-refresh debt:
//
//   refetchAll invalidates every coalesced program-account scan it (and
//   useVaults) reads BEFORE refetching (invalidateAccountScans), so a refetch
//   fired right after a confirmed action can never be served a pre-mutation
//   in-flight snapshot. useVaults does NOT subscribe to the mutationBus, so this
//   invalidate-before-refetch is the fix — not the bus emit that drives Trade.
//
// Every action hook's onSuccess is wired to this refetchAll, so exercise /
// claim / withdraw / burn / list / cancel all reconcile chain-fresh with no
// manual reload. Action instruction assembly is untouched (usePortfolioActions /
// useWriterActions are the byte-identical engines).
// =============================================================================

import { spotSourceOf } from "../../../utils/oracleArm";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../../hooks/useProgram";
import { safeFetchAll, invalidateAccountScans } from "../../../hooks/useFetchAccounts";
import { useVaults } from "../../../hooks/useVaults";
import { useSpotPrices } from "../../../hooks/useSpotPrices";
import { useTokenMetadata } from "../../../hooks/useTokenMetadata";
import { TOKEN_2022_PROGRAM_ID } from "../../../utils/constants";
import { hexFromBytes } from "../../../utils/format";
import { buildPositions, type Position } from "../positions";
import type { PotFundingView } from "../../../utils/earlyExerciseAvailability";
import { buildWriterRows, type WriterRow } from "../writerRows";
import { buildAskRows, type AskRow } from "../askRows";
import { canonicalAsset } from "../../../utils/assetDisplay";
import { usePortfolioActions } from "../usePortfolioActions";
import { useWriterActions } from "../useWriterActions";

interface AccountWrapper {
  publicKey: PublicKey;
  account: any;
}

// Every coalesced scan refetchAll + useVaults read — invalidated before a
// post-action refetch so none joins a pre-mutation in-flight snapshot.
const PORTFOLIO_SCANS = [
  "writerAskPosition",
  "optionsMarket",
  "settlementRecord",
  "vaultResaleListing",
  "sharedVault",
  "writerPosition",
  "vaultMint",
  "epochConfig",
  "restingOrder",
  "writerAskPot",
] as const;

export type PortfolioData = ReturnType<typeof usePortfolioData>;

export function usePortfolioData() {
  const { publicKey, connected } = useWallet();
  const { program } = useProgram();

  const [markets, setMarkets] = useState<AccountWrapper[]>([]);
  const [settlementRecords, setSettlementRecords] = useState<AccountWrapper[]>([]);
  const [listingsRaw, setListingsRaw] = useState<AccountWrapper[]>([]);
  // SLICE 2B — the account a modern /write actually produces.
  const [asksRaw, setAsksRaw] = useState<AccountWrapper[]>([]);
  // The BOOK. WriterAskPosition is a permanent accounting record and never
  // closes; RestingOrder is what actually rests and closes on fill. Without
  // this, a filled ask renders as ON THE BOOK forever.
  const [restingRaw, setRestingRaw] = useState<AccountWrapper[]>([]);
  const [potsRaw, setPotsRaw] = useState<AccountWrapper[]>([]);
  const [heldBalances, setHeldBalances] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const { vaults, vaultMints, myPositions, getUnclaimedPremium, refetch: refetchVaults } = useVaults();

  const feeds = useMemo(() => {
    const out: { ticker: string; feedIdHex: string; oracleSource: 0 | 1 | 2 }[] = [];
    const seen = new Set<string>();
    for (const m of markets) {
      const ticker = m.account.assetName as string;
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({
        ticker,
        feedIdHex: hexFromBytes(m.account.pythFeedId as number[]),
        oracleSource: spotSourceOf(m.account.oracleSource),
      });
    }
    return out;
  }, [markets]);
  const { prices: spotPrices, stale: pricesStale } = useSpotPrices(feeds);

  /**
   * Invalidate-before-refetch. `invalidate=true` (the default from every action
   * onSuccess) drops the coalesced scans first so the refetch is chain-fresh.
   * The initial mount / wallet-change load passes invalidate=false (nothing to
   * invalidate yet — a fresh scan either way).
   */
  const refetchAll = useCallback(
    async (invalidate = true) => {
      if (!program) return;
      if (invalidate) invalidateAccountScans(program, PORTFOLIO_SCANS);
      try {
        const [mkts, settles, lists, asks, resting, pots] = await Promise.all([
          safeFetchAll(program, "optionsMarket"),
          safeFetchAll(program, "settlementRecord"),
          safeFetchAll(program, "vaultResaleListing"),
          safeFetchAll(program, "writerAskPosition"),
          safeFetchAll(program, "restingOrder"),
          // Writer-ask collateral pots — the early-exercise gate cannot judge a
          // writer-ask series without them (vault_usdc is $0 there by design).
          safeFetchAll(program, "writerAskPot"),
        ]);
        setMarkets(mkts as AccountWrapper[]);
        setSettlementRecords(settles as AccountWrapper[]);
        setListingsRaw(lists as AccountWrapper[]);
        setAsksRaw(asks as AccountWrapper[]);
        setRestingRaw(resting as AccountWrapper[]);
        setPotsRaw(pots as AccountWrapper[]);
        if (publicKey) {
          const accts = await program.provider.connection.getTokenAccountsByOwner(publicKey, {
            programId: TOKEN_2022_PROGRAM_ID,
          });
          const m = new Map<string, number>();
          for (const a of accts.value) {
            const mint = new PublicKey(a.account.data.slice(0, 32)).toBase58();
            const balance = Number(a.account.data.readBigUInt64LE(64));
            if (balance > 0) m.set(mint, balance);
          }
          setHeldBalances(m);
        } else {
          setHeldBalances(new Map());
        }
        await refetchVaults();
        setError(false);
      } catch (err) {
        console.error("Portfolio refetch failed", err);
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [program, publicKey, refetchVaults],
  );

  const actions = usePortfolioActions(refetchAll);
  const writerActions = useWriterActions({ vaults, vaultMints, onSuccess: refetchAll });

  useEffect(() => {
    if (!program) return;
    setLoading(true);
    refetchAll(false);
  }, [program, publicKey, refetchAll]);

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

  const myListings = useMemo(() => {
    if (!connected || !publicKey) return [];
    return listingsRaw.filter((l) => (l.account.seller as PublicKey).equals(publicKey));
  }, [listingsRaw, connected, publicKey]);

  // Effective balance = directly-held + escrowed-in-own-listing, so listing your
  // whole balance doesn't make the row (and its cancel path) vanish.
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
      const totalBal = (heldBalances.get(mintKey) ?? 0) + (listedByMint.get(mintKey) ?? 0);
      if (totalBal <= 0) continue;
      const vault = vaults.find((v) => v.publicKey.equals(vm.account.vault as PublicKey));
      if (!vault) continue;
      const market = marketMap.get((vault.account.market as PublicKey).toBase58()) ?? null;
      found.push({ vaultMint: vm, vault, balance: totalBal, market });
    }
    return found;
  }, [vaultMints, vaults, marketMap, heldBalances, connected, publicKey, myListings]);

  // option_mint base58 -> pot. Keyed by mint, matching the pot PDA seed, so a
  // position row looks its own funding up directly.
  const potByMint = useMemo(() => {
    const m = new Map<string, PotFundingView>();
    for (const p of potsRaw) {
      m.set((p.account.optionMint as PublicKey).toBase58(), {
        totalCollateral: p.account.totalCollateral,
      });
    }
    return m;
  }, [potsRaw]);

  const positions = useMemo(
    () => buildPositions({ v2Held, spotPrices, metadataSymbolByMint, listings: myListings, potByMint }),
    [v2Held, spotPrices, metadataSymbolByMint, myListings, potByMint],
  );
  const writerRows = useMemo(
    () => buildWriterRows({ myPositions, vaults, vaultMints, marketMap, getUnclaimedPremium }),
    [myPositions, vaults, vaultMints, marketMap, getUnclaimedPremium],
  );

  // SLICE 2B — resting writer-asks. READ-ONLY (see askRows.ts for why).
  const assetByMarket = useMemo(() => {
    const m = new Map<string, string>();
    for (const [pda, acct] of marketMap) {
      const name = canonicalAsset((acct as { assetName?: string }).assetName);
      if (name) m.set(pda, name);
    }
    return m;
  }, [marketMap]);

  const liveOrderVaults = useMemo(
    () => new Set(restingRaw.map((o) => (o.account.vault as PublicKey).toBase58())),
    [restingRaw],
  );
  const askRows = useMemo(
    () => buildAskRows(
      asksRaw as never, vaults as never, publicKey ?? null, assetByMarket, liveOrderVaults),
    [asksRaw, vaults, publicKey, assetByMarket, liveOrderVaults],
  );

  return {
    connected,
    publicKey,
    program,
    loading,
    error,
    markets,
    settlementRecords,
    spotPrices,
    pricesStale,
    vaults,
    vaultMints,
    positions,
    writerRows,
    askRows,
    refetchAll,
    actions,
    writerActions,
  };
}

export type { Position, WriterRow };
