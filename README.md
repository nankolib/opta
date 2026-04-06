# Butter Options

**The first living financial instrument on any blockchain.**

Butter Options is a permissionless, any-asset options protocol on Solana featuring the Living Option Token — a self-expiring, self-describing financial instrument built on Token-2022.

## What Makes This Different

- **Living Option Token**: Token-2022 TransferHook (enforces expiry), PermanentDelegate (auto-burn), MetadataExtension (on-chain term sheet). The token knows its own terms, enforces its own lifecycle, and self-destructs at settlement.
- **Any Asset**: Permissionless support for any Pyth-priced asset — crypto, commodities, equities, forex, tokenized funds.
- **Isolated Escrow**: Every option has its own PDA escrow. No shared pool. Structurally immune to pool-drain exploits.
- **Built-in Secondary Market**: P2P marketplace with list/buy/cancel resale. Three-price discovery (B-S fair value, writer premium, market price).
- **Asset-Class-Aware Pricing**: 5 Black-Scholes profiles (crypto, commodity, equity, forex, tokenized fund) with realized vol from Pyth, jump risk premium, and continuous time decay.
- **CPI Composable**: All 11 instructions callable by other Solana programs.
- **AI-Readable**: Token metadata enables agents to read, price, and trade options with zero integration.

## Architecture

| Component | Details |
|-----------|---------|
| Main Program | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` |
| Transfer Hook | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` |
| Framework | Anchor 0.32.1 |
| Token Standard | SPL Token-2022 v8.0.1 |
| Oracle | Pyth Network |
| Settlement | European-style, USDC-only |
| Tests | 27/27 passing |

## Instructions

1. `initialize_protocol` — One-time setup
2. `create_market` — Create options market for any Pyth asset
3. `write_option` — Lock USDC collateral, mint Living Option Tokens
4. `purchase_option` — Buy options, partial fills supported
5. `settle_market` — Set settlement price from Pyth after expiry
6. `exercise_option` — Burn tokens, receive USDC payout (ITM)
7. `expire_option` — Return collateral to writer (OTM)
8. `cancel_option` — Writer cancels unsold position
9. `list_for_resale` — List tokens on secondary market
10. `buy_resale` — Purchase resale listing
11. `cancel_resale` — Withdraw resale listing

## Run Locally
```bash
# Smart contract tests
cd programs/butter-options
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
