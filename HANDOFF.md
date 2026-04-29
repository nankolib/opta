# Opta — Engineer Handoff

> Updated 2026-04-29 after the Pyth Pull migration arc + crank build. Renamed from Butter Options to Opta on 2026-04-21. This document is the project seed context — drop it into a fresh Claude chat to bring any instance up to speed without re-explanation. For current HEAD, run `git log -1 --oneline`; this doc does not try to self-reference its own commit.

> NOTE ON THE RENAME: As of 2026-04-29, **Phase 2 of the rename is complete on disk** (despite the original handoff saying it was parked until post-Colosseum). Directory layout is now `programs/opta/` and `programs/opta-transfer-hook/`. `Anchor.toml` keys are `opta` and `opta_transfer_hook`. PDA seed constants, `declare_id!()` macros, and IDL have been regenerated. The old `butter_options` / `butter-options` identifiers are gone from the codebase. If the in-memory mental model from older sessions still says Phase 2 is parked, the disk supersedes it.

---

## How to use this document

This document is the **seed context** for Opta. If you're a fresh Claude session starting work on this project:

1. **Read this doc end-to-end before answering.** Skimming misses the gotchas and norms.
2. **Verify before citing.** Line numbers and file paths drift. Before acting on a reference in this doc, confirm it still matches the current tree.
3. **The user is real-time. The doc is a snapshot.** If the user's live intent conflicts with this doc, follow the user.

---

## Working with the user

- **Non-developer by background.** The user is learning the stack through these sessions — treat them as a smart generalist who's newer to Solana/TypeScript specifics than to high-level software thinking. Explain in plain English with analogies, but don't over-baby; match their demonstrated level in a given conversation. Example: "a PDA is like a permanent mailbox address the program can always find" beats "program-derived address seeded from X."
- **Solo project, Claude-paired.** This project has no other engineers. Every change — code, tests, docs — has flowed through a Claude session. Assume the code you're reading came from a previous Claude instance, not from the user typing.
- **Two-Claude workflow.** This chat session functions as project manager and design reviewer; **Claude Code** (running in WSL on the user's Windows machine) does the actual code execution. The chat reviews proposals, locks decisions, then hands prompts to Claude Code. Claude Code uses propose-then-apply on every change.
- **Windows + WSL.** User is on Windows 10 with WSL2 for Solana tooling. Bash commands run in Windows git-bash by default; anything Solana-related (`anchor`, `solana`, `cargo`) MUST run via `wsl -- bash -lc "..."`. Keypair at `/home/nanko/.config/solana/id.json`. The user doesn't know what WSL is internally — just give the exact command to run.
- **Terminal preference: PowerShell.** When asking the user to run shell commands themselves (not Claude running them), prefer simple PowerShell one-liners. No piping gymnastics.
- **"Contracts" not "tokens" in UI copy.** Option tokens are called "contracts" throughout the frontend. Match that convention in any user-facing string you write.
- **Direct action over circling.** When there's a clear best path, take it and say so. Don't manufacture multi-option proposals just for ceremony — but do propose alternatives when there's genuine ambiguity.
- **Approve-then-apply for risky work.** For deletions, force-pushes, large rewrites, or anything irreversible, propose the plan first and wait for approval. Apply only after green-light; verify after applying.

---

## 1. Project Identity & Thesis

**Opta** is a permissionless options primitive on Solana. Anyone can write (sell) or buy call/put options on **any asset Pyth has a feed for** — crypto, commodities, equities, FX, ETFs. Each option is a Token-2022 mint with three extensions that make the token enforce its own lifecycle on-chain.

### The thesis

DeFi has a derivatives gap. Options are a much bigger TAM than spot in TradFi but barely exist on-chain. Solana specifically is essentially absent from on-chain derivatives — Hyperliquid is winning the EVM-side momentum, especially with institutional flow moving into commodities futures, and Solana doesn't have an equivalent options primitive competing for that flow. Opta is positioning to be that answer.

The differentiation comes from three intertwined design choices, each of which only makes sense because of the other two:

**Asset surface.** Most on-chain options projects support BTC, ETH, SOL, maybe a handful of large caps. Opta supports anything Pyth has a feed for. The pitch is not "options on SOL" — it's "options on whatever asset has a price feed." This compounds: every new feed Pyth adds becomes a potential Opta market.

**Token mechanic — the "living token."** Each option is a Token-2022 mint with three extensions doing real work: TransferHook enforces expiry (post-expiry transfers fail), PermanentDelegate gives the protocol authority to act on the holder's tokens without their signature, MetadataPointer makes the term sheet on-chain so other programs and AI agents can read it. The intent: at expiry, **no user has to claim, exercise, withdraw, or click anything**. The protocol burns the token, distributes the cash, closes the position. Users wake up the next day with USDC in their wallet — payout if ITM, refunded collateral + earned premium if OTM (writer side). Including for tokens held in *secondary-market* wallets — whoever holds the token at expiry gets paid, automatically. **This automated post-expiry resolution is the protocol's core narrative, and it is currently NOT YET SHIPPED — see §7 and §10.**

**Liquidity model.** TradFi-style options books fragment liquidity per strike, per expiry, per side. Opta's shared-vault V2 model has writers deposit into pooled vaults that mint multiple strikes/expiries against one collateral pool, eliminating per-listing fragmentation.

**On-chain Black-Scholes via solmath** — pricing happens on-chain at ~50K compute units, which means other Solana programs can CPI into Opta and price options as part of their own logic. This is the AI-agent / composability angle.

**European-style settlement** ships now. American comes post-hackathon. Locked decision.

### Stage

**Devnet demo / hackathon submission.** Deployed to Solana devnet, frontend live on Vercel. Built for **Colosseum Frontier Hackathon — April 2026**. Not on mainnet. The live deployment uses Pyth's mainnet price feeds via `hermes.pyth.network` (because Solana devnet's Wormhole Core Bridge only verifies Pyth's production guardian set, not Beta). The protocol code itself is still running on Solana devnet — only the price oracle endpoint is mainnet.

---

## 2. Repository State

- **GitHub remote:** `https://github.com/nankolib/opta.git`
- **Current branch:** `master` (also pushed to `main` for hackathon judges; both branches stay in sync at every commit)
- **Working tree:** clean
- **Latest commits as of 2026-04-29:**
  - `7d6100d` chore(admin): one-shot script to migrate SOL feed_id to mainnet
  - `a8d3d9b` feat(stage-p6): hermes endpoint configurable, mainnet default
  - `2a7c1c2` feat(stage-p4e): cleanup pass — eslint config, AppNav promotion, MigrateFeed admin tools, dead-code sweep
  - `924149e` feat(crank): settle automation crank — bot, config, README
  - `48b3795` feat(stage-p4d): permissionless settle button via Pyth Pull SDK + batched settle_vault
  - `bc5f509` feat(stage-p4c): NewMarketModal restored on Pyth Pull IDL
  - `6cbf16f` feat(stage-p4b): Hermes catalog + permissionless market creation
  - `db04bab` feat(stage-p4a): frontend read paths repaired against new IDL
  - `baea0a6` feat(stage-p3): migrate_pyth_feed admin instruction
  - `7f73d27` feat(stage-p2): settle_expiry consumes PriceUpdateV2, permissionless
  - `1c522a1` feat(stage-p1): pyth_feed Pubkey → pyth_feed_id [u8; 32]

Author throughout: **nankolib** (single-developer, Claude-paired).

### What changed in the migration arc (Apr 28–29 2026)

The protocol shipped the **Pyth Pull migration** in stages P1 → P5, then a **crank bot** in a separate sub-arc, then the **mainnet Hermes migration** as P6. Major upshots:

- `settle_expiry` is now permissionless, consumes a `PriceUpdateV2` account from Pyth's Pull oracle, and uses Hermes mainnet feeds via `hermes.pyth.network`
- `migrate_pyth_feed` admin instruction exists for rotating an asset's feed_id post-deployment
- `OptionsMarket.pyth_feed_id` is `[u8; 32]` (not `Pubkey`)
- A standalone Node.js crank lives in `crank/bot.ts` with its own `package.json`, `tsconfig.json`, and `README.md`
- Hermes endpoint is env-var configurable (`VITE_HERMES_BASE` for frontend, `OPTA_HERMES_BASE` for crank); mainnet is the default

---

## 3. Tech Stack

### Languages
- **Rust** — Solana on-chain programs (Anchor framework)
- **TypeScript** — frontend app, tests, scripts, crank bot, SDK

### On-chain / Anchor
- Anchor `0.32.1`, Rust toolchain pinned via `rust-toolchain.toml`
- SPL **Token-2022** v8.0.1 (`@solana/spl-token ^0.4.14`)
- Cargo workspace at repo root; `programs/*` are the workspace members
- Release profile uses `overflow-checks = true`, `lto = "fat"`

### Frontend (`app/`)
- Vite 8 + React 19 + TypeScript 5.9
- Tailwind 4 (via `@tailwindcss/vite`)
- Solana wallet adapter (`@solana/wallet-adapter-*`) + `@solana/web3.js ^1.98`
- `@coral-xyz/anchor ^0.32.1`
- `@pythnetwork/pyth-solana-receiver ^0.14.0`
- Manual Buffer polyfill in `app/src/polyfills.ts` (see §11)

### Crank (`crank/`)
- Node.js with `ts-node` runtime; one-file bot at `crank/bot.ts`
- Cross-imports helpers from `app/src/` via the `@app/*` tsconfig path alias
- Same Solana stack pins as `app/` (`@coral-xyz/anchor`, `@solana/web3.js`, `@pythnetwork/pyth-solana-receiver`)
- Dependency override: `rpc-websockets@9.3.7` and `@solana/web3.js ^1.98.4` are forced via the `overrides` block to dedupe across jito-ts's transitive pull of an old web3.js (mirrored from `app/package.json`)

### Tests
- Mocha + Chai + `ts-mocha` at repo root, invoked by `anchor test`

### External services
- **Pyth Network** — on-chain oracle for pricing + settlement via the Pull oracle (PriceUpdateV2)
- **Hermes mainnet** (`https://hermes.pyth.network`) — off-chain price update fetching; Beta is supported as an override but not used by default
- **Helius devnet RPC** — operator must set `VITE_RPC_URL` in `app/.env.local` (gitignored) and `OPTA_RPC_URL` for the crank
- **Vercel** — frontend hosting at `opta-solana.vercel.app`
- **solmath** — on-chain Black-Scholes math library

---

## 4. Architecture

### Programs (2)

| Program | Program ID | Purpose |
|---|---|---|
| `opta` | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` | Main protocol |
| `opta_transfer_hook` | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` | Token-2022 transfer hook — blocks transfers after expiry |

### Instruction inventory (15 instructions on the main program, post-Stage-1+P-arc)

**Admin (2):** `initialize_protocol`, `initialize_epoch_config`

**Market lifecycle (2):** `create_market` (permissionless, idempotent), `migrate_pyth_feed` (admin)

**Vault writer flow (5):** `create_shared_vault`, `deposit_to_vault`, `mint_from_vault`, `withdraw_from_vault`, `claim_premium`

**Vault buyer flow (1):** `purchase_from_vault`

**Settlement (2):** `settle_expiry` (post Pyth update + create SettlementRecord, permissionless), `settle_vault` (mark vault settled, permissionless — DOES NOT BURN OR DISTRIBUTE; see §7)

**Manual cleanup (3):** `exercise_from_vault` (holder-signed, burns own tokens, claims payout), `withdraw_post_settlement` (writer-signed, claims collateral + premium back), `burn_unsold_from_vault` (writer-signed, burns own unsold escrow inventory)

The original V1 P2P instructions (`write_option`, `purchase_option`, `settle_market`, `exercise_option`, `expire_option`, `cancel_option`, `list_for_resale`, `buy_resale`, `cancel_resale`) were archived in commit `54c35c5` (Stage 1) and are no longer in `programs/opta/`. They live in `archive/` for reference only.

### State accounts — `programs/opta/src/state/`

`protocol.rs`, `market.rs`, `writer_position.rs`, `epoch_config.rs`, `shared_vault.rs`, `vault_mint.rs`, `settlement_record.rs`

### Token-2022 extensions on every option mint
- **TransferHook** — blocks user-to-user transfers after expiry (enforced by the hook program)
- **PermanentDelegate** — protocol_state PDA holds delegate authority, **but no instruction currently uses this for permissionless multi-holder burns** (latent capability; see §7 and §10)
- **MetadataPointer + TokenMetadata** — on-chain term sheet (asset, strike, expiry, type)

### Frontend — `app/src/`
- Pages: `Landing`, `Markets`, `Trade`, `Write`, `Portfolio`, `DocsPage`
- Hooks: `useProgram`, `useAccounts`, `useFetchAccounts`, `useVaults`, `useTokenMetadata`, `usePythPrices`
- Utils: `blackScholes.ts`, `constants.ts`, `errorDecoder.ts`, `format.ts`, `tokenMetadata.ts`, `vaultFilters.ts`, `pythPullPost.ts`, `hermesCatalog.ts`, `env.ts`
- Feature flag: `USE_V2_VAULTS = true` in `app/src/utils/constants.ts` (V1 hidden but archived code referenced via this flag)

### Frontend Hermes flow
- `usePythPrices` is Hermes-only post-P4b — no CoinGecko/Jupiter/static fallbacks
- `hermesCatalog.ts` fetches the live Pyth catalog; cache key derives from URL host (auto-busts on endpoint switch)
- `pythPullPost.ts` exports `settleAllForExpiry` that the UI Settle button (P4d) and the crank both consume; it accepts a `hermesBase` parameter, defaulting to mainnet

### Data flow — user buys an option (V2 vault path)
1. User lands on `/trade`, UI loads live spot prices via `usePythPrices` (Hermes mainnet)
2. UI fetches all markets + shared vaults
3. UI computes B-S fair value client-side in `blackScholes.ts` for the grid
4. User clicks Buy → `purchase_from_vault` instruction sent
5. On-chain: vault transfers option tokens from its escrow ATA to buyer; transfer hook checks expiry; premium goes to vault
6. **At expiry — current state (manual):** crank automatically calls `settle_expiry` (creates SettlementRecord) + `settle_vault` (flips `is_settled = true`). After that, **users must manually call `exercise_from_vault` (ITM holders) or `withdraw_post_settlement` (writers) to receive USDC and burn their tokens.** The fully-automated post-expiry resolution is the protocol's intended behavior but has not yet shipped.
7. Crank bot at `crank/bot.ts` runs on a 5-minute tick interval (configurable via `OPTA_CRANK_TICK_MS`) to perform settlement automatically

### Supporting code
- `sdk/` — TS router SDK wrapping V2 vault flows
- `crank/bot.ts` — settle automation crank (see §5)
- `crank/migrate-sol-feed.ts` — one-shot admin script that rotated SOL's feed_id from Beta to mainnet on 2026-04-29
- `scripts/` — seed scripts, debug helpers, faucet setup, `pyth-feed-ids.csv`

---

## 5. Deployments

| What | Where |
|---|---|
| Both programs | **Solana devnet**, program IDs above. Last upgraded slots: opta = 458866752, opta_transfer_hook = 458867413 (both via `solana program deploy --program-id` upgrade on 2026-04-29) |
| Frontend | **Vercel** — `https://opta-solana.vercel.app` (root dir `app/`, SPA rewrite via `vercel.json`). Auto-deploys on push to `main` |
| Crank bot | Run manually via `npm start` from `crank/` (or as a background process under WSL with `nohup`). Reads `OPTA_RPC_URL` and `OPTA_CRANK_KEYPAIR` from env. **NOT** running as a daemon — operator must start it explicitly |
| Devnet USDC mint | `AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL` (in `app/src/utils/constants.ts`) |
| Devnet faucet wallet | Public keypair baked into `app/src/utils/constants.ts` for demo USDC distribution; in-code warnings flag it |
| Domain | `opta.fyi` purchased but not yet attached to Vercel — parked for post-Colosseum |

**Environment files (all gitignored as `.env*`):**
- `app/.env.local` — operator must set `VITE_RPC_URL` (Helius devnet URL); optionally `VITE_HERMES_BASE` (defaults to mainnet)
- `crank/` — set `OPTA_RPC_URL` at the command line or via shell env. Optional: `OPTA_CRANK_KEYPAIR` (default `~/.config/solana/id.json`), `OPTA_CRANK_TICK_MS` (default 300000), `OPTA_HERMES_BASE` (default mainnet)

The `app/.env.example` and `crank/README.md` document the expected variable names without leaking the Helius API key.

---

## 6. Current State — What Works

- All **15 instructions** deployed and live on devnet
- **95 tests across 6 suites — last verified passing 95/95** as of commit `ff08458` (pre-migration). The test suite has not been re-run after the P1–P6 migration arc; many tests likely need updating for the new IDL (see §7)
- **Full frontend** live on Vercel: Trade (Deribit-style chain), Write, Portfolio (with Settle Expired Markets section + admin Pyth feed migration tool), Markets (with "+ New Market" promoted to AppNav), Docs
- **On-chain Black-Scholes** pricing + 5 Greeks via solmath (~50K CU) — used by the frontend's IndicativePremium panel and (in principle) by any CPI consumer
- **Hermes-driven catalog + spot prices** — fetches live from `hermes.pyth.network` with a host-derived cache; catalog ~600 entries on mainnet
- **Permissionless settlement via Pyth Pull oracle** — anyone with a wallet (including the crank) can settle expired markets
- **Migrate-Pyth-feed admin tool** — admin-only Portfolio section that lets the protocol admin rotate any market's feed_id (used live on 2026-04-29 to switch SOL from Beta feed to mainnet)
- **Settle automation crank** — verified working end-to-end on 2026-04-29: detected expired vault, posted Hermes update, created SettlementRecord, flipped `is_settled = true`, all signed by the crank wallet

### Smoke test verified 2026-04-29

Operator wrote 20 SOL CALL contracts at $90 strike with a near-term expiry, buyer purchased 5 contracts, expiry passed. After the SOL market was migrated from Beta to mainnet feed_id (`ef0d8b6f…b56d`), the crank picked up the expired vault on its first tick and settled it cleanly:

- SettlementRecord PDA: `AzZMv3XF2MGXv237fvLptiJS2P8SKypuNiSPh9Ksdrjj` exists with `settlement_price = $83.001853`
- Vault `DsFhwmU4ph4yLz4QXUCHUF8qcW4urneQiqjXYJBJPStW` shows `is_settled = true`, `vault.settlement_price` matches
- Atomic tx `5X2Hftry…1que` contained the full Pyth Receiver + Wormhole + Opta settle sequence
- Crank wallet `5YRMuuoY…1zZk` signed both the atomic tx and the settle_vault batch
- Total cost: ~0 SOL net (orphaned encoded-VAA from the earlier failed Beta attempt was reclaimed)

This validates the automated settlement path. **It does NOT validate the auto-burn / auto-distribute flow, which is not yet implemented (§7).**

---

## 7. Current State — In Progress / Known Gaps

### The big architectural gap: auto-burn + auto-distribute is not yet shipped

**This is the most important entry in this document.** The "living token" thesis described in §1 — where post-expiry the protocol burns all holder tokens and distributes USDC payouts/refunds automatically — does not currently exist on-chain.

Audit confirmed on 2026-04-29 by reading every instruction handler:

- `settle_vault` is a *mark-only* operation. It flips `is_settled = true` and records the settlement price, but **touches zero tokens and moves zero USDC**. Its account list does not even include `option_mint`, holder ATAs, `vault_usdc_account`, or any token program — by structure, it cannot burn or distribute.
- The PermanentDelegate authority IS correctly installed on every option mint and IS held by the protocol_state PDA. The technical capability for a permissionless auto-burn exists. But no instruction exposes that capability for multi-holder iteration.
- The only paths that burn tokens are user-initiated: `exercise_from_vault` (holder signs to burn own tokens for ITM payout), `burn_unsold_from_vault` (writer signs to clean up own unsold escrow), `withdraw_post_settlement` (writer signs to claim collateral; does NOT burn but settles writer-side).
- After the Apr 29 smoke test, the buyer's 5 OTM tokens are still sitting in their wallet. The writer's full $3,600 collateral is still locked in the vault USDC account. No payouts have been distributed because nobody has signed the manual cleanup instructions.

**This means the user experience promised in the thesis ("wake up with USDC in your wallet, no clicks") is not currently achievable on the deployed protocol.** Closing this gap is the next major work item — see §10.

### Other open gaps

- **Secondary listing for V2 vaults is not implemented.** The V1 P2P listing instructions (`list_for_resale`, `buy_resale`, `cancel_resale`) were archived during the Stage-1 cleanup. The transfer-hook architecture allows pre-expiry token transfers in principle, but there's no on-chain marketplace state (listings, asks, bids, escrow PDAs). Scope: 3 new Rust instructions + new state account + new escrow PDA + frontend marketplace UI + tests + redeploy.
- **Test suite not refreshed for the migration arc.** All P-stage commits were code-only; no tests were updated to reflect the new IDL signatures. The 95/95 figure is from before P1.
- **Pricing crank from the original handoff was archived.** It was never used by the migration arc, isn't relevant to the current settle flow, and any future "live pricing refresh" feature is a separate concern from the settle automation crank that ships today.
- **Frontend bug — Markets page shows "No markets yet" when an asset is registered but has no vaults.** UX gap, not a chain-side bug. Logged for the doc-audit pass.
- **Frontend bug — Header reads "MAINNET · SOLANA" on the live site.** It's still Solana devnet underneath; only the Pyth feeds are mainnet. Display copy needs correcting before any judging touchpoint.
- **Frontend bug — Indicative Premium panel renders $0.00 for short-dated OTM options.** The Black-Scholes math is correct (a 4-minute OTM call really is ~$0); the display rounds sub-cent values to $0.00, which looks like a broken state. Needs a "tiny premium" indicator or non-zero floor.
- **Frontend bug — Stale market list on /markets after creating a market via AppNav.** The AppNav `+ New Market` modal owns its own state; the Markets page's `useMarketsData` doesn't refetch when the AppNav modal closes. User has to refresh. Acceptable for hackathon, queued.
- **Token2022 / Pyth pull edge cases not exhaustively tested** — the crank smoke validated the happy path but ITM payout, secondary-market holder, and multi-holder scenarios have not all been exercised.

### Minor housekeeping

- 3 orphaned write-buffer accounts on devnet from earlier deploy sessions (`2Tw7L2C…`, `A841WoZ…`, `5E9FmYo…`) — all 0 SOL balance, harmless, cleanup with `solana program close <buffer-pubkey>` is purely cosmetic
- The Vercel project doesn't yet have `opta.fyi` attached
- X handle `@opta` (or similar) unclaimed
- TSLA market exists on-chain with the Beta feed_id `7dac7caf…cc4e`. Has zero vaults. If TSLA is ever needed for a demo, it'll need its own `migrate_pyth_feed` call. For now: ignored

---

## 8. Key Decisions & Design Choices

- **Token-2022 over classic SPL** — needed TransferHook + PermanentDelegate + MetadataPointer for the "living token" lifecycle. Foundational to the protocol's narrative.
- **Options represented as tradable tokens** — anyone holding them at expiry gets paid (once auto-distribute ships). Enables DEX listing and a built-in secondary market.
- **European-style settlement, USDC-only** — simpler to audit and price; American-style is post-Colosseum work.
- **V2 shared-vault liquidity model is the only one exposed in the UI.** V1 P2P code was archived to `archive/` in Stage 1.
- **On-chain Black-Scholes via solmath** — expensive (~50K CU) but enables CPI composability and AI-agent-readable pricing without trusting an off-chain oracle.
- **Pyth Pull oracle (PriceUpdateV2) over the legacy Push oracle** — Push was deprecated; Pull is the modern path. Forces every settle to post a fresh price update on-chain in the same tx that consumes it.
- **Mainnet Hermes feeds, even though the protocol runs on Solana devnet** — Solana devnet's Wormhole Core Bridge only verifies Pyth's production guardian set, not Beta's. Locked decision: protocol runs on Solana devnet, prices come from Pyth mainnet via `hermes.pyth.network`.
- **Permissionless settlement** — `settle_expiry` and `settle_vault` are both signer-permissionless. Anyone can settle. The crank uses this; users could too if they wanted.
- **Crank-driven automation, not "token natively self-resolves on its own"** — Solana programs are passive (no native scheduling), so the user-experience claim "tokens resolve themselves at expiry" is achieved by a crank using PermanentDelegate authority. Honest framing for any pitch material: "no user action required at expiry," not "no infrastructure required."
- **Single repo, two-program Anchor workspace** — `Cargo.toml` at root defines workspace; programs at `programs/opta/` and `programs/opta-transfer-hook/`.
- **Security:** 5 Rust audit rounds + 2 frontend audits, **18 findings fixed, 0 remaining** as of commit `ff08458`. Not re-audited after the P1–P6 migration arc — fresh audit recommended before any mainnet talk.

---

## 9. External Dependencies & People

- **Contributors:** only `nankolib` (Nanko). See "Working with the user" at the top.
- **External services:** Pyth Network (Hermes mainnet for off-chain price updates + Pyth Receiver on-chain; Wormhole Core Bridge for VAA verification), Helius (devnet RPC), Vercel (hosting), GitHub (source).
- **Deadlines:** **Colosseum Frontier Hackathon — April 2026**. Submission window already open; final demo/judging is the near-term gate. Today is 2026-04-29.

---

## 10. Immediate Next Steps

In rough priority order:

### Tier 1 — must ship before judging touch-points

1. **Auto-burn + auto-distribute architecture** (the §7 gap). This is the single most important open item. Closing this gap is what makes the "living token" thesis real instead of aspirational. Scope sketch:
   - 1–2 new Rust instructions (e.g. `auto_finalize_vault` or split into `auto_burn_holders` + `auto_distribute_writers`) that take `remaining_accounts` slices of holder ATAs / writer positions and use the protocol_state PDA's PermanentDelegate authority to burn + transfer USDC in one signed call
   - The crank takes a third pass after `settle_expiry` + `settle_vault`: enumerate holders off-chain via `getProgramAccounts`, batch them into `auto_finalize` calls with compute-budget-aware chunking (~10–15 holder/writer pairs per tx)
   - Test suite expansion (~10–15 new cases: OTM all-burn, ITM partial-burn-with-payout, mixed pool, multi-batch idempotency, race vs. manual exercise mid-batch, race vs. burn_unsold)
   - Frontend: keep `exercise_from_vault` and `withdraw_post_settlement` UI as fallback for power users, but the default UX becomes "automatic, no action required"
   - Redeploy on devnet
   - Estimated scope: similar to the Pyth Pull migration arc — multiple sessions of focused Rust + crank + frontend work

2. **Secondary listing for V2 vaults.** New on-chain marketplace: 3 new Rust instructions (`list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale`), new `VaultResaleListing` account, new escrow PDA, frontend marketplace UI, tests, redeploy. Scoped in the original handoff but parked. Should ship in the same session-arc as auto-burn since both touch the same secondary-market story.

### Tier 2 — quality polish

3. **Frontend bug bash:** Markets-page-empty-when-asset-has-no-vaults, MAINNET-vs-devnet header copy, Indicative Premium $0 display, AppNav modal stale-list refetch.

4. **Test suite refresh.** Update mocha tests for the new IDL after the migration arc. Confirm the 95/95 figure still holds (or is replaced with a fresh count).

5. **Whitepaper / docs audit.** Update the project's whitepaper, README, CLAUDE.md, MIGRATION_LOG.md, and website copy to reflect actual current state — including honest framing of the crank-driven automation as "no user action required" rather than overclaiming "no infrastructure."

### Tier 3 — post-launch / mainnet path

6. American-style settlement (already deferred per Stage decision).
7. `opta.fyi` Vercel attachment + DNS setup.
8. X handle claim + social presence.
9. Fresh security audit covering the post-migration codebase.
10. Mainnet deployment readiness (separate from Pyth's mainnet — refers to Solana mainnet).

---

## 11. Gotchas for a New Claude / Engineer

### Environment
- **All Solana scripts run from WSL**, not Windows. Keypair lives at `/home/nanko/.config/solana/id.json`.
- **Before `anchor deploy`, sync WSL `.so` files** — otherwise you'll overwrite devnet with stale binaries.
- **Devnet clock skew:** add 30–60s buffer when waiting for expiry in test scripts.
- **Solana CLI default RPC:** as of 2026-04-29 the WSL `solana config` is set to devnet. If a future session runs against localhost it will silently fail.

### Build / runtime
- **Buffer polyfill must be imported first** in `main.tsx` via `app/src/polyfills.ts` — separate file, not `vite-plugin-node-polyfills` (broken on Vite 8).
- **800K CU compute-budget bump** needed for anything touching Token-2022 extensions + transfer hook. The crank bumps to 1.4M for atomic settle.
- **Token-2022 ATA creation must be idempotent** in the frontend.
- **`bigint: Failed to load bindings, pure JS will be used`** appears on crank startup. Harmless transitive-dep notice. Documented in `crank/README.md`.

### Code org
- **PDA seeds are string constants** repeated in both Rust and TS — if you rename one, rename both. `app/src/utils/constants.ts` mirrors the Rust seeds.
- **`USE_V2_VAULTS` feature flag** still gates the UI to V2-only. V1 archived but referenced in archive/.
- **IDL regeneration** — every time an instruction signature changes in Rust, the IDL JSON in `app/src/idl/opta.json` must be refreshed. The migration arc regenerated this multiple times.
- **Cross-package imports from `crank/` to `app/src/`** use the `@app/*` tsconfig path alias. The tsconfig's `moduleTypes` override forces `app/src/**/*.ts` to be loaded as CJS even though `app/package.json` says `type: module`. Don't break this without testing both runtimes.
- **Tests named `zzz-audit-fixes.ts`** run last on purpose (mocha alpha ordering) because they depend on earlier fixtures.

### Hermes / Pyth specifics
- **Mainnet Hermes is the default**, not Beta. Beta has guardian-set sync issues against Solana devnet's Wormhole Core Bridge — that's how we discovered the gap on 2026-04-29.
- **Catalog cache key is host-derived** — switching `HERMES_BASE` automatically gets a fresh cache.
- **Markets created against Beta feed_ids must be migrated to mainnet** via the admin `migrate_pyth_feed` instruction before the crank can settle them. SOL was migrated on Apr 29; TSLA still has the Beta feed_id and would fail.
- **`pythPullPost.ts` accepts a `hermesBase` parameter** in all Hermes-touching helpers, defaulting to mainnet. Both the frontend and the crank pass their own env-derived URL through.

### Repo hygiene
- `.context/` is gitignored — contains audit outputs and PoCs, never commit
- `*-keypair.json`, `id.json`, `.env*` are gitignored — never commit secrets
- `crank/verify-smoke.ts` and `crank/inspect-vault-tokens.ts` are untracked one-shot inspectors from the Apr 29 smoke. Keep, gitignore, or delete per operator preference; current state is "left in working tree, untracked"
- The `MIGRATION_LOG.md` is committed and carries the chronological story of the P1–P5 + crank + P6 arcs

---

## TL;DR

- **Opta** is a permissionless options primitive on Solana with Token-2022 "living" option tokens. Permissionless any-asset markets via Pyth. On-chain Black-Scholes. V2 shared-vault liquidity. Built for Colosseum Frontier (April 2026).
- **Live on devnet** with frontend on Vercel (`opta-solana.vercel.app`). Pyth Pull oracle migration shipped. Crank bot built and end-to-end-verified for the *settlement* phase on 2026-04-29.
- **The big open architectural gap** is auto-burn + auto-distribute on expiry. The "wake up with USDC in your wallet, no clicks" UX promised in the thesis is not yet implemented — it's the next major work item, alongside V2 secondary listing.
- **Programs ID:** `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` (opta), `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` (transfer hook).
- **Branches:** master + main both at `7d6100d` as of Apr 29 2026.
- **Biggest gotcha:** the protocol-on-devnet runs against Pyth-on-mainnet feeds. Don't confuse "we're on mainnet" with "Solana mainnet" — protocol is still devnet; only the price oracle endpoint is production.
