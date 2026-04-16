import { FC, useState } from "react";
import { PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { formatUsdc, usdcToNumber, toUsdcBN, formatExpiry, daysUntilExpiry } from "../../utils/format";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID, deriveExtraAccountMetaListPda, deriveHookStatePda } from "../../utils/constants";
import { deriveWriterPosition, deriveVaultPurchaseEscrow } from "../../hooks/useAccounts";
import { calculateCallPremium, calculatePutPremium, calculateCallGreeks, calculatePutGreeks, getDefaultVolatility } from "../../utils/blackScholes";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";

interface BuyVaultModalProps {
  vaultMint: { publicKey: PublicKey; account: any };
  vault: { publicKey: PublicKey; account: any };
  market: any;
  spotPrice: number;
  program: any;
  publicKey: PublicKey;
  onClose: () => void;
  onSuccess: () => void;
}

export const BuyVaultModal: FC<BuyVaultModalProps> = ({ vaultMint, vault, market, spotPrice, program, publicKey, onClose, onSuccess }) => {
  const [quantity, setQuantity] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const vm = vaultMint.account;
  const v = vault.account;
  const isCall = "call" in v.optionType;
  const strike = usdcToNumber(v.strikePrice);
  const premiumPerContract = usdcToNumber(vm.premiumPerContract);
  const available = (vm.quantityMinted?.toNumber?.() || 0) - (vm.quantitySold?.toNumber?.() || 0);
  const days = daysUntilExpiry(v.expiry);
  const vol = getDefaultVolatility(market?.assetName || "SOL");
  const spot = spotPrice || strike;
  const fairValue = isCall ? calculateCallPremium(spot, strike, days, vol) : calculatePutPremium(spot, strike, days, vol);
  const greeks = isCall ? calculateCallGreeks(spot, strike, days, vol) : calculatePutGreeks(spot, strike, days, vol);

  const qtyParsed = parseInt(quantity);
  const qtyValid = !isNaN(qtyParsed) && qtyParsed > 0;
  const qty = qtyValid ? qtyParsed : 0;
  const totalCost = premiumPerContract * qty;
  // max_premium covers total cost (qty × per-contract) + 5% slippage
  const maxPremium = toUsdcBN(premiumPerContract * qty * 1.05);

  const handleBuy = async () => {
    if (!program || !publicKey || !qtyValid || qty > available) return;
    setSubmitting(true);
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);

      const buyerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const optionMint = vm.optionMint as PublicKey;
      const writer = vm.writer as PublicKey;
      const createdAt = vm.createdAt as BN;

      const [writerPositionPda] = deriveWriterPosition(vault.publicKey, writer);
      const [purchaseEscrowPda] = deriveVaultPurchaseEscrow(vault.publicKey, writer, createdAt);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
      const [hookState] = deriveHookStatePda(optionMint);

      const buyerOptionAccount = getAssociatedTokenAddressSync(optionMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        publicKey, buyerOptionAccount, publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

      const tx = await program.methods
        .purchaseFromVault(new BN(qty), maxPremium)
        .accountsStrict({
          buyer: publicKey,
          sharedVault: vault.publicKey,
          writerPosition: writerPositionPda,
          vaultMintRecord: vaultMint.publicKey,
          protocolState: protocolStatePda,
          market: v.market,
          optionMint,
          purchaseEscrow: purchaseEscrowPda,
          buyerOptionAccount,
          buyerUsdcAccount,
          vaultUsdcAccount: v.vaultUsdcAccount,
          treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          extraAccountMetaList,
          hookState,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([EXTRA_CU, createAtaIx])
        .rpc({ commitment: "confirmed" });

      showToast({ type: "success", title: "Purchased!", message: `Bought ${qty} contracts for $${totalCost.toFixed(2)} USDC`, txSignature: tx });
      onSuccess();
    } catch (err: any) {
      showToast({ type: "error", title: "Purchase failed", message: decodeError(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-text-primary mb-4">Buy Option</h2>
        <div className="rounded-xl bg-bg-primary border border-border p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg font-bold text-text-primary">{market?.assetName || "?"}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>{isCall ? "Call" : "Put"}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-text-muted">Strike:</span> <span className="text-text-primary font-medium">${formatUsdc(v.strikePrice)}</span></div>
            <div><span className="text-text-muted">Expiry:</span> <span className="text-text-primary font-medium">{formatExpiry(v.expiry)}</span></div>
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Contracts to buy</label>
          <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)}
            placeholder="1" min="1" max={available}
            className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          <div className="text-xs text-text-muted mt-1">Available: {available.toLocaleString()} contracts</div>
        </div>

        <div className="space-y-2 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Price per contract:</span>
            <span className="text-text-primary">${premiumPerContract.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Total cost:</span>
            <span className="text-gold font-bold text-lg">${totalCost.toFixed(2)} USDC</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">Fair Value (B-S):</span>
            <span className="text-text-secondary">${fairValue.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">Protocol Fee (0.5%):</span>
            <span className="text-text-secondary">${(totalCost * 0.005).toFixed(4)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">Max premium (slippage):</span>
            <span className="text-text-secondary">${(premiumPerContract * qty * 1.05).toFixed(2)}</span>
          </div>
          {/* Greeks */}
          <div className="pt-2 mt-2 border-t border-border/30">
            <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">Option Greeks</div>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div><span className="text-text-muted">Delta </span><span className="text-text-primary">{greeks.delta.toFixed(2)}</span></div>
              <div><span className="text-text-muted">Gamma </span><span className="text-text-primary">{greeks.gamma.toFixed(4)}</span></div>
              <div><span className="text-text-muted">Theta </span><span className="text-loss">{greeks.theta.toFixed(2)}</span></div>
              <div><span className="text-text-muted">Vega </span><span className="text-text-primary">{greeks.vega.toFixed(2)}</span></div>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-border py-3 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
          <button onClick={handleBuy} disabled={submitting || !qtyValid || qty > available}
            className="flex-1 rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50">
            {submitting ? "Confirm in wallet..." : "Confirm Buy"}
          </button>
        </div>
      </div>
    </div>
  );
};
