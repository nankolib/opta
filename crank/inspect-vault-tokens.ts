// crank/inspect-vault-tokens.ts
// =============================================================================
// READ-ONLY inspector for a SharedVault's full on-chain token state.
//
// Pulls the post-settle picture for the SOL vault (PDA hardcoded to the
// 2026-04-29 smoke vault — change VAULT_PDA below to repurpose):
//   1. VaultMint records associated with the vault (option_mint, writer,
//      premium, quantity_minted/sold)
//   2. The Token-2022 option mint itself: supply, decimals, mint authority,
//      installed extensions, and the PermanentDelegate authority pubkey
//   3. Every non-zero holder ATA for that mint, with owner + balance —
//      shows whether buyer tokens / unsold protocol-escrow tokens still
//      exist post-settle
//   4. The vault's USDC token account amount + the vault's own counters
//      (total_collateral, collateral_remaining, options_minted/sold, shares)
//   5. WriterPosition records for the vault (per-writer shares + claimed
//      premium)
//
// Performs only RPC reads (Anchor account fetches, getProgramAccounts,
// getParsedAccountInfo). Submits no transactions and mutates no on-chain
// state. Useful for verifying whether auto-burn / auto-distribute has run
// or whether tokens + USDC are still parked awaiting manual cleanup.
//
// Run: OPTA_RPC_URL=... npx ts-node -r tsconfig-paths/register inspect-vault-tokens.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  unpackMint,
  getExtensionTypes,
  getPermanentDelegate,
  getMetadataPointerState,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";

const VAULT_PDA = new PublicKey("DsFhwmU4ph4yLz4QXUCHUF8qcW4urneQiqjXYJBJPStW");
const KEYPAIR_PATH = path.join(os.homedir(), ".config/solana/id.json");
const IDL_JSON_PATH = path.resolve(__dirname, "../app/src/idl/opta.json");

function bn(x: any): number {
  if (typeof x === "number") return x;
  if (x && typeof x.toNumber === "function") return x.toNumber();
  return Number(x);
}

async function main(): Promise<void> {
  const rpc = process.env.OPTA_RPC_URL;
  if (!rpc) throw new Error("OPTA_RPC_URL required");
  const conn = new Connection(rpc, "confirmed");

  const secret = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf-8")) as number[];
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(IDL_JSON_PATH, "utf-8")) as Opta;
  const program = new anchor.Program<Opta>(idl, provider);

  // 1. Find the VaultMint record(s) for this vault.
  const allVaultMints = await program.account.vaultMint.all();
  const ourMints = allVaultMints.filter(
    (a) => a.account.vault.toBase58() === VAULT_PDA.toBase58(),
  );
  console.log("=== VaultMint records for vault ===");
  console.log("  count:", ourMints.length);
  for (const vm of ourMints) {
    console.log("  --");
    console.log("  pda:               ", vm.publicKey.toBase58());
    console.log("  option_mint:       ", vm.account.optionMint.toBase58());
    console.log("  writer:            ", vm.account.writer.toBase58());
    console.log("  premium_per_contract:", bn(vm.account.premiumPerContract));
    console.log("  quantity_minted:   ", bn(vm.account.quantityMinted));
    console.log("  quantity_sold:     ", bn(vm.account.quantitySold));
    console.log("  created_at:        ", bn(vm.account.createdAt));
  }

  if (ourMints.length === 0) {
    console.log("no VaultMint for this vault — nothing more to inspect");
    return;
  }

  // For each mint: extensions, supply, top holders.
  for (const vm of ourMints) {
    const mintPk = vm.account.optionMint;
    console.log("");
    console.log("=== Mint:", mintPk.toBase58(), "===");
    const mintInfo = await conn.getAccountInfo(mintPk);
    if (!mintInfo) {
      console.log("  mint account not found (closed?)");
      continue;
    }
    console.log("  owner program:", mintInfo.owner.toBase58());
    const isToken2022 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
    console.log("  is Token-2022:", isToken2022);

    const unpacked = unpackMint(mintPk, mintInfo, mintInfo.owner);
    console.log("  supply:       ", unpacked.supply.toString());
    console.log("  decimals:     ", unpacked.decimals);
    console.log("  mint authority:", unpacked.mintAuthority?.toBase58() ?? "null");

    if (isToken2022) {
      const exts = getExtensionTypes(unpacked.tlvData);
      const extNames = exts.map((t) => ExtensionType[t] ?? `Unknown(${t})`);
      console.log("  extensions:   ", extNames);

      const pd = getPermanentDelegate(unpacked);
      console.log(
        "  PermanentDelegate authority:",
        pd?.delegate?.toBase58() ?? "(none)",
      );

      const mp = getMetadataPointerState(unpacked);
      console.log(
        "  MetadataPointer:",
        mp?.metadataAddress?.toBase58() ?? "(none)",
      );
    }

    // Supply > 0 → some holder still has tokens. Find the top holders.
    if (unpacked.supply > 0n) {
      // getProgramAccounts on Token-2022 with memcmp on mint (offset 0)
      // 165 = base TokenAccount; Token-2022 ATAs are typically 170 (with
      // ImmutableOwner) but can be longer. Use memcmp on mint at offset 0.
      const holders = await conn.getParsedProgramAccounts(TOKEN_2022_PROGRAM_ID, {
        filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
      });
      console.log("  holder ATAs:  ", holders.length);
      for (const h of holders) {
        const data: any = (h.account.data as any).parsed;
        const amt = data?.info?.tokenAmount?.amount ?? "?";
        const owner = data?.info?.owner ?? "?";
        if (amt === "0") continue;
        console.log(`    - ${h.pubkey.toBase58()}  owner=${owner}  amount=${amt}`);
      }
    } else {
      console.log("  supply is zero — no holders");
    }
  }

  // 2. Vault's USDC balance — to confirm collateral is still there.
  const vault: any = await program.account.sharedVault.fetch(VAULT_PDA);
  const vaultUsdcInfo = await conn.getParsedAccountInfo(vault.vaultUsdcAccount as PublicKey);
  const usdcAmount =
    (vaultUsdcInfo.value?.data as any)?.parsed?.info?.tokenAmount?.amount ?? "?";
  console.log("");
  console.log("=== Vault USDC account ===");
  console.log("  pda:           ", (vault.vaultUsdcAccount as PublicKey).toBase58());
  console.log("  amount:        ", usdcAmount);
  console.log("  total_collateral (vault):", bn(vault.totalCollateral));
  console.log("  collateral_remaining:    ", bn(vault.collateralRemaining));
  console.log("  total_options_minted:    ", bn(vault.totalOptionsMinted));
  console.log("  total_options_sold:      ", bn(vault.totalOptionsSold));
  console.log("  total_shares:            ", bn(vault.totalShares));

  // 3. WriterPosition for this vault (one per writer).
  const allWriterPositions = await program.account.writerPosition.all();
  const ourPositions = allWriterPositions.filter(
    (a) => a.account.vault.toBase58() === VAULT_PDA.toBase58(),
  );
  console.log("");
  console.log("=== WriterPositions for vault ===");
  console.log("  count:", ourPositions.length);
  for (const p of ourPositions) {
    console.log("  --");
    console.log("  pda:                  ", p.publicKey.toBase58());
    console.log("  owner (writer wallet):", p.account.owner.toBase58());
    console.log("  shares:               ", bn(p.account.shares));
    console.log("  deposited_collateral: ", bn(p.account.depositedCollateral));
    console.log("  options_minted:       ", bn(p.account.optionsMinted));
    console.log("  options_sold:         ", bn(p.account.optionsSold));
    console.log("  premium_claimed:      ", bn(p.account.premiumClaimed));
  }
}

main().catch((err: any) => {
  console.error("FATAL:", err?.message ?? err);
  process.exit(1);
});
