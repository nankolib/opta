import type { FC } from "react";
import { useMemo } from "react";

export type ExpiryPresetId = "15M" | "1H" | "1D" | "7D" | "30D" | "CUSTOM";

const PRESETS: ReadonlyArray<{ id: ExpiryPresetId; label: string; seconds: number | null }> = [
  { id: "15M", label: "15M", seconds: 15 * 60 },
  { id: "1H", label: "1H", seconds: 60 * 60 },
  { id: "1D", label: "1D", seconds: 24 * 3600 },
  { id: "7D", label: "7D", seconds: 7 * 24 * 3600 },
  { id: "30D", label: "30D", seconds: 30 * 24 * 3600 },
  { id: "CUSTOM", label: "Custom", seconds: null },
];

type ExpiryPickerProps = {
  /** Currently chosen preset (controls pill highlight). */
  preset: ExpiryPresetId;
  /** Resolved expiry as Unix seconds. `null` means "no valid expiry yet" (e.g. CUSTOM with empty inputs). */
  value: number | null;
  /** Called when preset OR date/time inputs change. Both args always reflect the new state. */
  onChange: (next: { preset: ExpiryPresetId; value: number | null }) => void;
};

/**
 * Bug-fix expiry picker — single source of truth.
 *
 * Internal model: there is ONE meaningful piece of state, the resolved
 * Unix-seconds timestamp. The date and time `<input>` values are
 * computed from it via formatters; clicking a preset sets the
 * timestamp and both inputs render the new value automatically.
 *
 * Replaces the legacy two-state pattern in CreateCustomVault.tsx where
 * `expirySeconds` and `customExpiry` could disagree, leaving the
 * datetime input visually empty after a preset click.
 *
 * Manual edits to the date or time inputs parse back into the
 * timestamp; only invalid combinations (resulting in NaN or strictly
 * past) leave `value` as `null` and surface a small warning line.
 */
export const ExpiryPicker: FC<ExpiryPickerProps> = ({ preset, value, onChange }) => {
  const dateStr = useMemo(() => formatDate(value), [value]);
  const timeStr = useMemo(() => formatTime(value), [value]);

  const handlePresetClick = (id: ExpiryPresetId) => {
    if (id === "CUSTOM") {
      onChange({ preset: "CUSTOM", value: null });
      return;
    }
    const p = PRESETS.find((x) => x.id === id)!;
    const target = Math.floor(Date.now() / 1000) + (p.seconds ?? 0);
    onChange({ preset: id, value: target });
  };

  const handleDateChange = (newDate: string) => {
    const ts = parseDateTime(newDate, timeStr);
    onChange({ preset: "CUSTOM", value: ts });
  };

  const handleTimeChange = (newTime: string) => {
    const ts = parseDateTime(dateStr, newTime);
    onChange({ preset: "CUSTOM", value: ts });
  };

  const isPast = value != null && value <= Math.floor(Date.now() / 1000);
  const showInputs = preset === "CUSTOM" || value != null;

  return (
    <div>
      <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
        Expiry
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => handlePresetClick(p.id)}
            aria-pressed={preset === p.id}
            className={`rounded-full border px-[14px] py-[6px] font-mono text-[10.5px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
              preset === p.id
                ? "border-crimson text-ink"
                : "border-rule text-ink opacity-55 hover:opacity-100 hover:border-ink"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {showInputs && (
        <div className="grid grid-cols-2 gap-3">
          <label>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mb-1">
              Date (UTC)
            </div>
            <input
              type="date"
              value={dateStr}
              onChange={(e) => handleDateChange(e.target.value)}
              className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[13px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
            />
          </label>
          <label>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mb-1">
              Time (UTC)
            </div>
            <input
              type="time"
              value={timeStr}
              onChange={(e) => handleTimeChange(e.target.value)}
              className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[13px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
            />
          </label>
        </div>
      )}

      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-60 mt-2">
        {value == null
          ? "—"
          : isPast
            ? <span className="text-crimson">Expiry is in the past</span>
            : <>Settles in {formatCountdown(value)} · {formatLongDate(value)} UTC</>}
      </div>
    </div>
  );
};

function formatDate(ts: number | null): string {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  // YYYY-MM-DD in UTC
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function formatTime(ts: number | null): string {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function parseDateTime(date: string, time: string): number | null {
  if (!date || !time) return null;
  // Treat the user input as UTC.
  const ts = Math.floor(Date.parse(`${date}T${time}:00Z`) / 1000);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatCountdown(ts: number): string {
  const diff = ts - Date.now() / 1000;
  if (diff <= 0) return "0M";
  if (diff < 3600) return `${Math.floor(diff / 60)}M`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}H ${Math.floor((diff % 3600) / 60)}M`;
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  return `${days}D ${hours}H`;
}

function formatLongDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

export default ExpiryPicker;
