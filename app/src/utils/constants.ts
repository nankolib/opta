// ============================================================================
// ⚠️  DEVNET / LOCALNET ONLY — NOT SAFE FOR MAINNET
// ============================================================================
//
// Every address, program ID, and keypair in this file is a devnet artifact.
// Nothing here has been deployed, audited, or secured for mainnet use.
//
// STRUCTURAL RISK — cluster choice lives in a DIFFERENT file:
//   app/src/contexts/WalletContext.tsx:24   →   clusterApiUrl("devnet")
// Flipping that single line to "mainnet-beta" without also updating this
// file will silently point the app at mainnet while still using devnet
// addresses and a publicly-known signing key. In that state, any wallet
// funded with DEVNET_FAUCET_KEYPAIR is drained within seconds of deploy.
//
// BEFORE ANY MAINNET BUILD — REQUIRED CHANGES:
//   [ ] Deploy both Anchor programs to mainnet; replace PROGRAM_ID and
//       TRANSFER_HOOK_PROGRAM_ID below with the mainnet addresses.
//   [ ] Replace DEVNET_USDC_MINT with Circle's real USDC mint
//       (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).
//   [ ] DELETE DEVNET_FAUCET_KEYPAIR entirely, then delete its only caller
//       in app/src/components/Header.tsx (the "Get devnet USDC" button).
//   [ ] Change app/src/contexts/WalletContext.tsx:24 to mainnet-beta and
//       swap the public RPC for a paid provider (Helius / Triton / QuickNode).
//   [ ] Re-run the full `anchor test` suite against the mainnet deployment.
// ============================================================================

import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export { TOKEN_2022_PROGRAM_ID };

// Devnet deployment only (per Anchor.toml). No mainnet address exists yet.
// See file header for pre-mainnet checklist.
export const PROGRAM_ID = new PublicKey(
  "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq",
);

// Devnet deployment only (per Anchor.toml). No mainnet address exists yet.
// See file header for pre-mainnet checklist.
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

// === V2 Secondary Listing Seeds (Stage Secondary, May 2026) ===
export const VAULT_RESALE_LISTING_SEED = "vault_resale_listing";
export const VAULT_RESALE_ESCROW_SEED = "vault_resale_escrow";

// Feature flag: when true, UI uses v2 shared vault flows.
// When false, UI uses v1 isolated escrow flows.
export const USE_V2_VAULTS = true;

// ============================================================================
// Phase 2 demo cutoff
// ============================================================================
// Hide vaults created before the Phase 2 redeploy (2026-04-26 ~18:00 UTC).
// Pre-Phase-2 vaults have BUTTER-prefixed Token-2022 metadata names; new vaults
// from this point forward use OPTA-. Filtering at the source in useVaults keeps
// the demo brand-consistent. Old vaults remain on-chain but are invisible to the UI.
export const PHASE2_CUTOFF_TIMESTAMP = 1777226400; // 2026-04-26T18:00:00Z

/** Returns true if a SharedVault account was created at or after the Phase 2 cutoff. */
export function isPostPhase2Vault(vault: { account: any } | { createdAt: any }): boolean {
  const createdAt = (vault as any)?.account?.createdAt ?? (vault as any)?.createdAt;
  if (createdAt == null) return false;
  const ts = typeof createdAt === "number" ? createdAt : createdAt.toNumber();
  return ts >= PHASE2_CUTOFF_TIMESTAMP;
}

/** Returns true if an OptionPosition account was created at or after the Phase 2 cutoff. */
export function isPostPhase2Position(position: { account: any } | { createdAt: any }): boolean {
  const createdAt = (position as any)?.account?.createdAt ?? (position as any)?.createdAt;
  if (createdAt == null) return false;
  const ts = typeof createdAt === "number" ? createdAt : createdAt.toNumber();
  return ts >= PHASE2_CUTOFF_TIMESTAMP;
}

// ============================================================================
// ⚠️  CRITICAL — FULL PRIVATE KEY, DO NOT SHIP TO MAINNET
// ============================================================================
// This is a complete 64-byte secret key (32-byte seed + 32-byte public key).
// Anyone who reads the public repo on GitHub or downloads the Vercel bundle
// controls this wallet. On devnet that wallet holds faucet USDC with zero
// monetary value — purely for "Get devnet USDC" demo convenience.
//
// If this constant survives into a mainnet build, any wallet funded with
// this seed with real assets is drained by automated key-scanners within seconds.
//
// Before any mainnet build:
//   [ ] Delete this constant entirely.
//   [ ] Delete its only caller in app/src/components/Header.tsx
//       (the handleUsdcFaucet function and its "Get devnet USDC" button).
// ============================================================================
export const DEVNET_FAUCET_KEYPAIR = Uint8Array.from([
  190, 228, 179, 16, 84, 86, 220, 167, 58, 26, 230, 109, 55, 214, 31, 68,
  44, 125, 100, 199, 2, 66, 159, 161, 128, 189, 95, 122, 246, 177, 174, 144,
  179, 209, 250, 69, 129, 154, 48, 172, 136, 163, 58, 36, 243, 181, 200, 211,
  13, 245, 237, 45, 41, 30, 221, 12, 131, 243, 51, 64, 92, 218, 20, 129,
]);

// Mock USDC mint used for devnet testing — NOT Circle's real USDC.
// Real mainnet USDC is at EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
// Mainnet builds must swap this constant before shipping.
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
