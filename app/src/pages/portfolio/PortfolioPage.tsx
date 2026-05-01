import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { usePythPrices } from "../../hooks/usePythPrices";
import { useTokenMetadata } from "../../hooks/useTokenMetadata";
import { usePaperPalette } from "../../hooks";
import { TOKEN_2022_PROGRAM_ID } from "../../utils/constants";
import { hexFromBytes } from "../../utils/format";
import { PaperGrain } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { MoneyAmount } from "../../components/MoneyAmount";
import { StatementHeader, type Denomination } from "./StatementHeader";
import { SummaryBand, type SummaryCell } from "./SummaryBand";
import { OpenPositionsSection } from "./OpenPositionsSection";
import { ClosedPositionsSection } from "./ClosedPositionsSection";
import { ResaleModal } from "./ResaleModal";
import { SettleExpiriesSection } from "./SettleExpiriesSection";
import { MigrateFeedSection } from "./MigrateFeedSection";
import { buildPositions, type Position, type PositionAction } from "./positions";
import { usePortfolioActions } from "./usePortfolioActions";

interface PositionAccount {
  publicKey: PublicKey;
  account: any;
}
interface MarketAccount {
  publicKey: PublicKey;
  account: any;
}

/**
 * PortfolioPage — the user's options statement.
 *
 * Stage 1 built the AppNav / StatementHeader / SummaryBand shell with
 * data-driven summary metrics. Stage 2 replaces the placeholder below
 * the band with the real positions content:
 *
 *   - § 01 · Open positions table (with filter pills)
 *   - § 02 · Closed positions (collapsible)
 *   - Admin tools (admin-only, visually quarantined)
 *   - ResaleModal (mounted on demand when a v1 active row clicks
 *     "List for Resale")
 *
 * Buyer-side only — written/vault-writer positions live elsewhere
 * (legacy WrittenTab and VaultPositions tabs were dropped per Stage 2
 * scope; their logic remains in components/portfolio/ for reference
 * and may be migrated to a future page).
 *
 * Position[] is built once via buildPositions(); both the SummaryBand
 * and the section tables consume the same array, so the cost-basis
 * and current-value math is computed in exactly one place.
 */
export const PortfolioPage: FC = () => {
  usePaperPalette();
  const { publicKey, connected } = useWallet();
  const { program } = useProgram();
  const [positionsRaw, setPositionsRaw] = useState<PositionAccount[]>([]);
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [settlementRecords, setSettlementRecords] = useState<
    { publicKey: PublicKey; account: any }[]
  >([]);
  const [heldBalances, setHeldBalances] = useState<Map<string, number>>(new Map());
  const [listingsRaw, setListingsRaw] = useState<
    { publicKey: PublicKey; account: any }[]
  >([]);
  const [denomination, setDenomination] = useState<Denomination>("USDC");
  const [resaleTarget, setResaleTarget] = useState<Position | null>(null);

  const { vaults, vaultMints } = useVaults();
  const feeds = useMemo(() => {
    const out: { ticker: string; feedIdHex: string }[] = [];
    const seen = new Set<string>();
    for (const m of markets) {
      const ticker = m.account.assetName as string;
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      out.push({ ticker, feedIdHex: hexFromBytes(m.account.pythFeedId as number[]) });
    }
    return out;
  }, [markets]);
  const { prices: spotPrices } = usePythPrices(feeds);

  const refetchAll = useCallback(async () => {
    if (!program) return;
    try {
      const [posns, mkts, settles, lists] = await Promise.all([
        safeFetchAll(program, "optionPosition"),
        safeFetchAll(program, "optionsMarket"),
        safeFetchAll(program, "settlementRecord"),
        safeFetchAll(program, "vaultResaleListing"),
      ]);
      setPositionsRaw(posns as PositionAccount[]);
      setMarkets(mkts as MarketAccount[]);
      setSettlementRecords(
        settles as { publicKey: PublicKey; account: any }[],
      );
      setListingsRaw(lists as { publicKey: PublicKey; account: any }[]);
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
    } catch (err) {
      console.error("Portfolio refetch failed", err);
    }
  }, [program, publicKey]);

  const actions = usePortfolioActions(refetchAll);

  useEffect(() => {
    if (!program) return;
    refetchAll();
  }, [program, publicKey, refetchAll]);

  const marketMap = useMemo(() => {
    const map = new Map<string, any>();
    markets.forEach((m) => map.set(m.publicKey.toBase58(), m.account));
    return map;
  }, [markets]);

  // Token metadata fallback for v2 vault mints whose market PDA isn't
  // reachable through marketMap (e.g. dropped by safeFetchAll's strict
  // validator). Used inside buildPositions to recover the asset ticker
  // from the on-chain token symbol.
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

  // Filter raw positions/vault-mints down to what the wallet currently holds
  const v1Held = useMemo(() => {
    if (!connected || !publicKey) return [];
    return positionsRaw.filter((p) => {
      if (p.account.isExercised || p.account.isCancelled) return false;
      const bal = heldBalances.get(p.account.optionMint.toBase58());
      return !!bal && bal > 0;
    });
  }, [positionsRaw, heldBalances, connected, publicKey]);

  const v2Held = useMemo(() => {
    if (!connected || !publicKey) return [];
    const found: { vaultMint: any; vault: any; balance: number; market: any | null }[] = [];
    for (const vm of vaultMints) {
      const mintKey = (vm.account.optionMint as PublicKey).toBase58();
      const balance = heldBalances.get(mintKey);
      if (!balance) continue;
      const vault = vaults.find((v) => v.publicKey.equals(vm.account.vault as PublicKey));
      if (!vault) continue;
      const market = marketMap.get((vault.account.market as PublicKey).toBase58()) ?? null;
      found.push({ vaultMint: vm, vault, balance, market });
    }
    return found;
  }, [vaultMints, vaults, marketMap, heldBalances, connected, publicKey]);

  // Filter raw listings down to ones the connected wallet owns. The on-chain
  // PDA seed [VAULT_RESALE_LISTING_SEED, mint, seller] guarantees at most one
  // active listing per (mint, seller), so this maps cleanly into the
  // listingByMint lookup inside buildPositions.
  const myListings = useMemo(() => {
    if (!connected || !publicKey) return [];
    return listingsRaw.filter((l) =>
      (l.account.seller as PublicKey).equals(publicKey),
    );
  }, [listingsRaw, connected, publicKey]);

  const positions = useMemo(
    () =>
      buildPositions({
        v1Held,
        v2Held,
        heldBalances,
        marketMap,
        spotPrices,
        metadataSymbolByMint,
        listings: myListings,
      }),
    [v1Held, v2Held, heldBalances, marketMap, spotPrices, metadataSymbolByMint, myListings],
  );

  const openPositions = useMemo(
    () =>
      positions.filter(
        (p) =>
          p.state === "active" ||
          p.state === "settled-itm" ||
          p.state === "expired-unsettled",
      ),
    [positions],
  );
  const closedPositions = useMemo(
    () => positions.filter((p) => p.state === "settled-otm"),
    [positions],
  );

  // Summary metrics — same definitions as Stage 1, now derived from the
  // unified Position[] array instead of duplicating the math.
  const summary = useMemo(() => {
    if (!connected || !publicKey) {
      return {
        openCount: null as number | null,
        callCount: 0,
        putCount: 0,
        costBasis: null as number | null,
        currentValue: null as number | null,
        pnl: null as number | null,
        pnlPercent: null as number | null,
      };
    }
    const activeOnly = positions.filter((p) => p.state === "active");
    const callCount = activeOnly.filter((p) => p.side === "call").length;
    const putCount = activeOnly.filter((p) => p.side === "put").length;
    const openCount = activeOnly.length;
    const costBasis = positions.reduce((s, p) => s + p.costBasis, 0);
    const currentValue = positions.reduce((s, p) => s + p.currentValue, 0);
    const pnl = currentValue - costBasis;
    const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
    return { openCount, callCount, putCount, costBasis, currentValue, pnl, pnlPercent };
  }, [positions, connected, publicKey]);

  const monthLabel = useMemo(
    () => new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    [],
  );
  const timestampLabel = useMemo(() => {
    const now = new Date();
    const datePart = now.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const timePart = now.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
    return `${datePart} · ${timePart} UTC`;
  }, []);

  const pnlColorClass =
    summary.pnl === null || summary.pnl === 0
      ? ""
      : summary.pnl > 0
        ? "text-emerald-700"
        : "text-crimson";

  const cells: [SummaryCell, SummaryCell, SummaryCell, SummaryCell] = [
    {
      label: "Open Positions",
      value: summary.openCount === null ? "—" : summary.openCount.toString(),
      sub:
        summary.openCount === null
          ? "Connect wallet"
          : `${summary.callCount} calls · ${summary.putCount} puts`,
    },
    {
      label: "Cost Basis",
      value: summary.costBasis === null ? "—" : <MoneyAmount value={summary.costBasis} />,
      sub: "USDC · Paid premia",
    },
    {
      label: "Current Value",
      value:
        summary.currentValue === null ? "—" : <MoneyAmount value={summary.currentValue} />,
      sub: "Mark · Black–Scholes",
    },
    {
      label: "Unrealised P&L",
      value:
        summary.pnl === null ? (
          "—"
        ) : (
          <span className={pnlColorClass}>
            <MoneyAmount value={summary.pnl} showSign />
          </span>
        ),
      sub:
        summary.pnl === null || summary.pnlPercent === null
          ? "Connect wallet"
          : `${summary.pnl >= 0 ? "▲" : "▼"} ${Math.abs(summary.pnlPercent).toFixed(2)}% vs cost`,
    },
  ];

  // Action dispatcher: most actions fire through the hook directly;
  // List for Resale opens the modal, which then submits via the hook.
  const handleAction = useCallback(
    (p: Position, action: PositionAction) => {
      switch (action) {
        case "exercise":
          actions.exercise(p);
          break;
        case "list-resale":
          setResaleTarget(p);
          break;
        case "cancel-resale":
          actions.cancelResale(p);
          break;
        case "burn":
          actions.burn(p);
          break;
        case "none":
        default:
          break;
      }
    },
    [actions],
  );

  const handleResaleSubmit = useCallback(
    async (premiumUsd: number, tokenAmount: number) => {
      if (!resaleTarget) return;
      await actions.listResale(resaleTarget, premiumUsd, tokenAmount);
      setResaleTarget(null);
    },
    [actions, resaleTarget],
  );

  return (
    <div className="relative bg-paper text-ink overflow-x-hidden min-h-screen">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
        <StatementHeader
          monthLabel={monthLabel}
          timestampLabel={timestampLabel}
          denomination={denomination}
          onDenominationChange={setDenomination}
        />
        <SummaryBand cells={cells} />

        {!connected ? (
          <div className="mt-16 border border-rule rounded-md p-12 text-center">
            <p className="font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(15px,1.2vw,17px)] m-0">
              Connect your wallet to view your positions.
            </p>
          </div>
        ) : (
          <>
            <OpenPositionsSection
              positions={openPositions}
              onAction={handleAction}
              busyId={actions.busyId}
            />
            <ClosedPositionsSection
              positions={closedPositions}
              onAction={handleAction}
              busyId={actions.busyId}
            />
            <SettleExpiriesSection
              vaults={vaults}
              markets={markets}
              settlementRecords={settlementRecords}
              onRefetch={refetchAll}
            />
            <MigrateFeedSection
              markets={markets}
              onRefetch={refetchAll}
            />
          </>
        )}

        {resaleTarget && (
          <ResaleModal
            position={resaleTarget}
            spotPrice={spotPrices[resaleTarget.asset]}
            onClose={() => setResaleTarget(null)}
            onSubmit={handleResaleSubmit}
            isSubmitting={actions.busyId === resaleTarget.id}
          />
        )}
      </main>
    </div>
  );
};

export default PortfolioPage;
