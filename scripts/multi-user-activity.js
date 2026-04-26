const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require("@solana/spl-token");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.opta;
  const admin = provider.wallet;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")], program.programId
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury_v2")], program.programId
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const adminUsdcAta = await getAssociatedTokenAddress(protocolState.usdcMint, admin.publicKey);

  // 1. Write a new option on the AAPL market from admin wallet
  console.log("--- Writing AAPL/USD option from admin wallet ---");
  const aaplMarket = new PublicKey("7V8UtQXkGiahy8nHoHiP7jZVheCXq84GoA2qBupCEYAh");

  const [aaplPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), aaplMarket.toBuffer(), admin.publicKey.toBuffer()],
    program.programId
  );
  const [aaplEscrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), aaplMarket.toBuffer(), admin.publicKey.toBuffer()],
    program.programId
  );

  try {
    const tx = await program.methods
      .writeOption(
        new anchor.BN(200_000_000), // $200 collateral
        new anchor.BN(25_000_000),  // $25 premium
        new anchor.BN(1_000_000),   // 1 contract
      )
      .accountsStrict({
        writer: admin.publicKey,
        protocolState: protocolStatePda,
        market: aaplMarket,
        position: aaplPosition,
        escrow: aaplEscrow,
        writerTokenAccount: adminUsdcAta,
        usdcMint: protocolState.usdcMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .rpc();
    console.log("✓ Admin wrote AAPL/USD $200 Put — premium $25, collateral $200");
    console.log("  Tx:", tx);
  } catch (e) {
    console.log("  Skipped (may already exist):", e.message.slice(0, 60));
  }

  // 2. Write options on BTC and ETH markets from admin
  const conn = provider.connection;
  const allAccounts = await conn.getProgramAccounts(program.programId);

  for (const a of allAccounts) {
    try {
      const mkt = program.coder.accounts.decode("optionsMarket", a.account.data);
      if (mkt.assetName === "BTC" || mkt.assetName === "ETH") {
        const [pos] = PublicKey.findProgramAddressSync(
          [Buffer.from("position"), a.pubkey.toBuffer(), admin.publicKey.toBuffer()],
          program.programId
        );
        const [esc] = PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), a.pubkey.toBuffer(), admin.publicKey.toBuffer()],
          program.programId
        );

        // Check if position exists
        const posInfo = await conn.getAccountInfo(pos);
        if (posInfo) { console.log("  " + mkt.assetName + " position already exists, skipping"); continue; }

        const isCall = "call" in mkt.optionType;
        const strike = mkt.strikePrice.toNumber() / 1e6;
        const collateral = isCall ? strike * 2 : strike;
        const premium = strike * 0.05; // 5% of strike

        try {
          await program.methods
            .writeOption(
              new anchor.BN(Math.round(collateral * 1e6)),
              new anchor.BN(Math.round(premium * 1e6)),
              new anchor.BN(1_000_000),
            )
            .accountsStrict({
              writer: admin.publicKey,
              protocolState: protocolStatePda,
              market: a.pubkey,
              position: pos,
              escrow: esc,
              writerTokenAccount: adminUsdcAta,
              usdcMint: protocolState.usdcMint,
              systemProgram: SystemProgram.programId,
              tokenProgram: TOKEN_PROGRAM_ID,
              rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
            })
            .rpc();
          console.log("✓ Wrote " + mkt.assetName + " $" + strike + " " + (isCall ? "Call" : "Put") + " — premium $" + premium);
        } catch (e) {
          console.log("  " + mkt.assetName + " write failed:", e.message.slice(0, 60));
        }
      }
    } catch {}
  }

  // 3. Summary
  console.log("\n--- All positions ---");
  for (const a of allAccounts) {
    try {
      const pos = program.coder.accounts.decode("optionPosition", a.account.data);
      let mktName = "?";
      try {
        const m = await program.account.optionsMarket.fetch(pos.market);
        mktName = m.assetName + " $" + m.strikePrice.toNumber()/1e6;
      } catch {}
      const status = pos.isCancelled ? "Cancelled" : pos.isExercised ? "Exercised" : pos.isPurchased ? "Purchased" : "For Sale";
      console.log("  " + mktName + " | writer:" + pos.writer.toBase58().slice(0,8) + " | " + status + " | $" + pos.premium.toNumber()/1e6);
    } catch {}
  }
  // Also check newly created ones
  const refreshed = await conn.getProgramAccounts(program.programId);
  let posCount = 0;
  for (const a of refreshed) {
    try { program.coder.accounts.decode("optionPosition", a.account.data); posCount++; } catch {}
  }
  console.log("\nTotal positions:", posCount);
}

main().catch(console.error);
