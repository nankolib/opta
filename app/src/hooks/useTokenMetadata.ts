import { useEffect, useState, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchOptionTokenMetadata, OptionTokenMetadata } from "../utils/tokenMetadata";

/**
 * Fetches and caches Token-2022 metadata for a set of mint pubkeys.
 * Returns a map keyed by mint base58 string.
 */
export function useTokenMetadata(mints: PublicKey[]): Map<string, OptionTokenMetadata> {
  const { connection } = useConnection();
  const [metadata, setMetadata] = useState<Map<string, OptionTokenMetadata>>(new Map());
  const cacheRef = useRef<Map<string, OptionTokenMetadata>>(new Map());

  useEffect(() => {
    if (mints.length === 0) return;
    let cancelled = false;

    const fetchAll = async () => {
      // Only fetch mints not already cached
      const toFetch = mints.filter((m) => !cacheRef.current.has(m.toBase58()));
      if (toFetch.length === 0) return;

      for (const mint of toFetch) {
        try {
          const meta = await fetchOptionTokenMetadata(connection, mint);
          if (meta && !cancelled) {
            cacheRef.current.set(mint.toBase58(), meta);
          }
        } catch {
          // Skip failed fetches
        }
      }
      if (!cancelled) {
        setMetadata(new Map(cacheRef.current));
      }
    };

    fetchAll();
    return () => { cancelled = true; };
  }, [mints.map((m) => m.toBase58()).join(","), connection]);

  return metadata;
}
