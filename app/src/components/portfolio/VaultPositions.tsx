import { FC, useState } from "react";
import { PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
import { formatUsdc, usdcToNumber, formatExpiry, toUsdcBN } from "../../utils/format";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";
import { deriveWriterPosition, deriveVaultPurchaseEscrow } from "../../hooks/useAccounts";
import { isEpochVault } from "../../hooks/useVaults";

interface VaultPositionsProps {
  vaults: { publicKey: PublicKey; account: any }[];
  myPositions: { publicKey: PublicKey; account: any }[];
  vaultMints: { publicKey: PublicKey; account: any }[];
  markets: { publicKey: PublicKey; account: any }[];
  program: any;
  publicKey: PublicKey;
  getUnclaimedPremium: (vault: any, position: any) => BN;
  onRefetch: () => void;
  onMint?: (vaultKey: PublicKey) => void;
}

export const VaultPositions: FC<VaultPositionsProps> = ({
  vaults, myPositions, vaultMints, markets, program, publicKey, getUnclaimedPremium, onRefetch, onMint,
}) => {
  const [actionId, setActionId] = useState<string | null>(null);

  // Build market lookup
  const marketMap = new Map<string, any>();
  markets.forEach((m) => marketMap.set(m.publicKey.toBase58(), m.account));

  const getVaultStatus = (v: any): "Active" | "Expired" | "Settled" => {
    if (v.isSettled) return "Settled";
    const expiry = typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber();
    if (Date.now() / 1000 >= expiry) return "Expired";
    return "Active";
  };

  const handleClaimPremium = async (vault: { publicKey: PublicKey; account: any }) => {
    setActionId("claim-" + vault.publicKey.toBase58());
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const [writerPositionPda] = deriveWriterPosition(vault.publicKey, publicKey);

      const tx = await program.methods.claimPremium()
        .accountsStrict({
          writer: publicKey,
          sharedVault: vault.publicKey,
          writerPosition: writerPositionPda,
          vaultUsdcAccount: vault.account.vaultUsdcAccount,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });
      showToast({ type: "success", title: "Premium claimed!", message: "USDC transferred to your wallet.", txSignature: tx });
      onRefetch();
    } catch (err: any) {
      showToast({ type: "error", title: "Claim failed", message: decodeError(err) });
    } finally { setActionId(null); }
  };

  const handleSettleVault = async (vault: { publicKey: PublicKey; account: any }) => {
    setActionId("settle-" + vault.publicKey.toBase58());
    try {
      const tx = await program.methods.settleVault()
        .accountsStrict({
          authority: publicKey,
          sharedVault: vault.publicKey,
          market: vault.account.market,
        })
        .rpc({ commitment: "confirmed" });
      showToast({ type: "success", title: "Vault settled!", message: "Collateral allocations finalized.", txSignature: tx });
      onRefetch();
    } catch (err: any) {
      showToast({ type: "error", title: "Settle failed", message: decodeError(err) });
    } finally { setActionId(null); }
  };

  const handleWithdrawPost = async (vault: { publicKey: PublicKey; account: any }) => {
    setActionId("withdraw-" + vault.publicKey.toBase58());
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const [writerPositionPda] = deriveWriterPosition(vault.publicKey, publicKey);

      const tx = await program.methods.withdrawPostSettlement()
        .accountsStrict({
          writer: publicKey,
          sharedVault: vault.publicKey,
          writerPosition: writerPositionPda,
          vaultUsdcAccount: vault.account.vaultUsdcAccount,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });
      showToast({ type: "success", title: "Withdrawn!", message: "Remaining collateral returned. Position closed.", txSignature: tx });
      onRefetch();
    } catch (err: any) {
      showToast({ type: "error", title: "Withdraw failed", message: decodeError(err) });
    } finally { setActionId(null); }
  };

  const handleBurnUnsold = async (vault: { publicKey: PublicKey; account: any }, vm: { publicKey: PublicKey; account: any }) => {
    setActionId("burn-" + vm.publicKey.toBase58());
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const [writerPositionPda] = deriveWriterPosition(vault.publicKey, publicKey);
      const writer = vm.account.writer as PublicKey;
      const createdAt = vm.account.createdAt as BN;
      const [purchaseEscrowPda] = deriveVaultPurchaseEscrow(vault.publicKey, writer, createdAt);

      const tx = await program.methods.burnUnsoldFromVault()
        .accountsStrict({
          writer: publicKey,
          sharedVault: vault.publicKey,
          writerPosition: writerPositionPda,
          vaultMintRecord: vm.publicKey,
          protocolState: protocolStatePda,
          optionMint: vm.account.optionMint,
          purchaseEscrow: purchaseEscrowPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: "confirmed" });
      showToast({ type: "success", title: "Unsold burned!", message: "Collateral freed.", txSignature: tx });
      onRefetch();
    } catch (err: any) {
      showToast({ type: "error", title: "Burn failed", message: decodeError(err) });
    } finally { setActionId(null); }
  };

  const handleWithdrawShares = async (vault: { publicKey: PublicKey; account: any }, shares: number) => {
    setActionId("wshr-" + vault.publicKey.toBase58());
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const [writerPositionPda] = deriveWriterPosition(vault.publicKey, publicKey);

      // Auto-claim premium first (program requires ClaimPremiumFirst)
      try {
        showToast({ type: "info", title: "Step 1/2", message: "Claiming premium..." });
        await program.methods.claimPremium()
          .accountsStrict({
            writer: publicKey,
            sharedVault: vault.publicKey,
            writerPosition: writerPositionPda,
            vaultUsdcAccount: vault.account.vaultUsdcAccount,
            writerUsdcAccount,
            protocolState: protocolStatePda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc({ commitment: "confirmed" });
      } catch (claimErr: any) {
        // NothingToClaim (6043 / 0x179B) is fine — proceed to withdraw.
        // Any other error (wallet rejection, RPC failure) should stop the flow.
        const errStr = claimErr?.message || claimErr?.toString() || "";
        const isNothingToClaim = errStr.includes("6043") || errStr.includes("179b") || errStr.includes("179B") || errStr.includes("NothingToClaim");
        if (!isNothingToClaim) {
          showToast({ type: "error", title: "Claim failed", message: decodeError(claimErr) });
          setActionId(null);
          return;
        }
      }

      showToast({ type: "info", title: "Step 2/2", message: "Withdrawing shares..." });
      const tx = await program.methods.withdrawFromVault(new BN(shares))
        .accountsStrict({
          writer: publicKey,
          sharedVault: vault.publicKey,
          writerPosition: writerPositionPda,
          vaultUsdcAccount: vault.account.vaultUsdcAccount,
          writerUsdcAccount,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });
      showToast({ type: "success", title: "Withdrawn!", message: `Shares withdrawn. USDC returned to wallet.`, txSignature: tx });
      onRefetch();
    } catch (err: any) {
      showToast({ type: "error", title: "Withdraw failed", message: decodeError(err) });
    } finally { setActionId(null); }
  };

  if (myPositions.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-bg-surface p-12 text-center">
        <div className="text-text-muted">No vault positions. Deposit collateral on the Write page.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {myPositions.map((wp) => {
        const vault = vaults.find((v) => v.publicKey.equals(wp.account.vault as PublicKey));
        if (!vault) return null;
        const v = vault.account;
        const mkt = marketMap.get((v.market as PublicKey).toBase58());
        const isCall = "call" in v.optionType;
        const status = getVaultStatus(v);
        const totalShares = v.totalShares.toNumber();
        const myShares = wp.account.shares.toNumber();
        const pct = totalShares > 0 ? ((myShares / totalShares) * 100).toFixed(1) : "0";
        const deposited = usdcToNumber(wp.account.depositedCollateral);
        const minted = wp.account.optionsMinted?.toNumber?.() || 0;
        const sold = wp.account.optionsSold?.toNumber?.() || 0;
        const unclaimed = getUnclaimedPremium(v, wp.account);
        const unclaimedNum = unclaimed.toNumber() / 1_000_000;

        // Find writer's vault mints with unsold tokens
        const myVaultMints = vaultMints.filter((vm) =>
          (vm.account.vault as PublicKey).equals(vault.publicKey) &&
          (vm.account.writer as PublicKey).equals(publicKey) &&
          ((vm.account.quantityMinted?.toNumber?.() || 0) - (vm.account.quantitySold?.toNumber?.() || 0)) > 0,
        );

        // Check if market is settled (needed for settle vault)
        const marketSettled = mkt?.isSettled ?? false;

        return (
          <div key={wp.publicKey.toBase58()} className="rounded-xl border border-border bg-bg-surface p-5">
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">{mkt?.assetName || "?"}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>
                  {isCall ? "Call" : "Put"}
                </span>
                {isEpochVault(vault) && <span className="text-xs px-2 py-0.5 rounded-full bg-sol-purple/10 text-sol-purple">Epoch</span>}
              </div>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                status === "Active" ? "bg-sol-green/10 text-sol-green" :
                status === "Expired" ? "bg-yellow-500/10 text-yellow-500" :
                "bg-blue-500/10 text-blue-400"
              }`}>{status}</span>
            </div>

            {/* Details grid */}
            <div className="grid grid-cols-4 gap-3 text-xs mb-3">
              <div><div className="text-text-muted">Strike</div><div className="text-text-primary font-medium">${formatUsdc(v.strikePrice)}</div></div>
              <div><div className="text-text-muted">Expiry</div><div className="text-text-primary font-medium">{formatExpiry(v.expiry)}</div></div>
              <div><div className="text-text-muted">Your Shares</div><div className="text-gold font-medium">{myShares.toLocaleString()} ({pct}%)</div></div>
              <div><div className="text-text-muted">Deposited</div><div className="text-text-primary font-medium">${deposited.toLocaleString()}</div></div>
            </div>
            <div className="grid grid-cols-4 gap-3 text-xs" title="Living Option Tokens created from your collateral. Sold contracts lock collateral until settlement.">
              <div><div className="text-text-muted">Minted</div><div className="text-text-primary font-medium">{minted} contracts</div></div>
              <div><div className="text-text-muted">Sold</div><div className="text-text-primary font-medium">{sold} contracts</div></div>
              <div><div className="text-text-muted">Unclaimed Premium</div><div className="text-gold font-bold">${unclaimedNum.toFixed(2)}</div></div>
              <div><div className="text-text-muted">Vault Total</div><div className="text-text-primary font-medium">${formatUsdc(v.totalCollateral)}</div></div>
            </div>

            {/* Collateral breakdown — shows what's locked vs free */}
            {(() => {
              const collPerContract = isCall ? usdcToNumber(v.strikePrice) * 2 : usdcToNumber(v.strikePrice);
              const backingSold = sold * collPerContract;
              const backingUnsold = (minted - sold) * collPerContract;
              const freeToWithdraw = Math.max(0, deposited - backingSold - backingUnsold);
              return (
                <div className="mt-3 p-3 rounded-lg bg-bg-primary/50 border border-border/30 text-xs space-y-1">
                  <div className="text-text-muted font-medium mb-1">Collateral Breakdown</div>
                  <div className="flex justify-between"><span className="text-text-muted">Deposited:</span><span className="text-text-primary">${deposited.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-text-muted">Backing sold contracts:</span><span className="text-text-secondary">${backingSold.toFixed(2)} {sold > 0 && `(locked — ${sold} sold)`}</span></div>
                  <div className="flex justify-between"><span className="text-text-muted">Backing unsold contracts:</span><span className="text-text-secondary">${backingUnsold.toFixed(2)} {minted - sold > 0 && "(burn to free)"}</span></div>
                  <div className="flex justify-between pt-1 border-t border-border/30"><span className="text-text-secondary font-medium">Free to withdraw:</span><span className="text-sol-green font-bold">${freeToWithdraw.toFixed(2)}</span></div>
                </div>
              );
            })()}

            {/* Actions */}
            <div className="mt-4 pt-3 border-t border-border/50 flex flex-wrap gap-2">
              {/* Mint options — before settlement, when nothing minted yet */}
              {status === "Active" && minted === 0 && myShares > 0 && onMint && (
                <button onClick={() => onMint(vault.publicKey)}
                  className="rounded-lg bg-gold/15 border border-gold/30 px-4 py-1.5 text-xs font-semibold text-gold hover:bg-gold/25 transition-colors">
                  Mint Options
                </button>
              )}

              {/* Info message when minted but nothing sold yet */}
              {status === "Active" && minted > 0 && sold === 0 && (
                <span className="text-xs text-text-muted py-1.5">Minted {minted} contracts — available for purchase on Trade page</span>
              )}

              {/* Claim premium — available anytime there's unclaimed premium */}
              {unclaimedNum > 0 && (
                <button onClick={() => handleClaimPremium(vault)} disabled={actionId !== null}
                  className="rounded-lg bg-gold/10 border border-gold/30 px-4 py-1.5 text-xs font-semibold text-gold hover:bg-gold/20 transition-colors disabled:opacity-50">
                  {actionId === "claim-" + vault.publicKey.toBase58() ? "Claiming..." : `Claim $${unclaimedNum.toFixed(2)} Premium`}
                </button>
              )}

              {/* Burn unsold — before settlement, if writer has unsold mints */}
              {status !== "Settled" && myVaultMints.length > 0 && myVaultMints.map((vm) => {
                const unsold = (vm.account.quantityMinted?.toNumber?.() || 0) - (vm.account.quantitySold?.toNumber?.() || 0);
                const collPerContract = isCall ? usdcToNumber(v.strikePrice) * 2 : usdcToNumber(v.strikePrice);
                const freed = unsold * collPerContract;
                return (
                  <button key={vm.publicKey.toBase58()} onClick={() => handleBurnUnsold(vault, vm)} disabled={actionId !== null}
                    className="rounded-lg bg-bg-primary border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                    title={`Burn ${unsold} unsold contracts to free $${freed.toFixed(2)} collateral`}>
                    {actionId === "burn-" + vm.publicKey.toBase58() ? "Burning..." : `Burn ${unsold} Unsold → Free $${freed.toFixed(0)}`}
                  </button>
                );
              })}

              {/* Withdraw collateral — before settlement, only if there's free collateral */}
              {status !== "Settled" && myShares > 0 && (() => {
                const collPerContract = isCall ? usdcToNumber(v.strikePrice) * 2 : usdcToNumber(v.strikePrice);
                const backingSold = sold * collPerContract;
                const backingUnsold = (minted - sold) * collPerContract;
                const freeToWithdraw = Math.max(0, deposited - backingSold - backingUnsold);
                const canWithdraw = freeToWithdraw > 0;
                return (
                  <button onClick={() => handleWithdrawShares(vault, myShares)} disabled={actionId !== null || !canWithdraw}
                    className="rounded-lg bg-blue-500/10 border border-blue-500/30 px-3 py-1.5 text-xs font-medium text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={canWithdraw ? `Withdraw $${freeToWithdraw.toFixed(2)} free USDC` : "All collateral is backing minted contracts. Burn unsold tokens first."}>
                    {actionId === "wshr-" + vault.publicKey.toBase58() ? "Withdrawing..." : canWithdraw ? `Withdraw $${freeToWithdraw.toFixed(0)} Collateral` : "Withdraw Collateral"}
                  </button>
                );
              })()}

              {/* Settle vault — after expiry, before settlement, if market is settled */}
              {status === "Expired" && !v.isSettled && marketSettled && (
                <button onClick={() => handleSettleVault(vault)} disabled={actionId !== null}
                  className="rounded-lg bg-yellow-500/10 border border-yellow-500/30 px-4 py-1.5 text-xs font-semibold text-yellow-500 hover:bg-yellow-500/20 transition-colors disabled:opacity-50">
                  {actionId === "settle-" + vault.publicKey.toBase58() ? "Settling..." : "Settle Vault"}
                </button>
              )}
              {status === "Expired" && !v.isSettled && !marketSettled && (
                <span className="text-xs text-text-muted py-1.5">Waiting for market settlement (admin)</span>
              )}

              {/* Withdraw post settlement — after vault is settled */}
              {status === "Settled" && (
                <button onClick={() => handleWithdrawPost(vault)} disabled={actionId !== null}
                  className="rounded-lg bg-blue-500/10 border border-blue-500/30 px-4 py-1.5 text-xs font-semibold text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-50">
                  {actionId === "withdraw-" + vault.publicKey.toBase58() ? "Withdrawing..." : "Withdraw & Close Position"}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
