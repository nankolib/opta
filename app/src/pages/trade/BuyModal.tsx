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
import { OfferingsPanel } from "./OfferingsPanel";
import { usePurchaseFlow } from "./usePurchaseFlow";
import { useResaleBuyFlow } from "./useResaleBuyFlow";
import type { ChainBest, Offering } from "./useTradeData";

type BuyModalProps = {
  asset: string;
  side: "call" | "put";
  strike: number;
  expiry: number;
  spot: number | null;
  fairPremium: number;
  ivSmiled: number;
  /** Pre-sorted ascending by premium per Slice 1. */
  offerings: Offering[];
  /** Cheapest non-self offering, pre-selected. Null only if every offering is a self-listing. */
  initialSelected: Offering | null;
  onClose: () => void;
  onSuccess: () => void;
};

/**
 * Unified buy modal — vault + resale paths, single lifecycle.
 *
 * Lifecycle:
 *   1. Form        — OfferingsPanel + qty input + cost preview
 *   2. Submitting  — disabled CTA showing "Confirming…"
 *   3. Confirmed   — Solscan link + Portfolio link + Done
 *
 * Confirm dispatcher routes on selected.kind:
 *   - vault  → usePurchaseFlow.submit  (5% slippage cushion)
 *   - resale → useResaleBuyFlow.submit (exact price, fixed)
 *
 * Race-error auto-close: if the on-chain tx fails because another
 * buyer/cancel hit the listing first, the modal calls onSuccess after
 * 1.5s so the parent refetches and the stale row decrements/vanishes
 * on next paint.
 *
 * Self-buy: defended in three places (OfferingsPanel rows are inert
 * for self-listings; canSubmit gate; useResaleBuyFlow refuses; on-chain
 * CannotBuyOwnOption is the final guard).
 *
 * Disconnected wallet: CTA swaps to "Connect Wallet" and opens the
 * wallet-adapter modal. Selection state persists across connect.
 */
export const BuyModal: FC<BuyModalProps> = ({
  asset,
  side,
  strike,
  expiry,
  spot,
  fairPremium,
  ivSmiled,
  offerings,
  initialSelected,
  onClose,
  onSuccess,
}) => {
  const { connected, publicKey } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { program } = useProgram();
  const purchaseFlow = usePurchaseFlow();
  const resaleBuyFlow = useResaleBuyFlow();
  const cluster = useMemo(
    () => inferClusterFromUrl(connection.rpcEndpoint),
    [connection.rpcEndpoint],
  );

  const [selected, setSelected] = useState<Offering | null>(initialSelected);
  const [quantity, setQuantity] = useState("1");
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [confirmedTx, setConfirmedTx] = useState<string | null>(null);

  const submitting = purchaseFlow.submitting || resaleBuyFlow.submitting;

  const selectedInventory = selected
    ? selected.kind === "vault"
      ? selected.inventory
      : selected.qty
    : 0;
  const isSelfListing =
    selected?.kind === "resale" &&
    publicKey != null &&
    selected.seller.equals(publicKey);
  const qtyNum = parseInt(quantity || "0", 10) || 0;
  const totalCost = (selected?.premium ?? 0) * qtyNum;
  const insufficient = usdcBalance != null && usdcBalance < totalCost;
  const canSubmit =
    !submitting &&
    selected != null &&
    qtyNum >= 1 &&
    qtyNum <= selectedInventory &&
    !isSelfListing &&
    !insufficient;

  // Esc dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // USDC balance read — same pattern as the prior ChainBest-only modal.
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

  const sourceLabel = useMemo(() => {
    if (!selected) return "—";
    if (selected.kind === "vault") return "Vault";
    return `Resale · ${truncateAddress(selected.seller.toBase58())}`;
  }, [selected]);
  const sourceTitle =
    selected?.kind === "resale" ? selected.seller.toBase58() : undefined;

  const handleConfirm = async () => {
    if (!selected) return;
    try {
      let result: { txSignature: string } | null = null;
      if (selected.kind === "vault") {
        const best: ChainBest = {
          vaultMint: selected.vaultMint,
          vault: selected.vault,
          market: selected.market,
          premium: selected.premium,
        };
        result = await purchaseFlow.submit({ best, quantity: qtyNum });
      } else {
        result = await resaleBuyFlow.submit({ offering: selected, quantity: qtyNum });
      }
      if (result) {
        setConfirmedTx(result.txSignature);
        showToast({
          type: "success",
          title: selected.kind === "vault" ? "Contracts purchased" : "Listing filled",
          message: `${qtyNum} ${asset} ${side.toUpperCase()} @ $${strike.toFixed(2)} from ${sourceLabel}`,
          txSignature: result.txSignature,
        });
        onSuccess();
      }
    } catch (err: any) {
      const msg: string = err?.message ?? "Unknown error";
      showToast({ type: "error", title: "Purchase failed", message: msg });
      // Race-detected errors mean another buyer/cancel hit first. Auto-
      // close + parent refetch on next paint.
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

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-paper border border-rule rounded-md p-8 shadow-2xl max-h-[90vh] overflow-y-auto"
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

        {confirmedTx ? (
          <ConfirmedBlock
            txSignature={confirmedTx}
            solscanUrl={getSolscanTxUrl(confirmedTx, cluster)}
            onDismiss={onClose}
          />
        ) : (
          <>
            <OfferingsPanel
              asset={asset}
              side={side}
              strike={strike}
              expiry={expiry}
              spot={spot}
              fairPremium={fairPremium}
              ivSmiled={ivSmiled}
              offerings={offerings}
              selected={selected}
              onSelect={setSelected}
            />

            <div className="mt-6">
              <Field label="Contracts to buy">
                <input
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  min={1}
                  max={selectedInventory}
                  className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[14px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
                />
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
                  Max {selectedInventory.toLocaleString()} available at this source
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
                  <MoneyAmount value={usdcBalance ?? 0} />, total cost{" "}
                  <MoneyAmount value={totalCost} />.
                </div>
              )}
              {isSelfListing && (
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
                  title={sourceTitle}
                  className="flex-1 rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink disabled:hover:text-paper"
                >
                  {!connected
                    ? "Connect Wallet"
                    : submitting
                      ? "Confirming…"
                      : `Buy ${qtyNum} from ${sourceLabel} →`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const Field: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="mb-5">
    <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
      {label}
    </div>
    {children}
  </div>
);

const ConfirmedBlock: FC<{
  txSignature: string;
  solscanUrl: string;
  onDismiss: () => void;
}> = ({ txSignature, solscanUrl, onDismiss }) => (
  <div>
    <p className="m-0 font-fraunces-text italic font-light leading-[1.55] opacity-75 text-[15px] mb-4">
      Your contracts are in your wallet. Solscan link below; Portfolio
      shows them in your open positions.
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
        onClick={onDismiss}
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

export default BuyModal;
