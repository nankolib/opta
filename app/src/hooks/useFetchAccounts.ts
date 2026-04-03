/**
 * Safe account fetching that handles old-format accounts from previous deployments.
 *
 * Uses memcmp on the 8-byte Anchor discriminator to filter by account type,
 * then decodes each individually — skipping any that fail to deserialize.
 * Also validates decoded data to filter out stale accounts.
 */
import { PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { Buffer } from "buffer";

// Token-2022 program ID — hardcoded to avoid importing @solana/spl-token here
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Account discriminators from the current IDL
const DISCRIMINATORS: Record<string, number[]> = {
  optionsMarket: [67, 30, 90, 36, 130, 219, 166, 8],
  optionPosition: [212, 247, 167, 73, 56, 224, 204, 102],
  protocolState: [33, 51, 173, 134, 35, 140, 195, 248],
};

export async function safeFetchAll<T>(
  program: Program<any>,
  accountName: "optionsMarket" | "optionPosition" | "protocolState",
): Promise<{ publicKey: PublicKey; account: T }[]> {
  const discriminator = DISCRIMINATORS[accountName];
  if (!discriminator) throw new Error(`Unknown account: ${accountName}`);

  const discriminatorBytes = Buffer.from(discriminator);
  const connection = program.provider.connection;

  // Fetch all accounts owned by our program with matching discriminator
  const rawAccounts = await connection.getProgramAccounts(program.programId, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: bs58Encode(discriminatorBytes),
        },
      },
    ],
  });

  // Decode each account individually, skipping decode failures
  const decoded: { publicKey: PublicKey; account: T }[] = [];
  const seen = new Set<string>(); // deduplicate by key

  for (const raw of rawAccounts) {
    try {
      const account = program.coder.accounts.decode(
        accountName,
        raw.account.data,
      ) as any;

      // Extra validation: skip accounts that decoded but have wrong shape
      if (accountName === "optionsMarket") {
        // Current format has assetName (string). Old format had underlyingAsset (enum).
        if (typeof account.assetName !== "string" || !account.assetName) continue;
        // Post-migration markets have assetClass 0-4. Old markets read garbage (249-255).
        if (typeof account.assetClass !== "number" || account.assetClass > 4) continue;
      }
      if (accountName === "optionPosition") {
        // Current format has optionMint (Pubkey). Old format had buyer (Option<Pubkey>).
        if (!account.optionMint) continue;
      }

      // Deduplicate — same PDA from different fetches shouldn't appear twice
      const key = raw.pubkey.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);

      decoded.push({ publicKey: raw.pubkey, account: account as T });
    } catch {
      // Skip old-format accounts that can't be decoded
    }
  }

  // For positions, filter to only Token-2022 mints (post-migration).
  // Old pre-migration positions use standard SPL Token mints and will fail on any transaction.
  if (accountName === "optionPosition" && decoded.length > 0) {
    try {
      const mints = decoded.map((d) => (d.account as any).optionMint as PublicKey);
      const mintInfos = await connection.getMultipleAccountsInfo(mints);
      return decoded.filter((_, i) => {
        const info = mintInfos[i];
        return info && info.owner.equals(TOKEN_2022_PROGRAM_ID);
      });
    } catch {
      // If mint lookup fails (e.g. network error), return all decoded positions
      return decoded;
    }
  }

  return decoded;
}

/** Encode bytes as base58 for RPC memcmp filter. */
function bs58Encode(bytes: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    str += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    str += ALPHABET[digits[i]];
  }
  return str;
}
