# Butter Options

**The first living financial instrument on any blockchain.**

Butter Options is a permissionless, any-asset options protocol on Solana featuring the Living Option Token — a self-expiring, self-describing financial instrument built on Token-2022.

## What Makes This Different

- **Living Option Token**: Token-2022 with TransferHook (enforces expiry), PermanentDelegate (auto-burn), MetadataPointer (on-chain term sheet). The token knows its own terms, enforces its own lifecycle, and self-destructs at settlement.
- **Any Asset**: Permissionless support for any Pyth-priced asset — crypto, commodities, equities, forex, tokenized funds. 5 asset classes with class-aware volatility profiles.
- **On-Chain Black-Scholes**: Full pricing engine via solmath computing fair value + 5 Greeks (delta, gamma, vega, theta, rho) directly on Solana (~50K CU).
- **Shared Vault Liquidity (V2)**: Pooled collateral vaults with proportional shares, automated premium distribution, and post-settlement withdrawal — DeFi-native liquidity alongside isolated P2P positions.
- **Built-in Secondary Market**: P2P marketplace with list/buy/cancel resale. Three-price discovery (B-S fair value, writer premium, market price).
- **CPI Composable**: All 24 instructions callable by other Solana programs.
- **AI-Readable**: Token metadata enables agents to read, price, and trade options with zero integration.

## Architecture

| Component | Details |
|-----------|---------|
| Main Program | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` |
| Transfer Hook | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` |
| Framework | Anchor 0.32.1 |
| Token Standard | SPL Token-2022 v8.0.1 |
| Oracle | Pyth Network |
| Pricing | solmath on-chain Black-Scholes with 5 Greeks |
| Settlement | European-style, USDC-only |
| Tests | 95 passing across 6 test suites |
| Security | 5 audit rounds, 18 findings fixed, 0 remaining |

## Instructions (24)

### Core Protocol (13)
1. `initialize_protocol` — One-time setup: admin, treasury, fee config
2. `create_market` — Create options market for any Pyth asset with asset class
3. `write_option` — Lock USDC collateral, mint Living Option Tokens (Token-2022 with 3 extensions)
4. `purchase_option` — Buy options from escrow, partial fills supported
5. `settle_market` — Set settlement price after expiry
6. `exercise_option` — Burn tokens, receive USDC payout (ITM only)
7. `expire_option` — Return collateral to writer (OTM only, post-settlement)
8. `cancel_option` — Writer cancels and burns unsold tokens
9. `list_for_resale` — List tokens on P2P secondary market
10. `buy_resale` — Purchase resale listing with slippage protection
11. `cancel_resale` — Withdraw resale listing
12. `initialize_pricing` — Create on-chain PricingData PDA (permissionless)
13. `update_pricing` — Compute Black-Scholes + Greeks on-chain via solmath (Pyth or parameter mode)

### Shared Vault System (11)
14. `initialize_epoch_config` — Configure epoch schedule (weekly/monthly expiry cycles)
15. `create_shared_vault` — Create pooled collateral vault for an option spec
16. `deposit_to_vault` — Deposit USDC collateral, receive proportional shares
17. `mint_from_vault` — Mint option tokens from vault share
18. `purchase_from_vault` — Buy vault-minted options with slippage protection
19. `burn_unsold_from_vault` — Burn unsold tokens, free committed collateral
20. `withdraw_from_vault` — Withdraw uncommitted collateral
21. `claim_premium` — Claim earned premium from vault
22. `settle_vault` — Settle vault after market settlement
23. `exercise_from_vault` — Exercise vault-minted tokens post-settlement
24. `withdraw_post_settlement` — Writer withdraws remaining collateral after settlement

## Token-2022 Extensions

Every option mint is created with three extensions:

| Extension | Purpose |
|-----------|---------|
| **TransferHook** | Blocks user-to-user transfers after expiry. Enforced by the transfer hook program on every transfer. |
| **PermanentDelegate** | Allows the protocol PDA to burn tokens from any holder at settlement. |
| **MetadataPointer** | Points to on-chain token metadata containing the full option term sheet (asset, strike, expiry, type). |

## On-Chain Pricing

The protocol computes Black-Scholes pricing and Greeks entirely on-chain:

- **Fair value** per option token in USDC
- **Delta** (price sensitivity), **Gamma** (delta rate of change)
- **Vega** (volatility sensitivity), **Theta** (daily time decay)
- Two modes: **Pyth oracle** (production) reads live price feeds; **Parameter** (testing) accepts caller-provided spot price
- Asset-class-aware volatility with EWMA and smile adjustments

## Frontend

Deribit-style options chain grid with live pricing:

- **Trade** — 11-column options chain (IV, Delta, Bid, Ask, Vol per side) grouped by asset and expiry
- **Write** — Dedicated option writing with B-S suggested premium
- **Portfolio** — Manage positions: exercise, expire, cancel resale, claim premium
- **Markets** — Browse all active markets
- **Docs** — Protocol documentation

Live spot prices via CoinGecko/Jupiter with static fallbacks for non-crypto assets.

## Tests

95 test cases across 6 files:

| Suite | Tests | Coverage |
|-------|-------|----------|
| `butter-options.ts` | 36 | Core lifecycle: write, purchase, exercise, expire, cancel, resale |
| `pricing.ts` | 19 | On-chain B-S, Greeks, Pyth oracle, parameter mode |
| `shared-vaults.ts` | 23 | Vault deposit, mint, purchase, settle, exercise, withdraw |
| `zzz-audit-fixes.ts` | 12 | All audit finding regressions |
| `poc-C1-expire-before-settle.ts` | 3 | Exploit PoC (blocked) |
| `token2022-smoke.ts` | 2 | Token-2022 extension verification |

## Security

5 rounds of security audit completed. 18 findings identified and fixed, 0 remaining.

| Round | Findings | Status |
|-------|----------|--------|
| Initial audit | C-01 (Critical), M-01 (Medium), L-01 (Low) | All fixed |
| Re-audit | CRITICAL-01, HIGH-01, MEDIUM-01, LOW-01 | All fixed |
| Rounds 3-5 | 11 additional findings | All fixed |

## Run Locally

```bash
# Smart contract tests (requires Solana CLI + Anchor 0.32.1)
anchor test

# Frontend
cd app
npm install
npm run dev
# Open http://localhost:5173
```

## Built With

Built entirely with Claude Code. Zero traditional developers.

Colosseum Frontier Hackathon — April 2026

## License

MIT
