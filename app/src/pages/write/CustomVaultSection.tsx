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

type CustomVaultSectionProps = {
  values: WriterFormValues;
  onChange: (next: WriterFormValues) => void;
  assets: AssetOption[];
  spotForChosenAsset: number | null;
  onSuccess: (result: WriteSubmitResult & { kind: "epoch" | "custom" }) => void;
};

/**
 * § 02 · Custom vault section. Same form shape as Epoch but with the
 * ExpiryPicker tail (preset row + date+time inputs).
 */
export const CustomVaultSection: FC<CustomVaultSectionProps> = ({
  values,
  onChange,
  assets,
  spotForChosenAsset,
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
    if (!chosen || strikeNum <= 0 || contractsNum <= 0 || values.expiry == null) return;
    try {
      const spot = spotForChosenAsset ?? 0;
      const baselineIv =
        spot > 0
          ? applyVolSmile(getDefaultVolatility(chosen.ticker), spot, strikeNum, chosen.ticker)
          : getDefaultVolatility(chosen.ticker);
      const days = Math.max(0, (values.expiry - Date.now() / 1000) / 86400);
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
        expiry: values.expiry,
        contracts: contractsNum,
        premiumPerContract: Math.max(premiumPerContract, 0.000001),
        collateral,
        vaultType: "custom",
      });

      if (result) {
        showToast({
          type: "success",
          title: "Custom vault written",
          message: `${contractsNum} ${chosen.ticker} ${values.side.toUpperCase()} contracts minted`,
          txSignature: result.txSignature,
        });
        onSuccess({ ...result, kind: "custom" });
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
        <SectionNumber number="02" label="Custom vault" />
        <p className="m-0 max-w-[420px] font-fraunces-text italic font-light leading-[1.5] opacity-70 text-[clamp(13px,1vw,15px)]">
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
        />
        <LiveQuoteCard
          asset={values.asset}
          side={values.side}
          strike={strikeNum}
          expiry={values.expiry}
          contracts={contractsNum}
          spot={spotForChosenAsset}
          isPlaceholder={!connected}
          footnote="Custom vaults inherit the same settlement mechanics as epoch vaults — the only difference is the expiry timestamp."
        />
      </div>
    </section>
  );
};

export default CustomVaultSection;
