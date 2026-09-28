// ============================================================================
// crank/settleRouting.ts -- which settle lane owns a tuple
// ============================================================================
//
// A market's oracle_source byte decides which lane may settle it:
//
//   0 (or absent, legacy)  Pyth lane         bot.ts settle loop
//   1                      Switchboard lane  sbOracleCrank settle pass
//   2                      first-party lane  optaSettleCrank
//   anything else          refused           counted, logged, never sent
//
// Until 2026-09-28 the Pyth enumeration excluded source 1 only, so every tuple
// on a source-2 market was sent to the Pyth builder, which passes
// `optaPriceFeed: null` and asks a price service that has never carried the
// feed. Four post-flip tuples expired unsettled that way (ops ledger 66).
//
// The same enumeration filtered on `is_settled` alone. A voided vault keeps
// `is_settled = false` for ever, so it was re-enumerated on every tick. A tuple
// is live only if some vault in it is neither settled nor voided.
//
// Pure functions only. bot.ts executes main() on import and cannot be loaded by
// a test; the rules live here so they can be.
// ============================================================================

import { PublicKey } from "@solana/web3.js";
import { hexFromBytes } from "@app/utils/format";

export const ORACLE_SOURCE_PYTH = 0;
export const ORACLE_SOURCE_SWITCHBOARD = 1;
export const ORACLE_SOURCE_OPTA = 2;

export type SettleRoute = "pyth" | "switchboard" | "opta" | "refuse";

/** The lane that owns a market, from its oracle_source byte. An absent byte is
 *  a legacy (pre-source) market and is Pyth. Anything that is not exactly 0, 1
 *  or 2 is refused: there is no safe default for a price path. */
export function routeForSource(raw: unknown): SettleRoute {
  if (raw === undefined || raw === null) return "pyth";
  if (typeof raw !== "number" && typeof raw !== "bigint") return "refuse";
  const n = Number(raw);
  if (n === ORACLE_SOURCE_PYTH) return "pyth";
  if (n === ORACLE_SOURCE_SWITCHBOARD) return "switchboard";
  if (n === ORACLE_SOURCE_OPTA) return "opta";
  return "refuse";
}

/** A vault still owed a settlement: neither settled nor voided. */
export function isLiveVault(account: { isSettled?: unknown; voided?: unknown }): boolean {
  return !account.isSettled && !account.voided;
}

export type LivenessSource = 0 | 1 | 2;
/** The source family a feed is probed under, or null when the byte is unknown
 *  and the feed must not be tracked at all. */
export function livenessSourceOf(raw: unknown): LivenessSource | null {
  const r = routeForSource(raw);
  return r === "pyth" ? 0 : r === "switchboard" ? 1 : r === "opta" ? 2 : null;
}

export interface AccountRecord {
  publicKey: PublicKey;
  account: any;
}

export interface ExpiryTuple {
  /** Stable key = `${asset}:${expiry}`. */
  key: string;
  asset: string;
  expiry: number;
  feedIdHex: string;
  oracleSource: number;
  vaultPdas: PublicKey[];
}

export interface PythEnumeration {
  tuples: ExpiryTuple[];
  /** Vaults left out, by reason. Counted so a tick can show it looked. */
  skipped: { switchboard: number; opta: number; refused: number; voided: number };
}

export function expiryOf(account: any): number {
  return typeof account.expiry === "number" ? account.expiry : account.expiry.toNumber();
}

/**
 * Group expired live vaults on PYTH markets by (asset, expiry). No
 * SettlementRecord-existence filter: settleAllForExpiry handles the resume case
 * through its own getAccountInfo check.
 */
export function computePythExpiredTuples(
  vaults: AccountRecord[],
  markets: AccountRecord[],
  nowSecs: number,
): PythEnumeration {
  const marketByPda = new Map<string, AccountRecord>();
  for (const m of markets) marketByPda.set(m.publicKey.toBase58(), m);
  const skipped = { switchboard: 0, opta: 0, refused: 0, voided: 0 };

  const grouped = new Map<string, ExpiryTuple>();
  for (const v of vaults) {
    const expiry = expiryOf(v.account);
    if (expiry >= nowSecs) continue;
    if (v.account.isSettled) continue;
    if (v.account.voided) { skipped.voided += 1; continue; }
    const market = marketByPda.get((v.account.market as PublicKey).toBase58());
    if (!market) continue;
    const route = routeForSource(market.account.oracleSource);
    if (route === "switchboard") { skipped.switchboard += 1; continue; }
    if (route === "opta") { skipped.opta += 1; continue; }
    if (route === "refuse") { skipped.refused += 1; continue; }
    const asset = market.account.assetName as string;
    if (!asset) continue;
    const key = `${asset}:${expiry}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.vaultPdas.push(v.publicKey);
    } else {
      grouped.set(key, {
        key,
        asset,
        expiry,
        feedIdHex: hexFromBytes(market.account.pythFeedId as number[]),
        oracleSource: ORACLE_SOURCE_PYTH,
        vaultPdas: [v.publicKey],
      });
    }
  }
  return { tuples: Array.from(grouped.values()).sort((a, b) => a.expiry - b.expiry), skipped };
}

/** Last line of defence at the call site of the Pyth builder: the enumeration
 *  above should make this unreachable, and a settle path that trusts its
 *  enumeration is how the 2026-09-25 tuples were lost. */
export function assertPythTuple(t: { asset: string; expiry: number; oracleSource: number }): void {
  if (routeForSource(t.oracleSource) !== "pyth") {
    throw new Error(
      `settle routing: a source ${String(t.oracleSource)} tuple (${t.asset}:${t.expiry}) reached the Pyth settle builder`,
    );
  }
}
