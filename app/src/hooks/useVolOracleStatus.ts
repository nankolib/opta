import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "./useProgram";
import { VOL_ORACLE_SEED } from "../utils/constants";
import { decodeVolOracleWarmup, writeWarmupGate, type VolOracleWarmup } from "../utils/oracleArm";

// =============================================================================
// useVolOracleStatus — surface vol-oracle coverage state to the Write flow
// =============================================================================
//
// Background. Between the moment a market is permissionlessly created via
// create_market and the moment its VolOracle PDA exists, any mint_from_vault
// against that market reverts with Anchor 3007 (AccountOwnedByWrongProgram —
// mint_from_vault.rs:472-475 documents this exact failure mode). This hook is
// the user-facing defense: detect the gap before the user signs anything and
// say so, instead of a confusing 3007 in their wallet's error stream.
//
// ⚠️ CORRECTION (SLICE 1, 2026-08-11). This header used to claim that "W2
// (crank reactive seeding via onLogs(MarketCreated)) closes that race window
// from hours to seconds". IT DID NOT EXIST. There is no MarketCreated event in
// the program — create_market.rs emits only msg! — and there was no listener
// anywhere in the repo. The only seeder was an hourly pass aligned to the
// wall-clock hour, so the real wait was up to 60 minutes for the whole time
// this comment claimed otherwise. A comment describing work nobody did is
// worse than no comment: it is why nobody looked again for months.
//
// What is true NOW: crank/volOracleFastSeed.ts polls every 120 s and seeds
// reactively. Measured end-to-end on devnet 2026-08-11 — market created
// 15:29:59Z, oracle seeded 15:31:53Z, 114 seconds. That is why this hook now
// polls (below) instead of telling the user to come back later.
//
// Cache semantics
//   - "seeded" is monotonic: once we observe a VolOracle PDA exists +
//     opta-owned, we cache that result for the rest of the session and
//     never re-query it. Vol oracles are never closed.
//   - "unseeded" is volatile: re-queried on every scan and on every
//     submit-click pre-flight, since the crank may seed at any moment.
//
// Refresh triggers
//   - On mount + on the input feed list changing (assets added/removed).
//   - On document visibilitychange → visible. Matches useVersionCheck's
//     pattern; catches crank-seeded-while-page-hidden cases.
//
// checkOne — submit-click pre-flight
//   Even if the cache says "unseeded," checkOne does a fresh getAccountInfo
//   against the specific feed's PDA before throwing. This catches the
//   common race-just-closed case (the crank seeded the oracle 30 s ago,
//   the cache hasn't refreshed yet). Worst case: one wasted RPC call. Best
//   case: the user's submit succeeds without a confusing "Oracle pending"
//   block when the oracle was just seeded.
// =============================================================================

// ---- VolOracle byte layout (SLICE 3) ---------------------------------------
//
// ONE definition, exported, because two call sites now read this account: the
// poll below (existence) and the first-write prefill (spot). A second copy of a
// byte offset is a silent mis-read waiting to happen.
//
// Layout after the 8-byte discriminator, from programs/opta/src/state/vol_oracle.rs:
//   sum_log_returns    i128        @8
//   sum_log_returns_sq i128        @24
//   feed_id            [u8;32]     @40
//   samples            [i64;720]   @72     (5760 bytes)
//   last_sample_ts     i64         @5832
//   last_spot_price    i64         @5840   <- this one
//   head/sample_count/bump/oracle_source   @5848..5854
//   seed_vol           i64         @5856
// Total 5864 (8 + 5856). Verified live on ORE 2026-08-11: $62.212987.

/** Byte offset of VolOracle.last_spot_price. */
export const VOL_ORACLE_SPOT_OFFSET = 5840;

/** solmath SCALE — spot is stored as an integer at 1e12. */
export const VOL_ORACLE_SCALE = 1e12;

/** Decode spot (human USD) from a raw VolOracle account, or null when the
 *  buffer is the wrong size or the oracle has no spot yet. */
export function decodeOracleSpot(data: Uint8Array | Buffer): number | null {
  if (!data || data.length < VOL_ORACLE_SPOT_OFFSET + 8) return null;
  const buf = Buffer.from(data);
  const raw = buf.readBigInt64LE(VOL_ORACLE_SPOT_OFFSET);
  if (raw <= 0n) return null;
  return Number(raw) / VOL_ORACLE_SCALE;
}

/** Poll cadence while an oracle is pending. The crank's fast-seed loop ticks
 *  every 120 s and lands a seed inside ~2 min of a market being created, so a
 *  10 s poll surfaces the flip promptly without being a busy-wait. */
export const VOL_ORACLE_POLL_MS = 10_000;

/** Poll cadence while a seeded source-2 oracle is still WARMING (write-gate
 *  closed). sample_count moves once an hour, so a minute is generous. */
export const VOL_ORACLE_WARMUP_POLL_MS = 60_000;

/** Human-facing wait, used by every "oracle pending" string. ONE constant, so
 *  the copy can never drift from the crank's actual behaviour again — it said
 *  "~1 hour" for weeks after the hourly pass stopped being the only seeder. */
export const VOL_ORACLE_EXPECTED_WAIT = "about 2 minutes";

function deriveVolOraclePda(feedIdHex: string, programId: PublicKey): PublicKey {
  const hex = feedIdHex.replace(/^0x/, "").toLowerCase();
  const bytes = Buffer.from(hex, "hex");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), bytes],
    programId,
  );
  return pda;
}

function normFeed(hex: string): string {
  return hex.replace(/^0x/, "").toLowerCase();
}

export type VolOracleStatus = {
  /** Feed ids (no 0x, lowercase) confirmed to have seeded oracles. Monotonic. */
  seeded: ReadonlySet<string>;
  /** Feed ids confirmed unseeded as of the last scan. May be stale —
   *  always re-check via checkOne before throwing a hard block. */
  unseeded: ReadonlySet<string>;
  /** Per feed id: sample_count + oracle_source from the last read of a
   *  SEEDED oracle. Feeds the plug-wave-1 write-gate (utils/oracleArm
   *  writeWarmupGate). Re-read each scan while the gate is closed. */
  warmup: ReadonlyMap<string, VolOracleWarmup>;
  /** True while a scan is in flight. */
  loading: boolean;
  /** Trigger a fresh batched re-scan of all currently-known feeds. */
  refresh: () => void;
  /** Submit-click pre-flight. Returns true iff the oracle exists on-chain
   *  at call time. Updates the cache in either direction. */
  checkOne: (feedIdHex: string) => Promise<boolean>;
  /** Submit-click pre-flight for WRITES: fresh chain read; null = writable
   *  now, string = the reason it is not (unseeded, or source-2 warming). */
  checkWritable: (feedIdHex: string) => Promise<string | null>;
};

export function useVolOracleStatus(
  feedIdHexes: readonly string[],
): VolOracleStatus {
  const { connection } = useConnection();
  const { program } = useProgram();
  const [seeded, setSeeded] = useState<Set<string>>(new Set());
  const [unseeded, setUnseeded] = useState<Set<string>>(new Set());
  const [warmup, setWarmup] = useState<Map<string, VolOracleWarmup>>(new Map());
  const [loading, setLoading] = useState(false);

  // Stable refs so callbacks don't re-create on every state update.
  const seededRef = useRef(seeded);
  seededRef.current = seeded;
  const warmupRef = useRef(warmup);
  warmupRef.current = warmup;
  const programIdRef = useRef<PublicKey | null>(program?.programId ?? null);
  programIdRef.current = program?.programId ?? null;

  // Stable identity key over the input list — re-scan when it changes.
  const feedKey = feedIdHexes.map(normFeed).sort().join(",");

  const scan = useCallback(async () => {
    const pid = programIdRef.current;
    if (!pid) return;
    if (feedIdHexes.length === 0) return;
    setLoading(true);
    try {
      const normalized = feedIdHexes.map(normFeed);
      // Skip ones we already know are seeded (monotonic property) — EXCEPT a
      // seeded source-2 oracle whose write-gate is still closed: its
      // sample_count moves hourly and the gate must lift on its own.
      const toCheck = normalized.filter((f) => {
        if (!seededRef.current.has(f)) return true;
        const w = warmupRef.current.get(f);
        return !!w && writeWarmupGate(w.oracleSource, w.sampleCount) !== null;
      });
      if (toCheck.length === 0) {
        // Reset unseeded to empty — everything we know about is seeded.
        setUnseeded(new Set());
        return;
      }
      const pdas = toCheck.map((f) => deriveVolOraclePda(f, pid));
      const infos = await connection.getMultipleAccountsInfo(pdas, "confirmed");
      const newSeeded = new Set(seededRef.current);
      const newUnseeded = new Set<string>();
      const newWarmup = new Map(warmupRef.current);
      for (let i = 0; i < toCheck.length; i++) {
        const acct = infos[i];
        const exists = !!acct && acct.owner.equals(pid);
        if (exists) {
          newSeeded.add(toCheck[i]);
          const w = decodeVolOracleWarmup(acct!.data);
          if (w) newWarmup.set(toCheck[i], w);
        } else newUnseeded.add(toCheck[i]);
      }
      setSeeded(newSeeded);
      setUnseeded(newUnseeded);
      setWarmup(newWarmup);
    } catch (err) {
      console.warn("[useVolOracleStatus] scan failed:", err);
      // Leave existing cache state untouched on transient RPC errors.
    } finally {
      setLoading(false);
    }
    // feedKey is the stable membership-fingerprint; we depend on it not
    // the raw array to avoid re-firing on every render with a new array
    // identity but identical content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, feedKey]);

  useEffect(() => {
    scan();
  }, [scan]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) scan();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [scan]);

  // ---- SLICE 2A: poll while anything is unseeded --------------------------
  //
  // Before SLICE 1 the wait was up to an hour, so polling would have been an
  // hour of pointless RPC and the tooltip told the user to come back later.
  // The crank now seeds reactively — proven at 114 s end-to-end on 2026-08-11 —
  // so the wait is short enough to simply WAIT THROUGH, and a user who is
  // staring at a disabled button should watch it enable itself rather than be
  // told to reload.
  //
  // Only runs while `unseeded` is non-empty, so a healthy board costs nothing:
  // the effect tears its own interval down the moment the set empties (and
  // `seeded` is monotonic, so it cannot re-arm spuriously). Paused while the
  // tab is hidden — the visibilitychange handler above re-scans on return.
  //
  // Plug wave 1: also poll (slowly) while any seeded source-2 oracle is still
  // warming, so the write-gate lifts without a reload.
  let warmingCount = 0;
  for (const w of warmup.values()) if (writeWarmupGate(w.oracleSource, w.sampleCount) !== null) warmingCount++;
  useEffect(() => {
    const cadence = unseeded.size > 0 ? VOL_ORACLE_POLL_MS : warmingCount > 0 ? VOL_ORACLE_WARMUP_POLL_MS : 0;
    if (cadence === 0) return;
    const id = window.setInterval(() => {
      if (!document.hidden) scan();
    }, cadence);
    return () => window.clearInterval(id);
  }, [unseeded.size, warmingCount, scan]);

  const checkOne = useCallback(
    async (feedIdHex: string): Promise<boolean> => {
      const pid = programIdRef.current;
      if (!pid) return false;
      const normalized = normFeed(feedIdHex);
      if (seededRef.current.has(normalized)) return true;
      const pda = deriveVolOraclePda(normalized, pid);
      try {
        const info = await connection.getAccountInfo(pda, "confirmed");
        const exists = !!info && info.owner.equals(pid);
        if (exists) {
          setSeeded((prev) => {
            const next = new Set(prev);
            next.add(normalized);
            return next;
          });
          setUnseeded((prev) => {
            if (!prev.has(normalized)) return prev;
            const next = new Set(prev);
            next.delete(normalized);
            return next;
          });
        } else {
          setUnseeded((prev) => {
            if (prev.has(normalized)) return prev;
            const next = new Set(prev);
            next.add(normalized);
            return next;
          });
        }
        return exists;
      } catch (err) {
        // Network blip — don't poison the cache. Treat as unknown by
        // returning false to err on the side of refusing the submit;
        // the user can retry.
        console.warn("[useVolOracleStatus] checkOne RPC failed:", err);
        return false;
      }
    },
    [connection],
  );

  // Write pre-flight: existence AND warmup, from one fresh read.
  const checkWritable = useCallback(
    async (feedIdHex: string): Promise<string | null> => {
      const pid = programIdRef.current;
      if (!pid) return "Wallet program not ready — please retry.";
      const normalized = normFeed(feedIdHex);
      const pda = deriveVolOraclePda(normalized, pid);
      try {
        const info = await connection.getAccountInfo(pda, "confirmed");
        const exists = !!info && info.owner.equals(pid);
        if (!exists) {
          setUnseeded((prev) => (prev.has(normalized) ? prev : new Set(prev).add(normalized)));
          return `Pricing is still warming up — this takes ${VOL_ORACLE_EXPECTED_WAIT} after a market is created. This unblocks itself; no need to reload.`;
        }
        setSeeded((prev) => (prev.has(normalized) ? prev : new Set(prev).add(normalized)));
        const w = decodeVolOracleWarmup(info!.data);
        if (w) setWarmup((prev) => new Map(prev).set(normalized, w));
        return writeWarmupGate(w?.oracleSource ?? null, w?.sampleCount ?? null);
      } catch (err) {
        console.warn("[useVolOracleStatus] checkWritable RPC failed:", err);
        return "Could not confirm pricing state — please retry.";
      }
    },
    [connection],
  );

  return { seeded, unseeded, warmup, loading, refresh: scan, checkOne, checkWritable };
}
