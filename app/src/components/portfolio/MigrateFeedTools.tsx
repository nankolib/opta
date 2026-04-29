import { FC, useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { showToast } from "../Toast";
import { decodeError } from "../../utils/errorDecoder";
import { hexFromBytes, hexToBytes32 } from "../../utils/format";

interface AccountRecord {
  publicKey: PublicKey;
  account: any;
}

interface MigrateFeedToolsProps {
  markets: AccountRecord[];
  program: any;
  onRefetch: () => void;
}

type ModalState =
  | { kind: "idle" }
  | { kind: "confirm"; asset: string; oldHex: string; newHex: string }
  | { kind: "submitting"; asset: string; oldHex: string; newHex: string }
  | { kind: "success"; asset: string; newHex: string; txSig: string };

const HEX_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const MARKET_SEED = "market";
const PROTOCOL_SEED = "protocol_v2";

export const MigrateFeedTools: FC<MigrateFeedToolsProps> = ({
  markets,
  program,
  onRefetch,
}) => {
  const wallet = useAnchorWallet();
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [newHexInput, setNewHexInput] = useState("");
  const [modal, setModal] = useState<ModalState>({ kind: "idle" });

  const sortedMarkets = useMemo(() => {
    return [...markets].sort((a, b) =>
      (a.account.assetName as string).localeCompare(b.account.assetName as string),
    );
  }, [markets]);

  const currentMarket = useMemo(
    () => sortedMarkets.find((m) => m.account.assetName === selectedAsset) ?? null,
    [sortedMarkets, selectedAsset],
  );
  const currentHex = currentMarket
    ? hexFromBytes(currentMarket.account.pythFeedId as number[])
    : "";

  const trimmedNewHex = newHexInput.trim().toLowerCase().replace(/^0x/, "");
  const newHexValid = HEX_RE.test(newHexInput);
  const newHexDiffers = newHexValid && trimmedNewHex !== currentHex;

  const canSubmit =
    !!selectedAsset && newHexValid && newHexDiffers && modal.kind === "idle";

  // Esc closes the confirm or success modal. Critically NOT during
  // "submitting" — dismissing mid-RPC would let the in-flight promise
  // resolve into a popped success modal seconds after the user thought
  // they'd cancelled. The submit state must be unkillable until the
  // RPC settles.
  useEffect(() => {
    if (modal.kind !== "confirm" && modal.kind !== "success") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal({ kind: "idle" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal.kind]);

  const openConfirm = () => {
    if (!canSubmit || !selectedAsset) return;
    setModal({
      kind: "confirm",
      asset: selectedAsset,
      oldHex: currentHex,
      newHex: trimmedNewHex,
    });
  };

  const handleConfirm = async () => {
    if (modal.kind !== "confirm") return;
    if (!wallet) {
      showToast({
        type: "error",
        title: "Connect wallet",
        message: "Admin wallet is required.",
      });
      return;
    }
    const { asset, oldHex, newHex } = modal;
    setModal({ kind: "submitting", asset, oldHex, newHex });
    try {
      const newBytes = hexToBytes32(newHex);
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(MARKET_SEED), Buffer.from(asset)],
        program.programId,
      );
      const [protocolStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from(PROTOCOL_SEED)],
        program.programId,
      );
      const sig = await program.methods
        .migratePythFeed(asset, newBytes)
        .accountsStrict({
          admin: wallet.publicKey,
          protocolState: protocolStatePda,
          market: marketPda,
        })
        .rpc({ commitment: "confirmed" });
      setModal({ kind: "success", asset, newHex, txSig: sig });
      setNewHexInput("");
      onRefetch();
    } catch (err: any) {
      setModal({ kind: "idle" });
      showToast({
        type: "error",
        title: "Migrate failed",
        message: decodeError(err),
      });
    }
  };

  if (sortedMarkets.length === 0) {
    return (
      <div className="border border-rule rounded-md p-8 text-center">
        <p className="m-0 font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(14px,1vw,16px)]">
          No markets registered yet.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="border border-rule rounded-md p-5 space-y-5">
        {/* Asset picker */}
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
            Asset
          </div>
          <div className="flex flex-wrap gap-2">
            {sortedMarkets.map((m) => {
              const ticker = m.account.assetName as string;
              const active = selectedAsset === ticker;
              return (
                <button
                  key={ticker}
                  type="button"
                  onClick={() => setSelectedAsset(ticker)}
                  aria-pressed={active}
                  className={`rounded-full border px-[14px] py-[6px] font-mono text-[10.5px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
                    active
                      ? "border-ink bg-ink text-paper"
                      : "border-rule text-ink opacity-65 hover:opacity-100 hover:border-ink"
                  }`}
                >
                  {ticker}
                </button>
              );
            })}
          </div>
        </div>

        {/* Current feed (read-only) */}
        {currentMarket && (
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
              Current feed_id
            </div>
            <div
              className="font-mono text-[12px] text-ink opacity-80 break-all"
              title={currentHex}
            >
              {currentHex.slice(0, 16)}…{currentHex.slice(-16)}
            </div>
          </div>
        )}

        {/* New feed input */}
        {currentMarket && (
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
              New feed_id
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newHexInput}
                onChange={(e) => setNewHexInput(e.target.value)}
                placeholder="64-char hex (with or without 0x)"
                spellCheck={false}
                className="flex-1 bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[12px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
              />
              <span
                className={`font-mono text-[12px] ${
                  newHexValid && newHexDiffers
                    ? "text-emerald-700"
                    : newHexInput
                      ? "text-crimson"
                      : "opacity-40"
                }`}
                aria-label={newHexValid && newHexDiffers ? "valid" : "invalid"}
              >
                {newHexValid && newHexDiffers ? "✓" : newHexInput ? "✕" : "·"}
              </span>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
              {newHexValid && !newHexDiffers
                ? "matches current feed_id — pick a different value"
                : "64 hex characters · 0x prefix optional"}
            </div>
          </div>
        )}

        {/* Submit */}
        <button
          type="button"
          onClick={openConfirm}
          disabled={!canSubmit}
          className="w-full rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink disabled:hover:text-paper"
        >
          Migrate feed_id
        </button>
      </div>

      {/* Confirm + submitting modal — click-outside only dismisses while
          in confirm state; submitting is unkillable until RPC settles. */}
      {(modal.kind === "confirm" || modal.kind === "submitting") && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 backdrop-blur-sm px-4"
          onClick={() => {
            if (modal.kind === "confirm") setModal({ kind: "idle" });
          }}
        >
          <div
            className="w-full max-w-md bg-paper border border-rule rounded-md p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="m-0 mb-5 font-fraunces-mid font-light text-ink leading-tight tracking-[-0.01em] text-[20px]">
              Migrate Pyth feed_id
            </h3>
            <div className="space-y-3 mb-5">
              <Row label="Asset">{modal.asset}</Row>
              <Row label="Old feed">
                <span title={modal.oldHex}>
                  {modal.oldHex.slice(0, 8)}…{modal.oldHex.slice(-8)}
                </span>
              </Row>
              <Row label="New feed">
                <span title={modal.newHex}>
                  {modal.newHex.slice(0, 8)}…{modal.newHex.slice(-8)}
                </span>
              </Row>
            </div>
            <p className="m-0 mb-5 font-fraunces-text italic font-light leading-[1.5] opacity-70 text-[12.5px]">
              This rotates the on-chain feed_id pointer. All future settlements
              for this asset will use the new feed.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setModal({ kind: "idle" })}
                disabled={modal.kind === "submitting"}
                className="flex-1 rounded-full border border-rule px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-ink/65 hover:text-ink hover:border-ink transition-colors duration-300 ease-opta disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={modal.kind === "submitting"}
                className="flex-1 rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50"
              >
                {modal.kind === "submitting" ? "Migrating…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success modal — RPC complete, free to dismiss anywhere. */}
      {modal.kind === "success" && (
        <div
          className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/50 backdrop-blur-sm px-4"
          onClick={() => setModal({ kind: "idle" })}
        >
          <div
            className="w-full max-w-md bg-paper border border-rule rounded-md p-8 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="m-0 mb-5 font-fraunces-mid font-light text-ink leading-tight tracking-[-0.01em] text-[20px]">
              Feed migrated
            </h3>
            <div className="space-y-3 mb-5">
              <Row label="Asset">{modal.asset}</Row>
              <Row label="New feed">
                <span title={modal.newHex}>
                  {modal.newHex.slice(0, 8)}…{modal.newHex.slice(-8)}
                </span>
              </Row>
              <Row label="Tx">
                <a
                  href={`https://solscan.io/tx/${modal.txSig}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                  className="opacity-80 hover:opacity-100 hover:text-crimson transition-colors duration-200"
                >
                  {modal.txSig.slice(0, 8)}…{modal.txSig.slice(-6)} ↗
                </a>
              </Row>
            </div>
            <button
              type="button"
              onClick={() => setModal({ kind: "idle" })}
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
  <div className="flex items-baseline justify-between gap-4">
    <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
      {label}
    </span>
    <span className="font-mono text-[13px] text-ink whitespace-nowrap">
      {children}
    </span>
  </div>
);

export default MigrateFeedTools;
