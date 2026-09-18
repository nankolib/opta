// =============================================================================
// tests/cu-profile-mint-from-vault-american.ts -- Pass 2 American branch CU
// =============================================================================
//
// Measures the CU cost of the FULL American branch pipeline that
// mint_from_vault now runs on AMER vaults: VolOracle load +
// realized_vol_annualized + BS-2002. Excludes Token-2022 mint creation
// (constant ~600K, same EUR/AMER).
//
// Gated by env var: CU_PROFILE=1 enables (matches cu-profile-american.ts).
// Run via:
//   anchor build -- --features cu-profile
//   CU_PROFILE=1 anchor test --skip-build -- --grep 'CU Profile mint_from_vault'
//
// Reports three scenario CUs: q=0 fast-path, worst CALL (q=5%), worst PUT (q=0).
// Headroom check: each scenario should leave ~600K for Token-2022 work under
// the 1.4M tx budget.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { FEED_ID_HEX, fixturePubkey } from "./_pyth_fixtures";

const SHOULD_RUN = process.env.CU_PROFILE === "1";

const SOL_FEED_ID = Array.from(Buffer.from(FEED_ID_HEX.SOL, "hex"));
const SOL_FIXTURE = fixturePubkey("sol-180-fresh");

function deriveVolOracle(programId: PublicKey, feedId: number[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vol_oracle"), Buffer.from(feedId)],
    programId,
  );
}

(SHOULD_RUN ? describe : describe.skip)(
  "CU Profile mint_from_vault American branch",
  () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    // Cast through `any` because cu_profile_mint_from_vault_american only
    // exists in the IDL when built with the cu-profile feature.
    const program = anchor.workspace.Opta as Program<any>;

    it("reports CU for q=0 fast-path, worst CALL, worst PUT", async () => {
      const [oraclePda] = deriveVolOracle(program.programId, SOL_FEED_ID);

      // Best-effort init -- ignore if already initialized.
      try {
        await (program.methods as any)
          .initializeVolOracle(SOL_FEED_ID, 0, new anchor.BN(0))
          .accountsStrict({
            sbQueue: null, sbSlothashes: null, sbInstructions: null, optaPriceFeed: null,
            initializer: provider.wallet.publicKey,
            priceUpdate: SOL_FIXTURE,
            volOracle: oraclePda,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch (err: any) {
        // "already in use" is fine -- the profile handler plants state in-place.
        if (!String(err).includes("already in use")) throw err;
      }

      const sig = await (program.methods as any)
        .cuProfileMintFromVaultAmerican()
        .accounts({
          signer: provider.wallet.publicKey,
          volOracle: oraclePda,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ])
        .rpc({ commitment: "confirmed" });

      const tx = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta?.logMessages) throw new Error("no logs on profile tx");

      console.log("\n========== CU PROFILE: mint_from_vault American ==========");
      for (const line of tx.meta.logMessages) {
        if (
          line.includes("compute units") ||
          line.includes("consumption:") ||
          line.includes("===") ||
          line.includes("result:")
        ) {
          console.log(line);
        }
      }
      console.log("==========================================================\n");
    });
  },
);
