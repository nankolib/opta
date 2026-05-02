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
import { deriveVaultResaleEscrow } from "../../hooks/useAccounts";
import {
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
} from "../../utils/constants";
import { toUsdcBN } from "../../utils/format";
import { decodeError } from "../../utils/errorDecoder";
import type { ResaleListingRow } from "./useMarketplaceData";

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

export type ResaleBuyInput = {
  row: ResaleListingRow;
  quantity: number;
};

export type ResaleBuyResult = {
  txSignature: string;
};

export type UseResaleBuyFlow = {
  submitting: boolean;
  submit: (input: ResaleBuyInput) => Promise<ResaleBuyResult | null>;
};

/**
 * V2 resale-listing buy flow. Wraps `buy_v2_resale` with the same
 * accountsStrict shape the smoke script proves works, plus the same
 * idempotent-ATA + EXTRA_CU pre-instructions usePurchaseFlow uses for
 * primary buys.
 *
 * Differs from usePurchaseFlow in two intentional ways:
 *   - No slippage cushion. Resale listings are fixed-price on-chain; the
 *     5% buffer in usePurchaseFlow exists because vault premiums move
 *     between fetch and confirm via real-time B-S, which doesn't apply
 *     here. maxTotalPrice = pricePerContract * quantity exactly.
 *   - Refuses self-buy off-chain (publicKey === row.seller) before the
 *     on-chain CannotBuyOwnOption guard fires — same UX defense the
 *     BuyListingModal will layer at the Confirm-button level.
 *
 * On any failure, throws an Error whose message is `decodeError(err)`
 * so the caller routes through showToast unchanged.
 */
export function useResaleBuyFlow(): UseResaleBuyFlow {
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    async ({ row, quantity }: ResaleBuyInput): Promise<ResaleBuyResult | null> => {
      if (!program || !publicKey) return null;
      if (quantity <= 0 || quantity > row.qtyAvailable) return null;
      if (publicKey.equals(row.seller)) return null;

      setSubmitting(true);
      try {
        const optionMint = row.vaultMint.account.optionMint as PublicKey;

        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const [treasuryPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("treasury_v2")],
          program.programId,
        );
        const protocolState = await program.account.protocolState.fetch(protocolStatePda);
        const usdcMint = protocolState.usdcMint as PublicKey;

        const [resaleEscrowPda] = deriveVaultResaleEscrow(row.listing.publicKey);
        const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
        const [hookState] = deriveHookStatePda(optionMint);

        // Buyer's option ATA (Token-2022) — first-time buyer of THIS mint
        // needs it; idempotent re-create is free if it already exists.
        const buyerOptionAccount = getAssociatedTokenAddressSync(
          optionMint,
          publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        );
        const createBuyerOptionAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          buyerOptionAccount,
          publicKey,
          optionMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        // Buyer's USDC ATA (TOKEN_PROGRAM_ID, NOT Token-2022) — same
        // idempotent pre-create the primary purchaseFromVault flow uses
        // defensively. First-time buyer wallets need this.
        const buyerUsdcAccount = await getAssociatedTokenAddress(usdcMint, publicKey);
        const createBuyerUsdcAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          buyerUsdcAccount,
          publicKey,
          usdcMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        // Seller's USDC ATA — Slice C's listResaleV2 ALWAYS pre-creates this
        // at list time (CRITICAL guarantee per FRONTEND_PLAN §10), so no
        // idempotent IX needed here. Just derive and pass the address.
        const sellerUsdcAccount = getAssociatedTokenAddressSync(
          usdcMint,
          row.seller,
          false,
          TOKEN_PROGRAM_ID,
        );

        // Exact total — no slippage cushion; resale listings are fixed-price.
        const maxTotalPrice = toUsdcBN(row.pricePerContract * quantity);

        const tx = await program.methods
          .buyV2Resale(new BN(quantity), maxTotalPrice)
          .accountsStrict({
            buyer: publicKey,
            sharedVault: row.vault.publicKey,
            market: row.vault.account.market,
            vaultMintRecord: row.vaultMint.publicKey,
            listing: row.listing.publicKey,
            seller: row.seller,
            optionMint,
            resaleEscrow: resaleEscrowPda,
            buyerOptionAccount,
            buyerUsdcAccount,
            sellerUsdcAccount,
            treasury: treasuryPda,
            protocolState: protocolStatePda,
            transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
            extraAccountMetaList,
            hookState,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([EXTRA_CU, createBuyerUsdcAtaIx, createBuyerOptionAtaIx])
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
