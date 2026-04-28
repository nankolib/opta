import { FC, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";
import { hexFromBytes, formatExpiry } from "../../utils/format";
import {
  settleAllForExpiry,
  fetchHermesParsedPrice,
} from "../../utils/pythPullPost";

interface AccountRecord {
  publicKey: PublicKey;
  account: any;
}

interface AdminToolsProps {
  vaults: AccountRecord[];
  markets: AccountRecord[];
  /** Eager-fetched per locked decision 14. Currently unused for tuple
   *  derivation (we drive purely off vault.is_settled to handle partial-
   *  failure resumes), but reserved for future use (e.g. metrics). */
  settlementRecords: AccountRecord[];
  program: any;
  onRefetch: () => void;
}

type SettleConfirm = {
  asset: string;
  expiry: number;
  price: number | null;
  txSignature: string;
  vaultsFinalized: number;
  /** True when the atomic Pyth tx was skipped because a SettlementRecord
   *  already existed — i.e. price posting was done on a prior attempt
   *  and this click only finalized previously-stuck vaults. */
  isResume: boolean;
};

type Tuple = {
  /** Stable key = `${asset}:${expiry}`. */
  key: string;
  asset: string;
  expiry: number;
  feedIdHex: string;
  /** PDAs of every vault sharing this (asset, expiry). One settle_vault IX
   *  fires per entry in the same click. */
  vaultPdas: PublicKey[];
};

export const AdminTools: FC<AdminToolsProps> = ({
  vaults,
  markets,
  settlementRecords: _settlementRecords,
  program,
  onRefetch,
}) => {
  const wallet = useAnchorWallet();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<SettleConfirm | null>(null);

  const marketByPda = useMemo(() => {
    const m = new Map<string, AccountRecord>();
    for (const mkt of markets) m.set(mkt.publicKey.toBase58(), mkt);
    return m;
  }, [markets]);

  // Tuples = (asset, expiry) groups where at least one vault has
  // !is_settled. We deliberately do NOT filter on SettlementRecord
  // existence — vaults stuck after a partial settle_vault failure must
  // remain visible so the user can re-trigger and complete them.
  const tuples = useMemo<Tuple[]>(() => {
    const now = Math.floor(Date.now() / 1000);
    const grouped = new Map<string, Tuple>();
    for (const v of vaults) {
      const expiry =
        typeof v.account.expiry === "number"
          ? v.account.expiry
          : v.account.expiry.toNumber();
      if (expiry >= now) continue;
      if (v.account.isSettled) continue;
      const market = marketByPda.get((v.account.market as PublicKey).toBase58());
      if (!market) continue;
      const asset = market.account.assetName as string;
      if (!asset) continue;
      const key = `${asset}:${expiry}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.vaultPdas.push(v.publicKey);
      } else {
        grouped.set(key, {
          key,
          asset,
          expiry,
          feedIdHex: hexFromBytes(market.account.pythFeedId as number[]),
          vaultPdas: [v.publicKey],
        });
      }
    }
    return Array.from(grouped.values()).sort((a, b) => a.expiry - b.expiry);
  }, [vaults, marketByPda]);

  useEffect(() => {
    if (!confirmation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmation(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmation]);

  const handleSettle = async (tuple: Tuple) => {
    if (!wallet) {
      showToast({
        type: "error",
        title: "Connect wallet",
        message: "A wallet is required to settle.",
      });
      return;
    }
    setBusyKey(tuple.key);
    try {
      const result = await settleAllForExpiry(
        program,
        wallet,
        tuple.asset,
        tuple.expiry,
        tuple.feedIdHex,
        tuple.vaultPdas,
      );
      const priceInfo = await fetchHermesParsedPrice(tuple.feedIdHex);
      // Prefer the atomic tx sig (the post + settle_expiry) since that's
      // the most informative for explorer linking; fall back to the last
      // vault batch sig on the resume path where atomic was skipped.
      const sig =
        result.atomicSig ??
        result.vaultSigs[result.vaultSigs.length - 1] ??
        "";
      setConfirmation({
        asset: tuple.asset,
        expiry: tuple.expiry,
        price: priceInfo?.price ?? null,
        txSignature: sig,
        vaultsFinalized: result.vaultsFinalized,
        isResume: result.atomicSig === null,
      });
      onRefetch();
    } catch (err: any) {
      showToast({
        type: "error",
        title: "Settle failed",
        message: decodeError(err),
      });
    } finally {
      setBusyKey(null);
    }
  };

  if (tuples.length === 0 && !confirmation) {
    return (
      <div className="border border-rule rounded-md p-8 text-center">
        <p className="m-0 font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(14px,1vw,16px)]">
          No expired markets need settling.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="border border-rule rounded-md divide-y divide-rule-soft">
        {tuples.map((t) => {
          const isBusy = busyKey === t.key;
          const isOtherBusy = busyKey !== null && !isBusy;
          const n = t.vaultPdas.length;
          return (
            <div key={t.key} className="flex items-center gap-4 p-4">
              <div className="flex-1">
                <div className="font-mono text-[13px] text-ink">
                  {t.asset}
                  <span className="ml-3 opacity-55">
                    expired {formatExpiry(t.expiry)}
                  </span>
                </div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-55 mt-1">
                  {n} vault{n === 1 ? "" : "s"} affected
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleSettle(t)}
                disabled={isBusy || isOtherBusy || !wallet}
                className="rounded-full border border-ink bg-ink text-paper px-4 py-2 font-mono text-[10.5px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink disabled:hover:text-paper"
              >
                {isBusy ? "Settling…" : "Settle"}
              </button>
            </div>
          );
        })}
      </div>

      {confirmation && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 backdrop-blur-sm px-4"
          onClick={() => setConfirmation(null)}
        >
          <div
            className="w-full max-w-md bg-paper border border-rule rounded-md p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h3 className="m-0 font-fraunces-mid font-light text-ink leading-tight tracking-[-0.01em] text-[20px]">
                {confirmation.isResume ? "Resumed" : "Settled"} —{" "}
                {confirmation.vaultsFinalized} vault
                {confirmation.vaultsFinalized === 1 ? "" : "s"} finalized
              </h3>
              <button
                type="button"
                onClick={() => setConfirmation(null)}
                aria-label="Close"
                className="font-mono text-[14px] opacity-60 hover:opacity-100 transition-opacity duration-200"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 mb-5">
              <Row label="Asset">{confirmation.asset}</Row>
              <Row label="Expiry">{formatExpiry(confirmation.expiry)}</Row>
              <Row label="Settlement price · Hermes">
                {confirmation.price != null
                  ? `$${confirmation.price.toLocaleString()}`
                  : "—"}
              </Row>
              <Row label="Tx">
                {confirmation.txSignature ? (
                  <a
                    href={`https://solscan.io/tx/${confirmation.txSignature}?cluster=devnet`}
                    target="_blank"
                    rel="noreferrer"
                    className="opacity-80 hover:opacity-100 hover:text-crimson transition-colors duration-200"
                  >
                    {confirmation.txSignature.slice(0, 8)}…
                    {confirmation.txSignature.slice(-6)} ↗
                  </a>
                ) : (
                  "—"
                )}
              </Row>
            </div>
            <button
              type="button"
              onClick={() => setConfirmation(null)}
              className="w-full rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
};

const Row: FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex items-baseline justify-between">
    <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
      {label}
    </span>
    <span className="font-mono text-[13px] text-ink">{children}</span>
  </div>
);

export default AdminTools;
