const anchor = require("@coral-xyz/anchor");
const { PublicKey } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require("@solana/spl-token");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.opta;
  const admin = provider.wallet;
  const userWallet = admin.publicKey.toBase58();
  const connection = provider.connection;

  // Find AAPL position written by user
  const allAccounts = await connection.getProgramAccounts(program.programId);
  let target = null;

  for (const a of allAccounts) {
    try {
      const pos = program.coder.accounts.decode("optionPosition", a.account.data);
      if (pos.writer.toBase58() === userWallet && !pos.isPurchased && !pos.isCancelled) {
        const mkt = await program.account.optionsMarket.fetch(pos.market);
        if (mkt.assetName.includes("AAPL")) {
          target = { pubkey: a.pubkey, account: pos };
          console.log("Found AAPL position:", a.pubkey.toBase58());
          console.log("  Premium:", pos.premium.toNumber() / 1e6, "USDC");
          console.log("  Collateral:", pos.collateralAmount.toNumber() / 1e6, "USDC");
        }
      }
    } catch {}
  }

  if (!target) { console.log("No AAPL position found"); return; }

  const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_v2")], program.programId);
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);

  const buyerTokenAccount = await getAssociatedTokenAddress(protocolState.usdcMint, admin.publicKey);
  const writerTokenAccount = await getAssociatedTokenAddress(protocolState.usdcMint, new PublicKey(userWallet));

  console.log("\nBuying...");
  const tx = await program.methods.buyOption().accountsStrict({
    buyer: admin.publicKey,
    protocolState: protocolStatePda,
    market: target.account.market,
    position: target.pubkey,
    buyerTokenAccount,
    writerTokenAccount,
    treasury: treasuryPda,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).rpc();

  console.log("\n✓ Purchased! Tx:", tx);
}

main().catch(console.error);
