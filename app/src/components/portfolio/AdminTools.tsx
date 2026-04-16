import { FC, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { formatUsdc, usdcToNumber, formatExpiry, isExpired } from "../../utils/format";
import { toUsdcBN } from "../../utils/format";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";

interface AdminToolsProps {
  markets: { publicKey: PublicKey; account: any }[];
  program: any;
  publicKey: PublicKey;
  onRefetch: () => void;
}

export const AdminTools: FC<AdminToolsProps> = ({ markets, program, publicKey, onRefetch }) => {
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});

  // Only show unsettled, expired markets
  const unsettledMarkets = markets.filter((m) =>
    !m.account.isSettled && isExpired(m.account.expiryTimestamp),
  );

  if (unsettledMarkets.length === 0) {
    return (
      <div className="rounded-xl border border-loss/20 bg-loss/5 p-4 text-center">
        <p className="text-xs text-text-muted">No expired unsettled markets.</p>
      </div>
    );
  }

  const handleSettle = async (market: { publicKey: PublicKey; account: any }) => {
    const key = market.publicKey.toBase58();
    const priceStr = priceInputs[key];
    if (!priceStr || parseFloat(priceStr) <= 0) {
      showToast({ type: "error", title: "Missing price", message: "Enter a settlement price." });
      return;
    }
    setSettlingId(key);
    try {
      const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
      const settlementPrice = toUsdcBN(parseFloat(priceStr));

      const tx = await program.methods.settleMarket(settlementPrice)
        .accountsStrict({
          admin: publicKey,
          protocolState: protocolStatePda,
          market: market.publicKey,
        })
        .rpc({ commitment: "confirmed" });
      showToast({ type: "success", title: "Market settled!", message: `${market.account.assetName} settled at $${priceStr}`, txSignature: tx });
      onRefetch();
    } catch (err: any) {
      showToast({ type: "error", title: "Settle failed", message: decodeError(err) });
    } finally {
      setSettlingId(null);
    }
  };

  return (
    <div className="rounded-xl border border-loss/30 bg-loss/5 p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm font-semibold text-loss">Admin Tools</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-loss/10 text-loss">Devnet Only</span>
      </div>

      <div className="space-y-3">
        {unsettledMarkets.map((m) => {
          const key = m.publicKey.toBase58();
          const isCall = "call" in m.account.optionType;
          return (
            <div key={key} className="flex items-center gap-3 rounded-lg bg-bg-primary border border-border p-3">
              <div className="flex-1 text-xs">
                <span className="font-medium text-text-primary">{m.account.assetName}</span>{" "}
                <span className="text-text-muted">${formatUsdc(m.account.strikePrice)} {isCall ? "Call" : "Put"}</span>{" "}
                <span className="text-text-muted">exp {formatExpiry(m.account.expiryTimestamp)}</span>
              </div>
              <input
                type="number"
                placeholder="Settlement $"
                value={priceInputs[key] || ""}
                onChange={(e) => setPriceInputs({ ...priceInputs, [key]: e.target.value })}
                className="w-28 rounded-lg border border-border bg-bg-surface px-2 py-1.5 text-xs text-text-primary focus:border-loss/50 focus:outline-none"
              />
              <button onClick={() => handleSettle(m)} disabled={settlingId !== null}
                className="rounded-lg bg-loss/10 border border-loss/30 px-3 py-1.5 text-xs font-medium text-loss hover:bg-loss/20 transition-colors disabled:opacity-50">
                {settlingId === key ? "Settling..." : "Settle"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
