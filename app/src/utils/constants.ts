import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq",
);

// PDA seeds (must match the Rust program)
export const PROTOCOL_SEED = "protocol_v2";
export const TREASURY_SEED = "treasury_v2";
export const MARKET_SEED = "market";
export const POSITION_SEED = "position";
export const ESCROW_SEED = "escrow";
