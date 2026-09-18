// =============================================================================
// useWriteController — terminal-surface write orchestration (Epoch + Custom).
// =============================================================================
//
// The terminal /write surface collapses the two paper sections (EpochVaultSection
// + CustomVaultSection) into ONE panel driven by an EPOCH|CUSTOM segmented
// control. This hook is the shared brain: for the ACTIVE mode it resolves the
// tenor/ladder cells, computes per-cell Black-Scholes premium, runs the three
// gates (market-hours, vol-oracle, American on-chain-quote freshness), and owns
// handleSubmit.
//
// ZERO transaction-logic change: cell building + premium math are copied
// verbatim from the paper sections, and submit calls the SAME useWriteSubmit
// engine (atomic bundle, sentinel, epoch_config handling, sequential retry — all
// untouched). This file only restructures WHERE that logic lives so the terminal
// panels can consume it. The paper sections remain the byte-identical fallback
// behind WRITE_TERMINAL_UI.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../../hooks/useProgram";
import { deriveEpochConfig } from "../../../hooks/useAccounts";
import { showToast } from "../../../components/Toast";
import { useOptionPriceQuoteFreshness } from "../../../hooks/useOptionPriceQuoteFreshness";
import { VOL_ORACLE_EXPECTED_WAIT } from "../../../hooks/useVolOracleStatus";
import {
  applyVolSmile,
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../../utils/blackScholes";
import { requiredCollateralPerContract } from "../../../utils/collateral";
import { decodeError } from "../../../utils/errorDecoder";
import {
  isMarketHours,
  buildMarketClosedTooltip,
  type AssetClass,
} from "../../../utils/marketHours";
import { tenorExpiry, snapLadder, type TenorLabel } from "../../../utils/tenors";
import {
  useWriteSubmit,
  type WriteCell,
  type WriteSuccessPayload,
} from "../useWriteSubmit";
import type { WriterFormValues, AssetOption } from "../WriterForm";

export const ALL_TENORS: TenorLabel[] = ["Weekly", "Monthly", "Quarterly"];

export type TenorMode = "single" | "ladder";
export type WriteMode = "epoch" | "custom";

/** One resolved, premium-priced cell for the ladder table + submit. */
export type PreviewCell = {
  expiryTs: number;
  tenorLabels: string[];
  contracts: number;
  collateral: number;
  /** Per-contract Black-Scholes premium (or Advanced flat override). */
  premiumPerContract: number;
  /** Allocation share of this cell (sum of the merged tenors' %). 100 for single/custom. */
  pct: number;
};

type Gate = { tooltip: string } | null;

export type WriteController = {
  /** Resolved cells (1 for single/custom, N for ladder). */
  cells: PreviewCell[];
  /** Front (earliest) resolved expiry — drives the premium panel + gates. */
  activeExpiry: number | null;
  collateralPerContract: number;
  /** Live epoch min-lead window (seconds) — the dated tenor chips roll past it. */
  minLeadSecs: number;
  totalCollateral: number;
  /** Sum of per-cell (premium × contracts) — the Black-Scholes "premium received". */
  totalPremium: number;
  /** Blocking form error (ladder %≠100, N<#tenors, etc.). */
  ladderError: string | null;
  marketHoursBlock: Gate;
  volOracleBlock: Gate;
  americanQuoteBlock: Gate;
  /** True iff every required field is populated (asset, strike, contracts, expiry). */
  fieldsReady: boolean;
  /** True iff submit is allowed right now (fieldsReady && no blocking gate). */
  canSubmit: boolean;
  submitting: boolean;
  stageLabel: string | null;
  submit: () => Promise<void>;
  retry: (failed: WriteCell[]) => Promise<import("../useWriteSubmit").CellResult[] | null>;
};

type ControllerInput = {
  mode: WriteMode;
  values: WriterFormValues;
  chosen: AssetOption | null;
  spotForChosenAsset: number | null;
  /** Epoch-only tenor state (ignored in custom mode). */
  tenorMode: TenorMode;
  singleTenor: TenorLabel;
  split: Record<TenorLabel, number>;
  unseededTickers: ReadonlySet<string>;
  /** Plug wave 1: ticker -> reason for source-2 markets whose vol ring is still warming. */
  warmupBlocks: ReadonlyMap<string, string>;
  /** Fresh chain read at submit: null = writable now, string = why not. */
  checkVolOracle: (feedIdHex: string) => Promise<string | null>;
  onSuccess: (payload: WriteSuccessPayload) => void;
};

export function useWriteController(input: ControllerInput): WriteController {
  const {
    mode,
    values,
    chosen,
    spotForChosenAsset,
    tenorMode,
    singleTenor,
    split,
    unseededTickers,
    warmupBlocks,
    checkVolOracle,
    onSuccess,
  } = input;

  const { connected } = useWallet();
  const { program } = useProgram();
  const { submitting, stageLabel, submit: rawSubmit, retry } = useWriteSubmit();

  const strikeNum = parseFloat(values.strike) || 0;
  const contractsNum = parseInt(values.contracts || "0", 10) || 0;
  const collateralPerContract = requiredCollateralPerContract(strikeNum, values.side);

  // ---- Live epoch min-duration window (EpochConfig.min_epoch_duration_days) ----
  // Slots inside `now + minLeadSecs` are rejected on-chain (6021); the tenor math
  // rolls forward past it. 1-day fallback while loading. (Epoch mode only.)
  const [minEpochDays, setMinEpochDays] = useState<number | null>(null);
  useEffect(() => {
    if (!program) return;
    let live = true;
    (async () => {
      try {
        const [epochConfigPda] = deriveEpochConfig();
        const ec: any = await (program.account as any).epochConfig.fetch(epochConfigPda);
        if (live) setMinEpochDays(Number(ec.minEpochDurationDays));
      } catch {
        /* leave null → conservative 1-day fallback */
      }
    })();
    return () => {
      live = false;
    };
  }, [program]);
  const minLeadSecs = (minEpochDays ?? 1) * 86400;

  const splitTotal = split.Weekly + split.Monthly + split.Quarterly;

  // ---- Baseline IV for per-cell BS premium (smile-adjusted for the strike) ----
  const baselineIv = useMemo(() => {
    if (!chosen) return 0.8;
    const spot = spotForChosenAsset ?? 0;
    return spot > 0
      ? applyVolSmile(getDefaultVolatility(chosen.ticker), spot, strikeNum, chosen.ticker)
      : getDefaultVolatility(chosen.ticker);
  }, [chosen, spotForChosenAsset, strikeNum]);

  // Per-cell premium: Advanced flat override (if valid + positive), else BS on the
  // cell's own time-to-expiry. Identical math to the paper sections' handleSubmit.
  const premiumForExpiry = useMemo(() => {
    const overrideStr = values.premiumPerContract.trim();
    const overrideNum = overrideStr ? parseFloat(overrideStr) : NaN;
    const useOverride = !isNaN(overrideNum) && overrideNum > 0;
    const spot = spotForChosenAsset ?? 0;
    return (expiryTs: number): number => {
      if (useOverride) return overrideNum;
      const days = Math.max(0, (expiryTs - Date.now() / 1000) / 86400);
      if (!(spot > 0) || !(days > 0)) return 0;
      return values.side === "call"
        ? calculateCallPremium(spot, strikeNum, days, baselineIv)
        : calculatePutPremium(spot, strikeNum, days, baselineIv);
    };
  }, [values.premiumPerContract, values.side, spotForChosenAsset, strikeNum, baselineIv]);

  // ---- Resolve cells (mode-branched) ----
  const { cells, ladderError, activeExpiry } = useMemo(() => {
    if (mode === "custom") {
      if (values.expiry == null || strikeNum <= 0 || contractsNum <= 0) {
        return { cells: [] as PreviewCell[], ladderError: null, activeExpiry: values.expiry ?? null };
      }
      const cell: PreviewCell = {
        expiryTs: values.expiry,
        tenorLabels: ["Custom"],
        contracts: contractsNum,
        collateral: collateralPerContract * contractsNum,
        premiumPerContract: Math.max(premiumForExpiry(values.expiry), 0.000001),
        pct: 100,
      };
      return { cells: [cell], ladderError: null, activeExpiry: values.expiry };
    }

    // Epoch: resolve tenors → snapped, collision-merged whole-contract cells.
    const now = Date.now();
    const tenors =
      tenorMode === "single"
        ? [{ label: singleTenor, pct: 100, expiryTs: tenorExpiry(singleTenor, now, minLeadSecs) }]
        : ALL_TENORS.filter((t) => split[t] > 0).map((t) => ({
            label: t,
            pct: split[t],
            expiryTs: tenorExpiry(t, now, minLeadSecs),
          }));
    const snapped = snapLadder(contractsNum, tenors, collateralPerContract);
    const front =
      tenorMode === "single"
        ? tenorExpiry(singleTenor, now, minLeadSecs)
        : (() => {
            const sel = ALL_TENORS.filter((t) => split[t] > 0).map((t) => tenorExpiry(t, now, minLeadSecs));
            return sel.length ? Math.min(...sel) : tenorExpiry("Weekly", now, minLeadSecs);
          })();
    const err =
      snapped.error ??
      (tenorMode === "ladder" && splitTotal !== 100 ? "Percentages must sum to 100." : null);
    const previewCells: PreviewCell[] = (snapped.cells ?? []).map((c) => ({
      expiryTs: c.expiryTs,
      tenorLabels: c.tenorLabels,
      contracts: c.contracts,
      collateral: c.collateral,
      premiumPerContract: Math.max(premiumForExpiry(c.expiryTs), 0.000001),
      pct:
        tenorMode === "single"
          ? 100
          : c.tenorLabels.reduce((s, l) => s + (split[l as TenorLabel] ?? 0), 0),
    }));
    return { cells: previewCells, ladderError: err, activeExpiry: front };
  }, [
    mode,
    values.expiry,
    strikeNum,
    contractsNum,
    collateralPerContract,
    premiumForExpiry,
    tenorMode,
    singleTenor,
    split,
    splitTotal,
    minLeadSecs,
  ]);

  const totalCollateral = cells.reduce((s, c) => s + c.collateral, 0);
  const totalPremium = cells.reduce((s, c) => s + c.premiumPerContract * c.contracts, 0);

  // ---- Gates (share the paper sections' logic verbatim) ----
  const marketHoursBlock = useMemo<Gate>(() => {
    if (!chosen || activeExpiry == null) return null;
    const assetClass = chosen.market.account.assetClass as AssetClass;
    const result = isMarketHours(activeExpiry, assetClass);
    if (result.ok) return null;
    return { tooltip: buildMarketClosedTooltip(result, Math.floor(Date.now() / 1000)) };
  }, [chosen, activeExpiry]);

  const volOracleBlock = useMemo<Gate>(() => {
    if (!chosen) return null;
    const warming = warmupBlocks.get(chosen.ticker);
    if (warming) return { tooltip: warming };
    if (!unseededTickers.has(chosen.ticker)) return null;
    return {
      tooltip: `Pricing for ${chosen.ticker} is still warming up — this takes ${VOL_ORACLE_EXPECTED_WAIT} after a market is created. This unblocks itself; no need to reload.`,
    };
  }, [chosen, unseededTickers, warmupBlocks]);

  // H-05 American on-chain quote freshness — expiry-independent verdict, so the
  // front/single expiry validates the whole write. Same authority as Trade.
  const amerEnabled =
    values.exerciseStyle === "american" &&
    connected &&
    !!chosen &&
    strikeNum > 0 &&
    activeExpiry != null;
  const { isFresh: amerFresh, statusReason: amerReason } = useOptionPriceQuoteFreshness(
    amerEnabled,
    chosen
      ? {
          publicKey: chosen.market.publicKey,
          account: { pythFeedId: chosen.market.account.pythFeedId },
        }
      : null,
    amerEnabled && activeExpiry != null
      ? {
          strike: strikeNum,
          expiryTs: activeExpiry,
          side: values.side,
          exerciseStyle: "american" as const,
          carryRateBps: Number(chosen?.market.account.carryRateBps ?? 0),
        }
      : null,
  );
  const americanQuoteBlock = useMemo<Gate>(() => {
    if (values.exerciseStyle !== "american") return null;
    if (!chosen || strikeNum <= 0 || activeExpiry == null) return null;
    if (amerFresh) return null;
    return { tooltip: amerReason ?? "Awaiting a fresh on-chain quote for this American option." };
  }, [values.exerciseStyle, chosen, strikeNum, activeExpiry, amerFresh, amerReason]);

  const fieldsReady =
    !!chosen &&
    strikeNum > 0 &&
    contractsNum > 0 &&
    activeExpiry != null &&
    (mode === "epoch" || activeExpiry > Math.floor(Date.now() / 1000));

  const canSubmit =
    fieldsReady &&
    !ladderError &&
    cells.length > 0 &&
    marketHoursBlock === null &&
    volOracleBlock === null &&
    americanQuoteBlock === null;

  const submit = async () => {
    if (!chosen || !canSubmit) return;
    try {
      // Submit-click pre-flight — re-check the oracle against the chain right now
      // (the crank may have seeded it since the last scan).
      const feedIdHex = Buffer.from(chosen.market.account.pythFeedId as number[]).toString("hex");
      const notWritable = await checkVolOracle(feedIdHex);
      if (notWritable) throw new Error(notWritable);

      const writeCells: WriteCell[] = cells.map((c) => ({
        expiryTs: c.expiryTs,
        contracts: c.contracts,
        collateral: c.collateral,
        premiumPerContract: c.premiumPerContract,
        tenorLabels: c.tenorLabels,
      }));

      const base = {
        market: chosen.market,
        side: values.side,
        exerciseStyle: values.exerciseStyle,
        strike: strikeNum,
        vaultType: mode,
      };

      const results = await rawSubmit({ ...base, cells: writeCells });
      if (results) {
        const landed = results.filter((r) => r.status === "landed").length;
        const failed = results.length - landed;
        showToast({
          type: failed === 0 ? "success" : landed ? "info" : "error",
          title:
            failed === 0
              ? mode === "epoch"
                ? "Epoch write confirmed"
                : "Custom vault written"
              : landed
                ? `Wrote ${landed}/${results.length} tenors`
                : "Write failed",
          message: `${chosen.ticker} ${values.side.toUpperCase()} · ${landed} landed${
            failed ? `, ${failed} failed` : ""
          }`,
          txSignature: results[0]?.txSignature,
        });
        onSuccess({
          kind: mode,
          cells: results,
          retryFailed: (failedCells: WriteCell[]) => retry({ ...base, cells: failedCells }),
        });
      }
    } catch (err: any) {
      showToast({ type: "error", title: "Write failed", message: decodeError(err) });
    }
  };

  return {
    cells,
    activeExpiry,
    collateralPerContract,
    minLeadSecs,
    totalCollateral,
    totalPremium,
    ladderError,
    marketHoursBlock,
    volOracleBlock,
    americanQuoteBlock,
    fieldsReady,
    canSubmit,
    submitting,
    stageLabel,
    submit,
    retry: (failed: WriteCell[]) =>
      retry({
        market: chosen!.market,
        side: values.side,
        exerciseStyle: values.exerciseStyle,
        strike: strikeNum,
        vaultType: mode,
        cells: failed,
      }),
  };
}
