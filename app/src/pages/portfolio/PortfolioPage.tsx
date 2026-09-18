import { spotSourceOf } from "../../utils/oracleArm";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { useSpotPrices } from "../../hooks/useSpotPrices";
import { useTokenMetadata } from "../../hooks/useTokenMetadata";
import { usePaperPalette } from "../../hooks";
import { TOKEN_2022_PROGRAM_ID } from "../../utils/constants";
import { hexFromBytes } from "../../utils/format";
import { PaperGrain } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { PORTFOLIO_TERMINAL_UI } from "../../utils/constants";
import { PortfolioTerminalPage } from "./PortfolioTerminalPage";
import { MoneyAmount } from "../../components/MoneyAmount";
import { StatementHeader, type Denomination } from "./StatementHeader";
import { SummaryBand, type SummaryCell } from "./SummaryBand";
import { WriterSummaryBand } from "./WriterSummaryBand";
import { OpenPositionsSection } from "./OpenPositionsSection";
import { ArmedTriggersSection } from "./ArmedTriggersSection";
import { WrittenPositionsSection } from "./WrittenPositionsSection";
import { ClosedPositionsSection } from "./ClosedPositionsSection";
import { ResaleModal } from "./ResaleModal";
import { SettleExpiriesSection } from "./SettleExpiriesSection";
import { MigrateFeedSection } from "./MigrateFeedSection";
import { buildPositions, type Position, type PositionAction } from "./positions";
import type { PotFundingView } from "../../utils/earlyExerciseAvailability";
import {
  buildWriterRows,
  type WriterRow,
  type WriterRowAction,
} from "./writerRows";
import { usePortfolioActions } from "./usePortfolioActions";
import { useWriterActions } from "./useWriterActions";

interface MarketAccount {
  publicKey: PublicKey;
  account: any;
}

/**
 * PortfolioPage — the user's options statement.
 *
 * Two-ledger composition (post WRITER_PF arc): the page renders a
 * buyer ledger and a writer ledger as parallel sections sharing the
 * AppNav + StatementHeader shell. Each ledger has its own SummaryBand
 * (writer band only renders when the wallet has writer positions),
 * its own data builder (positions.ts vs writerRows.ts), and its own
 * action hook (usePortfolioActions vs useWriterActions). Both action
 * hooks point onSuccess at the same refetchAll callback, which itself
 * also kicks useVaults().refetch — so D5b's "watch the cell tick"
 * demo moment fires symmetrically from both sides.
 *
 *   SummaryBand            — buyer summary metrics (always rendered)
 *   WriterSummaryBand      — writer summary metrics (conditional)
 *   § 01 · Open positions   (buyer)
 *   § 02 · Vaults written   (writer)
 *   § 03 · Closed positions (buyer; renumbered from § 02)
 *   SettleExpiriesSection  — public-good crank UI
 *   MigrateFeedSection     — admin
 *   ResaleModal            — mounted on demand from a buyer row
 *
 * Buyer rows: built once via buildPositions() and shared with SummaryBand.
 * Writer rows: built once via buildWriterRows() and shared with
 * WriterSummaryBand + WrittenPositionsSection so claim/withdraw math
 * is computed in exactly one place per side.
 */
/**
 * PortfolioPage — flag switch between the legacy paper surface
 * (PortfolioPageLegacy, unchanged) and the new terminal surface
 * (PortfolioTerminalPage). Gated by PORTFOLIO_TERMINAL_UI (default true).
 * Mirrors Trade/Write — App.tsx and routing untouched; the page owns which
 * surface it mounts.
 */
export const PortfolioPage: FC = () =>
  PORTFOLIO_TERMINAL_UI ? <PortfolioTerminalPage /> : <PortfolioPageLegacy />;

const PortfolioPageLegacy: FC = () => {
  usePaperPalette();
  const { publicKey, connected } = useWallet();
  const { program } = useProgram();
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [settlementRecords, setSettlementRecords] = useState<
    { publicKey: PublicKey; account: any }[]
  >([]);
  const [heldBalances, setHeldBalances] = useState<Map<string, number>>(new Map());
  const [listingsRaw, setListingsRaw] = useState<
    { publicKey: PublicKey; account: any }[]
  >([]);
  const [potsRaw, setPotsRaw] = useState<
    { publicKey: PublicKey; account: any }[]
  >([]);
  const [denomination, setDenomination] = useState<Denomination>("USDC");
  const [resaleTarget, setResaleTarget] = useState<Position | null>(null);

  const {
    vaults,
    vaultMints,
    myPositions,
    getUnclaimedPremium,
    refetch: refetchVaults,
  } = useVaults();
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

  const refetchAll = useCallback(async () => {
    if (!program) return;
    try {
      const [mkts, settles, lists, pots] = await Promise.all([
        safeFetchAll(program, "optionsMarket"),
        safeFetchAll(program, "settlementRecord"),
        safeFetchAll(program, "vaultResaleListing"),
        // Writer-ask collateral pots — the early-exercise gate needs them.
        safeFetchAll(program, "writerAskPot"),
      ]);
      setMarkets(mkts as MarketAccount[]);
      setSettlementRecords(
        settles as { publicKey: PublicKey; account: any }[],
      );
      setListingsRaw(lists as { publicKey: PublicKey; account: any }[]);
      setPotsRaw(pots as { publicKey: PublicKey; account: any }[]);
      if (publicKey) {
        const accts = await program.provider.connection.getTokenAccountsByOwner(publicKey, {
          programId: TOKEN_2022_PROGRAM_ID,
        });
        const m = new Map<string, number>();
        for (const a of accts.value) {
          // MED-4: raw byte read intentional. The getTokenAccountsByOwner
          // RPC filter on programId guarantees every result IS a Token-2022
          // token account, so the offset 0..32 (mint) and 64..72 (amount)
          // byte-slice reads are pre-validated by the RPC. Per-item getAccount
          // would round-trip the same data through a redundant re-validation.
          const mint = new PublicKey(a.account.data.slice(0, 32)).toBase58();
          const balance = Number(a.account.data.readBigUInt64LE(64));
          if (balance > 0) m.set(mint, balance);
        }
        setHeldBalances(m);
      } else {
        setHeldBalances(new Map());
      }
      // D5b: also refresh vault-side accounts so writer rows + summary band
      // see fresh state. useVaults owns its own state setters; awaiting
      // here makes the overall refetch atomic — both ledgers update before
      // the action's onSuccess promise resolves, so any post-action UI
      // (toast, busy-state clear) lands on a fully-fresh view.
      await refetchVaults();
    } catch (err) {
      console.error("Portfolio refetch failed", err);
    }
  }, [program, publicKey, refetchVaults]);

  const actions = usePortfolioActions(refetchAll);
  const writerActions = useWriterActions({
    vaults,
    vaultMints,
    onSuccess: refetchAll,
  });

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

  // V2 positions surface when the wallet either (a) holds option tokens
  // directly OR (b) has an active resale listing whose tokens are escrowed.
  // Without (b), listing your entire balance would make the row vanish from
  // Portfolio because the on-chain ATA balance drops to 0 — and the user
  // would lose the only path to cancel the listing from the existing UI.
  // Effective balance = direct + escrowed; positions.ts's downstream logic
  // treats this as the wallet's total economic exposure to the contract.
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

  const positions = useMemo(
    () =>
      buildPositions({
        v2Held,
        spotPrices,
        metadataSymbolByMint,
        listings: myListings,
        potByMint,
      }),
    [v2Held, spotPrices, metadataSymbolByMint, myListings, potByMint],
  );

  // Writer rows derived from useVaults().myPositions, joined to vaults +
  // vaultMints + marketMap. Same array drives WriterSummaryBand and
  // WrittenPositionsSection so claim/withdraw math is computed once.
  const writerRows = useMemo(
    () =>
      buildWriterRows({
        myPositions,
        vaults,
        vaultMints,
        marketMap,
        getUnclaimedPremium,
      }),
    [myPositions, vaults, vaultMints, marketMap, getUnclaimedPremium],
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
      sub: pricesStale ? "Mark · Black–Scholes · delayed" : "Mark · Black–Scholes",
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
        case "exercise-american":
          actions.exerciseAmerican(p);
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

  // Writer action dispatcher — mirrors handleAction but emits to
  // useWriterActions handlers. "settling" is informational only (no IX
  // to invoke); the table renders a disabled label and never fires this
  // case, but the switch is exhaustive for type-safety.
  const handleWriterAction = useCallback(
    (row: WriterRow, action: WriterRowAction) => {
      switch (action) {
        case "claim-premium":
          writerActions.claimPremium(row);
          break;
        case "withdraw-collateral":
          writerActions.withdrawCollateral(row);
          break;
        case "burn-unsold":
          writerActions.burnUnsoldEscrow(row);
          break;
        case "settling":
          break;
      }
    },
    [writerActions],
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
        <WriterSummaryBand rows={writerRows} />

        {!connected ? (
          <div className="mt-16 border border-rule rounded-md p-12 text-center">
            <p className="font-sans italic font-medium leading-[1.55] text-ink-body text-[15px] m-0">
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
            {/* Armed TP/SL exits sit directly under the positions they protect —
                a stop is only meaningful next to the thing it is guarding. */}
            <ArmedTriggersSection />
            <WrittenPositionsSection
              rows={writerRows}
              onAction={handleWriterAction}
              busyId={writerActions.busyId}
              busyLabel={writerActions.busyLabel}
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
