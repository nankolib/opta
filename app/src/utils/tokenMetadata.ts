// Parses Token-2022 MetadataExtension from mint accounts.
// The metadata (name, symbol) is embedded directly in the mint account data.

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";

export interface OptionTokenMetadata {
  name: string;
  symbol: string;
  uri: string;
  mint: PublicKey;
}

export async function fetchOptionTokenMetadata(
  connection: Connection,
  mint: PublicKey,
): Promise<OptionTokenMetadata | null> {
  try {
    const metadata = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (!metadata) return null;
    return {
      name: metadata.name || "",
      symbol: metadata.symbol || "",
      uri: metadata.uri || "",
      mint,
    };
  } catch {
    return null;
  }
}

/**
 * Batch-fetch metadata for multiple mints. Caches by mint address.
 * Returns a map keyed by mint base58 string.
 */
export async function fetchBatchMetadata(
  connection: Connection,
  mints: PublicKey[],
): Promise<Map<string, OptionTokenMetadata>> {
  const result = new Map<string, OptionTokenMetadata>();
  // Fetch in parallel, up to 10 at a time to avoid rate limits
  const chunks: PublicKey[][] = [];
  for (let i = 0; i < mints.length; i += 10) {
    chunks.push(mints.slice(i, i + 10));
  }
  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map((m) => fetchOptionTokenMetadata(connection, m)),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        result.set(r.value.mint.toBase58(), r.value);
      }
    }
  }
  return result;
}
