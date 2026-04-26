// =============================================================================
// scripts/initialize-epoch-config.ts — Initialize the EpochConfig singleton
// =============================================================================
// Usage: npx ts-node scripts/initialize-epoch-config.ts
// Sets: Friday 08:00 UTC expiries, monthly enabled, min 1-day duration
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Opta } from "../target/types/opta";
import { PublicKey, SystemProgram } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");

function deriveProtocolStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
}

function deriveEpochConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("epoch_config")], PROGRAM_ID);
}

async function main() {
  console.log("=== Initialize Epoch Config ===\n");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.opta as Program<Opta>;
  const admin = provider.wallet;

  console.log("Admin:", admin.publicKey.toBase58());

  const [protocolStatePda] = deriveProtocolStatePda();
  const [epochConfigPda] = deriveEpochConfigPda();

  // Check if EpochConfig already exists
  try {
    const existing = await program.account.epochConfig.fetch(epochConfigPda);
    console.log("\nEpochConfig already initialized:");
    console.log("  PDA:", epochConfigPda.toBase58());
    console.log("  Weekly expiry day:", existing.weeklyExpiryDay, "(0=Sun, 5=Fri)");
    console.log("  Weekly expiry hour:", existing.weeklyExpiryHour, "UTC");
    console.log("  Monthly enabled:", existing.monthlyEnabled);
    console.log("  Min epoch duration (days):", existing.minEpochDurationDays);
    return;
  } catch {
    // Does not exist yet — proceed to create
  }

  // Verify admin matches protocol state
  try {
    const protocolState = await program.account.protocolState.fetch(protocolStatePda);
    if (!protocolState.admin.equals(admin.publicKey)) {
      console.error("ERROR: Your wallet is not the protocol admin.");
      console.error("  Expected:", protocolState.admin.toBase58());
      console.error("  Got:", admin.publicKey.toBase58());
      process.exit(1);
    }
  } catch {
    console.error("ERROR: ProtocolState not found. Run seed-devnet.ts first.");
    process.exit(1);
  }

  console.log("Initializing EpochConfig...");
  console.log("  Weekly expiry: Friday (5) at 08:00 UTC");
  console.log("  Monthly enabled: true");

  const tx = await program.methods
    .initializeEpochConfig(
      5,    // Friday
      8,    // 08:00 UTC
      true, // monthly enabled
    )
    .accountsStrict({
      admin: admin.publicKey,
      protocolState: protocolStatePda,
      epochConfig: epochConfigPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("\n✓ EpochConfig initialized!");
  console.log("  PDA:", epochConfigPda.toBase58());
  console.log("  Tx:", tx);
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  if (err.logs) console.error("Logs:", err.logs.slice(-5).join("\n  "));
  process.exit(1);
});
