import { useEffect, useState, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { useConnection } from "@solana/wallet-adapter-react";
import { useProgram } from "./useProgram";
import {
  SHARED_VAULT_SEED,
  VAULT_USDC_SEED,
  WRITER_POSITION_SEED,
  VAULT_OPTION_MINT_SEED,
  VAULT_PURCHASE_ESCROW_SEED,
  VAULT_MINT_RECORD_SEED,
  EPOCH_CONFIG_SEED,
  VAULT_RESALE_LISTING_SEED,
  VAULT_RESALE_ESCROW_SEED,
  PROGRAM_ID,
} from "../utils/constants";

/**
 * Safely fetch all accounts of a given type from the program.
 *
 * The standard program.account.X.all() can fail if old accounts with a
 * different layout exist on-chain (from a previous program version). This
 * hook catches decode errors and returns only successfully decoded accounts.
 */
export function useSafeFetchAll<T>(
  accountName: "optionsMarket" | "protocolState"
    | "sharedVault" | "writerPosition" | "vaultMint" | "epochConfig",
) {
  const { program } = useProgram();
  const { connection } = useConnection();
  const [accounts, setAccounts] = useState<{ publicKey: PublicKey; account: T }[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!program) {
      setLoading(false);
      return;
    }
    setLoading(true);

    try {
      // Get the account discriminator (first 8 bytes of sha256("account:<Name>"))
      const coder = program.coder.accounts;
      const accountType = program.account[accountName];

      // Use getProgramAccounts with memcmp on the discriminator
      const rawAccounts = await connection.getProgramAccounts(program.programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: (accountType as any)._coder?.accountDiscriminator?.(accountName) ??
                "",
            },
          },
        ],
      });

      // Try to decode each account individually, skipping failures
      const decoded: { publicKey: PublicKey; account: T }[] = [];
      for (const raw of rawAccounts) {
        try {
          const account = coder.decode(accountName, raw.account.data);
          decoded.push({ publicKey: raw.pubkey, account: account as T });
        } catch {
          // Skip accounts that can't be decoded (old format)
        }
      }

      setAccounts(decoded);
    } catch (err) {
      console.error(`Failed to fetch ${accountName} accounts:`, err);
      // Fallback: try the standard .all() method
      try {
        const result = await (program.account[accountName] as any).all();
        setAccounts(result);
      } catch {
        setAccounts([]);
      }
    } finally {
      setLoading(false);
    }
  }, [program, connection, accountName]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { accounts, loading, refetch };
}

// === V2 Vault PDA Derivation Helpers ===

/** Seeds: ["shared_vault", market, strike_price(8 LE), expiry(8 LE), option_type(1)] */
export function deriveSharedVault(
  market: PublicKey,
  strikePrice: BN,
  expiry: BN,
  optionType: number, // 0 = Call, 1 = Put
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(SHARED_VAULT_SEED),
      market.toBuffer(),
      strikePrice.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([optionType]),
    ],
    programId,
  );
}

/** Seeds: ["vault_usdc", shared_vault] */
export function deriveVaultUsdc(
  sharedVault: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_USDC_SEED), sharedVault.toBuffer()],
    programId,
  );
}

/** Seeds: ["writer_position", shared_vault, writer] */
export function deriveWriterPosition(
  sharedVault: PublicKey,
  writer: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(WRITER_POSITION_SEED),
      sharedVault.toBuffer(),
      writer.toBuffer(),
    ],
    programId,
  );
}

/** Seeds: ["vault_option_mint", shared_vault, writer, created_at(8 LE)] */
export function deriveVaultOptionMint(
  sharedVault: PublicKey,
  writer: PublicKey,
  createdAt: BN,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_OPTION_MINT_SEED),
      sharedVault.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

/** Seeds: ["vault_purchase_escrow", shared_vault, writer, created_at(8 LE)] */
export function deriveVaultPurchaseEscrow(
  sharedVault: PublicKey,
  writer: PublicKey,
  createdAt: BN,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_PURCHASE_ESCROW_SEED),
      sharedVault.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    programId,
  );
}

/** Seeds: ["vault_mint_record", option_mint] */
export function deriveVaultMintRecord(
  optionMint: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_MINT_RECORD_SEED), optionMint.toBuffer()],
    programId,
  );
}

/** Seeds: ["epoch_config"] (singleton) */
export function deriveEpochConfig(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(EPOCH_CONFIG_SEED)],
    programId,
  );
}

/** Seeds: ["vault_resale_listing", option_mint, seller] */
export function deriveVaultResaleListing(
  optionMint: PublicKey,
  seller: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_RESALE_LISTING_SEED),
      optionMint.toBuffer(),
      seller.toBuffer(),
    ],
    programId,
  );
}

/** Seeds: ["vault_resale_escrow", listing] */
export function deriveVaultResaleEscrow(
  listing: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_RESALE_ESCROW_SEED), listing.toBuffer()],
    programId,
  );
}
