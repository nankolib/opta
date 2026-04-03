import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export { TOKEN_2022_PROGRAM_ID };

export const PROGRAM_ID = new PublicKey(
  "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq",
);

export const TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG",
);

// PDA seeds (must match the Rust program)
export const PROTOCOL_SEED = "protocol_v2";
export const TREASURY_SEED = "treasury_v2";
export const MARKET_SEED = "market";
export const POSITION_SEED = "position";
export const ESCROW_SEED = "escrow";
export const OPTION_MINT_SEED = "option_mint";
export const PURCHASE_ESCROW_SEED = "purchase_escrow";
export const RESALE_ESCROW_SEED = "resale_escrow";

// Transfer hook PDA helpers
export function deriveExtraAccountMetaListPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID,
  );
}

export function deriveHookStatePda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID,
  );
}
