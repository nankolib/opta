import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useProgram } from "../../hooks/useProgram";
import { showToast } from "../../components/Toast";
import { MoneyAmount } from "../../components/MoneyAmount";
import { HairlineRule } from "../../components/layout";
import { usdcToNumber } from "../../utils/format";
import { usePurchaseFlow } from "./usePurchaseFlow";
import type { ChainBest } from "./useTradeData";

type BuyModalProps = {
  best: ChainBest;
  side: "call" | "put";
  onClose: () => void;
  onSuccess: () => void;
};

/**
 * Paper-aesthetic buy modal. Calls `purchase_from_vault` via the
 * shared usePurchaseFlow hook. Modal lifecycle:
 *   1. Form state — quantity input + cost preview
 *   2. Submitting state — disabled CTA showing "Confirming…"
 *   3. Confirmed state — replaces form area with confirmation block
 *      (tx signature + Portfolio link + Dismiss). No auto-close.
 *
 * Esc + click-outside dismiss work in form state and confirmed state.
 *
 * Disconnected wallet: CTA swaps to "Connect Wallet" and triggers
 * the wallet modal (matches Write).
 */
export const BuyModal: FC<BuyModalProps> = ({ best, side, onClose, onSuccess }) => {
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { program } = useProgram();
  const { submitting, submit } = usePurchaseFlow();

  const [quantity, setQuantity] = useState("1");
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [confirmedTx, setConfirmedTx] = useState<string | null>(null);

  const v = best.vault.account;
  const vm = best.vaultMint.account;
  const market = best.market;
  const strike = usdcToNumber(v.strikePrice);
  const expiry =
    typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber();
  const available =
    (vm.quantityMinted?.toNumber?.() ?? 0) - (vm.quantitySold?.toNumber?.() ?? 0);

  const qtyNum = parseInt(quantity || "0", 10) || 0;
  const totalCost = best.premium * qtyNum;
  const canSubmit =
    !submitting && qtyNum > 0 && qtyNum <= available && best.premium > 0;

  // Esc dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Read USDC balance from chain.
  useEffect(() => {
    if (!program || !publicKey) {
      setUsdcBalance(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const protocolState = await program.account.protocolState.fetch(protocolStatePda);
        const ata = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
        const info = await program.provider.connection.getAccountInfo(ata);
        if (cancelled) return;
        if (info && info.data.length >= 72) {
          const raw = Number(info.data.readBigUInt64LE(64));
          setUsdcBalance(raw / 1_000_000);
        } else {
          setUsdcBalance(0);
        }
      } catch {
        if (!cancelled) setUsdcBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [program, publicKey]);

  const handleConfirm = async () => {
    try {
      const result = await submit({ best, quantity: qtyNum });
      if (result) {
        setConfirmedTx(result.txSignature);
        showToast({
          type: "success",
          title: "Contracts purchased",
          message: `${qtyNum} ${market.assetName} ${side.toUpperCase()} @ $${strike.toFixed(2)}`,
          txSignature: result.txSignature,
        });
        onSuccess();
      }
    } catch (err: any) {
      showToast({
        type: "error",
        title: "Purchase failed",
        message: err?.message ?? "Unknown error",
      });
    }
  };

  const expiryLabel = useMemo(
    () =>
      new Date(expiry * 1000).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
    [expiry],
  );

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-paper border border-rule rounded-md p-8 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="m-0 font-fraunces-mid font-light text-ink leading-tight tracking-[-0.01em] text-[24px]">
            {confirmedTx ? "Purchase confirmed" : "Buy option"}
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

        {/* Contract summary block — visible in both form + confirmed states */}
        <div className="border border-rule-soft rounded-sm p-4 mb-6">
          <div className="flex items-baseline gap-3 mb-3">
            <span className="font-fraunces-text italic text-ink text-[18px] leading-tight">
              {market.assetName}
            </span>
            <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em]">
              <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
              {side}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-y-2 gap-x-4 font-mono text-[11px] uppercase tracking-[0.18em]">
            <Row label="Strike">${strike.toFixed(2)}</Row>
            <Row label="Expiry">{expiryLabel}</Row>
            <Row label="Premium / contract">
              <MoneyAmount value={best.premium} />
            </Row>
            <Row label="Available">{available.toLocaleString()}</Row>
          </div>
        </div>

        {confirmedTx ? (
          <ConfirmedBlock txSignature={confirmedTx} onDismiss={onClose} />
        ) : (
          <>
            <Field label="Contracts to buy">
              <input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                min={1}
                max={available}
                className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[14px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
              />
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
                1 contract = 1 unit of underlying
              </div>
            </Field>

            <div className="border-y border-rule-soft py-3 my-5 flex items-baseline justify-between">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
                Total cost
              </span>
              <span className="font-mono text-[18px] text-crimson">
                <MoneyAmount value={totalCost} />
              </span>
            </div>

            <div className="flex items-baseline justify-between mb-6">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-60">
                Wallet USDC
              </span>
              <span className="font-mono text-[12px] text-ink">
                {usdcBalance != null ? <MoneyAmount value={usdcBalance} /> : "—"}
              </span>
            </div>

            <HairlineRule className="mb-5" weight="soft" />

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
                onClick={connected ? handleConfirm : () => setVisible(true)}
                disabled={connected && !canSubmit}
                className="flex-1 rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink disabled:hover:text-paper"
              >
                {!connected
                  ? "Connect Wallet"
                  : submitting
                    ? "Confirming…"
                    : "Confirm Purchase →"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const Row: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <>
    <span className="opacity-55">{label}</span>
    <span className="text-ink text-right">{children}</span>
  </>
);

const Field: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="mb-5">
    <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
      {label}
    </div>
    {children}
  </div>
);

const ConfirmedBlock: FC<{ txSignature: string; onDismiss: () => void }> = ({
  txSignature,
  onDismiss,
}) => (
  <div>
    <p className="m-0 font-fraunces-text italic font-light leading-[1.55] opacity-75 text-[15px] mb-4">
      Your contracts are minted into your wallet. Solscan link below;
      Portfolio shows them in your open positions.
    </p>
    <a
      href={`https://solscan.io/tx/${txSignature}?cluster=devnet`}
      target="_blank"
      rel="noreferrer"
      className="block font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-65 hover:opacity-100 hover:text-crimson transition-colors duration-300 ease-opta mb-6"
    >
      tx · {txSignature.slice(0, 10)}…{txSignature.slice(-8)} ↗
    </a>
    <HairlineRule className="mb-5" weight="soft" />
    <div className="flex gap-3">
      <button
        type="button"
        onClick={onDismiss}
        className="flex-1 rounded-full border border-rule px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-ink/65 hover:text-ink hover:border-ink transition-colors duration-300 ease-opta"
      >
        Dismiss
      </button>
      <Link
        to="/portfolio"
        className="flex-1 inline-flex items-center justify-center gap-2 rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] no-underline hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta"
      >
        View on Portfolio
        <span aria-hidden="true">→</span>
      </Link>
    </div>
  </div>
);

export default BuyModal;
