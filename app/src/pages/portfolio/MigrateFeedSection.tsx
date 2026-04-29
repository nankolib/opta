import type { FC } from "react";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { MetaLabel } from "../../components/layout";
import { MigrateFeedTools } from "../../components/portfolio/MigrateFeedTools";

interface AccountRecord {
  publicKey: PublicKey;
  account: any;
}

type MigrateFeedSectionProps = {
  markets: AccountRecord[];
  onRefetch: () => void;
};

/**
 * MigrateFeedSection — admin-only Pyth feed_id rotation.
 *
 * Renders only when the connected wallet matches `protocolState.admin`.
 * Non-admins see nothing — no fallback messaging, no empty section
 * header (per locked Stage P4e decision).
 *
 * The feed_id rotation calls `migrate_pyth_feed` (Stage P3 instruction)
 * which is admin-gated on-chain via `require_keys_eq!(admin.key(),
 * protocol_state.admin, OptaError::Unauthorized)`. The UI gate is
 * cosmetic — it just hides the section from non-admins so they aren't
 * shown a button they'd be rejected for using.
 */
export const MigrateFeedSection: FC<MigrateFeedSectionProps> = ({
  markets,
  onRefetch,
}) => {
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!program || !publicKey) {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const ps = await program.account.protocolState.fetch(protocolStatePda);
        if (!cancelled) setIsAdmin(ps.admin.equals(publicKey));
      } catch {
        if (!cancelled) setIsAdmin(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [program, publicKey]);

  if (!isAdmin || !program) return null;

  return (
    <section className="mt-16">
      <MetaLabel as="div" className="mb-6">
        Admin · Pyth feed migration
      </MetaLabel>
      <MigrateFeedTools
        markets={markets}
        program={program}
        onRefetch={onRefetch}
      />
    </section>
  );
};

export default MigrateFeedSection;
