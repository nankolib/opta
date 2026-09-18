// =============================================================================
// WriteTerminalPage — the terminal /write surface (FE terminal track, Slice 2).
// =============================================================================
//
// Shared TerminalAppBar + dark-default surface (useSurfaceMode) over a
// fixed-height flex column: a split cockpit (contract builder left · premium
// centerpiece right) driven by an EPOCH|CUSTOM segmented control, a full-width
// ladder table (Epoch·Ladder), and a docked footer strip with the ONE teal
// primary. Both write modes keep independent state so switching never clears the
// other's inputs. Exercise defaults to AMERICAN.
//
// Frontend-only reskin+restructure: all resolution + the write itself run through
// useWriteController → useWriteSubmit (the untouched atomic-bundle engine). The
// paper WritePageLegacy remains the byte-identical fallback behind WRITE_TERMINAL_UI.
// =============================================================================

import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useProgram } from "../../hooks/useProgram";
import { useSurfaceMode } from "../../hooks/useSurfaceMode";
import { SolscanLink } from "../../components/SolscanLink";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useSpotPrices } from "../../hooks/useSpotPrices";
import { useVolOracleStatus } from "../../hooks/useVolOracleStatus";
import { hexFromBytes } from "../../utils/format";
import { spotSourceOf, writeWarmupGate } from "../../utils/oracleArm";
import { canonicalAsset } from "../../utils/assetDisplay";
import { ASSET_CLASS_EQUITY, ASSET_CLASS_ETF } from "../../utils/marketHours";
import { TerminalAppBar } from "../../components/TerminalAppBar";
import { refreshAfterMutation } from "../trade/orderRefresh";
import { weeklyExpiry, type TenorLabel } from "../../utils/tenors";
import type { WriterFormValues, AssetOption } from "./WriterForm";
import type { WriteCell, WriteSuccessPayload } from "./useWriteSubmit";
import {
  useWriteController,
  type TenorMode,
  type WriteMode,
} from "./terminal/useWriteController";
import { WriteContractPanel } from "./terminal/WriteContractPanel";
import { WritePremiumPanel } from "./terminal/WritePremiumPanel";
import { WriteLadderTable } from "./terminal/WriteLadderTable";

interface MarketAccount {
  publicKey: PublicKey;
  account: any;
}

const fmtUsd = (v: number, dp = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const freshValues = (): WriterFormValues => ({
  asset: null,
  side: "call",
  exerciseStyle: "american", // deliberate product default
  strike: "",
  contracts: "1",
  expiry: null,
  expiryPreset: "1D",
  premiumPerContract: "",
});

export const WriteTerminalPage: FC = () => {
  const { mode: surfaceMode, toggle } = useSurfaceMode("dark");
  const { program } = useProgram();
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();

  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [lastSuccess, setLastSuccess] = useState<WriteSuccessPayload | null>(null);

  // ---- Write mode + per-mode form state (persist across EPOCH↔CUSTOM switch) ----
  const [mode, setMode] = useState<WriteMode>("epoch");
  const [epochValues, setEpochValues] = useState<WriterFormValues>(() => ({
    ...freshValues(),
    expiry: weeklyExpiry(),
    expiryPreset: "7D",
  }));
  const [customValues, setCustomValues] = useState<WriterFormValues>(() => ({
    ...freshValues(),
    expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
  }));
  const [tenorMode, setTenorMode] = useState<TenorMode>("single");
  const [singleTenor, setSingleTenor] = useState<TenorLabel>("Weekly");
  const [split, setSplit] = useState<Record<TenorLabel, number>>({ Weekly: 50, Monthly: 30, Quarterly: 20 });

  const values = mode === "epoch" ? epochValues : customValues;
  const setValues = mode === "epoch" ? setEpochValues : setCustomValues;

  // ---- Market universe + spot + vol-oracle coverage (mirrors WritePageLegacy) ----
  const refetchMarkets = async () => {
    if (!program) return;
    try {
      const mkts = await safeFetchAll<any>(program, "optionsMarket");
      setMarkets(mkts as MarketAccount[]);
    } catch (err) {
      console.error("Markets fetch failed", err);
    }
  };
  useEffect(() => {
    refetchMarkets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program]);

  const assets = useMemo<AssetOption[]>(() => {
    const map = new Map<string, AssetOption>();
    for (const m of markets) {
      const ticker = canonicalAsset(m.account.assetName);
      if (!ticker) continue;
      if (!map.has(ticker)) map.set(ticker, { ticker, market: m });
    }
    return Array.from(map.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [markets]);

  const feeds = useMemo(
    () =>
      assets.map((a) => ({
        ticker: a.ticker,
        feedIdHex: hexFromBytes(a.market.account.pythFeedId as number[]),
        oracleSource: spotSourceOf(a.market.account.oracleSource),
      })),
    [assets],
  );
  const { prices: spotPrices, stale: pricesStale, asOf: spotAsOfMap } = useSpotPrices(feeds);

  const volOracleStatus = useVolOracleStatus(useMemo(() => feeds.map((f) => f.feedIdHex), [feeds]));
  const unseededTickers = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const f of feeds) {
      if (volOracleStatus.unseeded.has(f.feedIdHex.toLowerCase().replace(/^0x/, ""))) out.add(f.ticker);
    }
    return out;
  }, [feeds, volOracleStatus.unseeded]);

  // Plug wave 1 write-gate: a source-2 market is write-closed until its vol
  // ring is warm (sample_count >= 168). Data-driven, self-lifting, fail-closed
  // while the oracle has not been read yet. ticker -> reason.
  const warmupBlocks = useMemo<ReadonlyMap<string, string>>(() => {
    const out = new Map<string, string>();
    for (const f of feeds) {
      const w = volOracleStatus.warmup.get(f.feedIdHex.toLowerCase().replace(/^0x/, ""));
      const reason = writeWarmupGate(f.oracleSource, w?.sampleCount ?? null);
      if (reason) out.set(f.ticker, reason);
    }
    return out;
  }, [feeds, volOracleStatus.warmup]);

  const tickers = useMemo(() => assets.map((a) => a.ticker), [assets]);
  const chosen = useMemo(() => assets.find((a) => a.ticker === values.asset) ?? null, [assets, values.asset]);
  const spotForChosenAsset = values.asset ? spotPrices[values.asset] ?? null : null;
  const spotAsOfForChosenAsset = values.asset ? spotAsOfMap?.[values.asset] ?? null : null;

  // Default the asset once markets load. Deep-link: /write?asset=NAME preselects
  // that asset when it exists in the live set (from the New-market success moment's
  // "Write first option"); otherwise first alphabetical. Seeds both modes.
  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (!tickers.length) return;
    const paramAsset = searchParams.get("asset");
    const desired = paramAsset && tickers.includes(paramAsset) ? paramAsset : tickers[0];
    if (!epochValues.asset || !tickers.includes(epochValues.asset)) {
      setEpochValues((v) => ({ ...v, asset: desired }));
    }
    if (!customValues.asset || !tickers.includes(customValues.asset)) {
      setCustomValues((v) => ({ ...v, asset: desired }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers.join(","), searchParams]);

  // ---- Equity/ETF: Epoch is structurally unwritable, so don't open on it ----
  //
  // Epoch expiries are Friday 08:00 UTC. NYSE opens 13:30 UTC (DST) / 14:30 UTC
  // (standard). An equity or ETF epoch vault therefore expires before its own
  // settlement venue has opened, on every Friday of the year — the market-hours
  // gate blocks the submit button 100% of the time. Landing on EPOCH for AAPL
  // presents a mode that can never be submitted and explains it only through a
  // disabled button's tooltip.
  //
  // So EPOCH is not the default for these classes. This is a DEFAULT, not a
  // prohibition: the switch fires once per newly-chosen asset (tracked by
  // ticker), so a user who deliberately selects EPOCH afterwards is left there,
  // with the gate and its now-explicit tooltip doing the explaining. Nothing
  // about expiry or settlement semantics changes here — this only picks which
  // mode the panel opens on.
  const chosenAssetClass = chosen ? Number(chosen.market.account.assetClass ?? 0) : null;
  const isNyseGated = chosenAssetClass === ASSET_CLASS_EQUITY || chosenAssetClass === ASSET_CLASS_ETF;
  const autoSwitchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!chosen || !isNyseGated) return;
    if (autoSwitchedFor.current === chosen.ticker) return;
    autoSwitchedFor.current = chosen.ticker;
    setMode((m) => (m === "epoch" ? "custom" : m));
  }, [chosen, isNyseGated]);

  const handleSuccess = (payload: WriteSuccessPayload) => {
    setLastSuccess(payload);
    refetchMarkets();
    // Mutation refresh — a landed epoch·American write posts a WriterAsk resting
    // order onto the shared book; reconcile so it reflects chain-fresh without a
    // manual reload. Reconcile-only (no optimistic BookOrder: sendCell doesn't
    // return one, and the legacy/Custom path posts no resting order at all).
    if (program && payload.kind === "epoch" && payload.cells.some((c) => c.status === "landed")) {
      refreshAfterMutation(program, {});
    }
  };

  const ctrl = useWriteController({
    mode,
    values,
    chosen,
    spotForChosenAsset,
    tenorMode,
    singleTenor,
    split,
    unseededTickers,
    warmupBlocks,
    checkVolOracle: volOracleStatus.checkWritable,
    onSuccess: handleSuccess,
  });

  const totalContracts = ctrl.cells.reduce((s, c) => s + c.contracts, 0);
  const isLadder = mode === "epoch" && tenorMode === "ladder";
  const primaryLabel = !connected
    ? "Connect wallet to write"
    : ctrl.submitting
      ? ctrl.stageLabel ?? "Writing…"
      : isLadder
        ? `Write ladder (${ctrl.cells.length} ${ctrl.cells.length === 1 ? "cell" : "cells"})`
        : "Write option";

  const noMarkets = assets.length === 0;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-l-bg font-sans text-l-text">
      <TerminalAppBar mode={surfaceMode} onToggleMode={toggle} />

      {lastSuccess && (
        <StatusBanner
          payload={lastSuccess}
          onDismiss={() => setLastSuccess(null)}
          onRetry={async () => {
            const failed: WriteCell[] = lastSuccess.cells
              .filter((c) => c.status === "failed")
              .map((c) => ({
                expiryTs: c.expiryTs,
                contracts: c.contracts,
                collateral: c.collateral,
                premiumPerContract: c.premiumPerContract,
                tenorLabels: c.tenorLabels,
              }));
            if (!failed.length) return;
            const retried = await lastSuccess.retryFailed(failed);
            if (retried) {
              const byExp = new Map(retried.map((r) => [r.expiryTs, r]));
              setLastSuccess({ ...lastSuccess, cells: lastSuccess.cells.map((c) => byExp.get(c.expiryTs) ?? c) });
              refetchMarkets();
            }
          }}
        />
      )}

      {/* Scroll body */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[1180px] px-[clamp(16px,3vw,40px)] py-[clamp(20px,4vh,44px)]">
          {noMarkets ? (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
              <p className="font-mono-plex text-[12px] text-l-muted">
                No markets registered yet — create one on Markets first.
              </p>
              <Link
                to="/markets"
                className="rounded-[6px] border border-l-hair px-[13px] py-[7px] font-mono-plex text-[11px] uppercase tracking-[0.12em] text-l-text transition-colors hover:bg-l-surface"
              >
                → Markets
              </Link>
            </div>
          ) : (
            <>
              {/* Says out loud why the panel opened on CUSTOM for this asset,
                  and why EPOCH stays blocked if the user switches back to it. */}
              {isNyseGated && (
                <div
                  data-testid="equity-epoch-notice"
                  className="mb-6 rounded-[6px] border border-l-hair bg-l-surface px-[12px] py-[9px] font-mono-plex text-[11px] leading-[1.5] text-l-muted"
                >
                  {values.asset} settles on NYSE — epoch expiries settle outside NYSE hours, so use a custom expiry.
                </div>
              )}

              <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-[1fr_380px]">
                <div className="lg:order-1">
                  <WriteContractPanel
                    mode={mode}
                    onModeChange={setMode}
                    values={values}
                    onValuesChange={setValues}
                    assets={tickers}
                    spotByTicker={spotPrices}
                    spotForChosenAsset={spotForChosenAsset}
                    spotAsOfForChosenAsset={spotAsOfForChosenAsset}
                    unseeded={unseededTickers}
                    tenorMode={tenorMode}
                    onTenorModeChange={setTenorMode}
                    singleTenor={singleTenor}
                    onSingleTenorChange={setSingleTenor}
                    split={split}
                    onSplitChange={setSplit}
                    minLeadSecs={ctrl.minLeadSecs}
                    collateralPerContract={ctrl.collateralPerContract}
                    totalCollateral={ctrl.totalCollateral}
                    marketHoursBlock={ctrl.marketHoursBlock}
                    volOracleBlock={ctrl.volOracleBlock}
                    americanQuoteBlock={ctrl.americanQuoteBlock}
                    ladderError={ctrl.ladderError}
                  />
                </div>

                {/* Premium centerpiece — on top on mobile, right rail on desktop */}
                <div className="order-first lg:order-2 lg:border-l lg:border-l-hair lg:pl-10">
                  <WritePremiumPanel
                    asset={values.asset}
                    side={values.side}
                    exerciseStyle={values.exerciseStyle}
                    market={chosen?.market ?? null}
                    strike={parseFloat(values.strike) || 0}
                    expiry={ctrl.activeExpiry}
                    contracts={totalContracts || parseInt(values.contracts || "0", 10) || 0}
                    spot={spotForChosenAsset}
                    spotStale={pricesStale}
                    isPlaceholder={!connected}
                    footnote={
                      mode === "epoch"
                        ? "Premium accrues into the vault as buyers fill — claimable on settlement."
                        : "Custom vaults settle on the same mechanics as epoch vaults — only the expiry differs."
                    }
                  />
                </div>
              </div>

              {isLadder && (
                <div className="mt-10 border-t border-l-hair pt-6">
                  <div className="mb-3 font-mono-plex text-[10px] uppercase tracking-[0.18em] text-l-muted">
                    Ladder · {ctrl.cells.length} {ctrl.cells.length === 1 ? "cell" : "cells"}
                  </div>
                  <WriteLadderTable cells={ctrl.cells} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Docked footer strip */}
      {!noMarkets && (
        <div className="flex flex-none items-center gap-4 border-t border-l-hair px-[clamp(16px,3vw,40px)] py-[11px]">
          <div className="font-mono-plex text-[11px] tabular-nums text-l-muted">
            Premium received{" "}
            <span className="text-l-text">{ctrl.totalPremium > 0 ? fmtUsd(ctrl.totalPremium) : "—"}</span> USDC
          </div>
          <button
            type="button"
            onClick={connected ? ctrl.submit : () => setVisible(true)}
            disabled={connected && (ctrl.submitting || !ctrl.canSubmit)}
            title={
              connected
                ? ctrl.ladderError ??
                  ctrl.americanQuoteBlock?.tooltip ??
                  ctrl.volOracleBlock?.tooltip ??
                  ctrl.marketHoursBlock?.tooltip ??
                  undefined
                : undefined
            }
            data-testid="write-primary"
            data-tour="write-submit"
            className="ml-auto inline-flex items-center justify-center rounded-[6px] bg-l-up px-[18px] py-[9px] font-sans text-[13px] font-medium text-l-on-up transition-opacity duration-300 ease-opta hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {primaryLabel}
          </button>
        </div>
      )}
    </div>
  );
};

// -----------------------------------------------------------------------------
// StatusBanner — submit outcome + per-cell rows + scoped retry (terminal).
// -----------------------------------------------------------------------------
const StatusBanner: FC<{
  payload: WriteSuccessPayload;
  onDismiss: () => void;
  onRetry: () => void;
}> = ({ payload, onDismiss, onRetry }) => {
  const landed = payload.cells.filter((c) => c.status === "landed").length;
  const failed = payload.cells.length - landed;
  return (
    <div className="flex-none border-b border-l-hair bg-l-surface px-[clamp(16px,3vw,40px)] py-3">
      <div className="mx-auto w-full max-w-[1180px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono-plex text-[11px] uppercase tracking-[0.16em] text-l-text">
            {payload.kind === "epoch" ? "Epoch" : "Custom"} write · {landed}/{payload.cells.length} landed
          </span>
          <div className="flex items-center gap-4">
            {failed > 0 && (
              <button
                type="button"
                onClick={onRetry}
                className="font-mono-plex text-[11px] uppercase tracking-[0.16em] text-l-down transition-opacity hover:opacity-70"
              >
                Retry {failed} failed
              </button>
            )}
            <Link
              to="/portfolio"
              className="font-mono-plex text-[11px] uppercase tracking-[0.16em] text-l-muted no-underline transition-colors hover:text-l-text"
            >
              Portfolio →
            </Link>
            <button
              type="button"
              onClick={onDismiss}
              className="font-mono-plex text-[11px] uppercase tracking-[0.16em] text-l-faint transition-colors hover:text-l-text"
            >
              Dismiss
            </button>
          </div>
        </div>
        <div className="mt-2 flex flex-col gap-1">
          {payload.cells.map((c) => (
            <div key={c.expiryTs} className="flex items-baseline justify-between gap-3 font-mono-plex text-[10.5px]">
              <span className="uppercase tracking-[0.14em] text-l-muted">
                {c.tenorLabels.join(" + ")} ·{" "}
                {new Date(c.expiryTs * 1000)
                  .toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })
                  .toUpperCase()}{" "}
                · {c.contracts}×
              </span>
              {c.status === "landed" ? (
                <span className="flex items-center gap-2 tabular-nums text-l-muted">
                  {c.txSignature && (
                    <>
                      <span>{c.txSignature.slice(0, 8)}…{c.txSignature.slice(-6)}</span>
                      <SolscanLink kind="tx" id={c.txSignature} label="transaction" />
                    </>
                  )}
                  {c.optionMint && <SolscanLink kind="token" id={c.optionMint} label="mint" />}
                  {c.vaultPda && <SolscanLink kind="account" id={c.vaultPda} label="vault" />}
                </span>
              ) : (
                <span className="uppercase tracking-[0.14em] text-l-down">{c.error ?? "Failed"}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default WriteTerminalPage;
