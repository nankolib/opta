// Maps Anchor custom error codes to human-readable messages.
// Codes 6000+ from programs/butter-options/src/errors.rs

const CUSTOM_ERRORS: Record<number, string> = {
  6000: "Protocol already initialized",
  6001: "Unauthorized — signer is not the protocol admin",
  6002: "Expiry must be in the future",
  6003: "Strike price must be greater than zero",
  6004: "Invalid Pyth price feed",
  6005: "Asset name must be 1–16 characters",
  6006: "Market has not expired yet",
  6007: "Market has already been settled",
  6008: "Market has not been settled yet",
  6009: "Market has already expired",
  6010: "Settlement price must be greater than zero",
  6011: "Position is no longer active",
  6012: "Insufficient collateral for this option",
  6013: "Contract size must be greater than zero",
  6014: "Premium must be greater than zero",
  6015: "Only the writer can perform this action",
  6016: "Only the token holder can perform this action",
  6017: "Cannot buy your own option",
  6018: "Insufficient option tokens to exercise",
  6019: "Writer must hold all tokens to cancel (some were sold)",
  6020: "Option is not listed for resale",
  6021: "Option is already listed for resale",
  6022: "Only the resale seller can cancel the listing",
  6023: "Cannot buy your own resale listing",
  6024: "Invalid asset class",
  6025: "Cannot expire an in-the-money option — holders must exercise first",
  6026: "Purchase amount too small — premium rounds to zero",
  6027: "Premium too low — must be at least 0.1% of collateral",
  6028: "Premium too high — must be at most 50% of collateral",
  6029: "Unauthorized pricing update",
  6030: "Volatility too low for calculation",
  6031: "Volatility too high for calculation",
  6032: "Option has expired — cannot price",
  6033: "Pricing calculation failed",
  // Stage Secondary (May 2026) — V2 secondary listing errors.
  // These four codes were previously stale in this map (pre-Stage-2 enum); on-disk
  // errors.rs now assigns 6034-6037 to ListingExhausted / NotResaleSeller /
  // InvalidListingEscrow / ListingMismatch respectively.
  6034: "Not enough contracts left in this listing — someone may have just bought.",
  6035: "Only the listing's seller can cancel it.",
  6036: "Listing data mismatch — please refresh and try again.",
  6037: "Listing data mismatch — please refresh and try again.",
  6038: "Vault expiry has passed",
  6039: "Invalid epoch expiry — must fall on configured day and hour",
  6040: "Insufficient free collateral in your vault position",
  6041: "Collateral is committed to active options and cannot be withdrawn",
  6042: "No unsold tokens to burn",
  6043: "Nothing to claim — all premium already withdrawn",
  6044: "Premium exceeds your maximum (slippage protection)",
  6045: "Vault not yet settled",
  6046: "Option is not in the money — cannot exercise",
  6047: "Option mint does not belong to this vault",
  6048: "Vault expiry must match market expiry",
  6049: "Vault option type must match market option type",
  6050: "Claim all premium before withdrawing shares",
};

export function decodeError(error: any): string {
  if (!error) return "Unknown error";
  const msg = error?.message || error?.toString() || "";

  // Wallet-replay artifact — wallet's optimistic resimulate against
  // a lagged RPC pool sees the now-landed tx as "already processed".
  // Decode to a stable substring ("already confirmed") that consumer
  // catch blocks detect to upgrade the error path to success +
  // refetch instead of showing a "failed" toast.
  if (msg.includes("already been processed")) {
    return "Transaction already confirmed.";
  }

  // User rejection
  if (msg.includes("User rejected")) return "Transaction rejected in wallet.";

  // Insufficient SOL
  if (msg.includes("insufficient funds") || msg.includes("0x1")) return "Insufficient SOL for transaction fees.";

  // Insufficient token balance
  if (msg.includes("insufficient") && msg.includes("token")) return "Insufficient USDC balance. Use the faucet to get test USDC.";

  // Extract Anchor custom error code
  const codeMatch = msg.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (codeMatch) {
    const code = parseInt(codeMatch[1], 16);
    if (CUSTOM_ERRORS[code]) return CUSTOM_ERRORS[code];
    return `Program error ${code}`;
  }

  // Anchor error code in decimal
  const anchorMatch = msg.match(/Error Number: (\d+)/);
  if (anchorMatch) {
    const code = parseInt(anchorMatch[1]);
    if (CUSTOM_ERRORS[code]) return CUSTOM_ERRORS[code];
  }

  // Truncate long messages
  if (msg.length > 150) return msg.slice(0, 147) + "...";
  return msg;
}
