import { useCallback, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { deriveVaultResaleEscrow } from "../../hooks/useAccounts";
import {
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
} from "../../utils/constants";
import { decodeError } from "../../utils/errorDecoder";
import type { ResaleListingRow } from "./useMarketplaceData";

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

export type ResaleCancelInput = {
  row: ResaleListingRow;
};

export type ResaleCancelResult = {
  txSignature: string;
};

export type UseResaleCancelFlow = {
  submitting: boolean;
  /**
   * Row id (option-mint base58) currently being cancelled, or null when
   * idle. Drives row-level disabled state on the My Listings table —
   * matches the busyId convention from usePortfolioActions.
   */
  busyId: string | null;
  submit: (input: ResaleCancelInput) => Promise<ResaleCancelResult | null>;
};

/**
 * V2 resale-listing cancel flow. Wraps `cancel_v2_resale` with the same
 * 12-account accountsStrict block smoke-cancel-v2.ts proves works, plus
 * EXTRA_CU pre-instruction and a defensive idempotent re-create of the
 * seller's option ATA (in case the seller closed it post-listing — rare
 * but not impossible).
 *
 * Mirrors useResaleBuyFlow's shape but specialised for the row-driven
 * cancel UX on Marketplace's My Listings section: returns a busyId so
 * the table can disable the cancelling row's button without spinning a
 * full modal lifecycle. Cancel takes no user input — just confirm via
 * wallet — so no modal is needed.
 *
 * Refuses cancellation off-chain when the connected wallet doesn't own
 * the listing (publicKey !== row.seller). The on-chain handler reverts
 * with NotResaleSeller in that case; we short-circuit for cleaner UX.
 *
 * NOTE: this duplicates the V2 cancel logic in usePortfolioActions.
 * cancelResaleV2 (Slice C). The duplication is acknowledged and
 * intentional — Portfolio takes a `Position`, this hook takes a
 * `ResaleListingRow`, and unifying them would require a bigger refactor
 * not in scope for Step 7.4. If/when a future arc consolidates the two,
 * both call sites can route through a single helper.
 *
 * On any failure, throws an Error whose message is `decodeError(err)`
 * so the caller routes through showToast unchanged.
 */
export function useResaleCancelFlow(): UseResaleCancelFlow {
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const submit = useCallback(
    async ({ row }: ResaleCancelInput): Promise<ResaleCancelResult | null> => {
      if (!program || !publicKey) return null;
      if (!publicKey.equals(row.seller)) return null;

      const optionMint = row.vaultMint.account.optionMint as PublicKey;
      const id = optionMint.toBase58();

      setSubmitting(true);
      setBusyId(id);
      try {
        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const [resaleEscrowPda] = deriveVaultResaleEscrow(row.listing.publicKey);
        const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
        const [hookState] = deriveHookStatePda(optionMint);

        // Defensive: the seller had an option ATA at list time, but may
        // have closed it afterward (rare). Idempotent re-create is free
        // if it already exists and prevents a "destination ATA not found"
        // revert. Same pattern as Slice C's cancelResaleV2.
        const sellerOptionAccount = getAssociatedTokenAddressSync(
          optionMint,
          publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        );
        const createSellerOptionAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          sellerOptionAccount,
          publicKey,
          optionMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        const tx = await program.methods
          .cancelV2Resale()
          .accountsStrict({
            seller: publicKey,
            sharedVault: row.vault.publicKey,
            optionMint,
            listing: row.listing.publicKey,
            resaleEscrow: resaleEscrowPda,
            sellerOptionAccount,
            protocolState: protocolStatePda,
            transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
            extraAccountMetaList,
            hookState,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([EXTRA_CU, createSellerOptionAtaIx])
          .rpc({ commitment: "confirmed" });

        return { txSignature: tx };
      } catch (err: any) {
        throw new Error(decodeError(err));
      } finally {
        setSubmitting(false);
        setBusyId(null);
      }
    },
    [program, publicKey],
  );

  return { submitting, busyId, submit };
}
