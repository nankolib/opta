import { useMemo } from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import type { ButterOptions } from "../idl/butter_options";
import idl from "../idl/butter_options.json";

/**
 * Hook that returns an Anchor Program instance for Butter Options.
 *
 * If no wallet is connected, returns a read-only provider (can fetch accounts
 * but cannot send transactions).
 */
export function useProgram(): {
  program: Program<ButterOptions> | null;
  provider: AnchorProvider | null;
} {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    // Create a provider — if no wallet, use a dummy for read-only access
    const provider = wallet
      ? new AnchorProvider(connection, wallet, { commitment: "confirmed" })
      : null;

    if (!provider) {
      // Read-only: create a minimal provider for fetching accounts
      try {
        const readOnlyProvider = {
          connection,
        } as any;
        const program = new Program(
          idl as any,
          readOnlyProvider,
        ) as unknown as Program<ButterOptions>;
        return { program, provider: null };
      } catch {
        return { program: null, provider: null };
      }
    }

    const program = new Program(
      idl as any,
      provider,
    ) as unknown as Program<ButterOptions>;
    return { program, provider };
  }, [connection, wallet]);
}
