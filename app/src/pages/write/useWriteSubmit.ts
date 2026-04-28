import { useCallback, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import BN from "bn.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import {
  deriveSharedVault,
  deriveVaultUsdc,
  deriveWriterPosition,
  deriveVaultOptionMint,
  deriveVaultPurchaseEscrow,
  deriveVaultMintRecord,
  deriveEpochConfig,
} from "../../hooks/useAccounts";
import {
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
} from "../../utils/constants";
import { toUsdcBN } from "../../utils/format";
import { decodeError } from "../../utils/errorDecoder";

const EXTRA_CU_400K = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const EXTRA_CU_800K = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

// On-chain seed constant — must match Rust (programs/opta/src/state/market.rs:65).
//   MARKET_SEED = b"market"
const MARKET_SEED = "market";

export type WriteSubmitInput = {
  /** Source market on chain — provides assetName for the (now single-seed)
   *  market PDA derivation. createMarket itself is no longer called here;
   *  the caller is expected to register the asset via Markets first. */
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
 * Bundles the three-step write sequence (post-Stage-P4c, post-Stage-2):
 *   1. createSharedVault        (skip if PDA exists)
 *   2. depositToVault
 *   3. mintFromVault
 *
 * createMarket is no longer part of this flow — markets are per-asset
 * registry rows now (Stage 2), and the user is expected to register an
 * asset via the Markets page before writing options on it. If
 * `input.market` is missing, we surface a clear error pointing back there.
 *
 * createSharedVault gained a 5th positional arg `collateral_mint: Pubkey`
 * in Stage 3 (USDC-only validation lives on the vault, not the market).
 * We pass `protocolState.usdcMint` for that arg.
 *
 * Each step is a separate RPC submitted sequentially. On any failure
 * the caller receives `null` and we throw the decoded error string for
 * the toaster to display.
 */
export function useWriteSubmit(): UseWriteSubmit {
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [stageLabel, setStageLabel] = useState<string | null>(null);

  const submit = useCallback(
    async (input: WriteSubmitInput): Promise<WriteSubmitResult | null> => {
      if (!program || !publicKey) return null;
      if (!input.market) {
        throw new Error(
          "No market selected. Open Markets and create one for this asset first.",
        );
      }
      setSubmitting(true);
      setStageLabel("Preparing…");

      try {
        const asset = input.market.account.assetName as string;
        const optTypeEnum = input.side === "call" ? { call: {} } : { put: {} };
        const optTypeIndex = input.side === "call" ? 0 : 1;

        const strikeBN = toUsdcBN(input.strike);
        const expiryBN = new BN(input.expiry);
        const collateralBN = toUsdcBN(input.collateral);
        const contractsBN = new BN(input.contracts);
        const premiumBN = toUsdcBN(input.premiumPerContract);
        const createdAt = new BN(Math.floor(Date.now() / 1000));

        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const protocolState = await program.account.protocolState.fetch(protocolStatePda);
        const writerUsdcAccount = await getAssociatedTokenAddress(
          protocolState.usdcMint,
          publicKey,
        );

        // Single-seed market PDA — strike/expiry/side moved to SharedVault
        // in Stage 2, so the market is per-asset only.
        const [marketPda] = PublicKey.findProgramAddressSync(
          [Buffer.from(MARKET_SEED), Buffer.from(asset)],
          program.programId,
        );

        // ---- Step 1: createSharedVault (skip if exists) ----
        const [sharedVaultPda] = deriveSharedVault(
          marketPda,
          strikeBN,
          expiryBN,
          optTypeIndex,
        );
        const [vaultUsdcPda] = deriveVaultUsdc(sharedVaultPda);

        let vaultExists = false;
        try {
          await program.account.sharedVault.fetch(sharedVaultPda);
          vaultExists = true;
        } catch {
          // not yet created
        }

        if (!vaultExists) {
          setStageLabel("1/3 · Creating vault");
          const [epochConfigPda] = deriveEpochConfig();
          await program.methods
            .createSharedVault(
              strikeBN,
              expiryBN,
              optTypeEnum as any,
              input.vaultType === "epoch" ? { epoch: {} } : ({ custom: {} } as any),
              protocolState.usdcMint,
            )
            .accountsStrict({
              creator: publicKey,
              market: marketPda,
              sharedVault: sharedVaultPda,
              vaultUsdcAccount: vaultUsdcPda,
              usdcMint: protocolState.usdcMint,
              protocolState: protocolStatePda,
              epochConfig: input.vaultType === "epoch" ? epochConfigPda : null,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .preInstructions([EXTRA_CU_400K])
            .rpc({ commitment: "confirmed" });
        }

        // ---- Step 2: depositToVault ----
        setStageLabel("2/3 · Depositing collateral");
        const [writerPositionPda] = deriveWriterPosition(sharedVaultPda, publicKey);
        await program.methods
          .depositToVault(collateralBN)
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
          .preInstructions([EXTRA_CU_400K])
          .rpc({ commitment: "confirmed" });

        // ---- Step 3: mintFromVault ----
        setStageLabel("3/3 · Minting contracts");
        const [optionMintPda] = deriveVaultOptionMint(
          sharedVaultPda,
          publicKey,
          createdAt,
        );
        const [purchaseEscrowPda] = deriveVaultPurchaseEscrow(
          sharedVaultPda,
          publicKey,
          createdAt,
        );
        const [vaultMintRecordPda] = deriveVaultMintRecord(optionMintPda);
        const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
        const [hookState] = deriveHookStatePda(optionMintPda);

        const tx = await program.methods
          .mintFromVault(contractsBN, premiumBN, createdAt)
          .accountsStrict({
            writer: publicKey,
            sharedVault: sharedVaultPda,
            writerPosition: writerPositionPda,
            market: marketPda,
            protocolState: protocolStatePda,
            optionMint: optionMintPda,
            purchaseEscrow: purchaseEscrowPda,
            vaultMintRecord: vaultMintRecordPda,
            transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
            extraAccountMetaList,
            hookState,
            systemProgram: SystemProgram.programId,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .preInstructions([EXTRA_CU_800K])
          .rpc({ commitment: "confirmed" });

        return {
          txSignature: tx,
          vaultPda: sharedVaultPda,
          optionMint: optionMintPda,
        };
      } catch (err: any) {
        throw new Error(decodeError(err));
      } finally {
        setSubmitting(false);
        setStageLabel(null);
      }
    },
    [program, publicKey],
  );

  return { submitting, stageLabel, submit };
}
