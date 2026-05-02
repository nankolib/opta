import type { FC } from "react";
import { useMemo } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { inferClusterFromUrl, getClusterDisplayLabel } from "../../utils/env";

type WriteStatementHeaderProps = {
  monthLabel: string;
  timestampLabel: string;
};

/**
 * Statement header for the Write page — same shape as Markets and
 * Portfolio statement headers. The right cluster is simpler: a live
 * UTC timestamp and a static "Collateral · USDC" indicator (no
 * toggle, no CTA).
 *
 * Stage Secondary 7.5: cluster label is derived at render time from
 * the active connection RPC URL via inferClusterFromUrl.
 */
export const WriteStatementHeader: FC<WriteStatementHeaderProps> = ({
  monthLabel,
  timestampLabel,
}) => {
  const { connection } = useConnection();
  const clusterLabel = useMemo(
    () => getClusterDisplayLabel(inferClusterFromUrl(connection.rpcEndpoint)),
    [connection.rpcEndpoint],
  );
  return (
    <header className="border-b border-rule pb-12 mb-12">
      <div className="flex items-center flex-wrap gap-x-[14px] gap-y-2 font-mono text-[11.5px] uppercase tracking-[0.22em] opacity-85 mb-8">
        <span className="font-serif italic font-normal opacity-55 normal-case tracking-normal">§</span>
        <span className="text-ink">
          Write<em className="font-serif italic text-crimson px-[1px]">·</em>
        </span>
        <span className="opacity-75">{monthLabel}</span>
        <span className="opacity-30">·</span>
        <span className="opacity-75">{clusterLabel}</span>
        <span className="opacity-30">·</span>
        <span className="opacity-75">v0.1.4</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-8">
        <h1 className="m-0 font-fraunces-display font-light text-ink leading-[0.92] tracking-[-0.04em] text-[clamp(72px,10vw,144px)]">
          Write<span className="italic font-fraunces-display-em text-crimson">.</span>
        </h1>

        <div className="flex flex-wrap items-center gap-6">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] opacity-60">
            As of {timestampLabel}
          </span>
          <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] opacity-75">
            <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
            Collateral · USDC
          </span>
        </div>
      </div>
    </header>
  );
};

export default WriteStatementHeader;
