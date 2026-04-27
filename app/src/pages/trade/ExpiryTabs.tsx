import type { FC } from "react";

type ExpiryTabsProps = {
  expiries: number[];
  selected: number;
  onSelect: (expiry: number) => void;
};

/**
 * Horizontal pill row of available expiries. Active = dark fill +
 * paper text. Inactive = paper background + hairline border + ink
 * text.
 *
 * Pill label: short date + countdown, e.g. "03 May · 5D 21H". When
 * countdown is < 1 day it falls back to hours; < 1 hour to minutes.
 */
export const ExpiryTabs: FC<ExpiryTabsProps> = ({ expiries, selected, onSelect }) => {
  if (expiries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mb-8">
      {expiries.map((ts) => {
        const active = ts === selected;
        return (
          <button
            key={ts}
            type="button"
            onClick={() => onSelect(ts)}
            aria-pressed={active}
            className={`inline-flex items-center gap-3 rounded-full border px-[16px] py-[8px] font-mono text-[11px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
              active
                ? "border-ink bg-ink text-paper"
                : "border-rule text-ink opacity-65 hover:opacity-100 hover:border-ink"
            }`}
          >
            <span>{formatShortDate(ts)}</span>
            <span aria-hidden="true" className={active ? "opacity-60" : "opacity-55"}>·</span>
            <span className={active ? "opacity-90" : "opacity-70"}>
              {formatCountdown(ts)}
            </span>
          </button>
        );
      })}
    </div>
  );
};

function formatShortDate(unix: number): string {
  return new Date(unix * 1000)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })
    .toUpperCase();
}

function formatCountdown(unix: number): string {
  const diff = unix - Date.now() / 1000;
  if (diff <= 0) return "Expired";
  if (diff < 3600) return `${Math.floor(diff / 60)}M`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}H ${Math.floor((diff % 3600) / 60)}M`;
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  return `${days}D ${hours}H`;
}

export default ExpiryTabs;
