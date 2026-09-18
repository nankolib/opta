// =============================================================================
// tests/cu-profile-get-option-price.ts -- Pass 3 get_option_price CU profile
// =============================================================================
//
// Measures CU consumption of the Pass 3 `price_american` helper -- the
// exact pricing path that `get_option_price` runs per call. Mirrors the
// cu-profile-american + cu-profile-mint-from-vault-american pattern:
//   - Gated by env var CU_PROFILE=1 (skips otherwise so the default
//     `anchor test` run doesn't blow up on the missing instruction).
//   - Pre-deploys a real VolOracle (best-effort init; idempotent).
//   - Submits cu_profile_get_option_price with 1.4M CU budget so the
//     scenario brackets fit even worst case.
//   - Parses program logs for sol_log_compute_units markers + scenario
//     headers + result lines.
//
// Run:
//   anchor build -- --features cu-profile
//   CU_PROFILE=1 anchor test --skip-build -- --grep 'CU Profile get_option_price'
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
  "CU Profile get_option_price (Pass 3)",
  () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    // Cast through `any` because cu_profile_get_option_price only exists in
    // the IDL when built with the cu-profile feature.
    const program = anchor.workspace.Opta as Program<any>;

    it("reports CU for Call q=5% and Put q=5% (both BS-2002 main)", async () => {
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
        if (!String(err).includes("already in use")) throw err;
      }

      const sig = await (program.methods as any)
        .cuProfileGetOptionPrice()
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

      console.log("\n========== CU PROFILE: get_option_price ==========");
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
      console.log("===================================================\n");
    });
  },
);
