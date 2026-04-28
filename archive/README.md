# archive/

This folder contains the original v1 P2P escrow path of the Opta protocol,
retired in Stage 1 of the Items 1+2 refactor (commit hash recorded in
`MIGRATION_LOG.md` at the repo root, or via `git log -- archive/`).

## What's in here

```
archive/
├── README.md                 (this file)
├── v1-instructions/          (10 retired instruction handlers)
│   ├── write_option.rs
│   ├── purchase_option.rs
│   ├── exercise_option.rs
│   ├── expire_option.rs
│   ├── cancel_option.rs
│   ├── list_for_resale.rs
│   ├── buy_resale.rs
│   ├── cancel_resale.rs
│   ├── initialize_pricing.rs
│   └── update_pricing.rs
├── v1-state/                 (2 retired account types)
│   ├── position.rs           (OptionPosition + v1 escrow seed constants)
│   └── pricing.rs            (PricingData + B-S parameter bounds)
└── cranks/                   (v1-only off-chain bots)
    ├── bot.ts                (auto-settle / auto-expire crank)
    ├── pricing-crank.ts      (Black-Scholes update crank)
    └── README.md             (original crank documentation)
```

These files are checked into git and excluded from the cargo workspace via
`exclude = ["archive"]` in the root `Cargo.toml`. They are inert: cargo does
not compile them, and the program ID does not register their handlers.

## Why retired

1. **No live frontend write/buy paths used v1.** As of the v3 paper
   redesign, `useWriteSubmit.ts` and `usePurchaseFlow.ts` go entirely
   through `create_shared_vault` / `mint_from_vault` / `purchase_from_vault`.
2. **Cranks were v1-only.** Both bots iterate `OptionsMarket` and
   `OptionPosition` accounts and call `settle_market` / `expire_option` /
   `initialize_pricing` / `update_pricing`. Items 1+2 break the on-chain
   shape these bots depend on. They will be rewritten as Item 3
   (separate work block).
3. **Item 1 collapses Market to asset-only.** Strike, expiry, and option
   type leave the Market account; settlement moves to per-(asset,expiry)
   `SettlementRecord` PDAs. v1 instructions read those fields from
   Market everywhere — they are not portable to the new shape.
4. **Audit-fix `M-01` cross-validations on `create_shared_vault`** are
   removed in Stage 2 (they validated vault parameters against the
   market's strike/expiry/type, which the market no longer carries).

The CLAUDE.md memory pointers `reference_v2_resale_gap` and
`project_v3_rollout_complete` flagged the v1 surface as out-of-scope for
the v3 demo before this refactor began.

## How to resurrect any of it

Each file is preserved as plain `.rs` / `.ts` text with no edits. To
restore one or more:

1. `git mv archive/v1-instructions/<name>.rs programs/opta/src/instructions/`
   (or v1-state for state files).
2. Restore the corresponding `pub mod <name>;` and `pub use <name>::*;`
   lines in `programs/opta/src/instructions/mod.rs` (or
   `programs/opta/src/state/mod.rs`).
3. Restore the handler function inside `#[program] pub mod opta` in
   `programs/opta/src/lib.rs`. The original handler signatures are
   preserved verbatim in the moved file's `handle_*` function.
4. Run `wsl -- bash -lc "anchor build"`. If the build fails, the most
   likely cause is that Items 1+2 changed the underlying state shape
   (e.g. `OptionsMarket` no longer carries `strike_price`), and the
   resurrected v1 instruction must be rewritten to read its needed
   fields from a v2 vault or `SettlementRecord` instead.

For cranks: `git mv archive/cranks/* crank/` and restore the program ID
in `bot.ts`/`pricing-crank.ts` if it has changed since they were
archived. Same caveat applies: the v1 account types they iterate may no
longer exist on-chain.

## Reference

The chronological story of the v2-only refactor is in
[`../MIGRATION_LOG.md`](../MIGRATION_LOG.md). Stage 1 explains the
archive operation; later stages explain why each piece of v1 became
unreachable.
