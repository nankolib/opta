import { useCallback, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import {
  deriveWriterPosition,
  deriveVaultPurchaseEscrow,
} from "../../hooks/useAccounts";
import {
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
} from "../../utils/constants";
import { toUsdcBN } from "../../utils/format";
import { decodeError } from "../../utils/errorDecoder";
import type { ChainBest } from "./useTradeData";

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

export type PurchaseInput = {
  best: ChainBest;
  quantity: number;
};

export type PurchaseResult = {
  txSignature: string;
};

export type UsePurchaseFlow = {
  submitting: boolean;
  submit: (input: PurchaseInput) => Promise<PurchaseResult | null>;
};

/**
 * V2-only purchase flow. Wraps `purchase_from_vault` with the same
 * account derivations and 5% slippage guard as the legacy
 * BuyVaultModal. V1 path is intentionally dropped — current
 * production has USE_V2_VAULTS=true and the chain build filters out
 * v1 sources entirely.
 *
 * On any failure, throws an Error whose message is `decodeError(err)`
 * so the caller can route through showToast unchanged.
 */
export function usePurchaseFlow(): UsePurchaseFlow {
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    async ({ best, quantity }: PurchaseInput): Promise<PurchaseResult | null> => {
      if (!program || !publicKey) return null;
      if (quantity <= 0) return null;
      setSubmitting(true);
      try {
        const vault = best.vault;
        const vaultMint = best.vaultMint;
        const v = vault.account;
        const vm = vaultMint.account;

        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const [treasuryPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("treasury_v2")],
          program.programId,
        );
        const protocolState = await program.account.protocolState.fetch(protocolStatePda);

        const buyerUsdcAccount = await getAssociatedTokenAddress(
          protocolState.usdcMint,
          publicKey,
        );
        const optionMint = vm.optionMint as PublicKey;
        const writer = vm.writer as PublicKey;
        const createdAt = vm.createdAt as BN;

        const [writerPositionPda] = deriveWriterPosition(vault.publicKey, writer);
        const [purchaseEscrowPda] = deriveVaultPurchaseEscrow(
          vault.publicKey,
          writer,
          createdAt,
        );
        const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
        const [hookState] = deriveHookStatePda(optionMint);

        const buyerOptionAccount = getAssociatedTokenAddressSync(
          optionMint,
          publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        );
        const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          buyerOptionAccount,
          publicKey,
          optionMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        // 5% slippage guard, mirrors legacy BuyVaultModal.
        const maxPremium = toUsdcBN(best.premium * quantity * 1.05);

        const tx = await program.methods
          .purchaseFromVault(new BN(quantity), maxPremium)
          .accountsStrict({
            buyer: publicKey,
            sharedVault: vault.publicKey,
            writerPosition: writerPositionPda,
            vaultMintRecord: vaultMint.publicKey,
            protocolState: protocolStatePda,
            market: v.market,
            optionMint,
            purchaseEscrow: purchaseEscrowPda,
            buyerOptionAccount,
            buyerUsdcAccount,
            vaultUsdcAccount: v.vaultUsdcAccount,
            treasury: treasuryPda,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
            extraAccountMetaList,
            hookState,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([EXTRA_CU, createAtaIx])
          .rpc({ commitment: "confirmed" });

        return { txSignature: tx };
      } catch (err: any) {
        throw new Error(decodeError(err));
      } finally {
        setSubmitting(false);
      }
    },
    [program, publicKey],
  );

  return { submitting, submit };
}
