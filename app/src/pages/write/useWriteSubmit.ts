import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
// NOTE: Most write-path imports gutted as part of the P4a stub. They
// are reinstated in P4c when the four-step submit sequence is rewritten
// against the new IDL. Do not re-add here without updating the submit
// body — the lint check would flag them as unused.

export type WriteSubmitInput = {
  /** Source market on chain — used to read assetName, pythFeed, assetClass when create_market needs to be called for a new (strike, expiry) variation. */
  market: { publicKey: PublicKey; account: any };
  side: "call" | "put";
  /** Strike in USDC (human-readable, e.g. 220). */
  strike: number;
  /** Expiry as Unix seconds. */
  expiry: number;
  /** Number of contracts to mint. */
  contracts: number;
  /** Premium per contract in USDC. */
  premiumPerContract: number;
  /** Collateral to deposit in USDC. */
  collateral: number;
  vaultType: "epoch" | "custom";
};

export type WriteSubmitResult = {
  txSignature: string;
  vaultPda: PublicKey;
  optionMint: PublicKey;
};

export type UseWriteSubmit = {
  submitting: boolean;
  /** Stage label visible to the UI while a submit is in flight. Cleared on completion. */
  stageLabel: string | null;
  submit: (input: WriteSubmitInput) => Promise<WriteSubmitResult | null>;
};

/**
 * Bundles the four-step write sequence:
 *   1. createMarket             (skip if PDA exists)
 *   2. createSharedVault        (skip if PDA exists)
 *   3. depositToVault
 *   4. mintFromVault
 *
 * Each step is a separate RPC submitted sequentially. The handler
 * derives all PDAs locally and reuses the exact account and arg
 * shapes from the legacy CreateEpochVault / CreateCustomVault /
 * MintFromVault components — no Rust changes.
 *
 * On any failure, the calling component receives `null` and the
 * decoded error is surfaced via the returned promise rejection's
 * message (caller is responsible for toasting).
 */
export function useWriteSubmit(): UseWriteSubmit {
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [stageLabel, setStageLabel] = useState<string | null>(null);

  const submit = useCallback(
    async (_input: WriteSubmitInput): Promise<WriteSubmitResult | null> => {
      if (!program || !publicKey) return null;
      // P4a stub: Stage 3 added collateral_mint to createSharedVault, and
      // Stage P1 changed createMarket signature + the market.account.pythFeed
      // field. Full write-path rewrite lands in P4c.
      throw new Error("Disabled until P4c — Pyth Pull migration in progress");
    },
    [program, publicKey],
  );

  return { submitting, stageLabel, submit };
}
