import { FC, useState, useMemo, useEffect } from "react";
import { PublicKey, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import BN from "bn.js";
import { formatUsdc, usdcToNumber, toUsdcBN, formatExpiry } from "../../utils/format";
import { showToast } from "../Toast";
import {
  deriveWriterPosition,
  deriveVaultOptionMint,
  deriveVaultPurchaseEscrow,
  deriveVaultMintRecord,
} from "../../hooks/useAccounts";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID, deriveExtraAccountMetaListPda, deriveHookStatePda } from "../../utils/constants";
import { calculateCallPremium, calculatePutPremium, calculateCallGreeks, calculatePutGreeks, getDefaultVolatility } from "../../utils/blackScholes";
import { usePythPrices } from "../../hooks/usePythPrices";
import { decodeError } from "../../utils/errorDecoder";
import { useNavigate } from "react-router-dom";

interface MintFromVaultProps {
  vault: { publicKey: PublicKey; account: any };
  market: any;
  writerPosition: { publicKey: PublicKey; account: any } | null;
  program: any;
  publicKey: PublicKey;
  onBack: () => void;
  onRefetch: () => void;
}

export const MintFromVault: FC<MintFromVaultProps> = ({ vault, market, writerPosition, program, publicKey, onBack, onRefetch }) => {
  const navigate = useNavigate();
  const [quantity, setQuantity] = useState("");
  const [premium, setPremium] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [mintSuccess, setMintSuccess] = useState(false);

  const v = vault.account;
  const isCall = "call" in v.optionType;
  const strike = usdcToNumber(v.strikePrice);
  const myShares = writerPosition?.account.shares.toNumber() || 0;
  const myCollateral = writerPosition?.account.depositedCollateral ? usdcToNumber(writerPosition.account.depositedCollateral) : 0;
  const optionsMinted = writerPosition?.account.optionsMinted?.toNumber() || 0;

  // Available collateral = deposited - committed (committed = minted * collateral-per-contract)
  const collateralPerContract = isCall ? strike * 2 : strike;
  const committedCollateral = optionsMinted * collateralPerContract;
  const freeCollateral = Math.max(0, myCollateral - committedCollateral);
  const maxContracts = collateralPerContract > 0 ? Math.floor(freeCollateral / collateralPerContract) : 0;

  // Spot price + B-S fair value
  const assetName = market?.assetName || "SOL";
  const { prices } = usePythPrices([assetName]);
  const spot = prices[assetName] || strike;
  const daysToExpiry = Math.max(0, (v.expiry.toNumber() - Date.now() / 1000) / 86400);
  const vol = getDefaultVolatility(assetName);
  const fairValue = isCall
    ? calculateCallPremium(spot, strike, daysToExpiry, vol)
    : calculatePutPremium(spot, strike, daysToExpiry, vol);
  const greeks = isCall
    ? calculateCallGreeks(spot, strike, daysToExpiry, vol)
    : calculatePutGreeks(spot, strike, daysToExpiry, vol);

  const qtyNum = parseInt(quantity) || 0;
  const premNum = parseFloat(premium) || 0;
  const premiumWarning = fairValue > 0 && premNum > 0
    ? (premNum > fairValue * 2 ? "Premium is significantly above fair value" : premNum < fairValue * 0.5 ? "Premium is significantly below fair value" : null)
    : null;

  const fillFairValue = () => {
    setQuantity(maxContracts.toString());
    setPremium(fairValue.toFixed(2));
  };

  const handleMint = async () => {
    if (!program || !publicKey || qtyNum <= 0 || premNum <= 0) return;
    setSubmitting(true);
    try {
      const createdAt = new BN(Math.floor(Date.now() / 1000));
      const quantityBN = new BN(qtyNum);
      const premiumBN = toUsdcBN(premNum);

      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const [writerPositionPda] = deriveWriterPosition(vault.publicKey, publicKey);
      const [optionMintPda] = deriveVaultOptionMint(vault.publicKey, publicKey, createdAt);
      const [purchaseEscrowPda] = deriveVaultPurchaseEscrow(vault.publicKey, publicKey, createdAt);
      const [vaultMintRecordPda] = deriveVaultMintRecord(optionMintPda);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
      const [hookState] = deriveHookStatePda(optionMintPda);

      const tx = await program.methods
        .mintFromVault(quantityBN, premiumBN, createdAt)
        .accountsStrict({
          writer: publicKey,
          sharedVault: vault.publicKey,
          writerPosition: writerPositionPda,
          market: v.market,
          protocolState: protocolStatePda,
          optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda,
          vaultMintRecord: vaultMintRecordPda,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          extraAccountMetaList,
          hookState,
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
        .rpc({ commitment: "confirmed" });

      showToast({ type: "success", title: "Options minted!", message: `${qtyNum} contracts at $${premNum.toFixed(2)} premium`, txSignature: tx });
      setMintSuccess(true);
      onRefetch();
    } catch (err: any) {
      showToast({ type: "error", title: "Mint failed", message: decodeError(err) });
    } finally {
      setSubmitting(false);
    }
  };

  // Success screen
  if (mintSuccess) {
    return (
      <div className="max-w-lg">
        <div className="rounded-2xl border border-sol-green/30 bg-sol-green/5 p-8 text-center space-y-4">
          <div className="text-4xl">&#10003;</div>
          <h2 className="text-xl font-bold text-text-primary">Options Minted!</h2>
          <p className="text-text-secondary text-sm">
            Successfully minted <span className="text-gold font-semibold">{qtyNum} option tokens</span> at <span className="text-gold font-semibold">${premNum.toFixed(2)}</span> premium per contract.
          </p>
          <p className="text-text-muted text-xs">These tokens are now available for purchase on the Trade page.</p>
          <div className="flex gap-3 justify-center pt-2">
            <button onClick={() => navigate("/portfolio")}
              className="rounded-xl border border-border px-6 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">
              View Portfolio
            </button>
            <button onClick={() => { setMintSuccess(false); setQuantity(""); setPremium(""); }}
              className="rounded-xl bg-gold px-6 py-2.5 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors">
              Mint More
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-text-secondary hover:text-text-primary transition-colors">&larr; Back</button>
        <h2 className="text-lg font-semibold text-text-primary">Mint Option Tokens</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Position summary */}
        <div className="rounded-2xl border border-border bg-bg-surface p-6">
          <h3 className="text-sm font-semibold text-text-secondary mb-4">Your Vault Position</h3>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold text-text-primary">{assetName}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>
                {isCall ? "Call" : "Put"}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><div className="text-text-muted">Strike</div><div className="text-text-primary font-medium">${strike.toLocaleString()}</div></div>
              <div><div className="text-text-muted">Expiry</div><div className="text-text-primary font-medium">{formatExpiry(v.expiry)}</div></div>
              <div><div className="text-text-muted">Your collateral</div><div className="text-text-primary font-medium">${myCollateral.toLocaleString()}</div></div>
              <div><div className="text-text-muted">Free collateral</div><div className="text-gold font-medium">${freeCollateral.toLocaleString()}</div></div>
              <div><div className="text-text-muted">Already minted</div><div className="text-text-primary font-medium">{optionsMinted}</div></div>
              <div><div className="text-text-muted">Max new contracts</div><div className="text-gold font-bold">{maxContracts}</div></div>
            </div>
            <div className="pt-2 border-t border-border/50 text-xs">
              <div className="flex justify-between"><span className="text-text-muted">Spot price:</span><span className="text-text-primary">${spot.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-text-muted">B-S fair value:</span><span className="text-gold">${fairValue.toFixed(2)} (&#916; {greeks.delta.toFixed(2)})</span></div>
              <div className="flex justify-between"><span className="text-text-muted">Days to expiry:</span><span className="text-text-primary">{daysToExpiry.toFixed(1)}</span></div>
            </div>
          </div>
        </div>

        {/* Mint form */}
        <div className="rounded-2xl border border-border bg-bg-surface p-6">
          <h3 className="text-sm font-semibold text-text-secondary mb-4">Mint Options</h3>

          {maxContracts === 0 ? (
            <div className="text-center py-8">
              <p className="text-text-muted text-sm mb-2">All collateral is committed to minted contracts.</p>
              <p className="text-text-muted text-xs mb-4">Deposit more collateral to mint additional options.</p>
              <button onClick={onBack}
                className="rounded-xl border border-gold/30 bg-gold/10 px-5 py-2 text-xs font-semibold text-gold hover:bg-gold/20 transition-colors">
                Deposit More Collateral
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <button onClick={fillFairValue}
                className="w-full rounded-lg bg-gold/10 border border-gold/20 py-2.5 text-xs font-semibold text-gold hover:bg-gold/20 transition-colors">
                Mint All at Fair Value ({maxContracts} contracts @ ${fairValue.toFixed(2)})
              </button>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Quantity (max: {maxContracts})</label>
                <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" min="1" max={maxContracts} step="1"
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
              </div>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Premium per contract (USDC)
                  <span className="text-gold ml-1">Fair: ${fairValue.toFixed(2)}</span>
                </label>
                <input type="number" value={premium} onChange={(e) => setPremium(e.target.value)} placeholder={fairValue.toFixed(2)} min="0" step="0.01"
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
                {premiumWarning && (
                  <div className="text-xs text-yellow-400 mt-1">{premiumWarning}</div>
                )}
              </div>

              {qtyNum > 0 && premNum > 0 && (
                <div className="rounded-lg bg-bg-primary border border-border/50 p-3 text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-text-muted">Total premium revenue:</span><span className="text-gold font-medium">${(qtyNum * premNum).toFixed(2)} USDC</span></div>
                  <div className="flex justify-between"><span className="text-text-muted">Collateral locked:</span><span className="text-text-primary">${(qtyNum * collateralPerContract).toLocaleString()} USDC</span></div>
                </div>
              )}

              <button onClick={handleMint} disabled={submitting || qtyNum <= 0 || qtyNum > maxContracts || premNum <= 0}
                className="w-full rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {submitting ? "Confirm in wallet..." : "Mint Option Tokens"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
