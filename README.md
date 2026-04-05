# Butter Options

A peer-to-peer, composable options protocol built on Solana.

**Colosseum Frontier Hackathon** (April 6 – May 11, 2026)

## 📖 Documentation

Full protocol documentation is available:
- **[Protocol Documentation](./docs/PROTOCOL.md)** — Complete technical docs covering architecture, instructions, security, pricing, and more

## What is Butter Options?

Butter Options is a decentralized options protocol where:

- **Writers** (sellers) lock USDC collateral to create option contracts
- **Buyers** pay a premium in USDC to purchase options
- **Settlement** happens at expiry using oracle prices
- **Cash-settled** — all settlements in USDC, no actual asset transfers
- **Any asset** — create markets for any token, stock, commodity, or forex pair with an oracle feed
- **Composable** — other Solana programs can integrate via CPI (Cross-Program Invocation)

## Supported Assets

The protocol supports **any asset** that has a Pyth oracle feed. Asset names are free-form strings (max 16 chars). Examples:

| Category | Assets |
|----------|--------|
| Crypto | SOL, BTC, ETH, BONK, JUP |
| Stocks | AAPL, TSLA, NVDA |
| Commodities | XAU (Gold), WTI (Oil) |
| Forex | EUR/USD, GBP/USD |

## Option Types

- **Calls** and **Puts**
- **European style** — exercise at expiry only
- **Cash-settled in USDC**
- **Multiple positions** — writers can create multiple options on the same market

## Tech Stack

| Component | Technology |
|-----------|------------|
| Smart Contracts | Rust / Anchor Framework |
| Frontend | React + TypeScript + Tailwind CSS v4 |
| Pricing Engine | Black-Scholes (client-side TypeScript) |
| Oracle | Pyth Network |
| Wallet | Solana Wallet Adapter (Phantom) |

## Project Structure

```
butter-options/
├── programs/butter-options/  # Anchor smart contract (8 instructions)
├── tests/                    # 29 integration tests
├── app/                      # React frontend
├── scripts/                  # Devnet setup scripts
├── cpi-examples/             # CPI integration guide + example code
├── sdk/                      # TypeScript SDK (WIP)
└── docs/                     # Documentation
```

## Smart Contract Instructions

| # | Instruction | Description |
|---|-------------|-------------|
| 1 | `initialize_protocol` | One-time setup — creates config + USDC treasury |
| 2 | `create_market` | Create an options market for any asset |
| 3 | `write_option` | Lock USDC collateral to sell an option |
| 4 | `buy_option` | Pay premium to purchase an option |
| 5 | `settle_market` | Set settlement price after expiry |
| 6 | `exercise_option` | Claim PnL after settlement |
| 7 | `expire_option` | Return collateral for unexercised options |
| 8 | `cancel_option` | Writer cancels unsold option |

## Key Features

- **Self-buy prevention** — writers cannot purchase their own options
- **Multiple positions per market** — writers can create unlimited options on the same market
- **Permissionless market creation** — anyone can create a market for any asset
- **Protocol fee** — 0.5% (50 bps) on premiums, sent to treasury
- **Escrow system** — each position has its own PDA-controlled USDC escrow

## Development Setup

### Prerequisites

- Rust 1.94+, Solana CLI 3.1+, Anchor 0.32+, Node.js 20+

### Quick Start

```bash
# Install dependencies
yarn install

# Build the program
anchor build

# Run tests (29 tests)
anchor test

# Run the frontend
cd app && npm install && npm run dev
```

## Deployment

- **Network:** Solana Devnet
- **Program ID:** `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq`
- **Tests:** 29/29 passing

## CPI Integration

Other Solana programs can call Butter Options via CPI. See [`cpi-examples/`](cpi-examples/) for:
- Plain English integration guide
- Fully commented Rust example code
- Complete technical specification (accounts, PDAs, error codes)

## License

MIT
