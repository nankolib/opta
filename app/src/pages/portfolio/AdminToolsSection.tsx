import type { FC } from "react";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { MetaLabel } from "../../components/layout";
import { AdminTools } from "../../components/portfolio/AdminTools";

type AdminToolsSectionProps = {
  markets: { publicKey: PublicKey; account: any }[];
  onRefetch: () => void;
};

/**
 * AdminToolsSection — paper-aesthetic wrapper around the existing
 * dark-themed AdminTools component. Visible only when the connected
 * wallet matches the on-chain protocolState.admin keypair.
 *
 * The dark internals are preserved per Stage 2 scope ("don't redesign
 * AdminTools internals — just the section wrapper around it"). Visual
 * mismatch between paper outer and dark inner is accepted — admin
 * territory reads as deliberately distinct.
 *
 * Uses MetaLabel rather than SectionNumber for the section header so
 * the admin block stays visually unobtrusive — it's not a §-numbered
 * editorial section like Open / Closed positions, just a reveal for
 * privileged actions.
 */
export const AdminToolsSection: FC<AdminToolsSectionProps> = ({
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

  if (!isAdmin || !publicKey || !program) return null;

  return (
    <section className="mt-16">
      <MetaLabel as="div" className="mb-6">
        Admin tools · Devnet only
      </MetaLabel>
      <AdminTools
        markets={markets}
        program={program}
        publicKey={publicKey}
        onRefetch={onRefetch}
      />
    </section>
  );
};

export default AdminToolsSection;
