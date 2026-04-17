// Quick check: dump v2 option mint account data to verify Token-2022 metadata
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ButterOptions } from "../target/types/butter_options";
import { PublicKey } from "@solana/web3.js";
import { getMint, getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.butterOptions as Program<ButterOptions>;

  // Fetch all VaultMint records
  const vaultMints = await (program.account as any).vaultMint.all();
  console.log(`Found ${vaultMints.length} VaultMint records\n`);

  for (const vm of vaultMints.slice(0, 3)) {
    const mint = vm.account.optionMint as PublicKey;
    console.log(`=== VaultMint: ${vm.publicKey.toBase58()} ===`);
    console.log(`  Option mint: ${mint.toBase58()}`);
    console.log(`  Quantity minted: ${vm.account.quantityMinted.toString()}`);

    try {
      const mintInfo = await getMint(provider.connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      console.log(`  Mint supply: ${mintInfo.supply}`);
      console.log(`  Decimals: ${mintInfo.decimals}`);
    } catch (e: any) {
      console.log(`  Mint fetch error: ${e.message}`);
    }

    try {
      const meta = await getTokenMetadata(provider.connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
      if (meta) {
        console.log(`  ✓ METADATA:`);
        console.log(`    name: "${meta.name}"`);
        console.log(`    symbol: "${meta.symbol}"`);
        console.log(`    uri: "${meta.uri}"`);
        console.log(`    additional fields: ${meta.additionalMetadata?.length ?? 0}`);
      } else {
        console.log(`  ✗ NO METADATA FOUND`);
      }
    } catch (e: any) {
      console.log(`  Metadata fetch error: ${e.message}`);
    }

    // Raw account size
    const acct = await provider.connection.getAccountInfo(mint);
    if (acct) console.log(`  Account size: ${acct.data.length} bytes`);

    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
