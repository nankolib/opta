// =============================================================================
// registry.ts — INTERNAL WALLET REGISTRY (single source of truth)
// =============================================================================
//
// The "ours" set. A wallet listed here is scored for sanity but EXCLUDED from
// the leaderboard.
//
// D2 (accepted deviation from the original spec): `is_internal` is NOT written
// onto the `events` tape. The tape is append-only and must never be rewritten;
// baking a mutable classification into it would break that the first time this
// registry changes. Instead the classification lives in the `wallets`
// PROJECTION table and is re-derived from this file on every recompute.
//
// Adding a wallet here + re-running recompute is sufficient — no re-index.
// =============================================================================

export interface InternalWallet {
  pubkey: string;
  label: string;
}

/** Wallets we operate. Excluded from the leaderboard, retained for sanity stats. */
export const INTERNAL_WALLETS: InternalWallet[] = [
  { pubkey: "5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk", label: "admin" },
  { pubkey: "DnExEYnZGuEu7xgpmNupJVXJLbMbkNdf3E7f28Zv6LUQ", label: "founder-phantom" },
  { pubkey: "GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx", label: "founder-treasury" },
  { pubkey: "HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS", label: "writer-bot" },
  { pubkey: "5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa", label: "crank-gas" },
  { pubkey: "J8Kct5tS5SvbmNj8fiuND94D4ZL5Cvip1MXsJLFRpEPz", label: "faucet" },
  // Treasury taker (service #8). Registered BEFORE it can spend: opta-taker
  // refuses to boot armed unless this entry exists, because an unregistered
  // taker would appear on the leaderboard as a top trader and its buys would
  // score as organic volume. Adding it here arms nothing.
  { pubkey: "FeQnyJpyhxAHGUcNTx7W22BRbnsbctyPvSoav5zq5N7p", label: "taker-bot" },
  // Throwaway keypairs used to probe the live faucet during the 2026-08-04 fix
  // session (BLK-1). They are not users: each holds exactly one faucet grant and
  // has never traded, so on the profit board they would read as real wallets
  // sitting at $10,000 deployed / 0 PnL. Scored for sanity, excluded from the
  // boards — same treatment as every other wallet we operate.
  { pubkey: "2VSPpJ5gdDYGoCnpZUTAG283obtE7fvbJZajYYxgDf4E", label: "faucet-probe-1" },
  { pubkey: "FPSmTjwGEm1UucPMwECCe8cA8riRLRwecYqvBV1hHXML", label: "faucet-probe-2" },
  { pubkey: "BqNX89nQe9bSshsdekc6Pw3NQsvENn7manuSR5QD8NZs", label: "faucet-probe-3" },
  // Founder QA wallet. Used for the first hand-written order on a first-party
  // market (2026-10-05) BEFORE it was registered, so for a few minutes it stood
  // at rank 1 on the profit board as an outside wallet and the taker treated its
  // ask as fillable outside flow. Rule since: a founder or test wallet is
  // registered here before its first use, never after.
  { pubkey: "Bw3ThDvrwnXkkETcDSC3GkcFbra7qc1aeGKR6S6F2ke2", label: "founder-A" },
];

const BY_PUBKEY = new Map(INTERNAL_WALLETS.map((w) => [w.pubkey, w]));

export function isInternal(pubkey: string | null | undefined): boolean {
  return pubkey != null && BY_PUBKEY.has(pubkey);
}

export function labelFor(pubkey: string): string | null {
  return BY_PUBKEY.get(pubkey)?.label ?? null;
}
