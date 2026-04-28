import type { FC } from "react";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "../../hooks/useProgram";
import { MetaLabel } from "../../components/layout";
import { AdminTools } from "../../components/portfolio/AdminTools";

interface AccountRecord {
  publicKey: PublicKey;
  account: any;
}

type SettleExpiriesSectionProps = {
  vaults: AccountRecord[];
  markets: AccountRecord[];
  settlementRecords: AccountRecord[];
  onRefetch: () => void;
};

/**
 * SettleExpiriesSection — paper-aesthetic wrapper around the settle-expiry
 * UI on the Portfolio page.
 *
 * Stage P4d: dropped the admin-only gate and the "Devnet Only" badge —
 * settle_expiry is permissionless on-chain (anyone can post a fresh Pyth
 * update + finalize the SettlementRecord). The wrapper is now a thin
 * MetaLabel + render of AdminTools, mounted whenever a program is in
 * scope. AdminTools handles its own "no expired markets" empty state.
 */
export const SettleExpiriesSection: FC<SettleExpiriesSectionProps> = ({
  vaults,
  markets,
  settlementRecords,
  onRefetch,
}) => {
  const { program } = useProgram();
  if (!program) return null;

  return (
    <section className="mt-16">
      <MetaLabel as="div" className="mb-6">
        Settle expired markets
      </MetaLabel>
      <AdminTools
        vaults={vaults}
        markets={markets}
        settlementRecords={settlementRecords}
        program={program}
        onRefetch={onRefetch}
      />
    </section>
  );
};

export default SettleExpiriesSection;
