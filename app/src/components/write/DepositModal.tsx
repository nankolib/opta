import { FC, useState } from "react";
import { PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
import { formatUsdc, usdcToNumber, toUsdcBN, formatExpiry } from "../../utils/format";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";
import { deriveWriterPosition, deriveVaultUsdc } from "../../hooks/useAccounts";

interface DepositModalProps {
  vault: { publicKey: PublicKey; account: any };
  market: any; // market account data
  myPosition: { publicKey: PublicKey; account: any } | null;
  program: any;
  publicKey: PublicKey;
  onClose: () => void;
  onSuccess: (vaultKey: PublicKey) => void;
}

export const DepositModal: FC<DepositModalProps> = ({ vault, market, myPosition, program, publicKey, onClose, onSuccess }) => {
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const v = vault.account;
  const isCall = "call" in v.optionType;
  const totalCollateral = usdcToNumber(v.totalCollateral);
  const totalShares = v.totalShares.toNumber();
  const myShares = myPosition?.account.shares.toNumber() || 0;
  const depositNum = parseFloat(amount) || 0;

  // Share estimation: first deposit is 1:1, subsequent is proportional
  const estimatedShares = totalShares === 0 ? depositNum * 1_000_000 : (depositNum / totalCollateral) * totalShares;
  const newTotalShares = totalShares + estimatedShares;
  const ownershipPct = newTotalShares > 0 ? (((myShares + estimatedShares) / newTotalShares) * 100).toFixed(1) : "0";

  const handleDeposit = async () => {
    if (!program || !publicKey || depositNum <= 0) return;
    setSubmitting(true);
    try {
      const amountBN = toUsdcBN(depositNum);
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const [writerPositionPda] = deriveWriterPosition(vault.publicKey, publicKey);
      const [vaultUsdcPda] = deriveVaultUsdc(vault.publicKey);

      const tx = await program.methods
        .depositToVault(amountBN)
        .accountsStrict({
          writer: publicKey,
          sharedVault: vault.publicKey,
          writerPosition: writerPositionPda,
          writerUsdcAccount,
          vaultUsdcAccount: vaultUsdcPda,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: "confirmed" });

      showToast({ type: "success", title: "Deposited!", message: `$${depositNum.toLocaleString()} USDC deposited to vault`, txSignature: tx });
      onSuccess(vault.publicKey);
    } catch (err: any) {
      showToast({ type: "error", title: "Deposit failed", message: decodeError(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-bg-surface p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-text-primary mb-4">Deposit to Vault</h2>

        {/* Vault summary */}
        <div className="rounded-xl bg-bg-primary border border-border p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg font-bold text-text-primary">{market.assetName}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>
              {isCall ? "Call" : "Put"}
            </span>
            {"epoch" in v.vaultType && <span className="text-xs px-2 py-0.5 rounded-full bg-sol-purple/10 text-sol-purple">Epoch</span>}
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div><span className="text-text-muted">Strike:</span> <span className="text-text-primary font-medium">${formatUsdc(v.strikePrice)}</span></div>
            <div><span className="text-text-muted">Expiry:</span> <span className="text-text-primary font-medium">{formatExpiry(v.expiry)}</span></div>
            <div><span className="text-text-muted">Total pooled:</span> <span className="text-text-primary font-medium">${formatUsdc(v.totalCollateral)}</span></div>
            <div><span className="text-text-muted">Your shares:</span> <span className="text-gold font-medium">{myShares > 0 ? myShares.toLocaleString() : "None"}</span></div>
          </div>
        </div>

        {/* Amount input */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Amount to deposit (USDC)</label>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" min="0" step="0.01"
            className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
        </div>

        {/* Share estimation */}
        {depositNum > 0 && (
          <div className="rounded-lg bg-bg-primary border border-border/50 p-3 mb-4 text-xs space-y-1">
            <div className="flex justify-between"><span className="text-text-muted">Estimated new shares:</span><span className="text-text-primary">{Math.floor(estimatedShares).toLocaleString()}</span></div>
            <div className="flex justify-between"><span className="text-text-muted">Your ownership after deposit:</span><span className="text-gold font-medium">{ownershipPct}%</span></div>
          </div>
        )}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-border py-3 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
          <button onClick={handleDeposit} disabled={submitting || depositNum <= 0}
            className="flex-1 rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50">
            {submitting ? "Confirm in wallet..." : "Deposit"}
          </button>
        </div>
      </div>
    </div>
  );
};
