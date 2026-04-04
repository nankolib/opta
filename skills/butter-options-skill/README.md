# Butter Options Agent Skill

Teaches AI agents to read, price, and trade Living Option Tokens on Solana.

## What This Skill Enables

An AI agent with this skill can:
- **Read** all option tokens on-chain and parse their terms from Token-2022 metadata
- **Price** any option using Black-Scholes with asset-class-specific volatility profiles
- **Trade** options: write, buy, list for resale, exercise, and cancel
- **Market make** by scanning for underpriced options and writing at fair value + spread

## Install

Copy the `SKILL.md` file into your agent's skill directory:

```bash
cp skills/butter-options-skill/SKILL.md /path/to/your/agent/skills/
```

Or clone the full skill with references:

```bash
cp -r skills/butter-options-skill/ /path/to/your/agent/skills/
```

## Requirements

- **Solana CLI** — `solana-cli` 1.18+
- **Node.js** — 18+
- **Anchor** — `@coral-xyz/anchor` 0.30+
- **SPL Token** — `@solana/spl-token` 0.4+
- **Network** — Solana Devnet

## Programs (Devnet)

| Program | Address |
|---------|---------|
| butter-options | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` |
| butter-transfer-hook | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` |

## Skill Structure

```
butter-options-skill/
├── SKILL.md                    # Main skill file (load this into your agent)
├── references/
│   ├── program-reference.md    # All instructions, accounts, PDAs
│   ├── pricing.md              # Black-Scholes pricing, Greeks, asset profiles
│   ├── token-metadata.md       # How to read Living Option Token metadata
│   └── examples.md             # Complete TypeScript code examples
└── README.md                   # This file
```

## License

MIT
