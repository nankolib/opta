# Butter Options — Program Reference

## Program IDs

| Program | Address |
|---------|---------|
| butter-options | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` |
| butter-transfer-hook | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` |

---

## Account Structures

### ProtocolState
Singleton account storing global protocol configuration.

| Field | Type | Description |
|-------|------|-------------|
| admin | Pubkey | Admin who initialized the protocol |
| fee_bps | u16 | Protocol fee in basis points (default: 50 = 0.50%) |
| treasury | Pubkey | Treasury PDA address |
| usdc_mint | Pubkey | USDC mint address |
| total_markets | u64 | Counter of markets created |
| total_volume | u64 | Total USDC volume (scaled 10^6) |
| bump | u8 | PDA bump |

**Seeds:** `["protocol_v2"]`

### OptionsMarket
Defines an options market for a specific asset/strike/expiry/type combination.

| Field | Type | Description |
|-------|------|-------------|
| asset_name | String (max 16) | Underlying asset ("SOL", "AAPL", "EUR/USD") |
| strike_price | u64 | Strike price in USDC (scaled 10^6) |
| expiry_timestamp | i64 | Unix timestamp of expiry |
| option_type | OptionType | `{ call: {} }` or `{ put: {} }` |
| is_settled | bool | Whether settlement price has been recorded |
| settlement_price | u64 | Settlement price in USDC (scaled 10^6, zero until settled) |
| pyth_feed | Pubkey | Pyth oracle price feed |
| asset_class | u8 | 0=crypto, 1=commodity, 2=equity, 3=forex, 4=ETF |
| bump | u8 | PDA bump |

**Seeds:** `["market", asset_name_bytes, strike_price(le8), expiry_timestamp(le8), option_type(u8)]`

### OptionPosition
Represents a single writer's option position with minted tokens.

| Field | Type | Description |
|-------|------|-------------|
| market | Pubkey | Parent market PDA |
| writer | Pubkey | Option writer's pubkey |
| option_mint | Pubkey | Token-2022 mint for this position's tokens |
| total_supply | u64 | Total tokens minted |
| tokens_sold | u64 | Tokens sold from primary purchase |
| collateral_amount | u64 | USDC locked in escrow (scaled 10^6) |
| premium | u64 | Total premium for ALL tokens (scaled 10^6) |
| contract_size | u64 | Number of contracts (= total_supply) |
| created_at | i64 | Unix timestamp (used as PDA seed) |
| is_exercised | bool | All tokens exercised |
| is_expired | bool | Marked expired after expiry |
| is_cancelled | bool | Writer cancelled (only if zero sold) |
| is_listed_for_resale | bool | Tokens currently listed on resale market |
| resale_premium | u64 | Total resale asking price (scaled 10^6) |
| resale_token_amount | u64 | Number of tokens listed for resale |
| resale_seller | Pubkey | Current resale seller |
| bump | u8 | PDA bump |

**Seeds:** `["position", market, writer, created_at(le8)]`

### HookState (Transfer Hook Program)
Per-mint state read by the transfer hook to decide allow/reject.

| Field | Type | Description |
|-------|------|-------------|
| expiry | i64 | Option expiry timestamp |
| protocol_state | Pubkey | Protocol PDA (escrow accounts owned by this) |
| bump | u8 | PDA bump |

**Seeds:** `["hook-state", mint]` (under butter-transfer-hook program)

---

## PDA Derivations (TypeScript)

```typescript
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

// ProtocolState
const [protocolStatePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("protocol_v2")],
  PROGRAM_ID,
);

// Treasury
const [treasuryPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("treasury_v2")],
  PROGRAM_ID,
);

// OptionsMarket
function deriveMarketPda(
  assetName: string, strike: BN, expiry: BN, optionTypeIndex: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      Buffer.from(assetName),
      strike.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([optionTypeIndex]), // 0=call, 1=put
    ],
    PROGRAM_ID,
  );
}

// OptionPosition
function derivePositionPda(
  market: PublicKey, writer: PublicKey, createdAt: BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      market.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
}

// USDC Escrow
function deriveEscrowPda(
  market: PublicKey, writer: PublicKey, createdAt: BN
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      market.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  );
}

// Option Mint (Token-2022)
function deriveOptionMintPda(position: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("option_mint"), position.toBuffer()],
    PROGRAM_ID,
  );
}

// Purchase Escrow (Token-2022)
function derivePurchaseEscrowPda(position: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("purchase_escrow"), position.toBuffer()],
    PROGRAM_ID,
  );
}

// Resale Escrow (Token-2022)
function deriveResaleEscrowPda(position: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("resale_escrow"), position.toBuffer()],
    PROGRAM_ID,
  );
}

// ExtraAccountMetaList (Transfer Hook)
function deriveExtraAccountMetaListPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
}

// HookState (Transfer Hook)
function deriveHookStatePda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), mint.toBuffer()],
    HOOK_PROGRAM_ID,
  );
}
```

---

## Instructions Reference

### 1. initialize_protocol
One-time protocol setup. Creates ProtocolState and Treasury.

**Parameters:** None
**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| admin | ✓ | ✓ | Protocol admin |
| protocol_state | ✓ | | PDA: `["protocol_v2"]` |
| treasury | ✓ | | PDA: `["treasury_v2"]` |
| usdc_mint | | | USDC mint address |
| system_program | | | `11111111111111111111111111111111` |
| token_program | | | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| rent | | | `SysvarRent111111111111111111111111111111111` |

### 2. create_market
Create an options market for any asset. Anyone can call.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| asset_name | string | 1-16 character asset name |
| strike_price | u64 | Strike in USDC (scaled 10^6) |
| expiry_timestamp | i64 | Unix timestamp (must be future) |
| option_type | OptionType | `{ call: {} }` or `{ put: {} }` |
| pyth_feed | Pubkey | Pyth oracle price feed |
| asset_class | u8 | 0-4 |

**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| creator | ✓ | ✓ | Market creator (pays rent) |
| protocol_state | ✓ | | PDA |
| market | ✓ | | PDA: `["market", ...]` |
| system_program | | | System program |

### 3. write_option
Lock collateral and mint option tokens. Requires 800K compute units.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| collateral_amount | u64 | USDC to lock (scaled 10^6) |
| premium | u64 | Total premium for all tokens (scaled 10^6) |
| contract_size | u64 | Number of tokens to mint |
| created_at | i64 | Unix timestamp (PDA seed) |

**Collateral requirements:**
- Call: `strike_price × 2 × contract_size` (scaled)
- Put: `strike_price × contract_size` (scaled)

**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| writer | ✓ | ✓ | Option writer |
| protocol_state | ✓ | | PDA |
| market | | | The target market |
| position | ✓ | | PDA: `["position", ...]` |
| escrow | ✓ | | PDA: `["escrow", ...]` (standard Token) |
| option_mint | ✓ | | PDA: `["option_mint", position]` (Token-2022) |
| purchase_escrow | ✓ | | PDA: `["purchase_escrow", position]` (Token-2022) |
| writer_usdc_account | ✓ | | Writer's USDC token account |
| usdc_mint | | | USDC mint |
| transfer_hook_program | | | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` |
| extra_account_meta_list | ✓ | | PDA under hook program |
| hook_state | ✓ | | PDA under hook program |
| system_program | | | System program |
| token_program | | | Standard SPL Token |
| token_2022_program | | | Token-2022 |
| rent | | | Rent sysvar |

### 4. purchase_option
Buy option tokens from purchase escrow. Partial fills supported.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| amount | u64 | Number of tokens to buy |

**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| buyer | ✓ | ✓ | Option buyer |
| protocol_state | ✓ | | PDA |
| market | | | The market |
| position | ✓ | | The position |
| purchase_escrow | ✓ | | Token-2022 escrow with unsold tokens |
| buyer_usdc_account | ✓ | | Buyer's USDC account |
| writer_usdc_account | ✓ | | Writer's USDC account (receives premium) |
| buyer_option_account | ✓ | | Buyer's Token-2022 ATA |
| option_mint | | | Token-2022 mint |
| treasury | ✓ | | Treasury PDA (receives fee) |
| token_program | | | Standard SPL Token |
| token_2022_program | | | Token-2022 |
| transfer_hook_program | | | Transfer hook program |
| extra_account_meta_list | | | Hook meta PDA |
| hook_state | | | Hook state PDA |
| system_program | | | System program |
| rent | | | Rent sysvar |

### 5. settle_market
Record settlement price after expiry. Admin-only (hackathon version).

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| settlement_price | u64 | Settlement price in USDC (scaled 10^6) |

**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| admin | ✓ | ✓ | Protocol admin |
| protocol_state | | | PDA |
| market | ✓ | | The market to settle |

### 6. exercise_option
Burn option tokens and claim PnL after settlement. No hook accounts needed (uses permanent delegate burn).

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| tokens_to_exercise | u64 | Number of tokens to burn |

**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| exerciser | ✓ | ✓ | Token holder |
| protocol_state | ✓ | | PDA |
| market | | | The settled market |
| position | ✓ | | The position |
| escrow | ✓ | | USDC escrow |
| option_mint | ✓ | | Token-2022 mint (supply decremented) |
| exerciser_option_account | ✓ | | Exerciser's Token-2022 account |
| exerciser_usdc_account | ✓ | | Receives PnL |
| writer_usdc_account | ✓ | | Receives remaining collateral |
| writer | ✓ | | Writer pubkey |
| token_program | | | Standard SPL Token |
| token_2022_program | | | Token-2022 |

### 7. expire_option
Return collateral for unexercised options. Anyone can call after expiry.

**Parameters:** None
**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| caller | ✓ | ✓ | Anyone |
| protocol_state | | | PDA |
| market | | | The expired market |
| position | ✓ | | The position |
| escrow | ✓ | | USDC escrow (closed) |
| writer_usdc_account | ✓ | | Receives collateral |
| writer | ✓ | | Writer pubkey |
| token_program | | | Standard SPL Token |

### 8. cancel_option
Writer cancels unsold option. Requires zero tokens sold.

**Parameters:** None
**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| writer | ✓ | ✓ | The option writer |
| protocol_state | | | PDA |
| position | ✓ | | The position |
| escrow | ✓ | | USDC escrow (closed) |
| purchase_escrow | ✓ | | Token-2022 escrow (tokens burned) |
| option_mint | ✓ | | Token-2022 mint |
| writer_usdc_account | ✓ | | Receives collateral back |
| token_program | | | Standard SPL Token |
| token_2022_program | | | Token-2022 |

### 9. list_for_resale
List owned option tokens on P2P resale market.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| resale_premium | u64 | Total asking price for all listed tokens (scaled 10^6) |
| token_amount | u64 | Number of tokens to list |

**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| seller | ✓ | ✓ | Token holder listing for resale |
| protocol_state | | | PDA |
| position | ✓ | | The position |
| seller_option_account | ✓ | | Seller's Token-2022 account |
| resale_escrow | ✓ | | PDA: `["resale_escrow", position]` |
| option_mint | | | Token-2022 mint |
| token_2022_program | | | Token-2022 |
| transfer_hook_program | | | Transfer hook program |
| extra_account_meta_list | | | Hook meta PDA |
| hook_state | | | Hook state PDA |
| system_program | | | System program |
| rent | | | Rent sysvar |

### 10. buy_resale
Buy tokens from resale listing. Partial fills supported.

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| amount | u64 | Number of tokens to buy |

**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| buyer | ✓ | ✓ | Buyer |
| protocol_state | ✓ | | PDA |
| position | ✓ | | The position |
| resale_escrow | ✓ | | Token-2022 escrow |
| buyer_usdc_account | ✓ | | Buyer's USDC account |
| seller_usdc_account | ✓ | | Seller's USDC account |
| buyer_option_account | ✓ | | Buyer's Token-2022 ATA |
| option_mint | | | Token-2022 mint |
| treasury | ✓ | | Treasury PDA |
| token_program | | | Standard SPL Token |
| token_2022_program | | | Token-2022 |
| transfer_hook_program | | | Transfer hook program |
| extra_account_meta_list | | | Hook meta PDA |
| hook_state | | | Hook state PDA |
| system_program | | | System program |
| rent | | | Rent sysvar |

### 11. cancel_resale
Cancel resale listing, return tokens to seller.

**Parameters:** None
**Accounts:**
| Name | Writable | Signer | Description |
|------|----------|--------|-------------|
| seller | ✓ | ✓ | The resale seller |
| protocol_state | | | PDA |
| position | ✓ | | The position |
| resale_escrow | ✓ | | Token-2022 escrow |
| seller_option_account | ✓ | | Seller's Token-2022 account |
| option_mint | | | Token-2022 mint |
| token_2022_program | | | Token-2022 |
| transfer_hook_program | | | Transfer hook program |
| extra_account_meta_list | | | Hook meta PDA |
| hook_state | | | Hook state PDA |

---

## Events

| Event | Fields | Emitted By |
|-------|--------|------------|
| OptionWritten | market, writer, position, option_mint, premium, collateral, contract_size | write_option |
| OptionPurchased | market, position, buyer, premium, fee | purchase_option |
| OptionExercised | position, exerciser, settlement_price, pnl, tokens_burned, profitable | exercise_option |
| OptionExpired | position | expire_option |
| OptionCancelled | position | cancel_option |
| MarketSettled | market, settlement_price | settle_market |
| OptionListedForResale | position, seller, resale_premium | list_for_resale |
| OptionResold | position, seller, buyer, resale_premium, fee | buy_resale |
| ResaleCancelled | position, seller | cancel_resale |

---

## Transfer Hook Logic

The transfer hook program (`83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG`) is called automatically by Token-2022 on every `transfer_checked` of an option token.

**Decision logic:**
1. If `clock.unix_timestamp < hook_state.expiry` → **ALLOW** (option still active)
2. If expired:
   - If source or destination account owner is `hook_state.protocol_state` → **ALLOW** (protocol escrow operation)
   - Otherwise → **REJECT** with `OptionExpired` error (user-to-user transfer of expired option blocked)

This ensures expired tokens can still be exercised (protocol burns them) but cannot be traded peer-to-peer.
