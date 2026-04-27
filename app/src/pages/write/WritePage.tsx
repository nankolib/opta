import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { usePythPrices } from "../../hooks/usePythPrices";
import { usePaperPalette } from "../../hooks";
import { PaperGrain, HairlineRule } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { WriteStatementHeader } from "./WriteStatementHeader";
import { EpochVaultSection } from "./EpochVaultSection";
import { CustomVaultSection } from "./CustomVaultSection";
import type { WriterFormValues, AssetOption } from "./WriterForm";
import type { WriteSubmitResult } from "./useWriteSubmit";

interface MarketAccount {
  publicKey: PublicKey;
  account: any;
}

/**
 * WritePage — the trader's write surface.
 *
 * Two side-by-side flows divided by a hairline: § 01 Epoch (Friday
 * weekly) and § 02 Custom (any expiry). Each section pairs a
 * WriterForm with a sticky LiveQuoteCard.
 *
 * Asset chips are derived from the on-chain markets list via dedupe —
 * we do NOT hardcode a 5-asset list. When no markets exist, each
 * section renders a clean empty-state pointing the user at /markets.
 *
 * Form values are owned at the page level so each section's state
 * persists independently and we can render a single page-level
 * confirmation banner after a successful submit.
 */
export const WritePage: FC = () => {
  usePaperPalette();
  const { program } = useProgram();
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [lastSuccess, setLastSuccess] = useState<
    (WriteSubmitResult & { kind: "epoch" | "custom" }) | null
  >(null);

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
  // pythFeed and assetClass for the create_market call).
  const assets = useMemo<AssetOption[]>(() => {
    const map = new Map<string, AssetOption>();
    for (const m of markets) {
      const ticker = m.account.assetName as string;
      if (!ticker) continue;
      if (!map.has(ticker)) {
        map.set(ticker, { ticker, market: m });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [markets]);

  const assetTickers = useMemo(() => assets.map((a) => a.ticker), [assets]);
  const { prices: spotPrices } = usePythPrices(assetTickers);

  const epochExpiryTs = useMemo(() => nextFridayUtc8(), []);
  const epochExpiryLabel = useMemo(
    () =>
      new Date(epochExpiryTs * 1000).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }) + " UTC",
    [epochExpiryTs],
  );

  const [epochValues, setEpochValues] = useState<WriterFormValues>({
    asset: null,
    side: "call",
    strike: "",
    contracts: "1",
    expiry: epochExpiryTs,
    expiryPreset: "7D",
  });

  const [customValues, setCustomValues] = useState<WriterFormValues>({
    asset: null,
    side: "call",
    strike: "",
    contracts: "1",
    expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
    expiryPreset: "1D",
  });

  // Keep the Epoch values' `expiry` field in sync with the computed
  // next-Friday timestamp. Form doesn't expose it as editable but
  // the LiveQuoteCard reads it.
  useEffect(() => {
    setEpochValues((v) => ({ ...v, expiry: epochExpiryTs }));
  }, [epochExpiryTs]);

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

  const handleSuccess = (result: WriteSubmitResult & { kind: "epoch" | "custom" }) => {
    setLastSuccess(result);
    refetchMarkets();
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <div className="relative bg-paper text-ink overflow-x-hidden min-h-screen">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
        <WriteStatementHeader monthLabel={monthLabel} timestampLabel={timestampLabel} />

        {lastSuccess && (
          <div className="border border-rule rounded-md p-5 mb-12 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
              <span className="font-mono text-[11.5px] uppercase tracking-[0.2em]">
                {lastSuccess.kind === "epoch" ? "Epoch" : "Custom"} write confirmed
              </span>
              <a
                href={`https://solscan.io/tx/${lastSuccess.txSignature}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-60 hover:opacity-100 hover:text-crimson transition-colors duration-300 ease-opta"
              >
                {lastSuccess.txSignature.slice(0, 8)}…{lastSuccess.txSignature.slice(-6)} ↗
              </a>
            </div>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setLastSuccess(null)}
                className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-55 hover:opacity-100 transition-opacity duration-200"
              >
                Dismiss
              </button>
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
          epochExpiryTs={epochExpiryTs}
          epochExpiryLabel={epochExpiryLabel}
          onSuccess={handleSuccess}
        />

        <div className="mt-16">
          <HairlineRule />
        </div>

        <CustomVaultSection
          values={customValues}
          onChange={setCustomValues}
          assets={assets}
          spotForChosenAsset={customValues.asset ? spotPrices[customValues.asset] ?? null : null}
          onSuccess={handleSuccess}
        />
      </main>
    </div>
  );
};

/**
 * Compute the next Friday at 08:00 UTC as a Unix timestamp (seconds).
 * Matches the on-chain default `EpochConfig` (weekly_expiry_day=5,
 * weekly_expiry_hour=8). If today is Friday but past 08:00 UTC, rolls
 * to the following Friday. The on-chain epoch_config can override this
 * — alignment work is parked for a later pass.
 */
function nextFridayUtc8(): number {
  const d = new Date();
  d.setUTCHours(8, 0, 0, 0);
  const day = d.getUTCDay(); // Sun=0, Fri=5
  let delta = (5 - day + 7) % 7;
  if (delta === 0 && d.getTime() <= Date.now()) delta = 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return Math.floor(d.getTime() / 1000);
}

export default WritePage;
