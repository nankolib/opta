# Butter Options — Token Metadata Reference

## How Living Option Token Metadata Works

Every Butter option token is a Token-2022 mint with the **MetadataPointer** extension. The metadata is stored directly on the mint account (not in a separate Metaplex account). This means any agent can read the option terms by fetching the mint and parsing the Token-2022 metadata.

### Token-2022 Extensions on Every Option Mint

1. **TransferHook** — Points to `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG`, blocks transfers after expiry
2. **PermanentDelegate** — Set to the protocol PDA, allows burning tokens from any holder during exercise/cancel
3. **MetadataPointer** — Points to the mint itself (self-referential), metadata stored on-chain

### Token Identity

| Field | Value |
|-------|-------|
| **Name** | `BUTTER-{ASSET}-{STRIKE}{C/P}-{MONTH}{DAY}` |
| **Symbol** | `bOPT` |
| **URI** | `""` (empty — all data is on-chain) |
| **Decimals** | `0` (whole number contracts) |

**Name examples:**
- `BUTTER-SOL-200C-APR15` — SOL $200 Call expiring April 15
- `BUTTER-AAPL-180P-MAY01` — AAPL $180 Put expiring May 1
- `BUTTER-EUR/USD-1.1C-JUN30` — EUR/USD 1.1 Call expiring June 30

---

## Metadata Fields

The following additional fields are stored as key-value pairs in the Token-2022 metadata:

| Key | Type | Example | Description |
|-----|------|---------|-------------|
| `asset_name` | string | `"SOL"` | Underlying asset name |
| `asset_class` | string | `"0"` | Asset class (0=crypto, 1=commodity, 2=equity, 3=forex, 4=ETF) |
| `strike_price` | string | `"200000000"` | Strike in USDC (scaled 10^6) |
| `expiry` | string | `"1713196800"` | Unix timestamp of expiry |
| `option_type` | string | `"call"` or `"put"` | Option direction |
| `pyth_feed` | string | `"7UVim...base58"` | Pyth oracle price feed address |
| `collateral_per_token` | string | `"400000000"` | USDC collateral backing each token (scaled 10^6) |
| `market_pda` | string | `"4xF3q...base58"` | Parent OptionsMarket PDA |

All values are stored as strings. Numeric values must be parsed with `parseInt()` or `new BN()`.

---

## Reading Metadata from a Mint Address

### Using @solana/spl-token

```typescript
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");

/**
 * Read all option terms from a Butter option token mint.
 * Returns null if the mint is not a Butter option token.
 */
async function readOptionMetadata(mintAddress: PublicKey) {
  // Fetch the raw mint account
  const accountInfo = await connection.getAccountInfo(mintAddress);
  if (!accountInfo || !accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return null; // Not a Token-2022 mint
  }

  // Use @solana/spl-token to parse Token-2022 metadata
  const { getTokenMetadata } = await import("@solana/spl-token");
  const metadata = await getTokenMetadata(connection, mintAddress, "confirmed", TOKEN_2022_PROGRAM_ID);

  if (!metadata) return null;

  // Parse the standard fields
  const result: any = {
    name: metadata.name,          // e.g., "BUTTER-SOL-200C-APR15"
    symbol: metadata.symbol,      // "bOPT"
    uri: metadata.uri,            // "" (empty)
  };

  // Parse additional fields from the metadata key-value pairs
  if (metadata.additionalMetadata) {
    for (const [key, value] of metadata.additionalMetadata) {
      result[key] = value;
    }
  }

  return result;
}

// Usage
const mint = new PublicKey("...");
const meta = await readOptionMetadata(mint);
if (meta) {
  console.log(`Token: ${meta.name}`);
  console.log(`Asset: ${meta.asset_name}`);
  console.log(`Strike: $${parseInt(meta.strike_price) / 1e6}`);
  console.log(`Expiry: ${new Date(parseInt(meta.expiry) * 1000).toISOString()}`);
  console.log(`Type: ${meta.option_type}`);
  console.log(`Collateral/token: $${parseInt(meta.collateral_per_token) / 1e6}`);
}
```

### Parsing the Human-Readable Name

```typescript
/**
 * Parse a Butter option token name into structured data.
 * Input: "BUTTER-SOL-200C-APR15"
 * Output: { asset: "SOL", strike: 200, type: "call", month: "APR", day: 15 }
 */
function parseOptionName(name: string) {
  const parts = name.split("-");
  if (parts[0] !== "BUTTER" || parts.length !== 4) return null;

  const asset = parts[1];
  const strikeStr = parts[2];
  const dateStr = parts[3];

  // Extract strike and type from "200C" or "1.1P"
  const typeChar = strikeStr.slice(-1);
  const strike = parseFloat(strikeStr.slice(0, -1));
  const optionType = typeChar === "C" ? "call" : "put";

  // Extract month and day from "APR15"
  const month = dateStr.slice(0, 3);
  const day = parseInt(dateStr.slice(3));

  return { asset, strike, optionType, month, day };
}
```

---

## Discovering All Butter Option Mints

### Method 1: Fetch all positions from the program

The most reliable way to find all option mints is through the Anchor program:

```typescript
import * as anchor from "@coral-xyz/anchor";

const program = /* your Anchor program instance */;
const positions = await program.account.optionPosition.all();

for (const pos of positions) {
  const mintAddress = pos.account.optionMint;
  const meta = await readOptionMetadata(mintAddress);
  console.log(meta);
}
```

### Method 2: Filter active/tradeable options

```typescript
const now = Math.floor(Date.now() / 1000);

const positions = await program.account.optionPosition.all();
const tradeable = [];

for (const pos of positions) {
  const p = pos.account;

  // Skip inactive positions
  if (p.isExercised || p.isExpired || p.isCancelled) continue;

  // Check if market is still active
  const market = await program.account.optionsMarket.fetch(p.market);
  if (market.expiryTimestamp.toNumber() < now) continue;

  // Calculate available tokens
  const availableFromPrimary = p.totalSupply.toNumber() - p.tokensSold.toNumber();
  const availableFromResale = p.isListedForResale ? p.resaleTokenAmount.toNumber() : 0;

  if (availableFromPrimary > 0 || availableFromResale > 0) {
    tradeable.push({
      position: pos.publicKey,
      mint: p.optionMint,
      market: p.market,
      asset: market.assetName,
      strike: market.strikePrice.toNumber() / 1e6,
      expiry: new Date(market.expiryTimestamp.toNumber() * 1000),
      type: market.optionType.call ? "call" : "put",
      premiumPerToken: p.premium.toNumber() / 1e6 / p.totalSupply.toNumber(),
      availablePrimary: availableFromPrimary,
      availableResale: availableFromResale,
      resalePricePerToken: availableFromResale > 0
        ? p.resalePremium.toNumber() / 1e6 / p.resaleTokenAmount.toNumber()
        : null,
    });
  }
}

console.log(`Found ${tradeable.length} tradeable options`);
```

---

## Metadata vs. Account Data

| Data Point | Where to Read | Why |
|------------|---------------|-----|
| Asset name, strike, expiry, type | Token metadata OR OptionsMarket account | Metadata is self-contained per token |
| Collateral per token | Token metadata | Calculated at write time |
| Tokens sold, available supply | OptionPosition account | Changes with each purchase |
| Settlement price | OptionsMarket account | Set after expiry |
| Resale status/price | OptionPosition account | Changes with list/buy/cancel |
| Option status (active/expired/etc.) | OptionPosition account | Boolean flags |

**Agent tip:** For a quick overview, read the token name. For full details, fetch the OptionPosition and OptionsMarket accounts.
