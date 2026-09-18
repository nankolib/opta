import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useProgram } from "../../hooks/useProgram";
import { deriveEpochConfig } from "../../hooks/useAccounts";
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
import { tenorExpiry, snapLadder, type TenorLabel } from "../../utils/tenors";

const ALL_TENORS: TenorLabel[] = ["Weekly", "Monthly", "Quarterly"];

type EpochVaultSectionProps = {
  values: WriterFormValues;
  onChange: (next: WriterFormValues) => void;
  assets: AssetOption[];
  spotForChosenAsset: number | null;
  spotStale: boolean;
  /** Called on (partial) success so the page can render its banner + retry. */
  onSuccess: (payload: WriteSuccessPayload) => void;
  /** W1 vol-oracle gate inputs. See CustomVaultSection for full notes. */
  unseededTickers: ReadonlySet<string>;
  /** Plug wave 1: ticker -> reason for source-2 markets whose vol ring is still warming. */
  warmupBlocks: ReadonlyMap<string, string>;
  /** Fresh chain read at submit: null = writable now, string = why not. */
  checkVolOracle: (feedIdHex: string) => Promise<string | null>;
};

/**
 * § 01 · Epoch vault section. Adds a tenor selector (Weekly/Monthly/Quarterly)
 * and a ladder mode (% split across tenors). Every tenor resolves to a Friday
 * 08:00 UTC expiry — a valid Epoch expiry on-chain. Single-tenor is the
 * degenerate 1-cell ladder; ladder fans out into N sequential atomic writes.
 */
export const EpochVaultSection: FC<EpochVaultSectionProps> = ({
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
  const { program } = useProgram();
  const { submitting, stageLabel, submit, retry } = useWriteSubmit();

  // Live epoch min-duration window (EpochConfig.min_epoch_duration_days). Slots
  // inside `now + minLeadSecs` are rejected on-chain (6021 InvalidEpochExpiry),
  // so the tenor math rolls forward past it. 1-day fallback while loading (the
  // on-chain default) so we never briefly offer a too-soon slot.
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
        /* leave null → conservative 1-day fallback below */
      }
    })();
    return () => { live = false; };
  }, [program]);
  const minLeadSecs = (minEpochDays ?? 1) * 86400;

  const contractsNum = parseInt(values.contracts || "0", 10) || 0;
  const strikeNum = parseFloat(values.strike) || 0;

  // ---- Tenor / ladder local state (Epoch-only; not in the shared form type) ----
  const [tenorMode, setTenorMode] = useState<"single" | "ladder">("single");
  const [singleTenor, setSingleTenor] = useState<TenorLabel>("Weekly");
  const [split, setSplit] = useState<Record<TenorLabel, number>>({
    Weekly: 50,
    Monthly: 30,
    Quarterly: 20,
  });
  const splitTotal = split.Weekly + split.Monthly + split.Quarterly;

  const chosen = useMemo(
    () => assets.find((a) => a.ticker === values.asset) ?? null,
    [assets, values.asset],
  );

  const collateralPerContract = requiredCollateralPerContract(strikeNum, values.side);

  // Resolve tenors -> snapped, collision-merged cells (post-snap whole contracts).
  const ladderResult = useMemo(() => {
    const now = Date.now();
    const tenors =
      tenorMode === "single"
        ? [{ label: singleTenor, pct: 100, expiryTs: tenorExpiry(singleTenor, now, minLeadSecs) }]
        : ALL_TENORS.filter((t) => split[t] > 0).map((t) => ({
            label: t,
            pct: split[t],
            expiryTs: tenorExpiry(t, now, minLeadSecs),
          }));
    return snapLadder(contractsNum, tenors, collateralPerContract);
  }, [tenorMode, singleTenor, split, contractsNum, collateralPerContract, minLeadSecs]);

  const cells = ladderResult.cells ?? [];
  const ladderError =
    ladderResult.error ??
    (tenorMode === "ladder" && splitTotal !== 100 ? "Percentages must sum to 100." : null);
  const totalCollateral = cells.reduce((s, c) => s + c.collateral, 0);

  // Front (earliest) resolved expiry — drives the market-hours gate + LiveQuoteCard.
  const frontExpiryTs = useMemo(() => {
    const now = Date.now();
    if (tenorMode === "single") return tenorExpiry(singleTenor, now, minLeadSecs);
    const sel = ALL_TENORS.filter((t) => split[t] > 0).map((t) => tenorExpiry(t, now, minLeadSecs));
    return sel.length ? Math.min(...sel) : tenorExpiry("Weekly", now, minLeadSecs);
  }, [tenorMode, singleTenor, split, minLeadSecs]);

  // W3 market-hours gate. Epoch expiries are Friday 08:00 UTC — always before
  // NYSE opens — so equity/ETF Epoch vaults are structurally un-settleable. All
  // cells share that property; the front expiry is representative.
  const marketHoursBlock = useMemo<{ tooltip: string } | null>(() => {
    if (!chosen) return null;
    const assetClass = chosen.market.account.assetClass as AssetClass;
    const result = isMarketHours(frontExpiryTs, assetClass);
    if (result.ok) return null;
    return { tooltip: buildMarketClosedTooltip(result, Math.floor(Date.now() / 1000)) };
  }, [chosen, frontExpiryTs]);

  // W1 vol-oracle gate. See CustomVaultSection for full notes.
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
  // not-stale + initialized) — expiry-independent, so the front (earliest)
  // ladder expiry validates the whole write. Same shared authority as Trade.
  const amerEnabled = values.exerciseStyle === "american" && connected && !!chosen && strikeNum > 0;
  const { isFresh: amerFresh, statusReason: amerReason } = useOptionPriceQuoteFreshness(
    amerEnabled,
    chosen ? { publicKey: chosen.market.publicKey, account: { pythFeedId: chosen.market.account.pythFeedId } } : null,
    amerEnabled
      ? {
          strike: strikeNum,
          expiryTs: frontExpiryTs,
          side: values.side,
          exerciseStyle: "american" as const,
          carryRateBps: Number(chosen?.market.account.carryRateBps ?? 0),
        }
      : null,
  );
  const americanQuoteBlock = useMemo<{ tooltip: string } | null>(() => {
    if (values.exerciseStyle !== "american") return null;
    if (!chosen || strikeNum <= 0) return null;
    if (amerFresh) return null;
    return { tooltip: amerReason ?? "Awaiting a fresh on-chain quote for this American option." };
  }, [values.exerciseStyle, chosen, strikeNum, amerFresh, amerReason]);

  const handleSubmit = async () => {
    if (!chosen || strikeNum <= 0 || contractsNum <= 0 || ladderError || cells.length === 0) return;
    try {
      // W1 submit-click pre-flight — see CustomVaultSection for full notes.
      const feedIdHex = Buffer.from(chosen.market.account.pythFeedId as number[]).toString("hex");
      const notWritable = await checkVolOracle(feedIdHex);
      if (notWritable) throw new Error(notWritable);

      // MED-6: prefer Advanced-mode override if valid + positive. Otherwise the
      // Black-Scholes default — recomputed PER CELL on each cell's expiry below.
      const overrideStr = values.premiumPerContract.trim();
      const overrideNum = overrideStr ? parseFloat(overrideStr) : NaN;
      const useOverride = !isNaN(overrideNum) && overrideNum > 0;

      const spot = spotForChosenAsset ?? 0;
      const baselineIv =
        spot > 0
          ? applyVolSmile(getDefaultVolatility(chosen.ticker), spot, strikeNum, chosen.ticker)
          : getDefaultVolatility(chosen.ticker);

      // ---- PER-CELL premium (keyed on each cell's expiryTs) ----
      const writeCells: WriteCell[] = cells.map((c) => {
        let premium: number;
        if (useOverride) {
          premium = overrideNum; // flat ask — honor across all cells as-is
        } else {
          const days = Math.max(0, (c.expiryTs - Date.now() / 1000) / 86400);
          premium =
            spot > 0 && days > 0
              ? values.side === "call"
                ? calculateCallPremium(spot, strikeNum, days, baselineIv)
                : calculatePutPremium(spot, strikeNum, days, baselineIv)
              : 0;
        }
        return {
          expiryTs: c.expiryTs,
          contracts: c.contracts,
          collateral: c.collateral,
          premiumPerContract: Math.max(premium, 0.000001),
          tenorLabels: c.tenorLabels,
        };
      });

      const base = {
        market: chosen.market,
        side: values.side,
        exerciseStyle: values.exerciseStyle,
        strike: strikeNum,
        vaultType: "epoch" as const,
      };

      const results = await submit({ ...base, cells: writeCells });
      if (results) {
        const landed = results.filter((r) => r.status === "landed").length;
        const failed = results.length - landed;
        showToast({
          type: failed === 0 ? "success" : "info",
          title: failed === 0 ? "Epoch write confirmed" : `Wrote ${landed}/${results.length} tenors`,
          message: `${chosen.ticker} ${values.side.toUpperCase()} · ${landed} landed${
            failed ? `, ${failed} failed` : ""
          }`,
        });
        onSuccess({
          kind: "epoch",
          cells: results,
          retryFailed: (failedCells: WriteCell[]) => retry({ ...base, cells: failedCells }),
        });
      }
    } catch (err: any) {
      showToast({ type: "error", title: "Write failed", message: decodeError(err) });
    }
  };

  // ---- Tenor selector + ladder controls + pre-sign preview (Epoch slot) ----
  const expirySlot = (
    <div className="space-y-3">
      <div className="font-mono font-medium text-[10.5px] uppercase tracking-[0.2em] text-ink-muted">
        Tenor
      </div>
      <div className="flex gap-2">
        <Pill active={tenorMode === "single"} onClick={() => setTenorMode("single")}>
          Single
        </Pill>
        <Pill active={tenorMode === "ladder"} onClick={() => setTenorMode("ladder")}>
          Ladder
        </Pill>
      </div>

      {tenorMode === "single" ? (
        <div className="flex gap-2">
          {ALL_TENORS.map((t) => (
            <Pill key={t} active={singleTenor === t} onClick={() => setSingleTenor(t)}>
              {t}
            </Pill>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {ALL_TENORS.map((t) => (
            <div key={t} className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-muted">
                {t}
              </span>
              <div className="flex items-center gap-1">
                <input
                  type="text"
            inputMode="decimal"
                  min="0"
                  max="100"
                  value={split[t]}
                  onChange={(e) =>
                    setSplit((s) => ({ ...s, [t]: Math.max(0, parseInt(e.target.value || "0", 10) || 0) }))
                  }
                  className="w-16 bg-paper-2 border border-rule rounded-sm px-2 py-1 font-mono text-[14px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
                />
                <span className="font-mono text-[11px] text-ink-muted">%</span>
              </div>
            </div>
          ))}
          <div
            className={`font-mono font-medium text-[10px] uppercase tracking-[0.18em] ${
              splitTotal === 100 ? "text-ink-muted" : "text-crimson"
            }`}
          >
            Total {splitTotal}%{splitTotal === 100 ? "" : " · must equal 100"}
          </div>
        </div>
      )}

      {/* Pre-sign preview */}
      <div className="border border-rule-soft rounded-sm p-3 space-y-1">
        {ladderError ? (
          <div className="font-sans italic font-medium leading-[1.5] text-crimson text-[12.5px]">
            {ladderError}
          </div>
        ) : (
          <>
            {cells.map((c) => (
              <div
                key={c.expiryTs}
                className="flex items-baseline justify-between gap-3 font-mono text-[11.5px] text-ink"
              >
                <span className="text-ink-muted">
                  {c.tenorLabels.join(" + ")} · {fmtDate(c.expiryTs)}
                </span>
                <span>
                  {c.contracts} × ${strikeNum.toLocaleString()} = ${c.collateral.toLocaleString()}
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-t border-rule-soft pt-1 mt-1 font-mono text-[11.5px] text-ink">
              <span className="text-ink-muted">Collateral locked as your ask</span>
              <span>${totalCollateral.toLocaleString()}</span>
            </div>
            {values.exerciseStyle === "american" && (
              <p className="font-sans italic font-normal leading-[1.5] opacity-70 text-[11px] pt-1">
                Posts as a resting sell on the shared series — refunded in full if you cancel (Open Orders
                on the Trade page), released when a buyer fills. First write per strike/expiry also pays a
                one-time ~0.02 SOL rent to create the series.
              </p>
            )}
            {cells.length > 1 && (
              <div className="font-mono font-medium text-[10px] uppercase tracking-[0.18em] text-crimson pt-0.5">
                {cells.length} wallet approvals · one per tenor
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-6 mb-8">
        <div className="flex items-center gap-4">
          <SectionNumber number="01" label="Epoch vault" />
          <span className="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.2em] border border-crimson rounded-full px-2.5 py-1 text-crimson">
            Recommended
          </span>
        </div>
        <p className="m-0 max-w-[420px] font-sans italic font-normal leading-[1.5] opacity-75 text-[14px]">
          Weekly, monthly, or quarterly settlement — all on Friday 08:00 UTC.
          Ladder mode splits collateral across tenors, one atomic write each.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-x-12 gap-y-10">
        <WriterForm
          mode="epoch"
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
          epochExpirySlot={expirySlot}
          ladderBlock={ladderError ? { tooltip: ladderError } : null}
          americanQuoteBlock={americanQuoteBlock}
        />
        <LiveQuoteCard
          asset={values.asset}
          side={values.side}
          exerciseStyle={values.exerciseStyle}
          market={chosen?.market ?? null}
          strike={strikeNum}
          expiry={frontExpiryTs}
          contracts={contractsNum}
          spot={spotForChosenAsset}
          spotStale={spotStale}
          isPlaceholder={!connected}
          footnote="Premium is paid into the vault as buyers fill — accrued share-by-share, claimable on settlement."
        />
      </div>
    </section>
  );
};

const Pill: FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-full border px-[14px] py-[6px] font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
      active
        ? "border-crimson text-ink"
        : "border-rule text-ink-muted hover:text-ink hover:border-ink"
    }`}
  >
    {children}
  </button>
);

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export default EpochVaultSection;
