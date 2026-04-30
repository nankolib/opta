# Opta — Engineer Handoff

> Updated 2026-04-30 after the auto-finalize arc (Steps 1–6, commits a7924d2 through 37c9b4b). The "living token" thesis is now real on devnet end-to-end. Renamed from Butter Options to Opta on 2026-04-21. This document is the project seed context — drop it into a fresh Claude chat to bring any instance up to speed without re-explanation. For current HEAD, run `git log -1 --oneline`; this doc does not try to self-reference its own commit.

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

**Token mechanic — the "living token."** Each option is a Token-2022 mint with three extensions doing real work: TransferHook enforces expiry (post-expiry transfers fail), PermanentDelegate gives the protocol authority to act on the holder's tokens without their signature, MetadataPointer makes the term sheet on-chain so other programs and AI agents can read it. The intent: at expiry, **no user has to claim, exercise, withdraw, or click anything**. The protocol burns the token, distributes the cash, closes the position. Users wake up the next day with USDC in their wallet — payout if ITM, refunded collateral + earned premium if OTM (writer side). Including for tokens held in *secondary-market* wallets — whoever holds the token at expiry gets paid, automatically. **This automated post-expiry resolution is the protocol's core narrative, and as of commit `37c9b4b` it is shipped on devnet and verified end-to-end via the Phase 6 smoke test (see §6 and the Step 6 follow-ups in `MIGRATION_LOG.md`). Mainnet readiness is a separate concern — see §10.**

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
- **Latest commits as of 2026-04-30:**
  - `37c9b4b` docs(auto-finalize-6): step 6 devnet smoke results
  - `883b2d0` feat(auto-finalize-5): crank wires holder + writer auto-finalize passes
  - `f7270b1` test(auto-finalize-3): writer-side test suite (14 cases)
  - `9069441` feat(auto-finalize-3): auto_finalize_writers instruction handler
  - `e219c17` docs: test harness gotchas + corrected test count
  - `d0edd10` test(auto-finalize-1): holder-side test suite (11 cases)
  - `ecdc7a3` feat(auto-finalize-1.1): add mint to HoldersFinalized event
  - `a7924d2` feat(auto-finalize-1): auto_finalize_holders instruction handler
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

### What changed in the auto-finalize arc (Apr 29 – Apr 30 2026)

The protocol gained two new permissionless on-chain instructions plus the crank wiring to drive them, closing the §7 gap that was the central open item at the end of the migration arc. Major upshots:

- Two new Rust instructions, both permissionless: `auto_finalize_holders` (burns holder option tokens via PermanentDelegate, distributes ITM USDC payouts; commit `a7924d2` + event-field tweak in `ecdc7a3`) and `auto_finalize_writers` (returns each writer's premium + pro-rata collateral share, manually closes their `WriterPosition` account, and on the last writer in a vault sweeps any leftover dust to the protocol treasury and closes the vault USDC account; commit `9069441`).
- Crank now runs holder-finalize and writer-finalize passes after the existing settle pass on every tick (`crank/bot.ts` + `crank/autoFinalize.ts`, commit `883b2d0`). Batch sizes, ATA pre-create budget per tick, dry-run mode, and stale-warn thresholds are all controlled via new env vars — see `crank/README.md`.
- Step 6 devnet smoke (commit `37c9b4b`) verified all paths end-to-end: deployed the new program, settled a fresh ITM vault, ran the crank live against three real vaults (the Apr 29 vault from the migration-arc smoke, a fresh ITM vault, plus one leftover from earlier devnet activity), watched all three converge into the crank's "fully finalized" cache. Treasury USDC and SOL deltas reconciled to the lamport. Full results: `MIGRATION_LOG.md` "Step 6 smoke results".
- The §7 "big architectural gap" — auto-burn + auto-distribute on expiry — is closed. The "wake up with USDC, no clicks" UX is real on devnet.

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

### Instruction inventory (17 instructions on the main program, post auto-finalize arc)

**Admin (2):** `initialize_protocol`, `initialize_epoch_config`

**Market lifecycle (2):** `create_market` (permissionless, idempotent), `migrate_pyth_feed` (admin)

**Vault writer flow (5):** `create_shared_vault`, `deposit_to_vault`, `mint_from_vault`, `withdraw_from_vault`, `claim_premium`

**Vault buyer flow (1):** `purchase_from_vault`

**Settlement (4):** `settle_expiry` (post Pyth update + create SettlementRecord, permissionless), `settle_vault` (mark vault settled, permissionless), `auto_finalize_holders` (permissionless, burns holder tokens via PermanentDelegate and distributes ITM payouts in batches), `auto_finalize_writers` (permissionless, returns writer collateral + premium, manually closes writer positions refunding rent to writers, sweeps dust to protocol treasury and closes vault USDC on the last writer in a vault)

**Manual cleanup (3):** `exercise_from_vault` (holder-signed, burns own tokens, claims payout — fallback for power users; the crank's auto-finalize handles the default UX), `withdraw_post_settlement` (writer-signed, claims collateral + premium back — same fallback role), `burn_unsold_from_vault` (writer-signed, burns own unsold escrow inventory)

The original V1 P2P instructions (`write_option`, `purchase_option`, `settle_market`, `exercise_option`, `expire_option`, `cancel_option`, `list_for_resale`, `buy_resale`, `cancel_resale`) were archived in commit `54c35c5` (Stage 1) and are no longer in `programs/opta/`. They live in `archive/` for reference only.

### State accounts — `programs/opta/src/state/`

`protocol.rs`, `market.rs`, `writer_position.rs`, `epoch_config.rs`, `shared_vault.rs`, `vault_mint.rs`, `settlement_record.rs`

### Token-2022 extensions on every option mint
- **TransferHook** — blocks user-to-user transfers after expiry (enforced by the hook program)
- **PermanentDelegate** — protocol_state PDA holds delegate authority; used by `auto_finalize_holders` for permissionless multi-holder burns at expiry
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
6. **At expiry:** the crank's settle pass calls `settle_expiry` (creates SettlementRecord) + `settle_vault` (flips `is_settled = true`).
7. **On the next tick after settle:** the crank's holder-finalize pass enumerates Token-2022 accounts holding the option mint(s), filters out zero-balance accounts and protocol-owned escrows, and calls `auto_finalize_holders` in batches — burning each holder's tokens via the PermanentDelegate authority and paying ITM holders their `(settlement − strike) × quantity` USDC in the same instruction. Idempotent across batches: zero-balance accounts and mismatched USDC ATAs are silent-skipped on chain.
8. **Then the writer-finalize pass:** the crank enumerates `WriterPosition` accounts for the vault and calls `auto_finalize_writers` in batches — each writer receives their unclaimed premium + pro-rata collateral share, their `WriterPosition` account is manually closed (rent SOL refunded to the writer's wallet), and on the last writer in a vault any leftover USDC dust is swept to the protocol treasury and the `vault_usdc_account` is closed (its rent SOL also routed to treasury). Once both passes return empty for a vault, the crank caches it as fully finalized and stops re-processing it for the rest of the process lifetime.
9. Crank bot at `crank/bot.ts` runs on a 5-minute tick interval (configurable via `OPTA_CRANK_TICK_MS`) to perform settlement and auto-finalize automatically

### Supporting code
- `sdk/` — TS router SDK wrapping V2 vault flows
- `crank/bot.ts` — settle + auto-finalize automation crank (see §5); see `crank/autoFinalize.ts` for the holder/writer enumeration and batching logic
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

- All **17 instructions** deployed and live on devnet (post auto-finalize arc, redeploy slot `459143156`)
- **77 tests in the suite as of 2026-04-30** (test count drifted from the historical 95 during the migration arc; 66 pass, 11 fail with `PriceTooOld` cascades — see `MIGRATION_LOG.md` test-harness gotchas).
- **Full frontend** live on Vercel: Trade (Deribit-style chain), Write, Portfolio (with Settle Expired Markets section + admin Pyth feed migration tool), Markets (with "+ New Market" promoted to AppNav), Docs
- **On-chain Black-Scholes** pricing + 5 Greeks via solmath (~50K CU) — used by the frontend's IndicativePremium panel and (in principle) by any CPI consumer
- **Hermes-driven catalog + spot prices** — fetches live from `hermes.pyth.network` with a host-derived cache; catalog ~600 entries on mainnet
- **Permissionless settlement via Pyth Pull oracle** — anyone with a wallet (including the crank) can settle expired markets
- **Migrate-Pyth-feed admin tool** — admin-only Portfolio section that lets the protocol admin rotate any market's feed_id (used live on 2026-04-29 to switch SOL from Beta feed to mainnet)
- **Settle automation crank** — verified working end-to-end on 2026-04-29: detected expired vault, posted Hermes update, created SettlementRecord, flipped `is_settled = true`, all signed by the crank wallet
- **Permissionless auto-finalize at expiry** — `auto_finalize_holders` burns holder tokens and pays ITM payouts in batches; `auto_finalize_writers` returns writer collateral + premium, closes positions, sweeps dust to treasury. Both verified working on devnet end-to-end via Step 6 smoke (commit `37c9b4b`).

### Smoke test verified 2026-04-29

Operator wrote 20 SOL CALL contracts at $90 strike with a near-term expiry, buyer purchased 5 contracts, expiry passed. After the SOL market was migrated from Beta to mainnet feed_id (`ef0d8b6f…b56d`), the crank picked up the expired vault on its first tick and settled it cleanly:

- SettlementRecord PDA: `AzZMv3XF2MGXv237fvLptiJS2P8SKypuNiSPh9Ksdrjj` exists with `settlement_price = $83.001853`
- Vault `DsFhwmU4ph4yLz4QXUCHUF8qcW4urneQiqjXYJBJPStW` shows `is_settled = true`, `vault.settlement_price` matches
- Atomic tx `5X2Hftry…1que` contained the full Pyth Receiver + Wormhole + Opta settle sequence
- Crank wallet `5YRMuuoY…1zZk` signed both the atomic tx and the settle_vault batch
- Total cost: ~0 SOL net (orphaned encoded-VAA from the earlier failed Beta attempt was reclaimed)

This validates the automated settlement path. The auto-burn / auto-distribute flow it didn't validate was the focus of the auto-finalize arc that followed; see the next subsection for that smoke.

### Smoke test verified 2026-04-30 (Step 6 of auto-finalize arc)

Three vaults processed end-to-end through the new `auto_finalize_holders` + `auto_finalize_writers` instructions: the Apr 29 vault (OTM call, $90 strike, $83 settlement) cleaned up — buyer's 5 tokens burned with no payout, writer received $3,600 collateral + premium dust back; a fresh ITM SOL vault ($50 strike, $83.39 settlement) paid the buyer **$100.19 USDC automatically with no buyer interaction**, writer received remaining collateral + premium share; one leftover settled-but-unfinalized vault from prior devnet activity finalized cleanly with the writer's $800 collateral refunded. Treasury accumulated $0.015 USDC (mostly the 0.5% purchase fee from the fresh-vault buy in Phase 3, plus 1 micro-USDC of dust from the Apr 29 writer pass) and 6,117,840 lamports of rent across the three `vault_usdc_account` closures (= 3 × 2,039,280 lamports per token-account rent, exact). Math reconciled to the lamport. All three vaults converged into the crank's "fully finalized" cache by tick 2. Full results: `MIGRATION_LOG.md` "Step 6 smoke results".

---

## 7. Current State — In Progress / Known Gaps

### The big gap from Apr 29 is closed

Auto-burn + auto-distribute shipped via the auto-finalize arc (commits `a7924d2` through `37c9b4b`). The "wake up with USDC, no clicks" UX is real on devnet as of the Step 6 smoke. The remaining open architectural gap is V2 secondary listing (see below) — the on-chain marketplace state for pre-expiry token resale is still unbuilt.

### The remaining big gap: V2 secondary listing

**Secondary listing for V2 vaults is not implemented.** The V1 P2P listing instructions (`list_for_resale`, `buy_resale`, `cancel_resale`) were archived during the Stage-1 cleanup. The transfer-hook architecture allows pre-expiry token transfers in principle, but there's no on-chain marketplace state (listings, asks, bids, escrow PDAs). Scope: 3 new Rust instructions + new state account + new escrow PDA + frontend marketplace UI + tests + redeploy. This is now the largest remaining architectural gap and the new Tier-1 item in §10.

### Other open gaps

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
- On-chain IDL account is undersized after the auto-finalize deploy (existing 9,904 bytes, new IDL needs 10,679). `anchor idl close` + `anchor idl init` pending — net cost ~0.005 SOL, runtime ~30 seconds. Cosmetic only: the deployed program code is correct and the local IDL at `app/src/idl/opta.json` is in sync; the on-chain IDL account is metadata for explorers and does not affect program execution. See `MIGRATION_LOG.md` "Step 6 follow-ups" for the exact commands.
- One additional orphan write-buffer at `574mMdbmjHyQ9qyXVPJ4itCXe46UokSuPkzK6HaYwCRn` from the Step 6 deploy (zero balance, owned by the operator wallet). Same harmless pattern as the three orphans above; cleanup with `solana program close <pubkey>` is cosmetic.
- Two test vaults have unsold `purchase_escrow` tokens left in protocol-PDA-owned token accounts: 15 from the Apr 29 vault and 2 from the fresh Step 6 vault. The auto-finalize holder pass correctly silent-skipped these (owner == protocol_state PDA filter). They need separate `burn_unsold_from_vault` calls from the original writers to fully tidy. Not blocking and not a finalize bug — the design always expected unsold escrow cleanup to be a separate writer-initiated operation.

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
- **Auto-finalize is permissionless and crank-driven, dust to treasury.** Both `auto_finalize_holders` and `auto_finalize_writers` accept any signer; in practice the crank wallet calls them. Rent from closed `WriterPosition` accounts returns to the writer's wallet (not the caller); rent from the closed `vault_usdc_account` goes to the protocol treasury, along with any USDC dust left over from premium-accumulator integer truncation. Locked decisions per the Step 1–6 design review.
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

1. **Secondary listing for V2 vaults.** New on-chain marketplace: 3 new Rust instructions (`list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale`), new `VaultResaleListing` account, new escrow PDA, frontend marketplace UI, tests, redeploy. Scoped in the original handoff but parked. Now the largest remaining architectural gap after the auto-finalize arc closed; the secondary-market story half is still unbuilt.

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
- The `MIGRATION_LOG.md` is committed and carries the chronological story of the P1–P5 + crank + P6 + auto-finalize arcs
- `.test-fixtures/` is gitignored and contains one-shot bootstrap helpers from the auto-finalize arc (`smoke-init.ts`, `run-tests.sh`, `step6-buyer.json`, `step6-phase*-*.ts`, etc.). These are reference-only artifacts for the smoke runs that produced commits `883b2d0` and `37c9b4b`; future sessions should regenerate them as needed rather than relying on what's in a given working tree.

---

## TL;DR

- **Opta** is a permissionless options primitive on Solana with Token-2022 "living" option tokens. Permissionless any-asset markets via Pyth. On-chain Black-Scholes. V2 shared-vault liquidity. Built for Colosseum Frontier (April 2026).
- **Live on devnet** with frontend on Vercel (`opta-solana.vercel.app`). Pyth Pull oracle migration shipped. Crank bot built and end-to-end-verified for both settlement and auto-finalize on 2026-04-30.
- **The auto-finalize arc closed on 2026-04-30; the remaining big gap is V2 secondary listing.** The "wake up with USDC in your wallet, no clicks" UX promised in the thesis is now real on devnet; the on-chain marketplace state for pre-expiry token resale is still unbuilt and is the new Tier-1 item.
- **Programs ID:** `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` (opta), `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` (transfer hook).
- **Branches:** master + main both at `37c9b4b` as of Apr 30 2026.
- **Biggest gotcha:** the protocol-on-devnet runs against Pyth-on-mainnet feeds. Don't confuse "we're on mainnet" with "Solana mainnet" — protocol is still devnet; only the price oracle endpoint is production.
