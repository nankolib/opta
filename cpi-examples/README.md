# CPI Integration Guide — Butter Options

## What is CPI?

CPI stands for **Cross-Program Invocation** — it's how one Solana program calls another. Think of it like an API call between smart contracts.

Butter Options is designed to be **composable** — meaning other Solana programs (like Drift, Jupiter, or your own vault/strategy) can create markets, write options, buy options, and exercise them **programmatically**, without any human interaction.

## Why Would You Integrate?

| Use Case | How You'd Use Butter Options |
|----------|------------------------------|
| **Structured Products** | A vault program writes covered calls automatically, earning premium yield for depositors |
| **Hedging Engine** | A perps platform buys put options to hedge user positions during volatile markets |
| **Options Market Maker** | A bot program writes options at Black-Scholes fair prices, auto-managing inventory |
| **Portfolio Insurance** | A lending protocol buys puts on collateral assets to protect against liquidation cascades |
| **Yield Strategies** | An aggregator writes strangles/straddles across multiple strikes for systematic premium income |

## Step-by-Step Integration

### 1. Add Butter Options as a dependency

In your program's `Cargo.toml`:

```toml
[dependencies]
butter-options = { path = "../butter-options/programs/butter-options", features = ["cpi"] }
```

The `cpi` feature exposes all the instruction builders and account structs.

### 2. Import the types

```rust
use butter_options::cpi::accounts::*;
use butter_options::cpi::*;
use butter_options::state::*;
```

### 3. Call an instruction via CPI

For example, to create a market:

```rust
let cpi_program = ctx.accounts.butter_options_program.to_account_info();
let cpi_accounts = CreateMarket {
    creator: ctx.accounts.your_pda.to_account_info(),
    protocol_state: ctx.accounts.protocol_state.to_account_info(),
    market: ctx.accounts.market.to_account_info(),
    system_program: ctx.accounts.system_program.to_account_info(),
};
let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
butter_options::cpi::create_market(cpi_ctx, asset_name, strike, expiry, option_type, pyth_feed)?;
```

### 4. Derive PDAs correctly

Your program needs to derive the same PDAs that Butter Options expects. See `INTEGRATION-SPEC.md` for the exact PDA formulas.

### 5. Handle the signer

If your program's PDA is the "creator" or "writer", you need to sign the CPI with your PDA seeds:

```rust
let seeds = &[b"your_seed", &[your_bump]];
let signer_seeds = &[&seeds[..]];
let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
```

## Available Instructions

| Instruction | What It Does | Who Can Call |
|-------------|-------------|--------------|
| `create_market` | Create a new options market for any asset | Anyone |
| `write_option` | Lock USDC collateral and create an option for sale | Anyone |
| `buy_option` | Purchase an existing option by paying the premium | Anyone (except the writer) |
| `settle_market` | Set the settlement price after expiry | Admin (Pyth in production) |
| `exercise_option` | Claim PnL after settlement | The buyer only |
| `expire_option` | Return collateral for unexercised options | Anyone |
| `cancel_option` | Cancel an unsold option and reclaim collateral | The writer only |

## Full Technical Reference

See `INTEGRATION-SPEC.md` for complete details on:
- Program ID and all instruction signatures
- Account structures and their fields
- PDA derivation formulas
- Error codes
- Fee structure

## Example Code

See `src/example_integration.rs` for a fully commented Rust example showing how to call `create_market`, `write_option`, and `buy_option` via CPI.

## Questions?

Open an issue on the [GitHub repo](https://github.com/nankolib/butter_options).
