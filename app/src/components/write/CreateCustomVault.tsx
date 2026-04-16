import { FC, useState, useMemo } from "react";
import { PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
import { formatUsdc, toUsdcBN, usdcToNumber } from "../../utils/format";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";
import { deriveSharedVault, deriveVaultUsdc, deriveWriterPosition } from "../../hooks/useAccounts";

interface CreateCustomVaultProps {
  markets: { publicKey: PublicKey; account: any }[];
  program: any;
  publicKey: PublicKey;
  onBack: () => void;
  onSuccess: (vaultKey: PublicKey) => void;
}

const EXPIRY_PRESETS = [
  { label: "5 min", seconds: 300 },
  { label: "15 min", seconds: 900 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "1 week", seconds: 604800 },
];

export const CreateCustomVault: FC<CreateCustomVaultProps> = ({ markets, program, publicKey, onBack, onSuccess }) => {
  const [selectedMarket, setSelectedMarket] = useState("");
  const [collateral, setCollateral] = useState("");
  const [expirySeconds, setExpirySeconds] = useState(3600);
  const [customExpiry, setCustomExpiry] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const market = markets.find((m) => m.publicKey.toBase58() === selectedMarket);
  const mkt = market?.account;

  const expiryTimestamp = useMemo(() => {
    if (customExpiry) {
      return Math.floor(new Date(customExpiry).getTime() / 1000);
    }
    return Math.floor(Date.now() / 1000) + expirySeconds;
  }, [customExpiry, expirySeconds]);

  const expiryDate = new Date(expiryTimestamp * 1000);
  const isCall = mkt ? "call" in mkt.optionType : true;
  const strike = mkt ? usdcToNumber(mkt.strikePrice) : 0;
  const depositNum = parseFloat(collateral) || 0;
  const contracts = strike > 0 ? (isCall ? Math.floor(depositNum / (strike * 2)) : Math.floor(depositNum / strike)) : 0;

  const handleCreate = async () => {
    if (!program || !publicKey || !market || depositNum <= 0) return;
    setSubmitting(true);
    try {
      const strikePrice = market.account.strikePrice as BN;
      const expiry = new BN(expiryTimestamp);
      const optionType = market.account.optionType;
      const optionTypeIndex = isCall ? 0 : 1;

      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const [sharedVaultPda] = deriveSharedVault(market.publicKey, strikePrice, expiry, optionTypeIndex);
      const [vaultUsdcPda] = deriveVaultUsdc(sharedVaultPda);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);

      // Try creating vault (may already exist)
      let vaultExists = false;
      try {
        await program.account.sharedVault.fetch(sharedVaultPda);
        vaultExists = true;
      } catch {
        // Vault doesn't exist, create it
      }

      if (!vaultExists) {
        showToast({ type: "info", title: "Step 1/2", message: "Creating vault..." });
        await program.methods
          .createSharedVault(strikePrice, expiry, optionType, { custom: {} })
          .accountsStrict({
            creator: publicKey,
            market: market.publicKey,
            sharedVault: sharedVaultPda,
            vaultUsdcAccount: vaultUsdcPda,
            usdcMint: protocolState.usdcMint,
            protocolState: protocolStatePda,
            epochConfig: null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
          .rpc({ commitment: "confirmed" });
      }

      // Deposit collateral
      showToast({ type: "info", title: vaultExists ? "Depositing..." : "Step 2/2", message: `Depositing $${depositNum.toLocaleString()} USDC` });
      const [writerPositionPda] = deriveWriterPosition(sharedVaultPda, publicKey);
      const amountBN = toUsdcBN(depositNum);

      const tx = await program.methods
        .depositToVault(amountBN)
        .accountsStrict({
          writer: publicKey,
          sharedVault: sharedVaultPda,
          writerPosition: writerPositionPda,
          writerUsdcAccount,
          vaultUsdcAccount: vaultUsdcPda,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: "confirmed" });

      showToast({ type: "success", title: "Vault ready!", message: `Created & deposited $${depositNum.toLocaleString()} USDC`, txSignature: tx });
      onSuccess(sharedVaultPda);
    } catch (err: any) {
      showToast({ type: "error", title: "Failed", message: decodeError(err) });
    } finally {
      setSubmitting(false);
    }
  };

  // Deduplicate markets by asset+strike+type (use newest expiry)
  const uniqueMarkets = useMemo(() => {
    const map = new Map<string, typeof markets[0]>();
    for (const m of markets) {
      const isC = "call" in m.account.optionType;
      const key = `${m.account.assetName}-${m.account.strikePrice.toString()}-${isC ? "C" : "P"}`;
      map.set(key, m);
    }
    return Array.from(map.values());
  }, [markets]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-text-secondary hover:text-text-primary transition-colors">&larr; Back</button>
        <h2 className="text-lg font-semibold text-text-primary">Create Custom Vault</h2>
      </div>

      <div className="rounded-2xl border border-border bg-bg-surface p-6 max-w-lg">
        <div className="space-y-4">
          {/* Market selection */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Market (Asset + Strike + Type)</label>
            <select value={selectedMarket} onChange={(e) => setSelectedMarket(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none">
              <option value="">Choose a market...</option>
              {uniqueMarkets.map((m) => {
                const c = "call" in m.account.optionType;
                return (
                  <option key={m.publicKey.toBase58()} value={m.publicKey.toBase58()}>
                    {m.account.assetName} ${formatUsdc(m.account.strikePrice)} {c ? "Call" : "Put"}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Expiry */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Expiry</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {EXPIRY_PRESETS.map((p) => (
                <button key={p.label} onClick={() => { setExpirySeconds(p.seconds); setCustomExpiry(""); }}
                  className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                    !customExpiry && expirySeconds === p.seconds
                      ? "bg-gold/15 border-gold/30 text-gold"
                      : "bg-bg-primary border-border text-text-secondary hover:border-border-light"
                  }`}>
                  {p.label}
                </button>
              ))}
            </div>
            <input type="datetime-local" value={customExpiry} onChange={(e) => setCustomExpiry(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary focus:border-gold/50 focus:outline-none" />
            <div className="text-xs text-text-muted mt-1">
              Expires: {expiryDate.toLocaleString()} (unix: {expiryTimestamp})
            </div>
          </div>

          {/* Collateral */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Collateral (USDC)</label>
            <input type="number" value={collateral} onChange={(e) => setCollateral(e.target.value)} placeholder="0.00" min="0" step="0.01"
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
            {strike > 0 && (
              <div className="text-xs text-text-muted mt-1">
                {isCall ? "Calls require 2x strike per contract." : "Puts require 1x strike per contract."}
                {contracts > 0 && <span className="text-gold ml-1">This backs {contracts} contract{contracts !== 1 ? "s" : ""}.</span>}
              </div>
            )}
          </div>

          <button onClick={handleCreate} disabled={submitting || !selectedMarket || depositNum <= 0}
            className="w-full rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? "Creating..." : "Create Vault & Deposit"}
          </button>
        </div>
      </div>
    </div>
  );
};
