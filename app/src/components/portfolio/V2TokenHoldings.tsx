import { FC, useEffect, useState, useMemo } from "react";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddress, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { formatUsdc, usdcToNumber, formatExpiry, isExpired } from "../../utils/format";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";
import { useTokenMetadata } from "../../hooks/useTokenMetadata";

// Fallback when the on-chain market account isn't reachable through marketMap
// (e.g. it failed safeFetchAll's strict validator). Parse the Token-2022 metadata
// symbol like "OPTA-SOL-100C-APR24" -> "SOL", and only accept it if it's in the
// known-asset allowlist so we don't render garbage tickers.
const KNOWN_ASSETS = new Set(["SOL", "BTC", "ETH", "AAPL", "XAU", "XAG", "WTI", "TSLA", "NVDA"]);
function tickerFromMetadataSymbol(symbol: string | undefined): string | null {
  if (!symbol) return null;
  const candidate = symbol.split("-")[1];
  return candidate && KNOWN_ASSETS.has(candidate) ? candidate : null;
}

interface V2TokenHoldingsProps {
  vaults: { publicKey: PublicKey; account: any }[];
  vaultMints: { publicKey: PublicKey; account: any }[];
  markets: { publicKey: PublicKey; account: any }[];
  program: any;
  publicKey: PublicKey;
  onRefetch: () => void;
  hasV1Tokens?: boolean;
}

interface HeldV2Token {
  vaultMint: { publicKey: PublicKey; account: any };
  vault: { publicKey: PublicKey; account: any };
  market: any;
  optionMint: PublicKey;
  balance: number;
}

export const V2TokenHoldings: FC<V2TokenHoldingsProps> = ({ vaults, vaultMints, markets, program, publicKey, onRefetch, hasV1Tokens }) => {
  const [holdings, setHoldings] = useState<HeldV2Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [exercisingId, setExercisingId] = useState<string | null>(null);

  // Build market lookup
  const marketMap = useMemo(() => {
    const m = new Map<string, any>();
    markets.forEach((x) => m.set(x.publicKey.toBase58(), x.account));
    return m;
  }, [markets]);

  // Scan wallet's Token-2022 accounts and match to VaultMints
  useEffect(() => {
    if (!program || !publicKey || vaultMints.length === 0) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const accounts = await program.provider.connection.getTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID });
        const heldMints = new Map<string, number>();
        for (const a of accounts.value) {
          const mint = new PublicKey(a.account.data.slice(0, 32)).toBase58();
          const balance = Number(a.account.data.readBigUInt64LE(64));
          if (balance > 0) heldMints.set(mint, balance);
        }

        const found: HeldV2Token[] = [];
        for (const vm of vaultMints) {
          const mintKey = (vm.account.optionMint as PublicKey).toBase58();
          const balance = heldMints.get(mintKey);
          if (!balance) continue;
          const vault = vaults.find((v) => v.publicKey.equals(vm.account.vault as PublicKey));
          if (!vault) continue;
          const mkt = marketMap.get((vault.account.market as PublicKey).toBase58());
          found.push({ vaultMint: vm, vault, market: mkt, optionMint: vm.account.optionMint, balance });
        }
        if (!cancelled) setHoldings(found);
      } catch (err) {
        console.error("Failed to scan Token-2022 holdings:", err);
        if (!cancelled) {
          showToast({ type: "error", title: "Scan failed", message: "Failed to load option tokens. Try refreshing." });
          setHoldings([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [program, publicKey, vaultMints, vaults, marketMap]);

  // Token metadata
  const mintKeys = useMemo(() => holdings.map((h) => h.optionMint), [holdings]);
  const tokenMetadata = useTokenMetadata(mintKeys);

  const handleExercise = async (h: HeldV2Token) => {
    if (!program || !publicKey) return;
    const key = h.vaultMint.publicKey.toBase58();
    setExercisingId(key);
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const protocolState = await program.account.protocolState.fetch(protocolStatePda);
      const holderUsdcAccount = await getAssociatedTokenAddress(protocolState.usdcMint, publicKey);
      const holderOptionAccount = getAssociatedTokenAddressSync(h.optionMint, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const v = h.vault.account;
      const isCall = "call" in v.optionType;
      const settlement = usdcToNumber(v.settlementPrice);
      const strike = usdcToNumber(v.strikePrice);
      const pnl = isCall ? Math.max(0, settlement - strike) : Math.max(0, strike - settlement);
      const totalPayout = (pnl * h.balance).toFixed(2);

      const tx = await program.methods.exerciseFromVault(new BN(h.balance))
        .accountsStrict({
          holder: publicKey,
          sharedVault: h.vault.publicKey,
          market: v.market,
          vaultMintRecord: h.vaultMint.publicKey,
          optionMint: h.optionMint,
          holderOptionAccount,
          vaultUsdcAccount: v.vaultUsdcAccount,
          holderUsdcAccount,
          protocolState: protocolStatePda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
        .rpc({ commitment: "confirmed" });

      showToast({ type: "success", title: "Exercised!", message: `${h.balance} tokens burned. Received $${totalPayout} USDC.`, txSignature: tx });
      onRefetch();
    } catch (err: any) {
      showToast({ type: "error", title: "Exercise failed", message: decodeError(err) });
    } finally {
      setExercisingId(null);
    }
  };

  if (loading) return <div className="text-text-muted text-sm animate-pulse py-4">Scanning wallet for option tokens...</div>;

  if (holdings.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-bg-surface p-8 text-center">
        <p className="text-text-muted text-sm">
          {hasV1Tokens
            ? "Vault options will appear here after purchasing from the Trade page."
            : <>No option tokens yet. Visit the <a href="/trade" className="text-gold hover:underline">Trade page</a> to buy options.</>}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {holdings.map((h) => {
        const v = h.vault.account;
        const isCall = "call" in v.optionType;
        const settled = v.isSettled;
        const expired = isExpired(v.expiry);
        const meta = tokenMetadata.get(h.optionMint.toBase58());

        let pnlDisplay = "—";
        let itm = false;
        if (settled) {
          const settlement = usdcToNumber(v.settlementPrice);
          const strike = usdcToNumber(v.strikePrice);
          const pnl = isCall ? Math.max(0, settlement - strike) : Math.max(0, strike - settlement);
          itm = pnl > 0;
          pnlDisplay = pnl > 0 ? `+$${pnl.toFixed(2)}/contract` : "$0 (OTM)";
        }

        const exercising = exercisingId === h.vaultMint.publicKey.toBase58();

        return (
          <div key={h.vaultMint.publicKey.toBase58()} className={`rounded-xl border border-border border-l-2 border-l-sol-purple/40 bg-bg-surface p-5 transition-opacity ${(exercising || expired) ? "opacity-60" : ""}`}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-primary">{h.market?.assetName || tickerFromMetadataSymbol(meta?.symbol) || "?"}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${isCall ? "bg-sol-green/10 text-sol-green" : "bg-sol-purple/10 text-sol-purple"}`}>{isCall ? "Call" : "Put"}</span>
                {!expired && <span className="text-xs px-2 py-0.5 rounded-full bg-gold/10 text-gold">Living Token</span>}
                {expired && <span className="text-xs px-2 py-0.5 rounded-full bg-text-muted/10 text-text-muted">Expired</span>}
              </div>
              {settled
                ? <span className="text-xs text-gold">Settled @ ${formatUsdc(v.settlementPrice)}</span>
                : expired ? <span className="text-xs text-text-muted">Expired — {formatExpiry(v.expiry)}</span>
                : <span className="text-xs text-sol-green">Active — {formatExpiry(v.expiry)}</span>}
            </div>
            {meta && (
              <div className="mb-3">
                <span className="text-xs font-mono text-gold">{meta.symbol}</span>
                <span className="text-xs text-text-muted ml-2">{meta.name}</span>
              </div>
            )}
            <div className="grid grid-cols-4 gap-3 text-xs">
              <div><div className="text-text-muted">Strike</div><div className="text-text-primary font-medium">${formatUsdc(v.strikePrice)}</div></div>
              <div><div className="text-text-muted">Balance</div><div className="text-gold font-bold">{h.balance} contracts</div></div>
              <div>
                <div className="text-text-muted">Expiry</div>
                <div className="text-text-primary font-medium">{formatExpiry(v.expiry)}</div>
                {!settled && !expired && (
                  <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full bg-text-muted/10 text-text-muted">Awaiting settlement</span>
                )}
              </div>
              <div><div className="text-text-muted">PnL</div><div className={`font-medium ${pnlDisplay.startsWith("+") ? "text-sol-green" : "text-text-muted"}`}>{pnlDisplay}</div></div>
            </div>

            {settled && (
              <div className="mt-4 pt-3 border-t border-border/50 flex gap-2">
                {itm && (
                  <button onClick={() => handleExercise(h)} disabled={exercising}
                    className="rounded-lg bg-sol-green/15 border border-sol-green/30 px-4 py-1.5 text-xs font-semibold text-sol-green hover:bg-sol-green/25 transition-colors disabled:opacity-50">
                    {exercising ? "Burning tokens & claiming payout..." : `Exercise & Burn ${h.balance} tokens`}
                  </button>
                )}
                {!itm && (
                  <span className="text-xs text-text-muted py-1.5">
                    Out of the money (settlement: ${formatUsdc(v.settlementPrice)}, strike: ${formatUsdc(v.strikePrice)})
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
