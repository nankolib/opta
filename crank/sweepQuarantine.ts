// ============================================================================
// crank/sweepQuarantine.ts -- stop re-sending a sweep batch that cannot land
// ============================================================================
//
// One (vault, mint) sweep batch on devnet has failed simulation on every tick
// since 2026-08 ("sum of account balances before and after instruction do not
// match"), which put `sweepOrdersErrors: 1` on every heartbeat for weeks and
// made the error count useless as a signal (ops ledger 66, 75).
//
// Rule, as ruled 2026-09-29: after QUARANTINE_AFTER_FAILURES consecutive
// failures a batch is quarantined -- announced once, then retried once a day.
// A success clears it. A failed daily retry keeps it quarantined without a
// second announcement. The state is a small JSON file in the crank's state
// directory so a restart does not re-announce or re-spam.
//
// Pure: the clock is passed in. The file I/O lives in the two static helpers.
// ============================================================================

import * as fs from "fs";
import * as path from "path";

export const QUARANTINE_AFTER_FAILURES = 3;
export const QUARANTINE_RETRY_MS = 24 * 60 * 60 * 1000;

export function quarantineKey(vault: string, mint: string): string {
  return `${vault}:${mint}`;
}

interface Entry {
  failures: number;
  /** ms epoch of the failure that quarantined it; 0 while not quarantined. */
  quarantinedAtMs: number;
  /** ms epoch of the last attempt that failed. */
  lastFailureMs: number;
}

export type SweepDecision =
  | { attempt: true; reason: "fresh" | "daily-retry" }
  | { attempt: false; reason: "quarantined"; retryAtMs: number };

export interface FailureOutcome {
  quarantined: boolean;
  /** True exactly once per quarantine: on the failure that crossed the line. */
  transitioned: boolean;
  failures: number;
}

export interface QuarantineFile {
  version: 1;
  entries: Array<{ key: string } & Entry>;
}

export class SweepQuarantine {
  private entries = new Map<string, Entry>();

  size(): number { return this.entries.size; }

  decide(key: string, nowMs: number): SweepDecision {
    const e = this.entries.get(key);
    if (!e || e.quarantinedAtMs === 0) return { attempt: true, reason: "fresh" };
    const retryAtMs = e.lastFailureMs + QUARANTINE_RETRY_MS;
    if (nowMs >= retryAtMs) return { attempt: true, reason: "daily-retry" };
    return { attempt: false, reason: "quarantined", retryAtMs };
  }

  recordFailure(key: string, nowMs: number): FailureOutcome {
    const e = this.entries.get(key) ?? { failures: 0, quarantinedAtMs: 0, lastFailureMs: 0 };
    e.failures += 1;
    e.lastFailureMs = nowMs;
    let transitioned = false;
    if (e.quarantinedAtMs === 0 && e.failures >= QUARANTINE_AFTER_FAILURES) {
      e.quarantinedAtMs = nowMs;
      transitioned = true;
    }
    this.entries.set(key, e);
    return { quarantined: e.quarantinedAtMs !== 0, transitioned, failures: e.failures };
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  summary(nowMs: number): { tracked: number; quarantined: number; dueForRetry: number } {
    let quarantined = 0, dueForRetry = 0;
    for (const e of this.entries.values()) {
      if (e.quarantinedAtMs === 0) continue;
      quarantined += 1;
      if (nowMs >= e.lastFailureMs + QUARANTINE_RETRY_MS) dueForRetry += 1;
    }
    return { tracked: this.entries.size, quarantined, dueForRetry };
  }

  toJSON(): QuarantineFile {
    return { version: 1, entries: [...this.entries].map(([key, e]) => ({ key, ...e })) };
  }

  /** Lenient: anything that is not the expected shape yields an empty state. */
  static fromJSON(raw: unknown): SweepQuarantine {
    const q = new SweepQuarantine();
    const entries = (raw as any)?.entries;
    if (!Array.isArray(entries)) return q;
    for (const e of entries) {
      if (!e || typeof e.key !== "string") continue;
      const failures = Number(e.failures), quarantinedAtMs = Number(e.quarantinedAtMs), lastFailureMs = Number(e.lastFailureMs);
      if (![failures, quarantinedAtMs, lastFailureMs].every(Number.isFinite)) continue;
      q.entries.set(e.key, { failures, quarantinedAtMs, lastFailureMs });
    }
    return q;
  }

  static load(filePath: string): SweepQuarantine {
    try {
      return SweepQuarantine.fromJSON(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch {
      return new SweepQuarantine();
    }
  }

  /** Atomic: write a sibling and rename over the target. Failure to persist is
   *  not fatal; the next flush tries again. */
  flush(filePath: string): boolean {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.toJSON()));
      fs.renameSync(tmp, filePath);
      return true;
    } catch {
      return false;
    }
  }
}
