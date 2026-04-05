# Butter Options Protocol Documentation

> **Permissionless Options Infrastructure for Every Asset Class on Solana**

**Program ID:** `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq`
**Transfer Hook Program:** `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG`
**Network:** Solana Devnet (mainnet planned)
**Hackathon:** Colosseum Frontier (April 6 – May 11, 2026)

---

## Table of Contents

1. [What is Butter Options?](#1-what-is-butter-options)
2. [The Problem](#2-the-problem)
3. [The Solution](#3-the-solution)
4. [The Living Option Token](#4-the-living-option-token)
5. [Protocol Architecture](#5-protocol-architecture)
6. [The 11 Instructions](#6-the-11-instructions)
7. [Account Structure & PDAs](#7-account-structure--pdas)
8. [Permissionless Any-Asset Support](#8-permissionless-any-asset-support)
9. [Asset-Class-Aware Pricing](#9-asset-class-aware-pricing)
10. [Security Architecture](#10-security-architecture)
11. [Option Lifecycle](#11-option-lifecycle)
12. [CPI Composability](#12-cpi-composability)
13. [Fee Structure](#13-fee-structure)
14. [Technical Stack](#14-technical-stack)
15. [Test Coverage](#15-test-coverage)
16. [Roadmap](#16-roadmap)

---

## 1. What is Butter Options?

Butter Options is a permissionless, peer-to-peer options protocol built on Solana. It allows anyone to create, trade, and settle options on **any asset** that has a Pyth oracle price feed — including cryptocurrencies, commodities, equities, forex pairs, and tokenized funds like Ondo's OUSG.

The protocol introduces the **Living Option Token** — the first self-expiring financial instrument token on Solana. Built using Token-2022 extensions, each option token carries its full financial terms in on-chain metadata, enforces its own expiry through a transfer hook, and can be burned by the protocol through a permanent delegate.

**The token doesn't just represent an option — it behaves like one.**

---

## 2. The Problem

On-chain options on Solana have a troubled history. PsyOptions shut down. Zeta Markets abandoned options to focus on perpetuals. The fundamental problem is that existing protocols treated options like simple database entries — a row in a table that says "User A owns Call Option #42."

This creates three critical failures:

**Shared vault risk.** Protocols like Drift pool all user funds into a single vault. When that vault gets exploited, everyone loses everything. On April 1, 2025, Drift suffered a ~$270 million vault drain. This is not a theoretical risk — it is the defining failure mode of DeFi options.

**Non-composable positions.** If your option is just a database entry inside Protocol X, no other protocol can see it, price it, or interact with it. Your position is trapped inside one application.

**Static tokens that don't behave like options.** Even protocols that tokenize positions create "dumb receipt tokens" — the token has no idea what it represents. It doesn't know its strike price, its expiry date, or whether it's a call or a put. It doesn't decay. It doesn't expire.

---

## 3. The Solution

Butter Options is built on three principles:

### Isolated Escrow, Not Shared Vaults

Every option position has its own escrow PDA (Program Derived Address). When a seller writes an option and locks $2,000 in USDC collateral, that $2,000 sits in a separate on-chain account that can only be touched by instructions governing that specific option's lifecycle.

There is no pool. There is no shared vault. There is nothing for an attacker to drain.

### Tokenized Positions via SPL Tokens

Every option position mints a unique SPL token. Whoever holds the token can exercise the option. This makes Butter Options fully composable with all of Solana DeFi — option tokens can be held by smart contracts, traded on DEXes, used as collateral, or integrated into structured products.

### The Living Option Token

Each option token is built using Token-2022 with three extensions that make it behave like a real financial instrument. See section 4 for details.

---

## 4. The Living Option Token

The Living Option Token is a Token-2022 SPL token with three extensions that make it behave like the real financial instrument it represents.

### Transfer Hook

A small program that runs automatically every time someone tries to transfer the token. It checks the option's expiry timestamp. If the option has expired, the transfer is blocked.

**Why it matters:** The token literally dies when it expires. Nobody can trade a dead option. This is enforced at the protocol level — no wallet, no DEX, no smart contract can override it.

### Permanent Delegate

Gives the Butter Options protocol permanent authority to burn any option token at any time, without needing the holder's signature.

**Why it matters:** Enables automatic cleanup of expired tokens and settlement mechanics. The protocol can burn tokens during exercise (converting them to cash) or after expiry (cleaning up dead instruments).

### Metadata Extension

Stores the full financial terms of the option directly on the token mint:

```
name:     BUTTER-SOL-200C-APR15
symbol:   bOPT
───────────────────────────────
asset:               SOL
class:               crypto
type:                call
strike:              $200
expiry:              1744675200 (Apr 15)
pyth:                H6ARH...f4Cey
collateral_per_token: $20 USDC
market:              [market PDA]
───────────────────────────────
transfer_hook:       blocks after expiry
permanent_delegate:  protocol can burn
metadata:            all terms readable
```

**Why it matters:** Any wallet, protocol, or AI agent can read the token's metadata and know exactly what it represents. Phantom shows "BUTTER-SOL-200C-APR15" instead of "Unknown Token." Any program can compute fair value from the metadata + Pyth price feed without calling Butter's SDK.

### Why Has Nobody Built This Before?

Token-2022 made it technically possible with transfer hooks and metadata extensions, but nobody has used these tools to create a time-decaying financial instrument token. The concept of a self-expiring, self-describing token that enforces its own lifecycle is novel — it does not exist on Solana or any other blockchain.

---

## 5. Protocol Architecture

The Butter Options protocol consists of two on-chain programs:

| Program | Purpose | Program ID |
|---------|---------|------------|
| Butter Options (main) | All 11 instructions for creating markets, writing options, trading, settling, and exercising | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` |
| Transfer Hook | Enforces expiry on every token transfer | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` |

---

## 6. The 11 Instructions

### Protocol Setup

| # | Instruction | What It Does | Who Can Call |
|---|-------------|--------------|--------------|
| 1 | `initialize_protocol` | One-time setup: creates protocol state, sets admin, treasury, and fee rate (0.5%) | Admin only |
| 2 | `create_market` | Creates a new options market for any asset with a Pyth oracle feed | Anyone |

### Primary Trading

| # | Instruction | What It Does | Who Can Call |
|---|-------------|--------------|--------------|
| 3 | `write_option` | Seller locks USDC collateral in isolated escrow, protocol mints Living Option Tokens (Token-2022 with all 3 extensions) into purchase escrow | Anyone |
| 4 | `purchase_option` | Buyer pays premium in USDC, receives option tokens. Premium split: 99.5% to writer, 0.5% to treasury. Supports partial fills | Anyone (except writer) |
| 5 | `cancel_option` | Writer burns all unsold tokens and reclaims collateral. Only works before any sale | Writer only |

### Settlement & Exercise

| # | Instruction | What It Does | Who Can Call |
|---|-------------|--------------|--------------|
| 6 | `settle_market` | Sets final settlement price after expiry (from Pyth in production) | Admin |
| 7 | `exercise_option` | Token holder burns tokens and receives proportional payout from escrow | Token holder |
| 8 | `expire_option` | Returns remaining collateral to writer for unexercised options | Anyone |

### Secondary Market (P2P Resale)

| # | Instruction | What It Does | Who Can Call |
|---|-------------|--------------|--------------|
| 9 | `list_for_resale` | Token holder lists tokens on built-in P2P marketplace. Tokens go to resale escrow | Token holder |
| 10 | `buy_resale` | Buyer purchases from resale listing. Supports partial fills. 0.5% fee | Anyone (except lister) |
| 11 | `cancel_resale` | Lister removes listing and gets tokens back | Lister only |

---

## 7. Account Structure & PDAs

All data is stored in on-chain accounts. Program Derived Addresses (PDAs) are computed deterministically from "seeds" so anyone can find them.

| Account | Seeds | What It Stores |
|---------|-------|----------------|
| ProtocolState | `["protocol_state"]` | Admin, treasury, fee rate, market count |
| OptionsMarket | `["options_market", market_index_bytes]` | Asset name, strike, expiry, settlement price, type, class, Pyth address |
| OptionPosition | `["option_position", market_pda, writer_pubkey]` | Writer, premium, supply, tokens sold, collateral, escrow address, mint address |
| Collateral Escrow | `["escrow", market_pda, writer_pubkey]` | USDC holding the writer's locked collateral |
| Purchase Escrow | `["purchase_escrow", position_pda]` | Token-2022 account holding unsold option tokens |
| ResaleListing | `["resale_listing", position_pda, seller_pubkey]` | Seller, price per token, quantity listed |
| Resale Escrow | `["resale_escrow", listing_pda]` | Token-2022 account holding tokens listed for resale |
| ExtraAccountMetaList | `["extra-account-metas", mint_pubkey]` *(hook program)* | Extra accounts the transfer hook needs for validation |
| HookState | `["hook-state", mint_pubkey]` *(hook program)* | Expiry timestamp for the transfer hook to check |

---

## 8. Permissionless Any-Asset Support

Butter Options does **not** have a hardcoded list of supported assets. Any asset with a Pyth Network oracle price feed can have an options market created for it:

- **Cryptocurrencies:** SOL, BTC, ETH, BONK, JUP
- **Commodities:** Gold (XAU), Silver, Oil (WTI)
- **Equities:** AAPL, TSLA, MSTR, NVDA
- **Forex:** EUR/USD, GBP/USD, JPY/USD
- **Tokenized Funds:** Ondo OUSG, BlackRock BUIDL, USTB

When someone calls `create_market`, they provide the asset name and Pyth oracle address. The protocol doesn't validate whether the asset is "approved" — it simply creates the market.

---

## 9. Asset-Class-Aware Pricing

Different assets behave differently. SOL can move 30% in a day. Gold might move 2% in a month. Butter's SDK applies different pricing profiles based on asset class:

| Asset Class | Code | Volatility | Time Model | Special Risk Factor |
|-------------|------|-----------|------------|---------------------|
| Crypto | 0 | High (60–120%+) | 24/7 continuous (8,760 hrs/yr) | Jump risk premium |
| Commodity | 1 | Low–Medium (15–30%) | Trading hours + weekend gaps | Supply shock premium |
| Equity | 2 | Medium (20–40%) | 252 trading days/yr | Earnings event spike |
| Forex | 3 | Low (5–15%) | 24/5 weekdays | Central bank events |
| ETF/Fund | 4 | Low (5–20%) | Varies | Depeg risk premium |

### The Four Black-Scholes Improvements

1. **Realized volatility from Pyth** — calculates actual vol from oracle data, not a static number
2. **Jump risk premium** — counts large moves (10%+) and adds a surcharge for jumpy assets
3. **Vault utilization surge pricing** — premiums increase as vault fills up (Phase 3)
4. **24/7 continuous time decay** — uses 8,760 hours/year for crypto instead of 252 trading days

---

## 10. Security Architecture

### Isolated Escrow Model

Every option position has its own dedicated escrow PDA. There is no pool. There is no shared vault. An attacker cannot drain the protocol because there is no central place where funds accumulate.

### Additional Security Measures

- **Self-buy prevention** on both primary purchase and resale
- **Protocol-signed escrow** — all transfers signed by protocol PDA, not individual users
- **Atomic transactions** — every instruction fully succeeds or fully reverts
- **European-style settlement** — exercise only after settlement, eliminating early exercise complexity
- **USDC-only collateral** — eliminates collateral volatility risk

### Phase 3 Vault Protection (Designed)

| Layer | Protection | How It Works |
|-------|-----------|--------------|
| 1 | Exposure caps | Max 30% of vault deployed at any time |
| 2 | Concentration limits | No single asset exceeds a set % of vault exposure |
| 3 | Directional hedging | Calls offset puts on same asset |
| 4 | Insurance fund | Portion of premium profits set aside as buffer |
| 5 | Circuit breakers | Auto-pause on drawdown threshold breach |

---

## 11. Option Lifecycle

### Step 1: Create Market
Someone specifies asset, strike, expiry, type, and asset class. Protocol creates an `OptionsMarket` account.

### Step 2: Write Option
A seller locks USDC collateral. Protocol mints Living Option Tokens with full metadata, transfer hook, and permanent delegate. Tokens go to purchase escrow.

### Step 3: Purchase Option
Buyer pays premium in USDC, receives tokens. Partial fills supported — buy 10 out of 100 available tokens.

### Step 4: Secondary Trading
Token holders can list on the built-in P2P marketplace at any price. Transfer hook allows pre-expiry transfers, blocks post-expiry.

### Step 5: Settlement
After expiry, settlement price is set from Pyth. Determines ITM vs OTM.

### Step 6: Exercise or Expire
- **Call payout:** max(0, settlement_price − strike_price) per token
- **Put payout:** max(0, strike_price − settlement_price) per token
- **OTM:** Payout is zero, writer's collateral returned via `expire_option`

---

## 12. CPI Composability

CPI (Cross-Program Invocation) means "your program calls our program." All 11 instructions are callable via CPI.

### Integration Examples

- **Perps platforms** can offer one-click hedging via `purchase_option`
- **Lending protocols** can accept option tokens as collateral (they're real SPL tokens)
- **Structured product vaults** can write options automatically via `write_option`
- **DAO treasuries** can buy puts for downside protection
- **AI agents** can read token metadata, compute fair value, and execute trades

Full CPI documentation with Rust code examples is in the [`cpi-examples/`](../cpi-examples/) directory.

### The AI Agent Angle

Because the Living Option Token carries its full terms in on-chain metadata, AI agents can read and price options using standard Solana RPC calls — no custom SDK needed. The token is the API.

---

## 13. Fee Structure

| Transaction | Fee | Who Pays | Destination |
|-------------|-----|----------|-------------|
| `purchase_option` | 0.5% of premium | Buyer | Protocol treasury |
| `buy_resale` | 0.5% of resale price | Buyer | Protocol treasury |
| `write_option` | None | — | — |
| `exercise_option` | None | — | — |
| `cancel_option` | None | — | — |

Fee rate and treasury address are configurable in `ProtocolState`.

---

## 14. Technical Stack

| Component | Technology |
|-----------|------------|
| Blockchain | Solana (devnet → mainnet) |
| Smart Contract | Anchor 0.32.1 (Rust) |
| Token Standard | SPL Token-2022 (TransferHook, PermanentDelegate, MetadataExtension) |
| Rust | 1.89.0 |
| Solana CLI | 2.3.0 |
| SPL Token-2022 | v8.0.1 |
| Oracle | Pyth Network |
| Collateral | USDC (standard SPL Token program) |
| Frontend | React + TypeScript + Tailwind CSS |
| Built With | Claude Code |

---

## 15. Test Coverage

**27/27 tests passing** across all instruction groups:

| Test Group | Tests | Verifies |
|-----------|-------|----------|
| initialize_protocol | 2 | Setup + double-init prevention |
| create_market | 2 | Creation + parameter validation |
| write_option | 3 | Call, put, insufficient collateral |
| purchase_option | 2 | Premium split + partial fills |
| cancel_option | 2 | Pre-sale cancel + post-sale block |
| Post-expiry suite | 5 | Settlement (ITM/OTM), exercise, expire |
| Resale market | 2 | List + buy resale |
| Partial fills | 3 | Multiple buyers, partial qty |
| Token-2022 extensions | 4 | Transfer hook, metadata, delegate |
| Token-2022 smoke | 2 | Extension init sanity |

---

## 16. Roadmap

| Phase | Milestone | Status |
|-------|-----------|--------|
| 1 | Core protocol: 11 instructions, isolated escrow, tokenized positions, P2P resale, fees | ✅ Complete |
| 1.5 | Living Option Token: Token-2022 with transfer hook, permanent delegate, metadata | ✅ Complete |
| 2 | Permissionless assets, asset-class pricing, Black-Scholes improvements, CPI docs | ✅ Complete |
| 2.5 | Devnet deployment, frontend, demo video, Colosseum submission | 🔄 In Progress |
| 3 | Protocol-managed vaults with 5-layer protection, automated market making | 📐 Designed |
| 4 | Mainnet launch, security audit, institutional integrations | 📋 Planned |
| 5 | Cross-chain, governance token, advanced strategies, AI agent marketplace | 🔮 Vision |

---

*Built with Claude Code. No traditional development team required.*
