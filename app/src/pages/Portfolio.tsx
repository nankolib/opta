import { FC, useEffect, useState, useMemo } from "react";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { useProgram } from "../hooks/useProgram";
import { safeFetchAll } from "../hooks/useFetchAccounts";
import { showToast } from "../components/Toast";
import { TOKEN_2022_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID, deriveExtraAccountMetaListPda, deriveHookStatePda } from "../utils/constants";
import { formatUsdc, formatExpiryShort, usdcToNumber, getPositionStatus, isExpired, daysUntilExpiry } from "../utils/format";
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility } from "../utils/blackScholes";

interface PositionAccount { publicKey: PublicKey; account: any; }
interface MarketAccount { publicKey: PublicKey; account: any; }

export const Portfolio: FC = () => {
  const { program, provider } = useProgram();
  const { publicKey, connected } = useWallet();
  const [positions, setPositions] = useState<PositionAccount[]>([]);
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"written" | "held">("written");
  const [resaleModal, setResaleModal] = useState<{ position: PositionAccount; market: any } | null>(null);

  useEffect(() => {
    if (!program || !publicKey) { setLoading(false); return; }
    setLoading(true);
    Promise.all([safeFetchAll(program, "optionPosition"), safeFetchAll(program, "optionsMarket")])
      .then(([posns, mkts]) => { setPositions(posns as PositionAccount[]); setMarkets(mkts as MarketAccount[]); })
      .catch(console.error).finally(() => setLoading(false));
  }, [program, publicKey]);

  const marketMap = useMemo(() => { const m = new Map<string, any>(); markets.forEach((x) => m.set(x.publicKey.toBase58(), x.account)); return m; }, [markets]);
  const writtenPositions = useMemo(() => publicKey ? positions.filter((p) => p.account.writer.toBase58() === publicKey.toBase58()) : [], [positions, publicKey]);

  // Token Holdings tab: only positions where the connected wallet actually holds option tokens.
  // Fetch all Token-2022 accounts for the wallet, then match mints to positions.
  const [heldPositions, setHeldPositions] = useState<PositionAccount[]>([]);
  useEffect(() => {
    if (!publicKey || !program || positions.length === 0) { setHeldPositions([]); return; }
    (async () => {
      try {
        const accounts = await program.provider.connection.getTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID });
        // Build set of mints where balance > 0
        const heldMints = new Set<string>();
        for (const a of accounts.value) {
          const mint = new PublicKey(a.account.data.slice(0, 32)).toBase58();
          const balance = a.account.data.readBigUInt64LE(64);
          if (balance > BigInt(0)) heldMints.add(mint);
        }
        const held = positions.filter((p) =>
          !p.account.isExercised && !p.account.isExpired && !p.account.isCancelled &&
          heldMints.has(p.account.optionMint.toBase58())
        );
        setHeldPositions(held);
      } catch {
        setHeldPositions([]);
      }
    })();
  }, [publicKey, program, positions]);

  const refetch = async () => {
    if (!program) return;
    const [posns, mkts] = await Promise.all([safeFetchAll(program, "optionPosition"), safeFetchAll(program, "optionsMarket")]);
    setPositions(posns as PositionAccount[]); setMarkets(mkts as MarketAccount[]);
  };

  if (!connected) {
    return (
      <div className="min-h-screen bg-bg-primary pt-24 px-4">
        <div className="mx-auto max-w-6xl">
          <h1 className="text-3xl font-bold text-text-primary mb-2">Portfolio</h1>
          <div className="rounded-xl border border-border bg-bg-surface p-12 text-center mt-8">
            <div className="text-text-muted text-lg mb-2">Connect your wallet</div>
            <p className="text-text-secondary text-sm">Your positions will appear here.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary pt-24 px-4 pb-12">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold text-text-primary mb-2">Portfolio</h1>
        <p className="text-text-secondary mb-6">Your option positions. Options are SPL tokens — tradeable anywhere.</p>

        <div className="rounded-xl border border-sol-purple/20 bg-sol-purple/5 p-4 mb-6">
          <div className="text-sm text-sol-purple font-medium mb-1">Tokenized Options</div>
          <p className="text-xs text-text-secondary">Each option is an SPL token. Hold, transfer, list for resale, or exercise them. Works with any Solana wallet or DEX.</p>
        </div>

        <div className="flex items-center gap-2 mb-6">
          <button onClick={() => setActiveTab("written")}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === "written" ? "bg-gold/15 text-gold border border-gold/30" : "bg-bg-surface text-text-secondary border border-border"}`}>
            Written ({writtenPositions.length})
          </button>
          <button onClick={() => setActiveTab("held")}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === "held" ? "bg-sol-green/15 text-sol-green border border-sol-green/30" : "bg-bg-surface text-text-secondary border border-border"}`}>
            Token Holdings
          </button>
        </div>

        {loading ? (
          <div className="rounded-xl border border-border bg-bg-surface p-12 text-center"><div className="text-text-muted animate-pulse">Loading...</div></div>
        ) : activeTab === "written" ? (
          <WrittenTab positions={writtenPositions} marketMap={marketMap} program={program} provider={provider} publicKey={publicKey!} onSuccess={refetch} />
        ) : (
          <HeldTab positions={heldPositions} marketMap={marketMap} publicKey={publicKey!}
          program={program} provider={provider} onSuccess={refetch}
          onListForResale={(p, m) => setResaleModal({ position: p, market: m })} />
        )}
      </div>

      {resaleModal && (
        <ResaleModal position={resaleModal.position} market={resaleModal.market}
          onClose={() => setResaleModal(null)} onSuccess={() => { setResaleModal(null); refetch(); }}
          program={program} provider={provider} publicKey={publicKey!} />
      )}
    </div>
  );
};

// =============================================================================
// Written Tab
// =============================================================================
const WrittenTab: FC<{
  positions: PositionAccount[]; marketMap: Map<string, any>; program: any; provider: any; publicKey: PublicKey; onSuccess: () => void;
}> = ({ positions, marketMap, program, provider, publicKey, onSuccess }) => {
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = async (p: PositionAccount) => {
    if (!program || !provider) return;
    setCancellingId(p.publicKey.toBase58());
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), p.account.market.toBuffer(), publicKey.toBuffer(), p.account.createdAt.toArrayLike(Buffer, "le", 8)], program.programId);
      const [purchaseEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("purchase_escrow"), p.publicKey.toBuffer()], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);

      const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
      const tx = await program.methods.cancelOption().accountsStrict({
        writer: publicKey, protocolState: protocolStatePda, position: p.publicKey,
        escrow: escrowPda, purchaseEscrow: purchaseEscrowPda,
        optionMint: p.account.optionMint, writerUsdcAccount,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).preInstructions([EXTRA_CU]).rpc({ commitment: "confirmed" });
      showToast({ type: "success", title: "Cancelled!", message: "Tokens burned, collateral returned.", txSignature: tx });
      onSuccess();
    } catch (err: any) {
      showToast({ type: "error", title: "Cancel failed", message: err?.message?.slice(0, 100) });
    } finally { setCancellingId(null); }
  };

  if (positions.length === 0) return <div className="rounded-xl border border-border bg-bg-surface p-12 text-center"><div className="text-text-muted">No options written yet.</div></div>;

  return (
    <div className="space-y-3">
      {positions.map((p) => {
        const mkt = marketMap.get(p.account.market.toBase58());
        const status = getPositionStatus(p.account);
        const canCancel = !p.account.isCancelled && !p.account.isExercised && !p.account.isExpired && !p.account.isListedForResale;
        return (
          <div key={p.publicKey.toBase58()} className="rounded-xl border border-border bg-bg-surface p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                {mkt && <><span className="text-sm font-semibold text-text-primary">{mkt.assetName}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${"call" in mkt.optionType ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>{"call" in mkt.optionType ? "Call" : "Put"}</span></>}
              </div>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${status === "Active" ? "bg-gold/10 text-gold" : status === "Listed for Resale" ? "bg-sol-purple/10 text-sol-purple" : "bg-text-muted/10 text-text-muted"}`}>{status}</span>
            </div>
            <div className="grid grid-cols-4 gap-4 text-xs">
              <div><div className="text-text-muted">Strike</div><div className="text-text-primary font-medium">{mkt ? `$${formatUsdc(mkt.strikePrice)}` : "—"}</div></div>
              <div><div className="text-text-muted">Premium</div><div className="text-text-primary font-medium">${formatUsdc(p.account.premium)}</div></div>
              <div><div className="text-text-muted">Collateral</div><div className="text-text-primary font-medium">${formatUsdc(p.account.collateralAmount)}</div></div>
              <div><div className="text-text-muted">Sold</div><div className="text-text-primary font-medium">{(p.account.tokensSold?.toNumber?.() || 0).toLocaleString()}/{(p.account.totalSupply?.toNumber?.() || 0).toLocaleString()}</div></div>
            </div>
            {canCancel && (
              <div className="mt-4 pt-3 border-t border-border/50">
                <button onClick={() => handleCancel(p)} disabled={cancellingId === p.publicKey.toBase58()}
                  className="rounded-lg border border-loss/30 bg-loss/10 px-4 py-1.5 text-xs font-medium text-loss hover:bg-loss/20 transition-colors disabled:opacity-50">
                  {cancellingId === p.publicKey.toBase58() ? "Cancelling..." : "Cancel & Burn Tokens"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// =============================================================================
// Token Holdings Tab
// =============================================================================
const HeldTab: FC<{
  positions: PositionAccount[]; marketMap: Map<string, any>; publicKey: PublicKey;
  program: any; provider: any; onSuccess: () => void;
  onListForResale: (p: PositionAccount, mkt: any) => void;
}> = ({ positions, marketMap, publicKey, program, provider, onSuccess, onListForResale }) => {
  const [exercisingId, setExercisingId] = useState<string | null>(null);

  const handleExercise = async (p: PositionAccount) => {
    if (!program || !provider || !publicKey) return;
    setExercisingId(p.publicKey.toBase58());
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), p.account.market.toBuffer(), p.account.writer.toBuffer(), p.account.createdAt.toArrayLike(Buffer, "le", 8)], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const exerciserUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, p.account.writer);
      const exerciserOptionAccount = getAssociatedTokenAddressSync(p.account.optionMint, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

      // Fetch exerciser's actual token balance
      const ataInfo = await program.provider.connection.getAccountInfo(exerciserOptionAccount);
      let tokensToExercise = 1;
      if (ataInfo && ataInfo.data.length >= 72) {
        tokensToExercise = Number(ataInfo.data.readBigUInt64LE(64));
      }

      const tx = await program.methods.exerciseOption(new BN(tokensToExercise)).accountsStrict({
        exerciser: publicKey, protocolState: protocolStatePda,
        market: p.account.market, position: p.publicKey,
        escrow: escrowPda, optionMint: p.account.optionMint,
        exerciserOptionAccount, exerciserUsdcAccount,
        writerUsdcAccount, writer: p.account.writer,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      }).preInstructions([EXTRA_CU]).rpc({ commitment: "confirmed" });
      showToast({ type: "success", title: "Exercised!", message: "Tokens burned, PnL distributed.", txSignature: tx });
      onSuccess();
    } catch (err: any) {
      showToast({ type: "error", title: "Exercise failed", message: err?.message?.slice(0, 120) });
    } finally { setExercisingId(null); }
  };
  if (positions.length === 0) return <div className="rounded-xl border border-border bg-bg-surface p-12 text-center"><div className="text-text-muted">No active positions.</div></div>;

  return (
    <div className="space-y-3">
      {positions.map((p) => {
        const mkt = marketMap.get(p.account.market.toBase58());
        if (!mkt) return null;
        const settled = mkt.isSettled;
        const expired = isExpired(mkt.expiryTimestamp);
        const isCall = "call" in mkt.optionType;
        let pnlDisplay = "—";
        if (settled) {
          const settlement = usdcToNumber(mkt.settlementPrice);
          const strike = usdcToNumber(mkt.strikePrice);
          const pnl = isCall ? Math.max(0, settlement - strike) : Math.max(0, strike - settlement);
          pnlDisplay = pnl > 0 ? `+$${pnl.toFixed(2)}/contract` : "$0 (OTM)";
        }

        return (
          <div key={p.publicKey.toBase58()} className="rounded-xl border border-border bg-bg-surface p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">{mkt.assetName}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>{isCall ? "Call" : "Put"}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-gold/10 text-gold">SPL Token</span>
              </div>
              {settled ? <span className="text-xs text-gold">Settled @ ${formatUsdc(mkt.settlementPrice)}</span>
                : expired ? <span className="text-xs text-text-muted">Expired</span>
                : <span className="text-xs text-sol-green">Active — {formatExpiryShort(mkt.expiryTimestamp)}</span>}
            </div>
            <div className="grid grid-cols-3 gap-4 text-xs">
              <div><div className="text-text-muted">Strike</div><div className="text-text-primary font-medium">${formatUsdc(mkt.strikePrice)}</div></div>
              <div><div className="text-text-muted">Mint</div><div className="text-text-primary font-mono text-[10px]">{p.account.optionMint.toBase58().slice(0, 12)}...</div></div>
              <div><div className="text-text-muted">PnL</div><div className={`font-medium ${pnlDisplay.startsWith("+") ? "text-sol-green" : "text-text-muted"}`}>{pnlDisplay}</div></div>
            </div>
            <div className="mt-4 pt-3 border-t border-border/50 flex gap-2">
              {!p.account.isListedForResale && !settled && (
                <button onClick={() => onListForResale(p, mkt)}
                  className="rounded-lg border border-gold/30 bg-gold/10 px-4 py-1.5 text-xs font-medium text-gold hover:bg-gold/20 transition-colors">
                  List for Resale
                </button>
              )}
              {settled && (
                <button onClick={() => handleExercise(p)} disabled={exercisingId === p.publicKey.toBase58()}
                  className="rounded-lg bg-sol-green/15 border border-sol-green/30 px-4 py-1.5 text-xs font-semibold text-sol-green hover:bg-sol-green/25 transition-colors disabled:opacity-50">
                  {exercisingId === p.publicKey.toBase58() ? "Exercising..." : "Exercise"}
                </button>
              )}
              {p.account.isListedForResale && <span className="text-xs text-sol-purple py-1.5">Listed for ${formatUsdc(p.account.resalePremium)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// =============================================================================
// Resale Modal
// =============================================================================
const ResaleModal: FC<{
  position: PositionAccount; market: any; program: any; provider: any; publicKey: PublicKey;
  onClose: () => void; onSuccess: () => void;
}> = ({ position, market, program, provider, publicKey, onClose, onSuccess }) => {
  const [resalePrice, setResalePrice] = useState("");
  const [listQuantity, setListQuantity] = useState("");

  const isCall = "call" in market.optionType;
  const strike = usdcToNumber(market.strikePrice);
  const days = daysUntilExpiry(market.expiryTimestamp);
  const vol = getDefaultVolatility(market.assetName);
  const suggestedPricePerToken = isCall ? calculateCallPremium(strike, strike, days, vol) : calculatePutPremium(strike, strike, days, vol);
  const totalSupply = position.account.totalSupply?.toNumber?.() || 1;

  // Fetch actual token balance from chain
  const [sellerBalance, setSellerBalance] = useState<number>(totalSupply);
  useEffect(() => {
    if (!publicKey) return;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(position.account.optionMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const info = await program.provider.connection.getAccountInfo(ata);
        if (info && info.data.length >= 72) {
          const buf = info.data.slice(64, 72);
          const bal = Number(buf.readBigUInt64LE(0));
          setSellerBalance(bal);
          setListQuantity(bal.toString());
          setResalePrice((suggestedPricePerToken * bal).toFixed(2));
        } else {
          setSellerBalance(0);
          setListQuantity("0");
        }
      } catch {
        setListQuantity(totalSupply.toString());
        setResalePrice((suggestedPricePerToken * totalSupply).toFixed(2));
      }
    })();
  }, [publicKey]);

  const [submitting, setSubmitting] = useState(false);

  const handleList = async () => {
    if (!program || !provider || !publicKey) return;
    setSubmitting(true);
    try {
      const resalePremiumBN = new BN(Math.round(parseFloat(resalePrice) * 1_000_000));
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const optionMint = position.account.optionMint;
      const sellerOptionAccount = getAssociatedTokenAddressSync(optionMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
      const [resaleEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("resale_escrow"), position.publicKey.toBuffer()], program.programId);
      const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
      const [hookState] = deriveHookStatePda(optionMint);
      const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

      // Ensure seller's Token-2022 ATA exists before the transfer
      const createSellerAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        publicKey, sellerOptionAccount, publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const tokenAmountBN = new BN(parseInt(listQuantity) || totalSupply);
      const tx = await program.methods.listForResale(resalePremiumBN, tokenAmountBN).accountsStrict({
        seller: publicKey, protocolState: protocolStatePda, position: position.publicKey,
        sellerOptionAccount, resaleEscrow: resaleEscrowPda,
        optionMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID, extraAccountMetaList, hookState,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      }).preInstructions([EXTRA_CU, createSellerAtaIx]).rpc({ commitment: "confirmed" });

      showToast({ type: "success", title: "Listed for resale!", message: `Asking: $${resalePrice}`, txSignature: tx });
      onSuccess();
    } catch (err: any) {
      const msg = err?.message || err?.toString() || "Unknown error";
      if (msg.includes("User rejected")) {
        showToast({ type: "error", title: "Transaction cancelled", message: "You rejected the transaction in your wallet." });
      } else {
        showToast({ type: "error", title: "Listing failed", message: msg.slice(0, 120) });
      }
    } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-text-primary">List for Resale</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-lg">✕</button>
        </div>
        <div className="rounded-xl bg-bg-primary border border-border p-3 mb-4 text-sm">
          <span className="font-semibold text-text-primary">{market.assetName}</span>{" "}
          <span className={`text-xs ${isCall ? "text-sol-green" : "text-sol-purple"}`}>{isCall ? "Call" : "Put"}</span>{" "}
          <span className="text-text-muted">@ ${formatUsdc(market.strikePrice)}</span>
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Contracts to List</label>
          <input type="number" value={listQuantity} onChange={(e) => setListQuantity(e.target.value)}
            placeholder={totalSupply.toString()} min="1" max={totalSupply}
            className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          <div className="text-xs text-text-muted mt-1">You hold {sellerBalance.toLocaleString()} contracts</div>
        </div>
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Total Asking Price (USDC)</label>
          <input type="number" value={resalePrice} onChange={(e) => setResalePrice(e.target.value)}
            className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          <div className="text-xs text-text-muted mt-1">B-S suggested per contract: <span className="text-gold">${suggestedPricePerToken.toFixed(4)}</span></div>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-border py-3 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
          <button onClick={handleList} disabled={submitting || !resalePrice || parseFloat(resalePrice) <= 0 || sellerBalance <= 0}
            className="flex-1 rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50">
            {submitting ? "Confirm in wallet..." : `List for $${resalePrice || "0"}`}
          </button>
        </div>
      </div>
    </div>
  );
};
