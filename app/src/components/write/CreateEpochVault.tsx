import { FC, useState, useMemo, useEffect } from "react";
import { PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
import { formatUsdc, toUsdcBN, usdcToNumber } from "../../utils/format";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";
import { deriveSharedVault, deriveVaultUsdc, deriveWriterPosition, deriveEpochConfig } from "../../hooks/useAccounts";

interface CreateEpochVaultProps {
  markets: { publicKey: PublicKey; account: any }[];
  epochConfig: { publicKey: PublicKey; account: any } | null;
  program: any;
  publicKey: PublicKey;
  onBack: () => void;
  onSuccess: (vaultKey: PublicKey) => void;
}

/** Compute next Friday 08:00 UTC that is at least min_epoch_duration_days away */
function nextEpochExpiry(minDays: number): number {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  let daysUntilFriday = (5 - dayOfWeek + 7) % 7;
  if (daysUntilFriday === 0) {
    const fridayAt8 = new Date(now);
    fridayAt8.setUTCHours(8, 0, 0, 0);
    if (now >= fridayAt8) daysUntilFriday = 7;
  }
  // Ensure at least minDays buffer
  if (daysUntilFriday * 86400 < minDays * 86400 + 30) {
    daysUntilFriday += 7;
  }
  const friday = new Date(now);
  friday.setUTCDate(friday.getUTCDate() + daysUntilFriday);
  friday.setUTCHours(8, 0, 0, 0);
  return Math.floor(friday.getTime() / 1000);
}

export const CreateEpochVault: FC<CreateEpochVaultProps> = ({ markets, epochConfig, program, publicKey, onBack, onSuccess }) => {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [selectedMarket, setSelectedMarket] = useState("");
  // Inline new-market fields
  const [newAsset, setNewAsset] = useState("");
  const [newAssetClass, setNewAssetClass] = useState(0);
  const [newPythFeed, setNewPythFeed] = useState("");
  const [strikeInput, setStrikeInput] = useState("");
  const [optionType, setOptionType] = useState<"call" | "put">("call");
  const [collateral, setCollateral] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const minDays = epochConfig?.account.minEpochDurationDays ?? 1;
  const expiryTs = useMemo(() => nextEpochExpiry(minDays), [minDays]);
  const expiryDate = new Date(expiryTs * 1000);

  const marketData = markets.find((m) => m.publicKey.toBase58() === selectedMarket);
  const isCall = optionType === "call";
  const depositNum = parseFloat(collateral) || 0;
  const strikeNum = parseFloat(strikeInput) || 0;
  const contracts = strikeNum > 0 ? (isCall ? Math.floor(depositNum / (strikeNum * 2)) : Math.floor(depositNum / strikeNum)) : 0;

  // Reset selected market when switching modes
  useEffect(() => { if (mode === "new") setSelectedMarket(""); }, [mode]);

  const handleCreate = async () => {
    if (!program || !publicKey || depositNum <= 0 || strikeNum <= 0) return;
    if (!epochConfig) {
      showToast({ type: "error", title: "Epoch config missing", message: "Admin must initialize epoch config first." });
      return;
    }
    if (mode === "new" && (!newAsset || !newPythFeed)) {
      showToast({ type: "error", title: "Missing fields", message: "Provide asset name and Pyth feed address." });
      return;
    }

    setSubmitting(true);
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const [epochConfigPda] = deriveEpochConfig();

      const strikeBN = toUsdcBN(strikeNum);
      const expiryBN = new BN(expiryTs);
      const optTypeEnum = isCall ? { call: {} } : { put: {} };
      const optTypeIndex = isCall ? 0 : 1;

      let marketPda: PublicKey;

      if (mode === "new") {
        // Step 0: Create market first
        const asset = newAsset.toUpperCase();
        let feedPubkey: PublicKey;
        try { feedPubkey = new PublicKey(newPythFeed); }
        catch { showToast({ type: "error", title: "Invalid Pyth feed pubkey" }); setSubmitting(false); return; }

        [marketPda] = PublicKey.findProgramAddressSync([
          Buffer.from("market"), Buffer.from(asset),
          strikeBN.toArrayLike(Buffer, "le", 8),
          expiryBN.toArrayLike(Buffer, "le", 8),
          Buffer.from([optTypeIndex]),
        ], program.programId);

        // Check if market already exists
        let marketExists = false;
        try { await program.account.optionsMarket.fetch(marketPda); marketExists = true; } catch { /* */ }

        if (!marketExists) {
          showToast({ type: "info", title: "Step 1/3", message: "Creating market..." });
          await program.methods
            .createMarket(asset, strikeBN, expiryBN, optTypeEnum as any, feedPubkey, newAssetClass)
            .accountsStrict({
              creator: publicKey,
              protocolState: protocolStatePda,
              market: marketPda,
              systemProgram: SystemProgram.programId,
            })
            .rpc({ commitment: "confirmed" });
        }
      } else {
        if (!marketData) { showToast({ type: "error", title: "Select a market" }); setSubmitting(false); return; }
        // Existing market: need to find (or create) a market with THIS strike and THIS expiry
        // Since existing market selector gives us (asset, strike, type) but we need a new expiry (next epoch),
        // we need to create a market with the same asset and type but our epoch expiry
        const asset = marketData.account.assetName as string;
        const feedPubkey = marketData.account.pythFeed as PublicKey;
        const assetClass = marketData.account.assetClass as number;

        [marketPda] = PublicKey.findProgramAddressSync([
          Buffer.from("market"), Buffer.from(asset),
          strikeBN.toArrayLike(Buffer, "le", 8),
          expiryBN.toArrayLike(Buffer, "le", 8),
          Buffer.from([optTypeIndex]),
        ], program.programId);

        let marketExists = false;
        try { await program.account.optionsMarket.fetch(marketPda); marketExists = true; } catch { /* */ }

        if (!marketExists) {
          showToast({ type: "info", title: "Step 1/3", message: "Creating market..." });
          await program.methods
            .createMarket(asset, strikeBN, expiryBN, optTypeEnum as any, feedPubkey, assetClass)
            .accountsStrict({
              creator: publicKey,
              protocolState: protocolStatePda,
              market: marketPda,
              systemProgram: SystemProgram.programId,
            })
            .rpc({ commitment: "confirmed" });
        }
      }

      // Step 1: Create shared vault (Epoch type)
      const [sharedVaultPda] = deriveSharedVault(marketPda, strikeBN, expiryBN, optTypeIndex);
      const [vaultUsdcPda] = deriveVaultUsdc(sharedVaultPda);

      let vaultExists = false;
      try { await program.account.sharedVault.fetch(sharedVaultPda); vaultExists = true; } catch { /* */ }

      if (!vaultExists) {
        showToast({ type: "info", title: "Step 2/3", message: "Creating epoch vault..." });
        await program.methods
          .createSharedVault(strikeBN, expiryBN, optTypeEnum as any, { epoch: {} })
          .accountsStrict({
            creator: publicKey,
            market: marketPda,
            sharedVault: sharedVaultPda,
            vaultUsdcAccount: vaultUsdcPda,
            usdcMint: protocolState.usdcMint,
            protocolState: protocolStatePda,
            epochConfig: epochConfigPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
          .rpc({ commitment: "confirmed" });
      }

      // Step 2: Deposit collateral
      showToast({ type: "info", title: "Step 3/3", message: `Depositing $${depositNum.toLocaleString()} USDC` });
      const [writerPositionPda] = deriveWriterPosition(sharedVaultPda, publicKey);
      const tx = await program.methods
        .depositToVault(toUsdcBN(depositNum))
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

      showToast({ type: "success", title: "Epoch vault ready!", message: `Deposited $${depositNum.toLocaleString()} USDC`, txSignature: tx });
      onSuccess(sharedVaultPda);
    } catch (err: any) {
      showToast({ type: "error", title: "Failed", message: decodeError(err) });
    } finally {
      setSubmitting(false);
    }
  };

  // Unique markets by (asset, strike, type) — user's strike will override
  const uniqueMarkets = useMemo(() => {
    const map = new Map<string, typeof markets[0]>();
    for (const m of markets) {
      const key = m.account.assetName;
      if (!map.has(key)) map.set(key, m);
    }
    return Array.from(map.values()).sort((a, b) => a.account.assetName.localeCompare(b.account.assetName));
  }, [markets]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sm text-text-secondary hover:text-text-primary transition-colors">&larr; Back</button>
        <h2 className="text-lg font-semibold text-text-primary">Create Epoch Vault</h2>
      </div>

      <div className="rounded-2xl border border-border bg-bg-surface p-6 max-w-lg">
        <div className="space-y-4">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <button onClick={() => setMode("existing")}
              className={`flex-1 rounded-lg py-2 text-xs font-medium transition-all ${mode === "existing" ? "bg-sol-purple/15 text-sol-purple border border-sol-purple/30" : "bg-bg-primary text-text-secondary border border-border"}`}>
              Existing Asset
            </button>
            <button onClick={() => setMode("new")}
              className={`flex-1 rounded-lg py-2 text-xs font-medium transition-all ${mode === "new" ? "bg-gold/15 text-gold border border-gold/30" : "bg-bg-primary text-text-secondary border border-border"}`}>
              + Add New Asset
            </button>
          </div>

          {mode === "existing" ? (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Asset</label>
              <select value={selectedMarket} onChange={(e) => setSelectedMarket(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none">
                <option value="">Choose an asset...</option>
                {uniqueMarkets.map((m) => (
                  <option key={m.publicKey.toBase58()} value={m.publicKey.toBase58()}>
                    {m.account.assetName}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Asset Name (max 16 chars)</label>
                <input type="text" value={newAsset} onChange={(e) => setNewAsset(e.target.value.toUpperCase())} maxLength={16}
                  placeholder="NVDA, WTI, ..."
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Asset Class</label>
                <select value={newAssetClass} onChange={(e) => setNewAssetClass(parseInt(e.target.value))}
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none">
                  <option value={0}>Crypto</option>
                  <option value={1}>Commodity</option>
                  <option value={2}>Equity</option>
                  <option value={3}>Forex</option>
                  <option value={4}>ETF / Fund</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Pyth Feed Address</label>
                <input type="text" value={newPythFeed} onChange={(e) => setNewPythFeed(e.target.value)}
                  placeholder="Pyth feed pubkey..."
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-xs font-mono text-text-primary focus:border-gold/50 focus:outline-none" />
              </div>
            </>
          )}

          {/* Strike, Type, Expiry */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Strike Price (USDC)</label>
            <input type="number" value={strikeInput} onChange={(e) => setStrikeInput(e.target.value)} placeholder="100"
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Option Type</label>
            <div className="flex gap-2">
              <button onClick={() => setOptionType("call")} className={`flex-1 rounded-lg py-2 text-xs font-medium ${optionType === "call" ? "bg-sol-green/15 text-sol-green border border-sol-green/30" : "bg-bg-primary text-text-secondary border border-border"}`}>Call</button>
              <button onClick={() => setOptionType("put")} className={`flex-1 rounded-lg py-2 text-xs font-medium ${optionType === "put" ? "bg-sol-purple/15 text-sol-purple border border-sol-purple/30" : "bg-bg-primary text-text-secondary border border-border"}`}>Put</button>
            </div>
          </div>

          <div className="rounded-lg bg-bg-primary border border-border/50 p-3 text-xs">
            <div className="text-text-muted mb-1">Expiry (next epoch — read only)</div>
            <div className="text-text-primary font-medium">{expiryDate.toLocaleString()} UTC</div>
            <div className="text-text-muted mt-1">Friday 08:00 UTC, at least {minDays} day{minDays !== 1 ? "s" : ""} away</div>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Collateral (USDC)</label>
            <input type="number" value={collateral} onChange={(e) => setCollateral(e.target.value)} placeholder="0.00" min="0" step="0.01"
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
            {strikeNum > 0 && (
              <div className="text-xs text-text-muted mt-1">
                {isCall ? "Calls require 2x strike per contract." : "Puts require 1x strike per contract."}
                {contracts > 0 && <span className="text-gold ml-1">This backs {contracts} contract{contracts !== 1 ? "s" : ""}.</span>}
              </div>
            )}
          </div>

          <button onClick={handleCreate}
            disabled={submitting || depositNum <= 0 || strikeNum <= 0 || (mode === "existing" && !selectedMarket) || (mode === "new" && (!newAsset || !newPythFeed))}
            className="w-full rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? "Creating..." : "Create Epoch Vault & Deposit"}
          </button>
        </div>
      </div>
    </div>
  );
};
