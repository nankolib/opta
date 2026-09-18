import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { inferClusterFromUrl, getSolscanTxUrl } from "../../utils/env";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useSpotPrices } from "../../hooks/useSpotPrices";
import { useVolOracleStatus } from "../../hooks/useVolOracleStatus";
import { canonicalAsset } from "../../utils/assetDisplay";
import { usePaperPalette } from "../../hooks";
import { hexFromBytes } from "../../utils/format";
import { spotSourceOf, writeWarmupGate } from "../../utils/oracleArm";
import { PaperGrain, HairlineRule } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { WRITE_TERMINAL_UI } from "../../utils/constants";
import { WriteTerminalPage } from "./WriteTerminalPage";
import { WriteStatementHeader } from "./WriteStatementHeader";
import { EpochVaultSection } from "./EpochVaultSection";
import { CustomVaultSection } from "./CustomVaultSection";
import { weeklyExpiry } from "../../utils/tenors";
import type { WriterFormValues, AssetOption } from "./WriterForm";
import type { WriteCell, WriteSuccessPayload } from "./useWriteSubmit";

interface MarketAccount {
  publicKey: PublicKey;
  account: any;
}

/**
 * WritePage — the trader's write surface.
 *
 * Two side-by-side flows divided by a hairline: § 01 Epoch (tenor selector +
 * ladder, all Friday 08:00 UTC) and § 02 Custom (any expiry). Each section
 * pairs a WriterForm with a sticky LiveQuoteCard.
 *
 * A write may fan out into N tenors (ladder) → N sequential atomic txs. The
 * page-level banner lists each tenor's result (landed → tx link, failed →
 * reason) and offers a scoped "Retry failed" that re-runs ONLY the failed cells.
 */
/**
 * WritePage — flag switch between the legacy paper surface (WritePageLegacy,
 * unchanged) and the new terminal surface (WriteTerminalPage). Gated by
 * WRITE_TERMINAL_UI (default true). Mirrors TradePage's V1/V2 switch — App.tsx
 * and routing are untouched; the page owns which surface it mounts.
 */
export const WritePage: FC = () =>
  WRITE_TERMINAL_UI ? <WriteTerminalPage /> : <WritePageLegacy />;

const WritePageLegacy: FC = () => {
  usePaperPalette();
  const { program } = useProgram();
  const { connection } = useConnection();
  const cluster = useMemo(
    () => inferClusterFromUrl(connection.rpcEndpoint),
    [connection.rpcEndpoint],
  );
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [lastSuccess, setLastSuccess] = useState<WriteSuccessPayload | null>(null);

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

  // Asset chip source: dedupe markets by assetName, keep one
  // representative market per asset (any one — we only need its
  // pythFeedId and assetClass for the create_market call).
  const assets = useMemo<AssetOption[]>(() => {
    const map = new Map<string, AssetOption>();
    for (const m of markets) {
      const ticker = canonicalAsset(m.account.assetName);
      if (!ticker) continue;
      if (!map.has(ticker)) {
        map.set(ticker, { ticker, market: m });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [markets]);

  // Pass (ticker, feedIdHex, oracleSource) tuples to useSpotPrices so it can
  // batch each market to its correct spot source.
  const feeds = useMemo(
    () =>
      assets.map((a) => ({
        ticker: a.ticker,
        feedIdHex: hexFromBytes(a.market.account.pythFeedId as number[]),
        oracleSource: spotSourceOf(a.market.account.oracleSource),
      })),
    [assets],
  );
  const { prices: spotPrices, stale: pricesStale } = useSpotPrices(feeds);

  // W1 vol-oracle coverage gate. Hourly polling crank leaves a race window
  // between create_market and the crank's initialize_vol_oracle; W1 surfaces
  // the gap to the user as "Oracle pending" instead of a confusing 3007
  // on submit. Re-derives unseeded set into ticker-keyed for the UI layer.
  const volOracleStatus = useVolOracleStatus(
    useMemo(() => feeds.map((f) => f.feedIdHex), [feeds]),
  );
  const unseededTickers = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const f of feeds) {
      if (volOracleStatus.unseeded.has(f.feedIdHex.toLowerCase().replace(/^0x/, ""))) {
        out.add(f.ticker);
      }
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

  const [epochValues, setEpochValues] = useState<WriterFormValues>({
    asset: null,
    side: "call",
    exerciseStyle: "european",
    strike: "",
    contracts: "1",
    // Epoch expiry is tenor-derived inside EpochVaultSection; this field is
    // unused there (seeded to the front weekly for sanity).
    expiry: weeklyExpiry(),
    expiryPreset: "7D",
    premiumPerContract: "",
  });

  const [customValues, setCustomValues] = useState<WriterFormValues>({
    asset: null,
    side: "call",
    exerciseStyle: "european",
    strike: "",
    contracts: "1",
    expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
    expiryPreset: "1D",
    premiumPerContract: "",
  });

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

  const handleSuccess = (payload: WriteSuccessPayload) => {
    setLastSuccess(payload);
    refetchMarkets();
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const handleRetryFailed = async () => {
    if (!lastSuccess) return;
    const failedCells: WriteCell[] = lastSuccess.cells
      .filter((c) => c.status === "failed")
      .map((c) => ({
        expiryTs: c.expiryTs,
        contracts: c.contracts,
        collateral: c.collateral,
        premiumPerContract: c.premiumPerContract,
        tenorLabels: c.tenorLabels,
      }));
    if (failedCells.length === 0) return;
    const retried = await lastSuccess.retryFailed(failedCells);
    if (retried) {
      // Merge: replace each failed entry with its retry outcome (keyed by expiry).
      const byExp = new Map(retried.map((r) => [r.expiryTs, r]));
      setLastSuccess({
        ...lastSuccess,
        cells: lastSuccess.cells.map((c) => byExp.get(c.expiryTs) ?? c),
      });
      refetchMarkets();
    }
  };

  const landedCount = lastSuccess?.cells.filter((c) => c.status === "landed").length ?? 0;
  const failedCount = (lastSuccess?.cells.length ?? 0) - landedCount;

  return (
    <div className="relative bg-paper text-ink overflow-x-hidden min-h-screen">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
        <WriteStatementHeader monthLabel={monthLabel} timestampLabel={timestampLabel} />

        {lastSuccess && (
          <div className="border border-rule rounded-md p-5 mb-12 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
                <span className="font-mono text-[11.5px] uppercase tracking-[0.2em]">
                  {lastSuccess.kind === "epoch" ? "Epoch" : "Custom"} write — {landedCount}/
                  {lastSuccess.cells.length} landed
                </span>
              </div>
              <button
                type="button"
                onClick={() => setLastSuccess(null)}
                className="font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] text-ink-muted hover:text-ink transition-colors duration-200"
              >
                Dismiss
              </button>
            </div>

            <div className="space-y-1.5">
              {lastSuccess.cells.map((c) => (
                <div
                  key={c.expiryTs}
                  className="flex items-baseline justify-between gap-3 font-mono text-[10.5px]"
                >
                  <span className="uppercase tracking-[0.18em] text-ink-muted">
                    {c.tenorLabels.join(" + ")} ·{" "}
                    {new Date(c.expiryTs * 1000).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      timeZone: "UTC",
                    })}{" "}
                    · {c.contracts}×
                  </span>
                  {c.status === "landed" && c.txSignature ? (
                    <a
                      href={getSolscanTxUrl(c.txSignature, cluster)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium tracking-[0.14em] text-ink-muted hover:text-crimson transition-colors duration-300 ease-opta"
                    >
                      {c.txSignature.slice(0, 8)}…{c.txSignature.slice(-6)} ↗
                    </a>
                  ) : (
                    <span className="text-crimson uppercase tracking-[0.14em]">
                      {c.error ?? "Failed"}
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center gap-4 pt-1">
              {failedCount > 0 && (
                <button
                  type="button"
                  onClick={handleRetryFailed}
                  className="font-mono text-[11px] uppercase tracking-[0.2em] text-crimson no-underline border-b border-crimson pb-0.5 hover:opacity-70 transition-opacity duration-200"
                >
                  Retry {failedCount} failed
                </button>
              )}
              <Link
                to="/portfolio"
                className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ink no-underline border-b border-ink pb-0.5 hover:border-crimson hover:text-crimson transition-colors duration-300 ease-opta"
              >
                View on Portfolio →
              </Link>
            </div>
          </div>
        )}

        <EpochVaultSection
          values={epochValues}
          onChange={setEpochValues}
          assets={assets}
          spotForChosenAsset={epochValues.asset ? spotPrices[epochValues.asset] ?? null : null}
          spotStale={pricesStale}
          onSuccess={handleSuccess}
          unseededTickers={unseededTickers}
          warmupBlocks={warmupBlocks}
          checkVolOracle={volOracleStatus.checkWritable}
        />

        <div className="mt-16">
          <HairlineRule />
        </div>

        <CustomVaultSection
          values={customValues}
          onChange={setCustomValues}
          assets={assets}
          spotForChosenAsset={customValues.asset ? spotPrices[customValues.asset] ?? null : null}
          spotStale={pricesStale}
          onSuccess={handleSuccess}
          unseededTickers={unseededTickers}
          warmupBlocks={warmupBlocks}
          checkVolOracle={volOracleStatus.checkWritable}
        />
      </main>
    </div>
  );
};

export default WritePage;
