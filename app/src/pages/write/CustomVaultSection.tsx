import type { FC } from "react";
import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { SectionNumber } from "../../components/layout";
import { showToast } from "../../components/Toast";
import { WriterForm, type WriterFormValues, type AssetOption } from "./WriterForm";
import { LiveQuoteCard } from "./LiveQuoteCard";
import { useOptionPriceQuoteFreshness } from "../../hooks/useOptionPriceQuoteFreshness";
import {
  applyVolSmile,
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { requiredCollateralPerContract } from "../../utils/collateral";
import {
  useWriteSubmit,
  type WriteCell,
  type WriteSuccessPayload,
} from "./useWriteSubmit";
import { decodeError } from "../../utils/errorDecoder";
import {
  isMarketHours,
  buildMarketClosedTooltip,
  type AssetClass,
} from "../../utils/marketHours";

type CustomVaultSectionProps = {
  values: WriterFormValues;
  onChange: (next: WriterFormValues) => void;
  assets: AssetOption[];
  spotForChosenAsset: number | null;
  spotStale: boolean;
  onSuccess: (payload: WriteSuccessPayload) => void;
  /** W1 vol-oracle gate: tickers whose VolOracle PDA is missing on chain.
   *  Drives the asset-chip "oracle pending" badge in WriterForm and the
   *  inline form-level block when the chosen ticker is unseeded. */
  unseededTickers: ReadonlySet<string>;
  /** Submit-click pre-flight that re-checks the chosen asset's oracle PDA
   *  against the chain — catches the race where the crank just seeded it
   *  but the cache hasn't refreshed. Returns true iff oracle exists now. */
  /** Plug wave 1: ticker -> reason for source-2 markets whose vol ring is still warming. */
  warmupBlocks: ReadonlyMap<string, string>;
  /** Fresh chain read at submit: null = writable now, string = why not. */
  checkVolOracle: (feedIdHex: string) => Promise<string | null>;
};

/**
 * § 02 · Custom vault section. Same form shape as Epoch but with the
 * ExpiryPicker tail (preset row + date+time inputs). Always a single cell
 * (arbitrary, possibly non-Friday expiry) — no tenor/ladder controls.
 */
export const CustomVaultSection: FC<CustomVaultSectionProps> = ({
  values,
  onChange,
  assets,
  spotForChosenAsset,
  spotStale,
  onSuccess,
  unseededTickers,
  warmupBlocks,
  checkVolOracle,
}) => {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { submitting, stageLabel, submit, retry } = useWriteSubmit();

  const contractsNum = parseInt(values.contracts || "0", 10) || 0;
  const strikeNum = parseFloat(values.strike) || 0;

  const chosen = useMemo(
    () => assets.find((a) => a.ticker === values.asset) ?? null,
    [assets, values.asset],
  );

  // W3 market-hours gate. Equity (2) and ETF (4) expiries outside NYSE
  // regular session would produce un-settleable vaults (Pyth equity feeds
  // only publish during market hours). Tooltip surfaces the next valid
  // session + delta from now; W3 refinement (2) keeps the user from
  // silently shifting forward without seeing the time gap.
  const marketHoursBlock = useMemo<{ tooltip: string } | null>(() => {
    if (!chosen || values.expiry == null) return null;
    const assetClass = chosen.market.account.assetClass as AssetClass;
    const result = isMarketHours(values.expiry, assetClass);
    if (result.ok) return null;
    return {
      tooltip: buildMarketClosedTooltip(result, Math.floor(Date.now() / 1000)),
    };
  }, [chosen, values.expiry]);

  // W1 vol-oracle gate. The chosen asset's VolOracle PDA must be seeded
  // on chain — otherwise mint_from_vault reverts with Anchor 3007.
  const volOracleBlock = useMemo<{ tooltip: string } | null>(() => {
    if (!chosen) return null;
    const warming = warmupBlocks.get(chosen.ticker);
    if (warming) return { tooltip: warming };
    if (!unseededTickers.has(chosen.ticker)) return null;
    return {
      tooltip: `Vol oracle for ${chosen.ticker} not yet seeded. New markets need ~1 hour for the oracle crank to initialize the oracle. Try again later, or contact support if this persists past 24 hours.`,
    };
  }, [chosen, unseededTickers, warmupBlocks]);

  // H-05: American writes require a FRESH on-chain quote (vol oracle warm +
  // not-stale + initialized). The freshness verdict is expiry-independent, so
  // the single chosen expiry validates it. Uses the exact same authority the
  // Trade-side gate uses (useOptionPriceQuoteFreshness → quoteFreshness).
  const amerEnabled =
    values.exerciseStyle === "american" && connected && !!chosen && strikeNum > 0 && values.expiry != null;
  const { isFresh: amerFresh, statusReason: amerReason } = useOptionPriceQuoteFreshness(
    amerEnabled,
    chosen ? { publicKey: chosen.market.publicKey, account: { pythFeedId: chosen.market.account.pythFeedId } } : null,
    amerEnabled && values.expiry != null
      ? {
          strike: strikeNum,
          expiryTs: values.expiry,
          side: values.side,
          exerciseStyle: "american" as const,
          carryRateBps: Number(chosen?.market.account.carryRateBps ?? 0),
        }
      : null,
  );
  const americanQuoteBlock = useMemo<{ tooltip: string } | null>(() => {
    if (values.exerciseStyle !== "american") return null;
    // Only gate once the terms needed to quote exist; fieldsReady handles the rest.
    if (!chosen || strikeNum <= 0 || values.expiry == null) return null;
    if (amerFresh) return null;
    return { tooltip: amerReason ?? "Awaiting a fresh on-chain quote for this American option." };
  }, [values.exerciseStyle, chosen, strikeNum, values.expiry, amerFresh, amerReason]);

  const handleSubmit = async () => {
    if (!chosen || strikeNum <= 0 || contractsNum <= 0 || values.expiry == null) return;
    try {
      // W1 submit-click pre-flight. Even if the cache says "unseeded,"
      // re-check the chain right now — the crank may have seeded the
      // oracle since the last scan. If still missing, refuse with a
      // friendly toast rather than letting the mint revert with 3007 mid-flight.
      const feedIdHex = Buffer.from(chosen.market.account.pythFeedId as number[]).toString("hex");
      const notWritable = await checkVolOracle(feedIdHex);
      if (notWritable) throw new Error(notWritable);

      // MED-6: prefer Advanced-mode override if writer provided a valid
      // positive value. Empty string or invalid input falls back to the
      // Black-Scholes-derived default for this expiry.
      const overrideStr = values.premiumPerContract.trim();
      const overrideNum = overrideStr ? parseFloat(overrideStr) : NaN;
      const useOverride = !isNaN(overrideNum) && overrideNum > 0;

      const spot = spotForChosenAsset ?? 0;
      const baselineIv =
        spot > 0
          ? applyVolSmile(getDefaultVolatility(chosen.ticker), spot, strikeNum, chosen.ticker)
          : getDefaultVolatility(chosen.ticker);
      const days = Math.max(0, (values.expiry - Date.now() / 1000) / 86400);
      const bsPremium =
        spot > 0 && days > 0
          ? values.side === "call"
            ? calculateCallPremium(spot, strikeNum, days, baselineIv)
            : calculatePutPremium(spot, strikeNum, days, baselineIv)
          : 0;
      const premiumPerContract = useOverride ? overrideNum : bsPremium;
      const collateralPerContract = requiredCollateralPerContract(strikeNum, values.side);
      const collateral = collateralPerContract * contractsNum;

      const base = {
        market: chosen.market,
        side: values.side,
        exerciseStyle: values.exerciseStyle,
        strike: strikeNum,
        vaultType: "custom" as const,
      };
      // Custom is always a single cell (one arbitrary expiry).
      const cells: WriteCell[] = [
        {
          expiryTs: values.expiry,
          contracts: contractsNum,
          collateral,
          premiumPerContract: Math.max(premiumPerContract, 0.000001),
          tenorLabels: ["Custom"],
        },
      ];

      const results = await submit({ ...base, cells });
      if (results) {
        const landed = results.filter((r) => r.status === "landed").length;
        showToast({
          type: landed ? "success" : "error",
          title: landed ? "Custom vault written" : "Write failed",
          message: `${contractsNum} ${chosen.ticker} ${values.side.toUpperCase()} contracts`,
          txSignature: results[0]?.txSignature,
        });
        onSuccess({
          kind: "custom",
          cells: results,
          retryFailed: (failedCells: WriteCell[]) => retry({ ...base, cells: failedCells }),
        });
      }
    } catch (err: any) {
      const msg = decodeError(err);
      showToast({
        type: "error",
        title: "Write failed",
        message: msg,
      });
    }
  };

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-6 mb-8">
        <SectionNumber number="02" label="Custom vault" />
        <p className="m-0 max-w-[420px] font-sans italic font-normal leading-[1.5] opacity-75 text-[14px]">
          Pick any expiry. The mint is derived from your terms; if it
          matches an existing market, your collateral joins that vault.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-x-12 gap-y-10">
        <WriterForm
          mode="custom"
          values={values}
          onChange={onChange}
          assets={assets}
          spotForChosenAsset={spotForChosenAsset}
          connected={connected}
          submitting={submitting}
          stageLabel={stageLabel}
          onSubmit={handleSubmit}
          onConnectClick={() => setVisible(true)}
          marketHoursBlock={marketHoursBlock}
          volOracleBlock={volOracleBlock}
          unseededTickers={unseededTickers}
          americanQuoteBlock={americanQuoteBlock}
        />
        <LiveQuoteCard
          asset={values.asset}
          side={values.side}
          exerciseStyle={values.exerciseStyle}
          market={chosen?.market ?? null}
          strike={strikeNum}
          expiry={values.expiry}
          contracts={contractsNum}
          spot={spotForChosenAsset}
          spotStale={spotStale}
          isPlaceholder={!connected}
          footnote="Custom vaults inherit the same settlement mechanics as epoch vaults — the only difference is the expiry timestamp."
        />
      </div>
    </section>
  );
};

export default CustomVaultSection;
