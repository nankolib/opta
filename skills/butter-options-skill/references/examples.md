# Butter Options — Complete Code Examples

All examples use `@coral-xyz/anchor` and `@solana/spl-token` on Solana devnet.

## Setup (shared by all examples)

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  Keypair,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getTokenMetadata,
} from "@solana/spl-token";
import BN from "bn.js";

// --- Constants ---
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

// --- Connection ---
const connection = new anchor.web3.Connection(
  "https://api.devnet.solana.com",
  { commitment: "confirmed" },
);
const wallet = anchor.AnchorProvider.env().wallet;
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

// Load the program (requires IDL in target/idl/)
const program = anchor.workspace.butterOptions as Program<any>;

// --- PDA Helpers ---
const [protocolStatePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("protocol_v2")], PROGRAM_ID,
);
const [treasuryPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("treasury_v2")], PROGRAM_ID,
);

function deriveMarketPda(asset: string, strike: BN, expiry: BN, typeIdx: number) {
  return PublicKey.findProgramAddressSync([
    Buffer.from("market"), Buffer.from(asset),
    strike.toArrayLike(Buffer, "le", 8),
    expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([typeIdx]),
  ], PROGRAM_ID);
}

function derivePositionPda(market: PublicKey, writer: PublicKey, createdAt: BN) {
  return PublicKey.findProgramAddressSync([
    Buffer.from("position"), market.toBuffer(), writer.toBuffer(),
    createdAt.toArrayLike(Buffer, "le", 8),
  ], PROGRAM_ID);
}

function deriveEscrowPda(market: PublicKey, writer: PublicKey, createdAt: BN) {
  return PublicKey.findProgramAddressSync([
    Buffer.from("escrow"), market.toBuffer(), writer.toBuffer(),
    createdAt.toArrayLike(Buffer, "le", 8),
  ], PROGRAM_ID);
}

function deriveOptionMintPda(position: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("option_mint"), position.toBuffer()], PROGRAM_ID,
  );
}

function derivePurchaseEscrowPda(position: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("purchase_escrow"), position.toBuffer()], PROGRAM_ID,
  );
}

function deriveResaleEscrowPda(position: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("resale_escrow"), position.toBuffer()], PROGRAM_ID,
  );
}

function deriveHookAccounts(mint: PublicKey) {
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()], HOOK_PROGRAM_ID,
  );
  const [hookState] = PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), mint.toBuffer()], HOOK_PROGRAM_ID,
  );
  return { extraAccountMetaList, hookState };
}

function usdc(amount: number): BN {
  return new BN(Math.round(amount * 1_000_000));
}
```

---

## Example 1: Scan All Active Options

Fetch every option position, filter to active/tradeable, and display.

```typescript
async function scanActiveOptions() {
  const now = Math.floor(Date.now() / 1000);
  const positions = await program.account.optionPosition.all();

  console.log(`Total positions: ${positions.length}\n`);

  for (const pos of positions) {
    const p = pos.account;

    // Determine status
    let status: string;
    if (p.isCancelled) status = "CANCELLED";
    else if (p.isExercised) status = "EXERCISED";
    else if (p.isExpired) status = "EXPIRED";
    else status = "ACTIVE";

    // Fetch market details
    const market = await program.account.optionsMarket.fetch(p.market);
    const expiry = new Date(market.expiryTimestamp.toNumber() * 1000);
    const type = market.optionType.call ? "CALL" : "PUT";
    const strike = market.strikePrice.toNumber() / 1e6;
    const premiumPerToken = p.premium.toNumber() / 1e6 / p.totalSupply.toNumber();
    const available = p.totalSupply.toNumber() - p.tokensSold.toNumber();

    console.log(`--- ${market.assetName} $${strike} ${type} ---`);
    console.log(`  Status: ${status}`);
    console.log(`  Expiry: ${expiry.toISOString()}`);
    console.log(`  Premium: $${premiumPerToken.toFixed(2)}/token`);
    console.log(`  Supply: ${p.totalSupply.toNumber()} total, ${available} available`);
    console.log(`  Collateral: $${p.collateralAmount.toNumber() / 1e6}`);
    console.log(`  Position: ${pos.publicKey.toBase58()}`);
    console.log(`  Mint: ${p.optionMint.toBase58()}`);

    if (p.isListedForResale) {
      const resalePrice = p.resalePremium.toNumber() / 1e6 / p.resaleTokenAmount.toNumber();
      console.log(`  RESALE: ${p.resaleTokenAmount.toNumber()} tokens @ $${resalePrice.toFixed(2)}/token`);
    }

    if (market.isSettled) {
      console.log(`  Settlement: $${market.settlementPrice.toNumber() / 1e6}`);
    }
    console.log();
  }
}

scanActiveOptions().catch(console.error);
```

---

## Example 2: Calculate Fair Value for a Specific Option

Given a position address, fetch its details and compute Black-Scholes fair value.

```typescript
// --- Black-Scholes (inline for standalone example) ---
function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function bsCallPremium(S: number, K: number, days: number, sigma: number): number {
  if (days <= 0 || S <= 0 || K <= 0) return 0;
  const T = days / 365;
  const d1 = (Math.log(S / K) + (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return S * normalCDF(d1) - K * normalCDF(d2);
}

function bsPutPremium(S: number, K: number, days: number, sigma: number): number {
  if (days <= 0 || S <= 0 || K <= 0) return 0;
  const T = days / 365;
  const d1 = (Math.log(S / K) + (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return K * normalCDF(-d2) - S * normalCDF(-d1);
}

function getVol(asset: string): number {
  const lower = asset.toLowerCase();
  if (["xau", "gold"].some(a => lower.includes(a))) return 0.20;
  if (["wti", "oil"].some(a => lower.includes(a))) return 0.35;
  if (["eur", "gbp", "jpy", "usd"].some(a => lower.includes(a))) return 0.10;
  if (["aapl", "tsla", "nvda", "googl", "msft"].some(a => lower.includes(a))) return 0.40;
  return 0.80;
}

// --- Main ---
async function calculateFairValue(positionAddress: PublicKey, spotPrice: number) {
  const pos = await program.account.optionPosition.fetch(positionAddress);
  const market = await program.account.optionsMarket.fetch(pos.market);

  const strike = market.strikePrice.toNumber() / 1e6;
  const now = Math.floor(Date.now() / 1000);
  const daysToExpiry = (market.expiryTimestamp.toNumber() - now) / 86400;
  const vol = getVol(market.assetName);
  const isCall = !!market.optionType.call;

  const fairValue = isCall
    ? bsCallPremium(spotPrice, strike, daysToExpiry, vol)
    : bsPutPremium(spotPrice, strike, daysToExpiry, vol);

  const askingPrice = pos.premium.toNumber() / 1e6 / pos.totalSupply.toNumber();
  const edge = fairValue - askingPrice;

  console.log(`=== Fair Value Analysis ===`);
  console.log(`Asset: ${market.assetName} (${isCall ? "CALL" : "PUT"})`);
  console.log(`Spot: $${spotPrice} | Strike: $${strike}`);
  console.log(`Days to expiry: ${daysToExpiry.toFixed(1)}`);
  console.log(`Volatility: ${(vol * 100).toFixed(0)}%`);
  console.log(`Fair value: $${fairValue.toFixed(4)}/token`);
  console.log(`Asking price: $${askingPrice.toFixed(4)}/token`);
  console.log(`Edge: $${edge.toFixed(4)} (${edge > 0 ? "UNDERPRICED — BUY" : "OVERPRICED — PASS"})`);

  return { fairValue, askingPrice, edge };
}

// Usage:
// calculateFairValue(new PublicKey("...positionAddress..."), 188).catch(console.error);
```

---

## Example 3: Buy the Cheapest Underpriced Option

Scan all active options, price them, and buy the one with the biggest edge.

```typescript
async function buyBestOption(
  buyerKeypair: Keypair,
  spotPrices: Record<string, number>, // e.g., { "SOL": 188, "BTC": 65000 }
  buyerUsdcAccount: PublicKey,
) {
  const now = Math.floor(Date.now() / 1000);
  const positions = await program.account.optionPosition.all();

  // Score each position
  type Opportunity = {
    pos: any;
    posKey: PublicKey;
    market: any;
    fairValue: number;
    askingPrice: number;
    edge: number;
    available: number;
  };

  const opportunities: Opportunity[] = [];

  for (const p of positions) {
    const pos = p.account;
    if (pos.isCancelled || pos.isExercised || pos.isExpired) continue;

    const market = await program.account.optionsMarket.fetch(pos.market);
    if (market.expiryTimestamp.toNumber() < now) continue;

    const available = pos.totalSupply.toNumber() - pos.tokensSold.toNumber();
    if (available <= 0) continue;

    const spot = spotPrices[market.assetName];
    if (!spot) continue;

    const strike = market.strikePrice.toNumber() / 1e6;
    const days = (market.expiryTimestamp.toNumber() - now) / 86400;
    const vol = getVol(market.assetName);
    const isCall = !!market.optionType.call;

    const fairValue = isCall
      ? bsCallPremium(spot, strike, days, vol)
      : bsPutPremium(spot, strike, days, vol);

    const askingPrice = pos.premium.toNumber() / 1e6 / pos.totalSupply.toNumber();
    const edge = fairValue - askingPrice;

    if (edge > 0) {
      opportunities.push({
        pos, posKey: p.publicKey, market,
        fairValue, askingPrice, edge, available,
      });
    }
  }

  if (opportunities.length === 0) {
    console.log("No underpriced options found.");
    return;
  }

  // Sort by edge (best first)
  opportunities.sort((a, b) => b.edge - a.edge);
  const best = opportunities[0];

  console.log(`Best opportunity: ${best.market.assetName} $${best.market.strikePrice.toNumber() / 1e6} ${best.market.optionType.call ? "CALL" : "PUT"}`);
  console.log(`  Edge: $${best.edge.toFixed(4)}/token (${best.available} available)`);

  // Buy 1 token from the best opportunity
  const amount = new BN(1);
  const optionMint = best.pos.optionMint;
  const [purchaseEscrowPda] = derivePurchaseEscrowPda(best.posKey);
  const { extraAccountMetaList, hookState } = deriveHookAccounts(optionMint);

  // Create buyer's Token-2022 ATA (idempotent)
  const buyerOptionAta = getAssociatedTokenAddressSync(
    optionMint, buyerKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    buyerKeypair.publicKey, buyerOptionAta, buyerKeypair.publicKey,
    optionMint, TOKEN_2022_PROGRAM_ID,
  );

  // Find writer's USDC account
  const writerUsdcAta = getAssociatedTokenAddressSync(
    (await program.account.protocolState.fetch(protocolStatePda)).usdcMint,
    best.pos.writer,
  );

  const tx = await program.methods
    .purchaseOption(amount)
    .accountsStrict({
      buyer: buyerKeypair.publicKey,
      protocolState: protocolStatePda,
      market: best.pos.market,
      position: best.posKey,
      purchaseEscrow: purchaseEscrowPda,
      buyerUsdcAccount: buyerUsdcAccount,
      writerUsdcAccount: writerUsdcAta,
      buyerOptionAccount: buyerOptionAta,
      optionMint: optionMint,
      treasury: treasuryPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([EXTRA_CU, createAtaIx])
    .signers([buyerKeypair])
    .rpc();

  console.log(`Purchased! TX: ${tx}`);
}
```

---

## Example 4: Write a New Option at Fair Value + 10% Spread

```typescript
async function writeOptionAtFairValue(
  writerKeypair: Keypair,
  writerUsdcAccount: PublicKey,
  assetName: string,
  spotPrice: number,
  strikePrice: number,
  daysToExpiry: number,
  isCall: boolean,
  contractSize: number,
  pythFeed: PublicKey,
  assetClass: number,
) {
  const vol = getVol(assetName);
  const fairValue = isCall
    ? bsCallPremium(spotPrice, strikePrice, daysToExpiry, vol)
    : bsPutPremium(spotPrice, strikePrice, daysToExpiry, vol);

  // Add 10% spread
  const premiumPerToken = fairValue * 1.10;
  const totalPremium = premiumPerToken * contractSize;

  console.log(`Fair value: $${fairValue.toFixed(4)}/token`);
  console.log(`Writing at: $${premiumPerToken.toFixed(4)}/token (10% spread)`);
  console.log(`Total premium: $${totalPremium.toFixed(2)} for ${contractSize} contracts`);

  // Calculate collateral
  const collateralPerToken = isCall ? strikePrice * 2 : strikePrice;
  const totalCollateral = collateralPerToken * contractSize;
  console.log(`Collateral required: $${totalCollateral.toFixed(2)}`);

  const strike = usdc(strikePrice);
  const expiry = new BN(Math.floor(Date.now() / 1000) + Math.round(daysToExpiry * 86400));
  const typeIdx = isCall ? 0 : 1;
  const optionType = isCall ? { call: {} } : { put: {} };

  // Derive market PDA (create market if needed)
  const [marketPda] = deriveMarketPda(assetName, strike, expiry, typeIdx);

  // Try to create market (ignore error if it already exists)
  try {
    await program.methods
      .createMarket(assetName, strike, expiry, optionType, pythFeed, assetClass)
      .accountsStrict({
        creator: writerKeypair.publicKey,
        protocolState: protocolStatePda,
        market: marketPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([writerKeypair])
      .rpc();
    console.log("Market created.");
  } catch {
    console.log("Market already exists.");
  }

  // Derive position PDAs
  const createdAt = new BN(Math.floor(Date.now() / 1000));
  const [positionPda] = derivePositionPda(marketPda, writerKeypair.publicKey, createdAt);
  const [escrowPda] = deriveEscrowPda(marketPda, writerKeypair.publicKey, createdAt);
  const [optionMintPda] = deriveOptionMintPda(positionPda);
  const [purchaseEscrowPda] = derivePurchaseEscrowPda(positionPda);
  const { extraAccountMetaList, hookState } = deriveHookAccounts(optionMintPda);

  // Fetch USDC mint from protocol
  const protocol = await program.account.protocolState.fetch(protocolStatePda);

  const tx = await program.methods
    .writeOption(
      usdc(totalCollateral),
      usdc(totalPremium),
      new BN(contractSize),
      createdAt,
    )
    .accountsStrict({
      writer: writerKeypair.publicKey,
      protocolState: protocolStatePda,
      market: marketPda,
      position: positionPda,
      escrow: escrowPda,
      optionMint: optionMintPda,
      purchaseEscrow: purchaseEscrowPda,
      writerUsdcAccount: writerUsdcAccount,
      usdcMint: protocol.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([EXTRA_CU])
    .signers([writerKeypair])
    .rpc();

  console.log(`Option written! TX: ${tx}`);
  console.log(`Position: ${positionPda.toBase58()}`);
  console.log(`Mint: ${optionMintPda.toBase58()}`);

  return { positionPda, optionMintPda, marketPda };
}

// Usage:
// writeOptionAtFairValue(
//   writerKeypair, writerUsdcAta,
//   "SOL", 188, 200, 7, true, 10,
//   new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"), // Pyth SOL/USD
//   0, // crypto
// );
```

---

## Example 5: Simple Market Maker Loop

Continuously scan, price, and trade options.

```typescript
async function marketMakerLoop(
  agentKeypair: Keypair,
  agentUsdcAccount: PublicKey,
  spotPrices: Record<string, number>,
  config: {
    maxPositionSize: number;      // Max tokens per position
    minEdge: number;              // Minimum edge to trade ($)
    writeSpread: number;          // Spread for writing (e.g., 0.10 = 10%)
    loopIntervalMs: number;       // Milliseconds between loops
  },
) {
  console.log("=== Butter Options Market Maker ===");
  console.log(`Assets tracked: ${Object.keys(spotPrices).join(", ")}`);
  console.log(`Min edge: $${config.minEdge} | Write spread: ${(config.writeSpread * 100).toFixed(0)}%`);

  while (true) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const positions = await program.account.optionPosition.all();

      let buyCount = 0, skipCount = 0;

      for (const p of positions) {
        const pos = p.account;
        if (pos.isCancelled || pos.isExercised || pos.isExpired) continue;

        const market = await program.account.optionsMarket.fetch(pos.market);
        if (market.expiryTimestamp.toNumber() < now) continue;

        const spot = spotPrices[market.assetName];
        if (!spot) continue;

        const strike = market.strikePrice.toNumber() / 1e6;
        const days = (market.expiryTimestamp.toNumber() - now) / 86400;
        if (days < 1) continue; // Skip options expiring in < 1 day

        const vol = getVol(market.assetName);
        const isCall = !!market.optionType.call;
        const fairValue = isCall
          ? bsCallPremium(spot, strike, days, vol)
          : bsPutPremium(spot, strike, days, vol);

        // Check primary market
        const available = pos.totalSupply.toNumber() - pos.tokensSold.toNumber();
        if (available > 0) {
          const askPerToken = pos.premium.toNumber() / 1e6 / pos.totalSupply.toNumber();
          const edge = fairValue - askPerToken;

          if (edge >= config.minEdge) {
            const buyAmount = Math.min(available, config.maxPositionSize);
            console.log(`[BUY] ${market.assetName} $${strike} ${isCall ? "C" : "P"} — edge $${edge.toFixed(2)}, buying ${buyAmount}`);

            // Execute purchase (simplified — add full account setup in production)
            // ... purchaseOption call here ...
            buyCount++;
          } else {
            skipCount++;
          }
        }

        // Check resale market
        if (pos.isListedForResale && pos.resaleTokenAmount.toNumber() > 0) {
          const resaleAsk = pos.resalePremium.toNumber() / 1e6 / pos.resaleTokenAmount.toNumber();
          const resaleEdge = fairValue - resaleAsk;

          if (resaleEdge >= config.minEdge) {
            const buyAmount = Math.min(pos.resaleTokenAmount.toNumber(), config.maxPositionSize);
            console.log(`[BUY RESALE] ${market.assetName} $${strike} ${isCall ? "C" : "P"} — edge $${resaleEdge.toFixed(2)}, buying ${buyAmount}`);

            // Execute buy_resale here...
            buyCount++;
          }
        }
      }

      console.log(`[LOOP] Scanned ${positions.length} positions — ${buyCount} buys, ${skipCount} skipped`);

    } catch (err) {
      console.error("[ERROR]", err);
    }

    // Wait before next loop
    await new Promise(r => setTimeout(r, config.loopIntervalMs));
  }
}

// Usage:
// marketMakerLoop(
//   agentKeypair, agentUsdcAta,
//   { "SOL": 188, "BTC": 65000, "ETH": 3400 },
//   { maxPositionSize: 5, minEdge: 0.50, writeSpread: 0.10, loopIntervalMs: 30_000 },
// );
```

---

## Common Patterns

### Idempotent ATA Creation
Always use idempotent creation for Token-2022 ATAs:
```typescript
const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
const createIx = createAssociatedTokenAccountIdempotentInstruction(
  payer, ata, owner, mint, TOKEN_2022_PROGRAM_ID,
);
// Add as preInstruction — safe to call even if ATA already exists
```

### 800K Compute Units
Every option token transaction needs extra CU:
```typescript
const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
// Add with .preInstructions([EXTRA_CU]) on the method builder
```

### Hook Accounts for Transfers
Any instruction that transfers option tokens (not burns) needs these three extra accounts:
```typescript
const { extraAccountMetaList, hookState } = deriveHookAccounts(optionMint);
// Include in accountsStrict: transferHookProgram, extraAccountMetaList, hookState
```

### Confirmed Commitment
Always use confirmed commitment to avoid stale reads:
```typescript
const connection = new Connection(url, { commitment: "confirmed" });
```
