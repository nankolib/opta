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

// === V2 Vault Seeds ===
export const SHARED_VAULT_SEED = "shared_vault";
export const VAULT_USDC_SEED = "vault_usdc";
export const WRITER_POSITION_SEED = "writer_position";
export const VAULT_MINT_RECORD_SEED = "vault_mint_record";
export const VAULT_OPTION_MINT_SEED = "vault_option_mint";
export const VAULT_PURCHASE_ESCROW_SEED = "vault_purchase_escrow";
export const EPOCH_CONFIG_SEED = "epoch_config";

// Feature flag: when true, UI uses v2 shared vault flows.
// When false, UI uses v1 isolated escrow flows.
export const USE_V2_VAULTS = true;

// Devnet-only faucet wallet — has USDC to distribute to test users.
// DO NOT use on mainnet. This keypair is public and has no real value.
export const DEVNET_FAUCET_KEYPAIR = Uint8Array.from([
  190, 228, 179, 16, 84, 86, 220, 167, 58, 26, 230, 109, 55, 214, 31, 68,
  44, 125, 100, 199, 2, 66, 159, 161, 128, 189, 95, 122, 246, 177, 174, 144,
  179, 209, 250, 69, 129, 154, 48, 172, 136, 163, 58, 36, 243, 181, 200, 211,
  13, 245, 237, 45, 41, 30, 221, 12, 131, 243, 51, 64, 92, 218, 20, 129,
]);
export const DEVNET_USDC_MINT = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");

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
