import { FC, useEffect, useState, useMemo } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { useProgram } from "../hooks/useProgram";
import { safeFetchAll } from "../hooks/useFetchAccounts";
import { showToast } from "../components/Toast";
import { formatUsdc, formatExpiryShort, truncateAddress, usdcToNumber, toUsdcBN, daysUntilExpiry, isExpired } from "../utils/format";
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility } from "../utils/blackScholes";

interface MarketAccount { publicKey: PublicKey; account: any; }
interface PositionAccount { publicKey: PublicKey; account: any; }

export const Trade: FC = () => {
  const { program, provider } = useProgram();
  const { publicKey, connected } = useWallet();
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [positions, setPositions] = useState<PositionAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [buyModal, setBuyModal] = useState<{ position: PositionAccount; market: any; isResale: boolean } | null>(null);

  useEffect(() => {
    if (!program) return;
    setLoading(true);
    Promise.all([safeFetchAll(program, "optionsMarket"), safeFetchAll(program, "optionPosition")])
      .then(([mkts, posns]) => { setMarkets(mkts as MarketAccount[]); setPositions(posns as PositionAccount[]); })
      .catch(console.error).finally(() => setLoading(false));
  }, [program]);

  // Deduplicate + filter active markets (keep newest per asset+strike+type)
  const activeMarkets = useMemo(() => {
    try {
      const active = markets.filter((m) => !isExpired(m.account.expiryTimestamp));
      const map = new Map<string, typeof active[0]>();
      for (const m of active) {
        const isCall = "call" in m.account.optionType;
        const key = `${m.account.assetName}-${m.account.strikePrice.toString()}-${isCall ? "C" : "P"}`;
        const existing = map.get(key);
        const mExpiry = typeof m.account.expiryTimestamp === "number" ? m.account.expiryTimestamp : m.account.expiryTimestamp.toNumber();
        const exExpiry = existing ? (typeof existing.account.expiryTimestamp === "number" ? existing.account.expiryTimestamp : existing.account.expiryTimestamp.toNumber()) : 0;
        if (!existing || mExpiry > exExpiry) {
          map.set(key, m);
        }
      }
      return Array.from(map.values());
    } catch (e) {
      console.error("Dedup error:", e);
      return markets.filter((m) => !isExpired(m.account.expiryTimestamp));
    }
  }, [markets]);
  const marketMap = useMemo(() => { const map = new Map<string, any>(); markets.forEach((m) => map.set(m.publicKey.toBase58(), m.account)); return map; }, [markets]);

  // Set of active market pubkeys (for filtering positions to deduped markets only)
  const activeMarketKeys = useMemo(() => new Set(activeMarkets.map((m) => m.publicKey.toBase58())), [activeMarkets]);

  // Primary options (active, not listed for resale, on deduped markets only)
  const primaryOptions = useMemo(() =>
    positions.filter((p) =>
      !p.account.isExercised && !p.account.isExpired && !p.account.isCancelled &&
      !p.account.isListedForResale && activeMarketKeys.has(p.account.market.toBase58())
    ),
  [positions, activeMarketKeys]);

  // Resale listings (on deduped markets only)
  const resaleOptions = useMemo(() =>
    positions.filter((p) =>
      p.account.isListedForResale && !p.account.isExercised && !p.account.isExpired &&
      !p.account.isCancelled && activeMarketKeys.has(p.account.market.toBase58())
    ),
  [positions, activeMarketKeys]);

  const refetch = async () => {
    if (!program) return;
    const [mkts, posns] = await Promise.all([safeFetchAll(program, "optionsMarket"), safeFetchAll(program, "optionPosition")]);
    setMarkets(mkts as MarketAccount[]); setPositions(posns as PositionAccount[]);
  };

  const getFairPrice = (mkt: any) => {
    const strike = usdcToNumber(mkt.strikePrice);
    const days = daysUntilExpiry(mkt.expiryTimestamp);
    const vol = getDefaultVolatility(mkt.assetName);
    const isCall = "call" in mkt.optionType;
    return isCall ? calculateCallPremium(strike, strike, days, vol) : calculatePutPremium(strike, strike, days, vol);
  };

  return (
    <div className="min-h-screen bg-bg-primary pt-24 px-4 pb-12">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold text-text-primary mb-2">Trade</h1>
        <p className="text-text-secondary mb-8">Write new options or purchase from sellers.</p>

        {loading ? (
          <div className="rounded-xl border border-border bg-bg-surface p-12 text-center"><div className="text-text-muted animate-pulse">Loading from devnet...</div></div>
        ) : (
          <div className="space-y-8">
            {/* Write + Primary Options */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <WriteOptionPanel markets={activeMarkets} program={program} provider={provider} publicKey={publicKey} connected={connected} onSuccess={refetch} marketMap={marketMap} getFairPrice={getFairPrice} />

              {/* Available Options */}
              <div className="rounded-2xl border border-border bg-bg-surface p-6">
                <h2 className="text-lg font-semibold text-sol-green mb-5">Available Options</h2>
                {primaryOptions.length === 0 ? (
                  <p className="text-text-muted text-sm">No options available for purchase.</p>
                ) : (
                  <div className="space-y-3 max-h-[500px] overflow-y-auto">
                    {primaryOptions.map((p) => {
                      const mkt = marketMap.get(p.account.market.toBase58());
                      if (!mkt) return null;
                      const isCall = "call" in mkt.optionType;
                      const fair = getFairPrice(mkt);
                      return (
                        <div key={p.publicKey.toBase58()} className="rounded-xl border border-border bg-bg-primary p-4">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-text-primary">{mkt.assetName}</span>
                              <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>{isCall ? "Call" : "Put"}</span>
                            </div>
                            <span className="text-xs text-text-muted">Exp: {formatExpiryShort(mkt.expiryTimestamp)}</span>
                          </div>
                          <div className="grid grid-cols-4 gap-2 text-xs mb-3">
                            <div><div className="text-text-muted">Strike</div><div className="text-text-primary font-medium">${formatUsdc(mkt.strikePrice)}</div></div>
                            <div><div className="text-text-muted">Premium</div><div className="text-gold font-medium">${formatUsdc(p.account.premium)}</div></div>
                            <div><div className="text-text-muted">Fair Value</div><div className="text-text-secondary font-medium">${fair.toFixed(2)}</div></div>
                            <div><div className="text-text-muted">Available</div><div className="text-sol-green font-medium">{((p.account.totalSupply?.toNumber?.() || 0) - (p.account.tokensSold?.toNumber?.() || 0)).toLocaleString()}/{(p.account.totalSupply?.toNumber?.() || 0).toLocaleString()}</div></div>
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="text-xs text-text-muted">Writer: {truncateAddress(p.account.writer.toBase58())}</div>
                            {connected && publicKey?.toBase58() !== p.account.writer.toBase58() ? (
                              <button onClick={() => setBuyModal({ position: p, market: mkt, isResale: false })}
                                className="rounded-lg bg-sol-green/15 border border-sol-green/30 px-5 py-2 text-xs font-semibold text-sol-green hover:bg-sol-green/25 transition-colors">
                                Buy ${formatUsdc(p.account.premium)}
                              </button>
                            ) : connected ? (
                              <span className="text-xs text-text-muted">Your option</span>
                            ) : (
                              <span className="text-xs text-text-muted">Connect wallet</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Secondary Market (Resale) */}
            <div className="rounded-2xl border border-gold/20 bg-bg-surface p-6">
              <div className="flex items-center gap-3 mb-5">
                <h2 className="text-lg font-semibold text-gold">Secondary Market</h2>
                <span className="text-xs px-2 py-0.5 rounded-full bg-gold/10 text-gold">P2P Resale</span>
              </div>
              {resaleOptions.length === 0 ? (
                <p className="text-text-muted text-sm">No resale listings yet. Option holders can list their tokens for resale from the Portfolio page.</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {resaleOptions.map((p) => {
                    const mkt = marketMap.get(p.account.market.toBase58());
                    if (!mkt) return null;
                    const isCall = "call" in mkt.optionType;
                    const fair = getFairPrice(mkt);
                    return (
                      <div key={p.publicKey.toBase58()} className="rounded-xl border border-gold/20 bg-bg-primary p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-text-primary">{mkt.assetName}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>{isCall ? "Call" : "Put"}</span>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                          <div><div className="text-text-muted">Strike</div><div className="text-text-primary font-medium">${formatUsdc(mkt.strikePrice)}</div></div>
                          <div><div className="text-text-muted">Asking</div><div className="text-gold font-bold">${formatUsdc(p.account.resalePremium)}</div></div>
                          <div><div className="text-text-muted">Fair Value</div><div className="text-text-secondary">${fair.toFixed(2)}</div></div>
                          <div><div className="text-text-muted">Seller</div><div className="text-text-secondary">{truncateAddress(p.account.resaleSeller.toBase58())}</div></div>
                        </div>
                        {connected && publicKey?.toBase58() !== p.account.resaleSeller.toBase58() ? (
                          <button onClick={() => setBuyModal({ position: p, market: mkt, isResale: true })}
                            className="w-full rounded-lg bg-gold/15 border border-gold/30 py-2 text-xs font-semibold text-gold hover:bg-gold/25 transition-colors">
                            Buy Resale ${formatUsdc(p.account.resalePremium)}
                          </button>
                        ) : (
                          <div className="text-xs text-text-muted text-center py-2">Your listing</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Buy Confirmation Modal */}
      {buyModal && (
        <BuyConfirmModal {...buyModal} program={program} provider={provider} publicKey={publicKey}
          onClose={() => setBuyModal(null)} onSuccess={() => { setBuyModal(null); refetch(); }} />
      )}
    </div>
  );
};

// =============================================================================
// Buy Confirmation Modal
// =============================================================================
const BuyConfirmModal: FC<{
  position: PositionAccount; market: any; isResale: boolean;
  program: any; provider: any; publicKey: PublicKey | null;
  onClose: () => void; onSuccess: () => void;
}> = ({ position, market, isResale, program, provider, publicKey, onClose, onSuccess }) => {
  const [submitting, setSubmitting] = useState(false);
  const [quantity, setQuantity] = useState("");
  const isCall = "call" in market.optionType;
  const totalSupply = position.account.totalSupply?.toNumber?.() || 1_000_000;
  const tokensSold = position.account.tokensSold?.toNumber?.() || 0;
  const available = isResale ? (position.account.resaleTokenAmount?.toNumber?.() || 0) : (totalSupply - tokensSold);
  const price = isResale ? position.account.resalePremium : position.account.premium;
  const pricePerToken = usdcToNumber(price) / (isResale ? (position.account.resaleTokenAmount?.toNumber?.() || 1) : totalSupply);
  const qty = parseInt(quantity) || available;
  const totalCost = pricePerToken * qty;
  const strike = usdcToNumber(market.strikePrice);
  const days = daysUntilExpiry(market.expiryTimestamp);
  const vol = getDefaultVolatility(market.assetName);
  const fair = isCall ? calculateCallPremium(strike, strike, days, vol) : calculatePutPremium(strike, strike, days, vol);

  const handleConfirm = async () => {
    if (!program || !provider || !publicKey) return;
    setSubmitting(true);
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);

      const buyerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, position.account.writer);

      if (isResale) {
        // buy_resale: buy from resale listing
        const sellerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, position.account.resaleSeller);
        const buyerOptionAccount = await getAssociatedTokenAddress(position.account.optionMint, publicKey);
        const [resaleEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("resale_escrow"), position.publicKey.toBuffer()], program.programId);

        const tx = await program.methods.buyResale(new BN(qty)).accountsStrict({
          buyer: publicKey, protocolState: protocolStatePda, position: position.publicKey,
          resaleEscrow: resaleEscrowPda, buyerUsdcAccount, sellerUsdcAccount,
          buyerOptionAccount, optionMint: position.account.optionMint, treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        }).rpc();
        showToast({ type: "success", title: "Resale purchased!", message: `Paid $${formatUsdc(price)}`, txSignature: tx });
      } else {
        // purchase_option: buy from purchase escrow (no writer signature needed!)
        const buyerOptionAccount = await getAssociatedTokenAddress(position.account.optionMint, publicKey);
        const [purchaseEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("purchase_escrow"), position.publicKey.toBuffer()], program.programId);

        const tx = await program.methods.purchaseOption(new BN(qty)).accountsStrict({
          buyer: publicKey, protocolState: protocolStatePda, market: position.account.market,
          position: position.publicKey, purchaseEscrow: purchaseEscrowPda,
          buyerUsdcAccount, writerUsdcAccount,
          buyerOptionAccount, optionMint: position.account.optionMint, treasury: treasuryPda,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        }).rpc();
        showToast({ type: "success", title: "Option purchased!", message: `Paid $${formatUsdc(price)} USDC`, txSignature: tx });
      }
      onSuccess();
    } catch (err: any) {
      const msg = err?.message || err?.toString() || "Unknown error";
      if (msg.includes("User rejected")) {
        showToast({ type: "error", title: "Transaction cancelled", message: "You rejected the transaction in your wallet." });
      } else {
        showToast({ type: "error", title: "Purchase failed", message: msg.slice(0, 120) });
      }
    } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-bg-surface p-6 shadow-2xl">
        <h2 className="text-lg font-bold text-text-primary mb-4">{isResale ? "Buy Resale" : "Buy Option"}</h2>
        <div className="rounded-xl bg-bg-primary border border-border p-4 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg font-bold text-text-primary">{market.assetName}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>{isCall ? "Call" : "Put"}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-text-muted">Strike:</span> <span className="text-text-primary font-medium">${formatUsdc(market.strikePrice)}</span></div>
            <div><span className="text-text-muted">Expiry:</span> <span className="text-text-primary font-medium">{formatExpiryShort(market.expiryTimestamp)}</span></div>
          </div>
        </div>
        {/* Quantity input */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Contracts to buy</label>
          <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)}
            placeholder={available.toString()} min="1" max={available}
            className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          <div className="text-xs text-text-muted mt-1">Available: {available.toLocaleString()} contracts</div>
        </div>

        <div className="space-y-2 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Price per contract:</span>
            <span className="text-text-secondary">${pricePerToken.toFixed(4)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-text-secondary">Total cost:</span>
            <span className="text-gold font-bold text-lg">${totalCost.toFixed(2)} USDC</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">Fair Value (B-S):</span>
            <span className="text-text-secondary">${fair.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-text-muted">Protocol Fee (0.5%):</span>
            <span className="text-text-secondary">${(totalCost * 0.005).toFixed(4)}</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-border py-3 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors">Cancel</button>
          <button onClick={handleConfirm} disabled={submitting}
            className="flex-1 rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50">
            {submitting ? "Confirm in wallet..." : "Confirm Buy"}
          </button>
        </div>
      </div>
    </div>
  );
};

// =============================================================================
// Write Option Panel
// =============================================================================
const WriteOptionPanel: FC<{
  markets: MarketAccount[]; program: any; provider: any; publicKey: PublicKey | null;
  connected: boolean; onSuccess: () => void; marketMap: Map<string, any>; getFairPrice: (mkt: any) => number;
}> = ({ markets, program, provider, publicKey, connected, onSuccess, marketMap, getFairPrice }) => {
  const [selectedMarket, setSelectedMarket] = useState("");
  const [collateral, setCollateral] = useState("");
  const [premium, setPremium] = useState("");
  const [contractSize, setContractSize] = useState("10");
  const [submitting, setSubmitting] = useState(false);

  const selectedMarketData = markets.find((m) => m.publicKey.toBase58() === selectedMarket);
  const minCollateral = useMemo(() => {
    if (!selectedMarketData) return 0;
    const strike = usdcToNumber(selectedMarketData.account.strikePrice);
    const size = parseFloat(contractSize) || 0;
    return ("call" in selectedMarketData.account.optionType) ? strike * 2 * size : strike * size;
  }, [selectedMarketData, contractSize]);

  // Auto-suggest premium via Black-Scholes
  useEffect(() => {
    if (!selectedMarketData) return;
    const fair = getFairPrice(selectedMarketData.account);
    const size = parseFloat(contractSize) || 1;
    setPremium((fair * size).toFixed(2));
  }, [selectedMarketData, contractSize]);

  const handleWrite = async () => {
    if (!program || !provider || !publicKey || !selectedMarketData) return;
    setSubmitting(true);
    try {
      const marketPubkey = selectedMarketData.publicKey;
      const collateralBN = toUsdcBN(parseFloat(collateral));
      const premiumBN = toUsdcBN(parseFloat(premium));
      const sizeBN = new BN(Math.round(parseFloat(contractSize)));
      const createdAt = new BN(Math.floor(Date.now() / 1000));

      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const [positionPda] = PublicKey.findProgramAddressSync([Buffer.from("position"), marketPubkey.toBuffer(), publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)], program.programId);
      const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), marketPubkey.toBuffer(), publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)], program.programId);
      const [optionMintPda] = PublicKey.findProgramAddressSync([Buffer.from("option_mint"), positionPda.toBuffer()], program.programId);

      const [purchaseEscrowPda] = PublicKey.findProgramAddressSync([Buffer.from("purchase_escrow"), positionPda.toBuffer()], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const writerUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);

      const tx = await program.methods
        .writeOption(collateralBN, premiumBN, sizeBN, createdAt)
        .accountsStrict({
          writer: publicKey, protocolState: protocolStatePda, market: marketPubkey,
          position: positionPda, escrow: escrowPda, optionMint: optionMintPda,
          purchaseEscrow: purchaseEscrowPda, writerUsdcAccount,
          usdcMint: protocolState.usdcMint, systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID, rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
        }).rpc();

      showToast({ type: "success", title: "Option written!", message: `Option created. Premium: $${premium}`, txSignature: tx });
      setCollateral(""); onSuccess();
    } catch (err: any) {
      showToast({ type: "error", title: "Failed to write option", message: err?.message?.slice(0, 120) });
    } finally { setSubmitting(false); }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-surface p-6">
      <h2 className="text-lg font-semibold text-gold mb-5">Write Option</h2>
      {!connected ? (
        <p className="text-text-muted text-sm">Connect your wallet to write options.</p>
      ) : markets.length === 0 ? (
        <p className="text-text-muted text-sm">No active markets. Create one on Markets page.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Select Market</label>
            <select value={selectedMarket} onChange={(e) => setSelectedMarket(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none">
              <option value="">Choose a market...</option>
              {markets.map((m) => (
                <option key={m.publicKey.toBase58()} value={m.publicKey.toBase58()}>
                  {m.account.assetName} ${formatUsdc(m.account.strikePrice)} {"call" in m.account.optionType ? "Call" : "Put"} — exp {formatExpiryShort(m.account.expiryTimestamp)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Number of Contracts</label>
            <input type="number" value={contractSize} onChange={(e) => setContractSize(e.target.value)} min="1" step="1"
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Collateral (USDC) {minCollateral > 0 && <span className="text-text-muted ml-2">min: ${minCollateral.toFixed(2)}</span>}</label>
            <input type="number" value={collateral} onChange={(e) => setCollateral(e.target.value)} placeholder={minCollateral > 0 ? minCollateral.toFixed(2) : "0.00"}
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Premium (USDC) <span className="text-gold ml-1">B-S suggested</span></label>
            <input type="number" value={premium} onChange={(e) => setPremium(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary focus:border-gold/50 focus:outline-none" />
          </div>
          <button onClick={handleWrite} disabled={submitting || !selectedMarket || !collateral || !premium}
            className="w-full rounded-xl bg-gold py-3 text-sm font-semibold text-bg-primary hover:bg-gold-dim transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? "Creating contracts..." : "Write Option"}
          </button>
        </div>
      )}
    </div>
  );
};
