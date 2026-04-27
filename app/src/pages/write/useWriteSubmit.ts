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
    async (input: WriteSubmitInput): Promise<WriteSubmitResult | null> => {
      if (!program || !publicKey) return null;
      setSubmitting(true);
      setStageLabel("Preparing…");

      try {
        const asset = input.market.account.assetName as string;
        const feedPubkey = input.market.account.pythFeed as PublicKey;
        const assetClass = input.market.account.assetClass as number;
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

        const [marketPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from("market"),
            Buffer.from(asset),
            strikeBN.toArrayLike(Buffer, "le", 8),
            expiryBN.toArrayLike(Buffer, "le", 8),
            Buffer.from([optTypeIndex]),
          ],
          program.programId,
        );

        // ---- Step 1: createMarket (skip if exists) ----
        let marketExists = false;
        try {
          await program.account.optionsMarket.fetch(marketPda);
          marketExists = true;
        } catch {
          // not yet created
        }

        if (!marketExists) {
          setStageLabel("1/4 · Creating market");
          await program.methods
            .createMarket(
              asset,
              strikeBN,
              expiryBN,
              optTypeEnum as any,
              feedPubkey,
              assetClass,
            )
            .accountsStrict({
              creator: publicKey,
              protocolState: protocolStatePda,
              market: marketPda,
              systemProgram: SystemProgram.programId,
            })
            .rpc({ commitment: "confirmed" });
        }

        // ---- Step 2: createSharedVault (skip if exists) ----
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
          setStageLabel("2/4 · Creating vault");
          const [epochConfigPda] = deriveEpochConfig();
          await program.methods
            .createSharedVault(
              strikeBN,
              expiryBN,
              optTypeEnum as any,
              input.vaultType === "epoch" ? { epoch: {} } : ({ custom: {} } as any),
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

        // ---- Step 3: depositToVault ----
        setStageLabel("3/4 · Depositing collateral");
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

        // ---- Step 4: mintFromVault ----
        setStageLabel("4/4 · Minting contracts");
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
