// =============================================================================
// Formatting utilities for display
// =============================================================================

import BN from "bn.js";

/** Convert on-chain USDC amount (scaled by 10^6) to human-readable string. */
export function formatUsdc(amount: BN | number): string {
  const num = typeof amount === "number" ? amount : amount.toNumber();
  return (num / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Convert on-chain USDC amount to raw number (for calculations). */
export function usdcToNumber(amount: BN | number): number {
  const num = typeof amount === "number" ? amount : amount.toNumber();
  return num / 1_000_000;
}

/** Convert human-readable USDC to on-chain scaled amount. */
export function toUsdcBN(amount: number): BN {
  return new BN(Math.round(amount * 1_000_000));
}

/** Format a Unix timestamp as a human-readable date. */
export function formatExpiry(timestamp: BN | number): string {
  const ts = typeof timestamp === "number" ? timestamp : timestamp.toNumber();
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format a date as short string (e.g., "Apr 15"). */
export function formatExpiryShort(timestamp: BN | number): string {
  const ts = typeof timestamp === "number" ? timestamp : timestamp.toNumber();
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** Truncate a public key for display (e.g., "CtzJ...z9Cq"). */
export function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

/**
 * Convert a 32-byte feed_id (Anchor [u8; 32] = number[] | Uint8Array | Buffer)
 * to lowercase 64-char hex with NO `0x` prefix. Hermes API + our on-chain
 * registry both store/accept this canonical form.
 */
export function hexFromBytes(bytes: number[] | Uint8Array | Buffer): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = (bytes as any)[i] & 0xff;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/** Get days until expiry from a Unix timestamp. */
export function daysUntilExpiry(timestamp: BN | number): number {
  const ts = typeof timestamp === "number" ? timestamp : timestamp.toNumber();
  const now = Date.now() / 1000;
  return Math.max(0, (ts - now) / 86400);
}

/** Check if a market has expired. */
export function isExpired(timestamp: BN | number): boolean {
  const ts = typeof timestamp === "number" ? timestamp : timestamp.toNumber();
  return Date.now() / 1000 >= ts;
}

/** Get position status string (tokenized model). */
export function getPositionStatus(position: {
  isExercised: boolean;
  isExpired: boolean;
  isCancelled: boolean;
  isListedForResale: boolean;
}): string {
  if (position.isCancelled) return "Cancelled";
  if (position.isExercised) return "Exercised";
  if (position.isExpired) return "Expired";
  if (position.isListedForResale) return "Listed for Resale";
  return "Active";
}
