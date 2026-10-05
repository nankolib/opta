import { clusterApiUrl, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export { TOKEN_2022_PROGRAM_ID };

export const EXPECTED_CLUSTER = "devnet" as const;
export const OPTA_CHAIN = "solana:devnet";
export const RPC_ENDPOINT =
  process.env.EXPO_PUBLIC_RPC_URL || clusterApiUrl("devnet");
// ---------------------------------------------------------------------------
// Indexer read path (vC3 Rev C). REQUIRED BUILD VARS — see mobile/.env:
//   EXPO_PUBLIC_RPC_URL        e.g. https://rpc.opta.fyi/devnet
//   EXPO_PUBLIC_INDEXER_BASE   e.g. https://opta.fyi/api/chain
// Both bake in at bundle time. An unset EXPO_PUBLIC_RPC_URL is what silently
// shipped api.devnet.solana.com in the first Rev A build; treat these the same.
// ---------------------------------------------------------------------------
export const INDEXER_BASE =
  process.env.EXPO_PUBLIC_INDEXER_BASE || "https://opta.fyi/api/chain";
/** Build-time flag. ON in this build; set EXPO_PUBLIC_INDEXER_ENABLED=0 to force chain scans. */
export const INDEXER_ENABLED = process.env.EXPO_PUBLIC_INDEXER_ENABLED !== "0";
/** Envelope must be younger than this. Indexer's own staleAfterSec is 110. */
export const INDEXER_MAX_AGE_SEC = 110;
export const INDEXER_TIMEOUT_MS = 12_000;
/**
 * Lineage the rows must have been built from: `${programId}:${deploySlot}`.
 * An indexer on another deploy would hand back plausible nonsense.
 */
export const OPTA_DEPLOY_SLOT = 485057525;
export const INDEXER_EXPECTED_LINEAGE =
  "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq:485057525";

export const HERMES_BASE =
  process.env.EXPO_PUBLIC_HERMES_BASE || "https://hermes.pyth.network";

export const PROGRAM_ID = new PublicKey(
  "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq"
);
export const TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG"
);

export const PROTOCOL_SEED = "protocol_v2";
export const MARKET_SEED = "market";
export const TREASURY_SEED = "treasury_v2";
export const EPOCH_CONFIG_SEED = "epoch_config";
export const SHARED_VAULT_SEED = "shared_vault";
export const SHARED_VAULT_AMERICAN_SEED = "shared_vault_american";
export const VAULT_USDC_SEED = "vault_usdc";
export const WRITER_POSITION_SEED = "writer_position";
export const VAULT_MINT_RECORD_SEED = "vault_mint_record";
export const VAULT_OPTION_MINT_SEED = "vault_option_mint";
export const VAULT_PURCHASE_ESCROW_SEED = "vault_purchase_escrow";
export const VAULT_RESALE_LISTING_SEED = "vault_resale_listing";
export const VAULT_RESALE_ESCROW_SEED = "vault_resale_escrow";
export const VOL_ORACLE_SEED = "vol_oracle";
export const OPTA_PRICE_FEED_SEED = "opta_price_feed";

export const SERIES_OPTION_TYPE_CALL = 0;
export const SERIES_OPTION_TYPE_PUT = 1;
export const PHASE2_CUTOFF_TIMESTAMP = 1777226400;
