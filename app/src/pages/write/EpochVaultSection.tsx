import type { FC } from "react";
import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { SectionNumber } from "../../components/layout";
import { showToast } from "../../components/Toast";
import { WriterForm, type WriterFormValues, type AssetOption } from "./WriterForm";
import { LiveQuoteCard } from "./LiveQuoteCard";
import {
  applyVolSmile,
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { useWriteSubmit, type WriteSubmitResult } from "./useWriteSubmit";

type EpochVaultSectionProps = {
  values: WriterFormValues;
  onChange: (next: WriterFormValues) => void;
  assets: AssetOption[];
  spotForChosenAsset: number | null;
  /** Computed expiry timestamp for next Friday (Unix seconds). */
  epochExpiryTs: number;
  /** Pretty label for the expiry, rendered in the form's read-only tail. */
  epochExpiryLabel: string;
  /** Called on successful submit so the page can render its banner. */
  onSuccess: (result: WriteSubmitResult & { kind: "epoch" | "custom" }) => void;
};

/**
 * § 01 · Epoch vault section. RECOMMENDED pill in the header,
 * italic tagline on the right, paired form + LiveQuoteCard underneath.
 *
 * Form values are owned by the parent (WritePage) so each section's
 * values persist when the user scrolls between sections without
 * losing input.
 */
export const EpochVaultSection: FC<EpochVaultSectionProps> = ({
  values,
  onChange,
  assets,
  spotForChosenAsset,
  epochExpiryTs,
  epochExpiryLabel,
  onSuccess,
}) => {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { submitting, stageLabel, submit } = useWriteSubmit();

  const contractsNum = parseInt(values.contracts || "0", 10) || 0;
  const strikeNum = parseFloat(values.strike) || 0;

  const chosen = useMemo(
    () => assets.find((a) => a.ticker === values.asset) ?? null,
    [assets, values.asset],
  );

  const handleSubmit = async () => {
    if (!chosen || strikeNum <= 0 || contractsNum <= 0) return;
    try {
      // Compute premium from baseline IV (matches LiveQuoteCard).
      const spot = spotForChosenAsset ?? 0;
      const baselineIv =
        spot > 0
          ? applyVolSmile(getDefaultVolatility(chosen.ticker), spot, strikeNum, chosen.ticker)
          : getDefaultVolatility(chosen.ticker);
      const days = Math.max(0, (epochExpiryTs - Date.now() / 1000) / 86400);
      const premiumPerContract =
        spot > 0 && days > 0
          ? values.side === "call"
            ? calculateCallPremium(spot, strikeNum, days, baselineIv)
            : calculatePutPremium(spot, strikeNum, days, baselineIv)
          : 0;
      const collateralPerContract = values.side === "call" ? strikeNum * 2 : strikeNum;
      const collateral = collateralPerContract * contractsNum;

      const result = await submit({
        market: chosen.market,
        side: values.side,
        strike: strikeNum,
        expiry: epochExpiryTs,
        contracts: contractsNum,
        premiumPerContract: Math.max(premiumPerContract, 0.000001),
        collateral,
        vaultType: "epoch",
      });

      if (result) {
        showToast({
          type: "success",
          title: "Epoch vault written",
          message: `${contractsNum} ${chosen.ticker} ${values.side.toUpperCase()} contracts minted`,
          txSignature: result.txSignature,
        });
        onSuccess({ ...result, kind: "epoch" });
      }
    } catch (err: any) {
      showToast({
        type: "error",
        title: "Write failed",
        message: err?.message ?? "Unknown error",
      });
    }
  };

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-6 mb-8">
        <div className="flex items-center gap-4">
          <SectionNumber number="01" label="Epoch vault" />
          <span className="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.2em] border border-crimson rounded-full px-2.5 py-1 text-crimson">
            Recommended
          </span>
        </div>
        <p className="m-0 max-w-[420px] font-fraunces-text italic font-light leading-[1.5] opacity-70 text-[clamp(13px,1vw,15px)]">
          Weekly settlement, every Friday. Writers deposit USDC and receive
          writer-share tokens that earn premium as buyers fill the strike.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-x-12 gap-y-10">
        <WriterForm
          mode="epoch"
          values={values}
          onChange={onChange}
          assets={assets}
          epochExpiryLabel={epochExpiryLabel}
          spotForChosenAsset={spotForChosenAsset}
          connected={connected}
          submitting={submitting}
          stageLabel={stageLabel}
          onSubmit={handleSubmit}
          onConnectClick={() => setVisible(true)}
        />
        <LiveQuoteCard
          asset={values.asset}
          side={values.side}
          strike={strikeNum}
          expiry={epochExpiryTs}
          contracts={contractsNum}
          spot={spotForChosenAsset}
          isPlaceholder={!connected}
          footnote="Premium is paid into the vault as buyers fill — accrued share-by-share, claimable on settlement."
        />
      </div>
    </section>
  );
};

export default EpochVaultSection;
