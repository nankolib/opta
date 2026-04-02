import { useEffect, useState, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useProgram } from "./useProgram";

/**
 * Safely fetch all accounts of a given type from the program.
 *
 * The standard program.account.X.all() can fail if old accounts with a
 * different layout exist on-chain (from a previous program version). This
 * hook catches decode errors and returns only successfully decoded accounts.
 */
export function useSafeFetchAll<T>(
  accountName: "optionsMarket" | "optionPosition" | "protocolState",
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
