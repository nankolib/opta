import type { FC } from "react";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { TOKEN_2022_PROGRAM_ID } from "../../utils/constants";
import { daysUntilExpiry } from "../../utils/format";
import {
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { HairlineRule } from "../../components/layout";
import type { Position } from "./positions";

type ResaleModalProps = {
  position: Position;
  spotPrice?: number;
  onClose: () => void;
  onSubmit: (premiumUsd: number, tokenAmount: number) => Promise<void>;
  isSubmitting: boolean;
};

/**
 * Paper-aesthetic resale-listing modal. Lifts the on-chain logic
 * pattern from the legacy modal verbatim — only the visual layer is
 * rebuilt for the v3 paper palette. Submission goes through the
 * usePortfolioActions hook's listResale handler via the parent's
 * onSubmit callback.
 *
 * On open, re-reads the seller's actual Token-2022 ATA balance to
 * pre-fill the quantity field with what they currently hold (not
 * what the position originally minted — they may have transferred or
 * already listed some).
 */
export const ResaleModal: FC<ResaleModalProps> = ({
  position,
  spotPrice,
  onClose,
  onSubmit,
  isSubmitting,
}) => {
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const [sellerBalance, setSellerBalance] = useState<number>(position.contracts);
  const [resalePrice, setResalePrice] = useState("");
  const [listQuantity, setListQuantity] = useState<string>(String(position.contracts));

  const isCall = position.side === "call";
  const strike = position.strike;
  const spot = spotPrice ?? strike;
  const days = Math.max(0, (position.expiry - Date.now() / 1000) / 86400);
  const vol = getDefaultVolatility(position.asset);
  const suggestedPerContract = isCall
    ? calculateCallPremium(spot, strike, days, vol)
    : calculatePutPremium(spot, strike, days, vol);

  // Re-read on-chain ATA balance so quantity defaults to what the
  // wallet actually holds. v2 has no resale; this branch only fires
  // for v1 positions, which is the only kind that reaches the modal
  // anyway (the action button gates).
  useEffect(() => {
    if (!publicKey || !program) return;
    if (position.source.kind !== "v1") return;
    const optionMint = position.source.position.account.optionMint as PublicKey;
    let cancelled = false;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(
          optionMint,
          publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        );
        const info = await program.provider.connection.getAccountInfo(ata);
        if (info && info.data.length >= 72 && !cancelled) {
          const bal = Number(info.data.readBigUInt64LE(64));
          setSellerBalance(bal);
          setListQuantity(String(bal));
          setResalePrice((suggestedPerContract * bal).toFixed(2));
        }
      } catch {
        // Fall through with the position.contracts default.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, program, position.id]);

  const tokenAmount = parseInt(listQuantity || "0", 10) || 0;
  const premiumUsd = parseFloat(resalePrice || "0") || 0;

  const canSubmit =
    !isSubmitting &&
    sellerBalance > 0 &&
    tokenAmount > 0 &&
    tokenAmount <= sellerBalance &&
    premiumUsd > 0;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 backdrop-blur-sm px-4">
      <div className="w-full max-w-md bg-paper border border-rule rounded-md p-8 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="m-0 font-fraunces-mid font-light text-ink leading-tight tracking-[-0.01em] text-[24px]">
            List for resale
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="font-mono text-[14px] opacity-60 hover:opacity-100 transition-opacity duration-200"
          >
            ✕
          </button>
        </div>

        {/* Position context */}
        <div className="border border-rule-soft rounded-sm p-4 mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] uppercase tracking-[0.18em]">
          <span className="font-fraunces-text italic normal-case tracking-normal text-[15px] text-ink">
            {position.asset}
          </span>
          <span className="text-crimson">{position.side}</span>
          <span className="opacity-30">·</span>
          <span className="text-ink">strike ${position.strike.toFixed(2)}</span>
          <span className="opacity-30">·</span>
          <span className="opacity-65">{Math.round(daysUntilExpiry(position.expiry))}d</span>
        </div>

        <label className="block mb-5">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
            Contracts to list
          </div>
          <input
            type="number"
            value={listQuantity}
            onChange={(e) => setListQuantity(e.target.value)}
            min={1}
            max={sellerBalance}
            className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[14px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
          />
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
            You hold {sellerBalance.toLocaleString()} contracts
          </div>
        </label>

        <label className="block mb-6">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
            Total asking price (USDC)
          </div>
          <input
            type="number"
            value={resalePrice}
            onChange={(e) => setResalePrice(e.target.value)}
            step="0.01"
            min="0"
            className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[14px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
          />
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
            B-S suggested per contract:{" "}
            <span className="text-crimson">${suggestedPerContract.toFixed(4)}</span>
          </div>
        </label>

        <HairlineRule className="my-6" />

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-full border border-rule px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-ink/65 hover:text-ink hover:border-ink transition-colors duration-300 ease-opta"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(premiumUsd, tokenAmount)}
            disabled={!canSubmit}
            className="flex-1 rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink disabled:hover:text-paper"
          >
            {isSubmitting ? "Listing…" : `List for $${(premiumUsd || 0).toFixed(2)}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ResaleModal;
