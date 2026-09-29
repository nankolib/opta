// =============================================================================
// settleTuples — classify expired-unsettled (asset, expiry) tuples. PURE.
// =============================================================================
//
// Extracted from AdminTools so the classification can be unit-tested (the app
// has no test runner; pure logic lives in pure modules — see
// app/scripts/run-settle-tuples-tests.mjs).
//
// ── WHAT ACTUALLY GATES A SETTLE (recon 2026-08-05) ─────────────────────────
// The thing that decides whether a tuple can be settled is NOT its oracle
// source. It is whether a SettlementRecord already exists.
//
//   settle_expiry  — writes the SettlementRecord. Needs an oracle proof.
//                    Pyth: a HISTORICAL at-expiry print, good for 30 days.
//                    Switchboard: a FRESH quote, verifiable only while its
//                    signed_slothash is still in the SlotHashes sysvar
//                    (~512 slots ≈ 3.5 min; SB_SETTLE_WINDOW_SECS = 300).
//   settle_vault   — the per-vault fan-out. PERMISSIONLESS, reads the price
//                    from the SettlementRecord PDA, takes NO oracle accounts,
//                    and has NO upper time bound.
//
// So once a record exists the tuple is settleable forever, by anyone, whatever
// its oracle source. On 2026-08-05 that described 45 of the 52 open tuples
// (2,175 vaults) — all Switchboard, all past their 300 s window, and all
// simulated OK. The crank lands records and deliberately stops there
// (settleGuardJul31.ts: "the guard settles TUPLES, not vaults"); the fan-out is
// this UI's job.
//
// ⚠️ The BLK-9 filter this replaces gated on `oracleSource === 0` and therefore
// hid every one of those 45. Do not reintroduce an oracle-source filter here.
// =============================================================================

/** Mirror of SB_SETTLE_WINDOW_SECS in settle_expiry.rs. */
export const SB_SETTLE_WINDOW_SECS = 300;
/** Mirror of PYTH_MAX_AGE_SECS in settle_expiry.rs (30 days). */
export const PYTH_MAX_AGE_SECS = 2_592_000;

export const ORACLE_PYTH = 0;
export const ORACLE_SWITCHBOARD = 1;
/** The first-party lane. Like Switchboard it persists the CURRENT price, so it
 *  shares the 300 s window; the keeper settles it (crank/optaSettleCrank.ts). */
export const ORACLE_OPTA = 2;

/**
 * What this UI can do with a tuple.
 *
 *  settleable — a SettlementRecord exists. Oracle-free `settle_vault` fan-out.
 *               Works today, for any oracle source, at any age.
 *  pyth       — no record, Pyth-sourced, still inside the 30-day backstop. The
 *               existing atomic post_update + settle_expiry path can create the
 *               record and then fan out.
 *  crankOnly  — no record, Switchboard or first-party, still inside the 300 s window. Settleable
 *               in principle but NOT by this UI: posting a signed SB quote needs
 *               the Switchboard SDK, which is deliberately kept out of the FE
 *               bundle. The crank owns this. A ~5-minute sliver; rarely seen.
 *  dark       — no record, Switchboard or first-party, past the 300 s window. Unsettleable by
 *               ANYONE, permanently: the verifier resolves the quote's
 *               signed_slothash against the live SlotHashes sysvar, so no stored
 *               attestation can ever satisfy it. Disposition is
 *               `reclaim_unsettled` after the 7-day grace.
 */
export type SettleClass = "settleable" | "pyth" | "crankOnly" | "dark";

export interface VaultRow {
  /** SharedVault PDA, base58. */
  pda: string;
  /** Parent OptionsMarket PDA, base58. */
  market: string;
  expiry: number;
  isSettled: boolean;
}

export interface MarketRow {
  /** OptionsMarket PDA, base58. */
  pda: string;
  assetName: string;
  feedIdHex: string;
  /** 0 Pyth / 1 Switchboard / 2 first-party. Legacy 62-byte markets decode as undefined → Pyth. */
  oracleSource: number;
}

export interface RecordRow {
  assetName: string;
  expiry: number;
}

export interface SettleTuple {
  /** Stable key, `${asset}:${expiry}`. */
  key: string;
  asset: string;
  expiry: number;
  feedIdHex: string;
  oracleSource: number;
  /** SharedVault PDAs (base58) sharing this (asset, expiry) and still unsettled. */
  vaultPdas: string[];
  hasRecord: boolean;
  cls: SettleClass;
}

const recKey = (assetName: string, expiry: number) => `${assetName}:${expiry}`;

/**
 * Group expired, unsettled vaults into (asset, expiry) tuples and classify each.
 *
 * Deliberately does NOT drop tuples whose vaults are mid-fan-out: a partial
 * settle_vault failure must stay visible so the user can re-trigger it. Vaults
 * already settled are simply excluded from `vaultPdas`.
 */
export function classifySettleTuples(
  vaults: readonly VaultRow[],
  markets: readonly MarketRow[],
  records: readonly RecordRow[],
  nowSec: number,
): SettleTuple[] {
  const marketByPda = new Map(markets.map((m) => [m.pda, m]));
  const recordSet = new Set(records.map((r) => recKey(r.assetName, r.expiry)));

  const grouped = new Map<string, SettleTuple>();
  for (const v of vaults) {
    if (v.expiry >= nowSec) continue;
    if (v.isSettled) continue;
    const m = marketByPda.get(v.market);
    if (!m || !m.assetName) continue;

    const key = recKey(m.assetName, v.expiry);
    const existing = grouped.get(key);
    if (existing) {
      existing.vaultPdas.push(v.pda);
      continue;
    }

    const hasRecord = recordSet.has(key);
    const age = nowSec - v.expiry;
    const src = Number(m.oracleSource ?? ORACLE_PYTH);

    let cls: SettleClass;
    if (hasRecord) {
      cls = "settleable";
    } else if (src === ORACLE_PYTH) {
      cls = age <= PYTH_MAX_AGE_SECS ? "pyth" : "dark";
    } else {
      // Every source that is not Pyth: Switchboard, first-party, or a byte this
      // build does not know. None has a historical print, so none is ever
      // offered for a manual settle; the manual path is the Pyth builder, which
      // refuses them (pythPullPost.assertPythSettleSource).
      cls = age <= SB_SETTLE_WINDOW_SECS ? "crankOnly" : "dark";
    }

    grouped.set(key, {
      key,
      asset: m.assetName,
      expiry: v.expiry,
      feedIdHex: m.feedIdHex,
      oracleSource: src,
      vaultPdas: [v.pda],
      hasRecord,
      cls,
    });
  }

  return Array.from(grouped.values()).sort((a, b) => a.expiry - b.expiry);
}

/** Tuples this UI can actually complete — what the settle list may show. */
export const actionable = (t: readonly SettleTuple[]): SettleTuple[] =>
  t.filter((x) => x.cls === "settleable" || x.cls === "pyth");

/** Tuples nobody can settle. Surfaced separately, never in a quest-earnable list. */
export const unsettleable = (t: readonly SettleTuple[]): SettleTuple[] =>
  t.filter((x) => x.cls === "dark");
