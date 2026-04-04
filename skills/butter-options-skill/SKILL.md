---
name: butter-options
description: Interact with the Butter Options protocol on Solana — read, price, and trade Living Option Tokens (Token-2022) for any asset class (crypto, commodities, equities, forex, ETFs)
license: MIT
metadata:
  author: butter-options
  version: "1.0.0"
  network: devnet
tags:
  - options
  - defi
  - token-2022
  - derivatives
  - black-scholes
  - solana
---

# Butter Options Agent Skill

Butter Options is a Solana options protocol that turns every option contract into a **Living Option Token** — a Token-2022 SPL token with transfer hook, permanent delegate, and on-chain metadata. Whoever holds the token can exercise it. Agents can read option terms directly from the token, price them with Black-Scholes, and trade them programmatically.

## Use / Do Not Use

**Use when:** user wants to trade options on Solana, price derivatives, write covered options, scan for underpriced options, build a market maker, read option token metadata, or interact with the Butter Options devnet deployment.

**Do not use when:** user wants spot token swaps (use Jupiter), lending/borrowing (use Drift), or NFT operations.

**Triggers:** options, calls, puts, strike price, expiry, premium, Black-Scholes, greeks, delta, theta, write option, exercise, collateral, option token

---

## 1. Program IDs

| Program | Address | Network |
|---------|---------|---------|
| butter-options | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` | Devnet |
| butter-transfer-hook | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` | Devnet |

**USDC Mint (Devnet):** Use the USDC mint stored in `protocolState.usdcMint` after fetching the protocol account.

---

## 2. Key Concepts

### Options Basics
- **Call option:** Right to profit if asset price rises above strike price
- **Put option:** Right to profit if asset price falls below strike price
- **Strike price:** The target price, scaled by 10^6 (USDC decimals)
- **Expiry:** Unix timestamp after which the option can be settled
- **Premium:** The price paid to buy the option, scaled by 10^6
- **European-style:** Options can only be exercised after settlement, not before expiry

### The Living Option Token
Each option position mints Token-2022 tokens with three extensions:
1. **Transfer Hook** — Routes every transfer through the hook program, which blocks user-to-user transfers after expiry
2. **Permanent Delegate** — The protocol PDA can burn tokens from any holder (for exercise/cancel)
3. **Metadata Pointer** — Option terms (asset, strike, expiry, type) stored directly on the mint as Token-2022 metadata

**Symbol:** `bOPT`
**Name format:** `BUTTER-{ASSET}-{STRIKE}{C/P}-{MONTH}{DAY}` (e.g., `BUTTER-SOL-200C-APR15`)
**Decimals:** 0 (whole number contracts)

### Isolated Escrow
Every option position has its own USDC collateral escrow — no shared vaults. This means:
- Writer collateral is never commingled
- Exercise pays out from the position's own escrow
- No risk of one position affecting another

### Asset Classes
| Value | Class | Default Volatility |
|-------|-------|--------------------|
| 0 | Crypto | 80% |
| 1 | Commodity | 20-35% |
| 2 | Equity | 40% |
| 3 | Forex | 10% |
| 4 | ETF | 30% |

### Token Program Rules
- **USDC** uses `TOKEN_PROGRAM_ID` (standard SPL Token: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
- **Option tokens** use `TOKEN_2022_PROGRAM_ID` (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)
- Every transaction involving option tokens needs **800,000 compute units**
- Use `createAssociatedTokenAccountIdempotentInstruction` for ATAs (not `createAssociatedTokenAccount`)
- Transfer hook accounts (`extraAccountMetaList`, `hookState`, `transferHookProgram`) must be included for all Token-2022 transfers (not burns)

---

## 3. Reading Option Tokens

### Fetch All Option Positions
```typescript
const positions = await program.account.optionPosition.all();
for (const pos of positions) {
  const market = await program.account.optionsMarket.fetch(pos.account.market);
  console.log(`${market.assetName} ${market.optionType.call ? "CALL" : "PUT"}`);
  console.log(`  Strike: $${pos.account.premium.toNumber() / 1e6}`);
  console.log(`  Expiry: ${new Date(market.expiryTimestamp.toNumber() * 1000)}`);
  console.log(`  Supply: ${pos.account.totalSupply.toNumber()}`);
  console.log(`  Sold: ${pos.account.tokensSold.toNumber()}`);
}
```

### Read Token Metadata from Mint
Option terms are stored as Token-2022 metadata on the mint account. See [references/token-metadata.md](references/token-metadata.md) for parsing code.

Key metadata fields:
| Key | Value Example | Description |
|-----|---------------|-------------|
| `asset_name` | `"SOL"` | Underlying asset |
| `asset_class` | `"0"` | Asset class enum value |
| `strike_price` | `"200000000"` | Strike in USDC (scaled 10^6) |
| `expiry` | `"1713196800"` | Unix timestamp |
| `option_type` | `"call"` or `"put"` | Option direction |
| `pyth_feed` | `"<base58>"` | Pyth oracle address |
| `collateral_per_token` | `"400000000"` | USDC collateral per token |
| `market_pda` | `"<base58>"` | Parent market PDA |

### Determine Option Status
```typescript
const now = Math.floor(Date.now() / 1000);
const pos = await program.account.optionPosition.fetch(positionPda);
const market = await program.account.optionsMarket.fetch(pos.market);

if (pos.isCancelled) status = "cancelled";
else if (pos.isExercised) status = "exercised";
else if (pos.isExpired) status = "expired";
else if (market.isSettled) status = "settled (awaiting exercise)";
else if (market.expiryTimestamp.toNumber() < now) status = "expired (awaiting settlement)";
else status = "active";
```

---

## 4. Pricing Options

Use Black-Scholes to calculate fair value. See [references/pricing.md](references/pricing.md) for the full implementation.

### Quick Price Check
```typescript
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility } from "./blackScholes";

const spot = 188;      // Current SOL price from Pyth
const strike = 200;    // Strike price
const days = 7;        // Days to expiry
const vol = getDefaultVolatility("SOL"); // 0.8 for crypto

const fairValue = calculateCallPremium(spot, strike, days, vol);
// Compare: if asking premium < fairValue → underpriced → buy opportunity
```

### Greeks
- **Delta (Δ):** `N(d1)` for calls, `N(d1) - 1` for puts — price sensitivity
- **Gamma (Γ):** `N'(d1) / (S * σ * √T)` — delta sensitivity
- **Theta (Θ):** Time decay per day
- **Vega (ν):** `S * N'(d1) * √T` — volatility sensitivity

---

## 5. Trading Actions

### 5.1 Create a Market

Anyone can create an options market for any asset with a Pyth feed.

```typescript
const strikePrice = new BN(200 * 1e6);  // $200 USDC
const expiryTimestamp = new BN(Math.floor(Date.now() / 1000) + 30 * 24 * 3600); // 30 days
const optionType = { call: {} };  // or { put: {} }
const pythFeed = new PublicKey("..."); // Pyth price feed
const assetClass = 0; // crypto

const [marketPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("market"),
    Buffer.from("SOL"),
    strikePrice.toArrayLike(Buffer, "le", 8),
    expiryTimestamp.toArrayLike(Buffer, "le", 8),
    Buffer.from([0]), // 0=call, 1=put
  ],
  PROGRAM_ID,
);

await program.methods
  .createMarket("SOL", strikePrice, expiryTimestamp, optionType, pythFeed, assetClass)
  .accountsStrict({
    creator: wallet.publicKey,
    protocolState: protocolStatePda,
    market: marketPda,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

### 5.2 Write an Option

Lock USDC collateral and mint option tokens. Collateral requirements:
- **Call:** `strike × 2 × contractSize` (2x coverage)
- **Put:** `strike × contractSize` (1x coverage)

```typescript
const createdAt = new BN(Math.floor(Date.now() / 1000));
const collateral = new BN(4000 * 1e6);  // $4,000 for 10 call contracts at $200
const premium = new BN(10 * 1e6);       // $10 total ($1 per contract)
const contractSize = new BN(10);

const [positionPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("position"), marketPda.toBuffer(), writer.publicKey.toBuffer(),
   createdAt.toArrayLike(Buffer, "le", 8)],
  PROGRAM_ID,
);
const [escrowPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("escrow"), marketPda.toBuffer(), writer.publicKey.toBuffer(),
   createdAt.toArrayLike(Buffer, "le", 8)],
  PROGRAM_ID,
);
const [optionMintPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("option_mint"), positionPda.toBuffer()], PROGRAM_ID,
);
const [purchaseEscrowPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("purchase_escrow"), positionPda.toBuffer()], PROGRAM_ID,
);
const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
  [Buffer.from("extra-account-metas"), optionMintPda.toBuffer()], HOOK_PROGRAM_ID,
);
const [hookState] = PublicKey.findProgramAddressSync(
  [Buffer.from("hook-state"), optionMintPda.toBuffer()], HOOK_PROGRAM_ID,
);

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

await program.methods
  .writeOption(collateral, premium, contractSize, createdAt)
  .accountsStrict({
    writer: writer.publicKey,
    protocolState: protocolStatePda,
    market: marketPda,
    position: positionPda,
    escrow: escrowPda,
    optionMint: optionMintPda,
    purchaseEscrow: purchaseEscrowPda,
    writerUsdcAccount: writerUsdcAta,
    usdcMint: usdcMint,
    transferHookProgram: HOOK_PROGRAM_ID,
    extraAccountMetaList,
    hookState,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  })
  .preInstructions([EXTRA_CU])
  .signers([writer])
  .rpc();
```

### 5.3 Purchase an Option

Buy option tokens from the purchase escrow. Supports partial fills.

```typescript
const amount = new BN(5); // Buy 5 of 10 available tokens

// Create buyer's Token-2022 ATA for the option mint (idempotent)
const buyerOptionAta = getAssociatedTokenAddressSync(
  optionMintPda, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID,
);
const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
  buyer.publicKey, buyerOptionAta, buyer.publicKey, optionMintPda, TOKEN_2022_PROGRAM_ID,
);

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

await program.methods
  .purchaseOption(amount)
  .accountsStrict({
    buyer: buyer.publicKey,
    protocolState: protocolStatePda,
    market: marketPda,
    position: positionPda,
    purchaseEscrow: purchaseEscrowPda,
    buyerUsdcAccount: buyerUsdcAta,
    writerUsdcAccount: writerUsdcAta,
    buyerOptionAccount: buyerOptionAta,
    optionMint: optionMintPda,
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
  .signers([buyer])
  .rpc();
```

**Premium calculation:** `premium × amount / totalSupply`
**Fee:** `premium × 50 / 10000` (0.50% protocol fee)

### 5.4 List for Resale

List owned option tokens on the P2P resale market.

```typescript
const resalePremium = new BN(15 * 1e6); // $15 total asking price
const tokenAmount = new BN(5);           // List all 5 tokens

const [resaleEscrowPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("resale_escrow"), positionPda.toBuffer()], PROGRAM_ID,
);

await program.methods
  .listForResale(resalePremium, tokenAmount)
  .accountsStrict({
    seller: seller.publicKey,
    protocolState: protocolStatePda,
    position: positionPda,
    sellerOptionAccount: sellerOptionAta,
    resaleEscrow: resaleEscrowPda,
    optionMint: optionMintPda,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    transferHookProgram: HOOK_PROGRAM_ID,
    extraAccountMetaList,
    hookState,
    systemProgram: SystemProgram.programId,
    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  })
  .preInstructions([EXTRA_CU])
  .signers([seller])
  .rpc();
```

### 5.5 Buy from Resale

Buy tokens from a resale listing. Supports partial fills.

```typescript
const amount = new BN(3); // Buy 3 of 5 listed tokens

await program.methods
  .buyResale(amount)
  .accountsStrict({
    buyer: buyer.publicKey,
    protocolState: protocolStatePda,
    position: positionPda,
    resaleEscrow: resaleEscrowPda,
    buyerUsdcAccount: buyerUsdcAta,
    sellerUsdcAccount: sellerUsdcAta,
    buyerOptionAccount: buyerOptionAta,
    optionMint: optionMintPda,
    treasury: treasuryPda,
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    transferHookProgram: HOOK_PROGRAM_ID,
    extraAccountMetaList,
    hookState,
    systemProgram: SystemProgram.programId,
    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  })
  .preInstructions([EXTRA_CU])
  .signers([buyer])
  .rpc();
```

**Price calculation:** `resalePremium × amount / resaleTokenAmount`

### 5.6 Cancel Resale

Only the original seller can cancel.

```typescript
await program.methods
  .cancelResale()
  .accountsStrict({
    seller: seller.publicKey,
    protocolState: protocolStatePda,
    position: positionPda,
    resaleEscrow: resaleEscrowPda,
    sellerOptionAccount: sellerOptionAta,
    optionMint: optionMintPda,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    transferHookProgram: HOOK_PROGRAM_ID,
    extraAccountMetaList,
    hookState,
  })
  .preInstructions([EXTRA_CU])
  .signers([seller])
  .rpc();
```

### 5.7 Exercise an Option

After the market is settled, burn option tokens to claim PnL.

**PnL calculation:**
- **Call:** `max(0, settlementPrice - strikePrice) × tokensToExercise`
- **Put:** `max(0, strikePrice - settlementPrice) × tokensToExercise`
- Capped at proportional collateral: `collateral × tokensToExercise / totalSupply`

```typescript
const tokensToExercise = new BN(5);

await program.methods
  .exerciseOption(tokensToExercise)
  .accountsStrict({
    exerciser: exerciser.publicKey,
    protocolState: protocolStatePda,
    market: marketPda,
    position: positionPda,
    escrow: escrowPda,
    optionMint: optionMintPda,
    exerciserOptionAccount: exerciserOptionAta,
    exerciserUsdcAccount: exerciserUsdcAta,
    writerUsdcAccount: writerUsdcAta,
    writer: writerPubkey,
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
  })
  .signers([exerciser])
  .rpc();
```

Note: Exercise uses permanent delegate to burn tokens — no transfer hook accounts needed.

### 5.8 Cancel an Option

Writer cancels an unsold option (zero tokens sold). Burns all tokens, returns collateral.

```typescript
await program.methods
  .cancelOption()
  .accountsStrict({
    writer: writer.publicKey,
    protocolState: protocolStatePda,
    position: positionPda,
    escrow: escrowPda,
    purchaseEscrow: purchaseEscrowPda,
    optionMint: optionMintPda,
    writerUsdcAccount: writerUsdcAta,
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
  })
  .signers([writer])
  .rpc();
```

---

## 6. Market Making Strategy

### Scan → Price → Trade Loop

1. **Scan all positions:**
   ```typescript
   const positions = await program.account.optionPosition.all();
   const activePositions = positions.filter(p =>
     !p.account.isExercised && !p.account.isExpired && !p.account.isCancelled
   );
   ```

2. **Calculate fair value for each:**
   ```typescript
   for (const pos of activePositions) {
     const market = await program.account.optionsMarket.fetch(pos.account.market);
     const spot = await fetchPythPrice(market.pythFeed); // Get from Pyth
     const daysToExpiry = (market.expiryTimestamp.toNumber() - now) / 86400;
     const vol = getDefaultVolatility(market.assetName);

     const fairValue = market.optionType.call
       ? calculateCallPremium(spot, market.strikePrice.toNumber() / 1e6, daysToExpiry, vol)
       : calculatePutPremium(spot, market.strikePrice.toNumber() / 1e6, daysToExpiry, vol);

     const askingPrice = pos.account.premium.toNumber() / 1e6 / pos.account.totalSupply.toNumber();
     const edge = fairValue - askingPrice;
     if (edge > 0) console.log(`BUY opportunity: ${edge.toFixed(2)} edge per token`);
   }
   ```

3. **Buy underpriced:** Execute `purchaseOption` when `fairValue > askingPrice`
4. **Write at fair value + spread:** Execute `writeOption` with `premium = fairValue × 1.1 × contractSize`
5. **List for resale:** When held tokens appreciate, `listForResale` at `fairValue + spread`

### Risk Management
- Limit total positions per asset class
- Diversify across asset classes and expiry dates
- Monitor delta exposure across portfolio
- Set maximum premium per trade
- Exit positions (list for resale) when theta decay erodes value

---

## 7. Account Derivations (PDAs)

See [references/program-reference.md](references/program-reference.md) for full details.

| Account | Seeds | Program |
|---------|-------|---------|
| ProtocolState | `["protocol_v2"]` | butter-options |
| Treasury | `["treasury_v2"]` | butter-options |
| OptionsMarket | `["market", asset_name_bytes, strike(le8), expiry(le8), option_type(1)]` | butter-options |
| OptionPosition | `["position", market, writer, created_at(le8)]` | butter-options |
| USDC Escrow | `["escrow", market, writer, created_at(le8)]` | butter-options |
| Option Mint | `["option_mint", position]` | butter-options |
| Purchase Escrow | `["purchase_escrow", position]` | butter-options |
| Resale Escrow | `["resale_escrow", position]` | butter-options |
| ExtraAccountMetaList | `["extra-account-metas", mint]` | butter-transfer-hook |
| HookState | `["hook-state", mint]` | butter-transfer-hook |

All numeric seeds use **little-endian** byte encoding. `option_type` is 0 for Call, 1 for Put.

---

## 8. Important Rules for Agents

1. **Always set 800,000 compute units** for any transaction involving option tokens (write, purchase, resale, list, cancel resale)
2. **USDC = standard SPL Token**, option tokens = Token-2022 — never mix up the program IDs
3. **Create ATAs idempotently** — use `createAssociatedTokenAccountIdempotentInstruction`, not `createAssociatedTokenAccount`
4. **Include transfer hook accounts** (`extraAccountMetaList`, `hookState`, `transferHookProgram`) for Token-2022 transfers (purchase, list, buy resale, cancel resale) — but NOT for burns (exercise, cancel option)
5. **Expired options cannot be transferred** — the transfer hook blocks user-to-user transfers after expiry. Only protocol escrow operations are allowed
6. **Premium is total, not per-token** — when purchasing, the per-token cost is `premium × amount / totalSupply`
7. **Collateral is per-position** — each position has its own escrow, never shared
8. **All USDC values are scaled by 10^6** — `$200` = `200_000_000`
9. **Use confirmed commitment** — set `{ commitment: "confirmed" }` on the connection to avoid stale reads
10. **Cancel only works if zero tokens sold** — once any tokens are purchased, the position cannot be cancelled

---

## 9. Error Codes

| Code | Name | Meaning |
|------|------|---------|
| 6000 | AlreadyInitialized | Protocol already set up |
| 6001 | Unauthorized | Not the admin |
| 6002 | ExpiryInPast | Expiry timestamp is in the past |
| 6003 | InvalidStrikePrice | Strike price must be > 0 |
| 6004 | InvalidPythFeed | Invalid Pyth oracle address |
| 6005 | InvalidAssetName | Asset name empty or > 16 chars |
| 6006 | MarketNotExpired | Trying to settle before expiry |
| 6007 | MarketAlreadySettled | Market already has settlement price |
| 6008 | MarketNotSettled | Trying to exercise before settlement |
| 6009 | MarketExpired | Trying to buy from expired market |
| 6010 | InvalidSettlementPrice | Settlement price must be > 0 |
| 6011 | PositionNotActive | Position already exercised/expired/cancelled |
| 6012 | InsufficientCollateral | Not enough USDC for collateral requirement |
| 6013 | InvalidContractSize | Contract size must be > 0 |
| 6014 | InvalidPremium | Premium must be > 0 |
| 6015 | NotWriter | Only the writer can cancel |
| 6016 | NotTokenHolder | No tokens to exercise |
| 6017 | CannotBuyOwnOption | Buyer cannot be the writer |
| 6018 | InsufficientOptionTokens | Not enough tokens available |
| 6019 | TokensAlreadySold | Cannot cancel — tokens already sold |
| 6020 | NotListedForResale | Position not listed |
| 6021 | AlreadyListedForResale | Already listed for resale |
| 6022 | NotResaleSeller | Only the resale seller can cancel |
| 6023 | CannotBuyOwnResale | Buyer cannot be the resale seller |
| 6024 | InvalidAssetClass | Asset class must be 0-4 |
| 6025 | MathOverflow | Arithmetic overflow |

**Transfer Hook Error:**
| 6000 | OptionExpired | Transfer blocked — option has expired |

---

## References

- [Program Reference](references/program-reference.md) — Full IDL, account layouts, instruction details
- [Pricing](references/pricing.md) — Black-Scholes implementation, Greeks, asset profiles
- [Token Metadata](references/token-metadata.md) — How to read Living Option Token metadata
- [Examples](references/examples.md) — Complete runnable TypeScript examples
