import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useProgram } from "../../hooks/useProgram";
import { showToast } from "../../components/Toast";
import { MoneyAmount } from "../../components/MoneyAmount";
import { HairlineRule } from "../../components/layout";
import { truncateAddress } from "../../utils/format";
import { inferClusterFromUrl, getSolscanTxUrl } from "../../utils/env";
import { useResaleBuyFlow } from "../trade/useResaleBuyFlow";
import type { ResaleListingRow } from "./useMarketplaceData";

type BuyListingModalProps = {
  row: ResaleListingRow;
  /** From useMarketplaceData.spotPrices[row.asset]; may be undefined when Pyth feed didn't resolve. */
  spotPrice: number | undefined;
  /** User-cancel or Done-from-confirmed close. Parent sets buyTarget=null; no refetch. */
  onClose: () => void;
  /**
   * Triggered after a confirmed buy OR after an OQ-F race-detected close.
   * Parent calls data.refetch() and sets buyTarget=null. Both confirmed-buy
   * and stale-state cases warrant a refetch, hence the shared callback.
   */
  onSuccess: () => void;
};

/**
 * Paper-aesthetic buy-listing modal. Wraps `buy_v2_resale` via
 * useResaleBuyFlow with three lifecycle states: form / submitting /
 * confirmed. Mirrors trade/BuyModal's lifecycle exactly — only the
 * specifics of the listing row + fair-value comparison differ.
 *
 * On mount: reads the connected wallet's USDC ATA balance via the same
 * raw getAccountInfo + readBigUInt64LE(64) pattern Portfolio's
 * ResaleModal uses. Balance display is informational; on-chain tx will
 * reject with "Insufficient USDC" if balance is short. Confirm button
 * additionally disables when balance < total cost (defensive).
 *
 * On error: keeps modal open with form values intact so user can retry.
 * Per OQ-F: if the error indicates a race condition (ListingExhausted
 * or ListingMismatch via the errorDecoder strings), auto-closes after
 * 1.5s via onSuccess() so the parent refetches and the user sees the
 * decremented row on next paint.
 *
 * Disconnected wallet: CTA swaps to "Connect Wallet" and triggers the
 * wallet modal. Browse-as-guest is supported on the page; buying
 * requires connection.
 *
 * Self-buy: defended in three places (useResaleBuyFlow's off-chain check,
 * on-chain CannotBuyOwnOption guard, and this modal's canSubmit gate).
 * The buyable section's row partition already filters out own listings,
 * so this modal should never see a self-buy in practice — defenses are
 * belt-and-braces against deep-link or partition-bug regressions.
 */
export const BuyListingModal: FC<BuyListingModalProps> = ({
  row,
  spotPrice: _spotPrice,
  onClose,
  onSuccess,
}) => {
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { program } = useProgram();
  const { submitting, submit } = useResaleBuyFlow();
  const cluster = useMemo(
    () => inferClusterFromUrl(connection.rpcEndpoint),
    [connection.rpcEndpoint],
  );

  // Default qty per OQ-E: full-fill (row.qtyAvailable). Capped at qtyAvailable.
  const [quantity, setQuantity] = useState<string>(String(row.qtyAvailable));
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [confirmedTx, setConfirmedTx] = useState<string | null>(null);

  const qtyNum = parseInt(quantity || "0", 10) || 0;
  const totalCost = row.pricePerContract * qtyNum;
  const isSelfBuy = !!publicKey && publicKey.equals(row.seller);
  const insufficient = usdcBalance != null && usdcBalance < totalCost;
  const canSubmit =
    !submitting &&
    qtyNum >= 1 &&
    qtyNum <= row.qtyAvailable &&
    !isSelfBuy &&
    !insufficient;

  // Esc dismiss (form state only — confirmed state still allows Esc to dismiss
  // the same way the trade/BuyModal does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // USDC balance on mount — same pattern trade/BuyModal uses.
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
      // Project ResaleListingRow → Offering's resale shape for the lifted
      // hook. createdAt + isSelfListing aren't read by submit() but the
      // type requires them; Slice 6 deletes this whole file when the
      // marketplace page goes away.
      const result = await submit({
        offering: {
          kind: "resale",
          premium: row.pricePerContract,
          qty: row.qtyAvailable,
          seller: row.seller,
          createdAt: 0,
          isSelfListing: false,
          listing: row.listing,
          vaultMint: row.vaultMint,
          vault: row.vault,
          market: row.market,
        },
        quantity: qtyNum,
      });
      if (result) {
        setConfirmedTx(result.txSignature);
        showToast({
          type: "success",
          title: "Listing filled",
          message: `${qtyNum} ${row.asset} ${row.optionType.toUpperCase()} @ $${row.strike.toFixed(2)}`,
          txSignature: result.txSignature,
        });
      }
    } catch (err: any) {
      const msg: string = err?.message ?? "Unknown error";
      showToast({ type: "error", title: "Purchase failed", message: msg });
      // Per OQ-F: race-detected errors (ListingExhausted, InvalidListingEscrow,
      // ListingMismatch) mean another buyer / cancel hit the listing first.
      // Auto-close + parent refetch so the user sees the decremented (or
      // vanished) row on next paint. Substring match against the decoder's
      // user-friendly strings AND the raw enum names (defensive).
      const isStaleStateError =
        msg.includes("contracts left in this listing") ||
        msg.includes("Listing data mismatch") ||
        msg.includes("ListingExhausted") ||
        msg.includes("InvalidListingEscrow") ||
        msg.includes("ListingMismatch");
      if (isStaleStateError) {
        setTimeout(() => onSuccess(), 1500);
      }
    }
  };

  const expiryLabel = useMemo(
    () =>
      new Date(row.expiry * 1000).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
    [row.expiry],
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
            {confirmedTx ? "Purchase confirmed" : "Buy listing"}
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

        {/* Listing summary block — visible in both form + confirmed states */}
        <div className="border border-rule-soft rounded-sm p-4 mb-6">
          <div className="flex items-baseline gap-3 mb-3">
            <span className="font-fraunces-text italic text-ink text-[18px] leading-tight">
              {row.asset}
            </span>
            <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em]">
              <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
              {row.optionType}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-y-2 gap-x-4 font-mono text-[11px] uppercase tracking-[0.18em]">
            <Row label="Strike">${row.strike.toFixed(2)}</Row>
            <Row label="Expiry">{expiryLabel}</Row>
            <Row label="Ask / contract">
              <MoneyAmount value={row.pricePerContract} />
            </Row>
            <Row label="Available">{row.qtyAvailable.toLocaleString()}</Row>
            <Row label="Seller">{truncateAddress(row.seller.toBase58())}</Row>
          </div>
        </div>

        {confirmedTx ? (
          <ConfirmedBlock
            txSignature={confirmedTx}
            solscanUrl={getSolscanTxUrl(confirmedTx, cluster)}
            onDone={onSuccess}
          />
        ) : (
          <>
            <Field label="Contracts to buy">
              <QuantityInput
                value={quantity}
                onChange={setQuantity}
                max={row.qtyAvailable}
              />
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
                Max {row.qtyAvailable.toLocaleString()} available · 1 contract = 1 unit
              </div>
            </Field>

            {/* Fair value comparison */}
            <FairValueLine row={row} qtyNum={qtyNum} />

            <div className="border-y border-rule-soft py-3 my-5 flex items-baseline justify-between">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
                Total cost
              </span>
              <span className="font-mono text-[18px] text-crimson">
                <MoneyAmount value={totalCost} />
              </span>
            </div>

            <div className="flex items-baseline justify-between mb-2">
              <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-60">
                Wallet USDC
              </span>
              <span className="font-mono text-[12px] text-ink">
                {usdcBalance != null ? <MoneyAmount value={usdcBalance} /> : "—"}
              </span>
            </div>
            {insufficient && (
              <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-crimson mb-4">
                Insufficient USDC — wallet has{" "}
                <MoneyAmount value={usdcBalance ?? 0} />, listing costs{" "}
                <MoneyAmount value={totalCost} />.
              </div>
            )}
            {isSelfBuy && (
              <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-crimson mb-4">
                You can't buy your own listing.
              </div>
            )}

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

const QuantityInput: FC<{
  value: string;
  onChange: (v: string) => void;
  max: number;
}> = ({ value, onChange, max }) => {
  const num = parseInt(value || "0", 10) || 0;
  const dec = () => onChange(String(Math.max(1, num - 1)));
  const inc = () => onChange(String(Math.min(max, num + 1)));
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={dec}
        disabled={num <= 1}
        aria-label="Decrement"
        className="inline-flex items-center justify-center w-9 h-9 rounded-sm border border-rule font-mono text-[16px] text-ink/70 hover:border-ink hover:text-ink transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        −
      </button>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={1}
        max={max}
        className="flex-1 bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[14px] text-ink text-center focus:outline-none focus:border-ink transition-colors duration-200"
      />
      <button
        type="button"
        onClick={inc}
        disabled={num >= max}
        aria-label="Increment"
        className="inline-flex items-center justify-center w-9 h-9 rounded-sm border border-rule font-mono text-[16px] text-ink/70 hover:border-ink hover:text-ink transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        +
      </button>
    </div>
  );
};

const FairValueLine: FC<{ row: ResaleListingRow; qtyNum: number }> = ({ row, qtyNum }) => {
  if (row.pricePerContractFairValue == null || row.premiumPct == null) {
    return (
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-50 mb-3">
        Fair value · — (Pyth feed unresolved)
      </div>
    );
  }
  const totalFair = row.pricePerContractFairValue * qtyNum;
  const absPct = Math.abs(row.premiumPct);
  let descriptor: React.ReactNode;
  if (row.premiumPct < -0.5) {
    descriptor = (
      <span className="text-emerald-700">paying {absPct.toFixed(1)}% below</span>
    );
  } else if (row.premiumPct > 0.5) {
    descriptor = (
      <span className="text-crimson">paying {absPct.toFixed(1)}% above</span>
    );
  } else {
    descriptor = <span className="text-ink/70">at fair</span>;
  }
  return (
    <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-65 mb-3 flex items-baseline justify-between">
      <span>
        Fair value · <MoneyAmount value={totalFair} />
      </span>
      <span>You're {descriptor}</span>
    </div>
  );
};

const ConfirmedBlock: FC<{
  txSignature: string;
  solscanUrl: string;
  onDone: () => void;
}> = ({ txSignature, solscanUrl, onDone }) => (
  <div>
    <p className="m-0 font-fraunces-text italic font-light leading-[1.55] opacity-75 text-[15px] mb-4">
      Your contracts are in your wallet. Solscan link below; Portfolio shows
      them in your open positions.
    </p>
    <a
      href={solscanUrl}
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
        onClick={onDone}
        className="flex-1 rounded-full border border-rule px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-ink/65 hover:text-ink hover:border-ink transition-colors duration-300 ease-opta"
      >
        Done
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

export default BuyListingModal;
