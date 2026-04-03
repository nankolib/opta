# Butter Options Crank Bot

Auto-settle, auto-expire crank for the Butter Options protocol on Solana devnet.

## What it does

Runs on a 60-second timer:

1. **Settle** — finds expired markets that haven't been settled, sets the settlement price
2. **Expire** — finds positions on settled markets, returns collateral to writers
3. **Scan** — reports any remaining expired tokens (blocked by transfer hook)

Users exercise their own ITM options from the frontend (exerciser must sign).

## Requirements

- Node.js 18+
- The bot wallet must be the **protocol admin** (the deploy keypair at `~/.config/solana/id.json`)
- Solana CLI configured for devnet: `solana config set --url devnet`

## Run

```bash
cd /path/to/butter_options
npx ts-node crank/bot.ts
```

Press `Ctrl+C` to stop.

## Price feeds

Currently uses hardcoded devnet prices in `DEVNET_PRICES`. In production, replace with Pyth oracle reads.

## Permanent delegate burns

The protocol PDA is the permanent delegate on all option token mints. Burning expired tokens from holders requires a CPI from the on-chain program (PDA can only sign via CPI). A future `admin_burn` instruction would enable the crank to auto-burn expired tokens — the "Living Option Token" signature move where tokens disappear from wallets after settlement. For now, the transfer hook blocks all transfers of expired tokens, making them inert.
