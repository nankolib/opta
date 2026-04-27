import type { FC } from "react";

type TradeStatementHeaderProps = {
  monthLabel: string;
  timestampLabel: string;
  assets: string[];
  selectedAsset: string;
  onAssetChange: (asset: string) => void;
};

/**
 * Statement header for the Trade page. Right cluster carries the
 * timestamp + asset chips (mono uppercase pills, single-select,
 * crimson-outlined-and-dark-filled when active).
 */
export const TradeStatementHeader: FC<TradeStatementHeaderProps> = ({
  monthLabel,
  timestampLabel,
  assets,
  selectedAsset,
  onAssetChange,
}) => (
  <header className="border-b border-rule pb-12 mb-8">
    <div className="flex items-center flex-wrap gap-x-[14px] gap-y-2 font-mono text-[11.5px] uppercase tracking-[0.22em] opacity-85 mb-8">
      <span className="font-serif italic font-normal opacity-55 normal-case tracking-normal">§</span>
      <span className="text-ink">
        Trade<em className="font-serif italic text-crimson px-[1px]">·</em>
      </span>
      <span className="opacity-75">{monthLabel}</span>
      <span className="opacity-30">·</span>
      <span className="opacity-75">Mainnet · Solana</span>
      <span className="opacity-30">·</span>
      <span className="opacity-75">v0.1.4</span>
    </div>

    <div className="flex flex-wrap items-end justify-between gap-8">
      <h1 className="m-0 font-fraunces-display font-light text-ink leading-[0.92] tracking-[-0.04em] text-[clamp(72px,10vw,144px)]">
        Trade<span className="italic font-fraunces-display-em text-crimson">.</span>
      </h1>

      <div className="flex flex-wrap items-center gap-5">
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] opacity-60">
          As of {timestampLabel}
        </span>

        {assets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {assets.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => onAssetChange(a)}
                aria-pressed={selectedAsset === a}
                className={`rounded-full border px-[14px] py-[6px] font-mono text-[10.5px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
                  selectedAsset === a
                    ? "border-crimson bg-ink text-paper"
                    : "border-rule text-ink opacity-65 hover:opacity-100 hover:border-ink"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  </header>
);

export default TradeStatementHeader;
