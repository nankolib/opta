# Butter Options — Integration Specification

## Program ID

```
CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq
```

Network: Solana Devnet (mainnet deployment TBD)

## PDA Derivation Formulas

### ProtocolState (singleton)
```
seeds = ["protocol_v2"]
```

### Treasury (USDC token account)
```
seeds = ["treasury_v2"]
```

### OptionsMarket
```
seeds = ["market", asset_name_bytes, strike_price_le_u64, expiry_timestamp_le_i64, option_type_u8]
```
- `asset_name_bytes`: UTF-8 bytes of the asset name string (e.g., `b"SOL"`)
- `strike_price_le_u64`: 8 bytes, little-endian u64 (USDC scaled by 10^6)
- `expiry_timestamp_le_i64`: 8 bytes, little-endian i64 (Unix timestamp)
- `option_type_u8`: 1 byte — `0` for Call, `1` for Put

### OptionPosition
```
seeds = ["position", market_pubkey, writer_pubkey, created_at_le_i64]
```
- `created_at_le_i64`: 8 bytes, little-endian i64 (Unix timestamp of creation)

### Escrow (USDC token account per position)
```
seeds = ["escrow", market_pubkey, writer_pubkey, created_at_le_i64]
```

## Account Structures

### ProtocolState
| Field | Type | Description |
|-------|------|-------------|
| admin | Pubkey | Protocol admin wallet |
| fee_bps | u16 | Fee in basis points (50 = 0.5%) |
| treasury | Pubkey | Treasury token account address |
| usdc_mint | Pubkey | USDC mint address |
| total_markets | u64 | Running market count |
| total_volume | u64 | Running USDC volume (scaled 10^6) |
| bump | u8 | PDA bump |

### OptionsMarket
| Field | Type | Description |
|-------|------|-------------|
| asset_name | String (max 16) | Asset identifier (e.g., "SOL", "BTC", "AAPL") |
| strike_price | u64 | Strike in USDC (scaled 10^6) |
| expiry_timestamp | i64 | Unix timestamp of expiry |
| option_type | OptionType | Call or Put |
| is_settled | bool | Whether settlement price has been set |
| settlement_price | u64 | Oracle price at settlement (scaled 10^6) |
| pyth_feed | Pubkey | Pyth price feed account |
| bump | u8 | PDA bump |

### OptionPosition
| Field | Type | Description |
|-------|------|-------------|
| market | Pubkey | The OptionsMarket this belongs to |
| writer | Pubkey | Writer (seller) wallet |
| buyer | Option\<Pubkey\> | Buyer wallet (None until purchased) |
| collateral_amount | u64 | USDC collateral locked (scaled 10^6) |
| premium | u64 | Premium price (scaled 10^6) |
| contract_size | u64 | Number of contracts (scaled 10^6) |
| created_at | i64 | Creation timestamp (also PDA seed) |
| is_purchased | bool | Has been bought |
| is_exercised | bool | Has been exercised |
| is_expired | bool | Has expired |
| is_cancelled | bool | Has been cancelled |
| bump | u8 | PDA bump |

### OptionType (enum)
```rust
pub enum OptionType {
    Call,  // discriminant 0
    Put,   // discriminant 1
}
```

## Instruction Signatures

### create_market
```
Args: asset_name: String, strike_price: u64, expiry_timestamp: i64, option_type: OptionType, pyth_feed: Pubkey
Accounts: creator (signer, mut), protocol_state (mut), market (init), system_program
```

### write_option
```
Args: collateral_amount: u64, premium: u64, contract_size: u64, created_at: i64
Accounts: writer (signer, mut), protocol_state, market, position (init), escrow (init), writer_token_account (mut), usdc_mint, system_program, token_program, rent
```

### buy_option
```
Args: (none)
Accounts: buyer (signer, mut), protocol_state (mut), market, position (mut), buyer_token_account (mut), writer_token_account (mut), treasury (mut), token_program
```

### settle_market
```
Args: settlement_price: u64
Accounts: admin (signer), protocol_state, market (mut)
```

### exercise_option
```
Args: (none)
Accounts: buyer (signer, mut), protocol_state (mut), market, position (mut), escrow (mut), buyer_token_account (mut), writer_token_account (mut), writer (mut), token_program
```

### expire_option
```
Args: (none)
Accounts: caller (signer, mut), protocol_state, market, position (mut), escrow (mut), writer_token_account (mut), writer (mut), token_program
```

### cancel_option
```
Args: (none)
Accounts: writer (signer, mut), protocol_state, position (mut), escrow (mut), writer_token_account (mut), token_program
```

## Collateral Requirements

| Option Type | Minimum Collateral |
|-------------|-------------------|
| **Put** | `strike_price * contract_size / 10^6` |
| **Call** | `2 * strike_price * contract_size / 10^6` |

## PnL Calculation

| Option Type | PnL Formula |
|-------------|-------------|
| **Call** | `max(0, (settlement_price - strike_price)) * contract_size / 10^6` |
| **Put** | `max(0, (strike_price - settlement_price)) * contract_size / 10^6` |

PnL is capped at the collateral amount.

## Fee Structure

- Fee: `premium * fee_bps / 10_000`
- Default fee_bps: 50 (0.5%)
- Fee goes to the treasury
- Writer receives: `premium - fee`

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | AlreadyInitialized | Protocol already set up |
| 6001 | Unauthorized | Not the admin |
| 6002 | ExpiryInPast | Expiry must be future |
| 6003 | InvalidStrikePrice | Strike must be > 0 |
| 6004 | InvalidPythFeed | Zero pubkey not allowed |
| 6005 | InvalidAssetName | Must be 1-16 chars |
| 6006 | MarketNotExpired | Action requires expired market |
| 6007 | MarketAlreadySettled | Can't settle twice |
| 6008 | MarketNotSettled | Exercise requires settlement |
| 6009 | MarketExpired | Can't write/buy on expired market |
| 6010 | InvalidSettlementPrice | Must be > 0 |
| 6011 | PositionAlreadyPurchased | Already bought |
| 6012 | PositionNotPurchased | Not yet bought |
| 6013 | PositionNotActive | Already settled/cancelled |
| 6014 | InsufficientCollateral | Below minimum |
| 6015 | InvalidContractSize | Must be > 0 |
| 6016 | InvalidPremium | Must be > 0 |
| 6017 | NotWriter | Wrong signer |
| 6018 | NotBuyer | Wrong signer |
| 6019 | CannotBuyOwnOption | Self-buy not allowed |
| 6020 | MathOverflow | Arithmetic overflow |
