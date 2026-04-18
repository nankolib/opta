# Butter Options — Engineer Handoff

> Generated 2026-04-18 by `handoff-scribe`. Snapshot of project state for a fresh engineer.

---

## 1. Project Identity

**Butter Options** is an options-trading protocol built on the Solana blockchain. It lets anyone write (sell) or buy call/put options on any asset that has a Pyth price feed — crypto, commodities, equities, forex — with the option itself represented as a token that can be freely traded on a secondary market until it expires. The pitch line in the README is "the first living financial instrument on any blockchain": each option mint is an SPL **Token-2022** with three extensions that make the token enforce its own expiry, auto-burn at settlement, and carry its full term sheet on-chain.

- **Problem it solves:** On-chain options today are either asset-limited (crypto only), oracle-limited, or not composable by other programs. Butter makes any Pyth asset tradable as a permissionless, CPI-callable option token.
- **Users:** DeFi traders (Trade/Write/Portfolio UI), liquidity providers (shared vaults), other Solana programs (CPI), AI agents (metadata is machine-readable).
- **Stage:** **Devnet demo / hackathon submission.** Deployed to Solana devnet, frontend live on Vercel, built for **Colosseum Frontier Hackathon — April 2026.** Not on mainnet.

---

## 2. Repository State

- **GitHub remote:** `https://github.com/nankolib/butter_options.git`
- **Current branch:** `master` (also pushed to `main` for hackathon judges)
- **Working tree:** clean, up to date with `origin/master`
- **Uncommitted changes:** none
- **Branches:** `master` (local + remote), `remotes/origin/main`

**Last 20 commits:**

```
67c0d0c fix: unified vault filtering across all pages, token metadata verified on-chain
5661d94 fix: Trade page filtered to v2 vault data only, synced with Markets page
5393429 feat: pre-demo cleanup — filtered markets, collateral breakdown, epoch vault creation, fresh seed script
5da2a17 fix: Buffer polyfill for Vercel production builds
5807eeb feat: complete v2 vault frontend with full lifecycle, greeks, token metadata, 2 audits passed
b83b23f docs: regenerate IDL (24 instructions) and update README for full protocol state
cd7d101 fix: sweep premium rounding dust before vault close — audit round 4
e3bbbee fix: reset premium debt/claimed after partial share withdrawal — final audit H-01
9f8d870 docs: add re-audit findings to CLAUDE.md
cb13068 security: fix re-audit findings CRITICAL-01, HIGH-01, MEDIUM-01, LOW-01
d293cba security: all audit findings fixed + 14 pre-existing test failures resolved — 83/83 passing
f2a69c9 feat: shared vault liquidity system — 11 new instructions, router SDK, 23 tests
4a2dfaf fix: switch from Pyth Hermes to CoinGecko + Jupiter for live spot prices
0435ecf fix: use URL API for Pyth Hermes request to fix param encoding
5602da5 fix: add parsed=true param, debug logging, and case-insensitive ID match to Pyth hook
4aaf9b7 fix: use live Pyth spot prices for B-S pricing instead of strike
318f58e 9-asset options chain: seed + expiry fix + per-asset IV
3785c6d Deribit-style options chain + Greeks + devnet seeder
a0267d4 Phase D: Pyth on-chain integration + pricing crank
e0d1b38 Phase C: on-chain pricing via solmath (A+C hybrid)
```

Author throughout: **nankolib** (single-developer project, built with Claude Code).

---

## 3. Tech Stack

### Languages
- **Rust** — Solana on-chain programs (Anchor framework)
- **TypeScript** — frontend app, tests, scripts, crank bot, SDK
- **JavaScript** — a few ad-hoc scripts (e.g. `scripts/buy-aapl.js`)

### On-chain / Anchor
- Anchor `0.32.1`, Rust toolchain pinned via `rust-toolchain.toml`
- SPL **Token-2022** v8.0.1 (`@solana/spl-token ^0.4.14`)
- Cargo workspace at repo root; `programs/*` are the workspace members
- Release profile uses `overflow-checks = true`, `lto = "fat"` — safety-oriented build

### Frontend (`app/`)
- Vite 8 + React 19 + TypeScript 5.9
- Tailwind 4 (via `@tailwindcss/vite`)
- Solana wallet adapter (`@solana/wallet-adapter-*`) + `@solana/web3.js ^1.98`
- `@coral-xyz/anchor ^0.32.1`
- Manual Buffer polyfill in [app/src/polyfills.ts](app/src/polyfills.ts) (see §11)

### Tests
- Mocha + Chai + `ts-mocha` at repo root, invoked by `anchor test`

### External services
- **Pyth Network** — on-chain oracle for pricing + settlement (feed IDs in `scripts/pyth-feed-ids.csv`)
- **CoinGecko + Jupiter APIs** — live spot prices in the UI (replaced Pyth Hermes — see commit `4a2dfaf`)
- **Vercel** — frontend hosting
- **solmath** — on-chain Black-Scholes math library

---

## 4. Architecture

### Programs (2)

| Program | ID (same on devnet + localnet) | Purpose |
|---|---|---|
| `butter_options` | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` | Main protocol — 24 instructions |
| `butter_transfer_hook` | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` | Token-2022 transfer hook — blocks transfers after expiry |

### Instruction groups (24 total)

**Core P2P protocol (13)** — [programs/butter-options/src/instructions/](programs/butter-options/src/instructions/)
`initialize_protocol`, `create_market`, `write_option`, `purchase_option`, `settle_market`, `exercise_option`, `expire_option`, `cancel_option`, `list_for_resale`, `buy_resale`, `cancel_resale`, `initialize_pricing`, `update_pricing`

**Shared vault system V2 (11)** — same directory
`initialize_epoch_config`, `create_shared_vault`, `deposit_to_vault`, `mint_from_vault`, `purchase_from_vault`, `burn_unsold_from_vault`, `withdraw_from_vault`, `claim_premium`, `settle_vault`, `exercise_from_vault`, `withdraw_post_settlement`

### State accounts — [programs/butter-options/src/state/](programs/butter-options/src/state/)
`protocol.rs`, `market.rs`, `position.rs`, `writer_position.rs`, `pricing.rs`, `epoch_config.rs`, `shared_vault.rs`, `vault_mint.rs`

### Token-2022 extensions on every option mint
- **TransferHook** — blocks user-to-user transfer after expiry (enforced by the hook program)
- **PermanentDelegate** — lets protocol PDA burn tokens from any holder at settlement
- **MetadataPointer** — on-chain term sheet (asset, strike, expiry, type)

### Frontend — [app/src/](app/src/)
- Pages: `Landing`, `Markets`, `Trade`, `Write`, `Portfolio`, `DocsPage` ([app/src/App.tsx](app/src/App.tsx))
- Hooks: `useProgram`, `useAccounts`, `useFetchAccounts`, `useVaults`, `useTokenMetadata`, `usePythPrices`
- Utils: `blackScholes.ts`, `constants.ts`, `errorDecoder.ts`, `format.ts`, `tokenMetadata.ts`, `vaultFilters.ts`
- Feature flag: `USE_V2_VAULTS = true` in [app/src/utils/constants.ts:35](app/src/utils/constants.ts#L35)

### Data flow — user buys an option (V2 vault path)
1. User lands on `/trade`, UI loads live spot prices via `usePythPrices` (CoinGecko/Jupiter)
2. UI fetches all markets + shared vaults, runs `vaultFilters.ts` so only V2 vault markets render
3. UI computes B-S fair value client-side in `blackScholes.ts` for the grid
4. User clicks Buy → `purchase_from_vault` instruction sent
5. On-chain: vault transfers option tokens from its escrow ATA to buyer; transfer hook checks expiry; premium goes to vault
6. After expiry: admin calls `settle_market`, then either `exercise_from_vault` (ITM) or `withdraw_post_settlement` (OTM writer) finalizes
7. Crank bot ([crank/bot.ts](crank/bot.ts)) runs on 60s timer to auto-settle, auto-exercise, auto-expire

### Supporting code
- [sdk/](sdk/) — TS router SDK wrapping V2 vault flows
- [crank/bot.ts](crank/bot.ts), [crank/pricing-crank.ts](crank/pricing-crank.ts) — admin automation
- [scripts/](scripts/) — seed scripts, debug helpers, faucet setup

---

## 5. Deployments

| What | Where |
|---|---|
| Both programs | **Solana devnet**, program IDs above |
| Frontend | **Vercel**, root dir set to `app/`, SPA rewrite via `vercel.json` (exact URL: check user memory / Vercel dashboard — not hard-coded in repo) |
| Crank bot | Run manually via `npx ts-node crank/bot.ts` (devnet-only hardcoded price map for the hackathon) |
| Devnet USDC mint | `AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL` (in constants) |
| Devnet faucet wallet | Public keypair baked into [app/src/utils/constants.ts:39](app/src/utils/constants.ts#L39) — deliberately exposed for demo USDC distribution, no mainnet value |

**Environment files:** no `.env` or `.env.local` present in `app/`, repo root, or `crank/` — the app hardcodes devnet via `clusterApiUrl("devnet")` in [app/src/contexts/WalletContext.tsx:24](app/src/contexts/WalletContext.tsx#L24). `.gitignore` already blocks `.env*`, `*-keypair.json`, `id.json`, `.claude/settings.local.json`.

---

## 6. Current State — What Works

- All **24 instructions** deployed and tested on devnet
- **99 tests** across 6 suites (per CLAUDE.md + README). Suite breakdown: `butter-options.ts` (37), `pricing.ts` (19), `shared-vaults.ts` (24), `zzz-audit-fixes.ts` (13), `poc-C1-expire-before-settle.ts` (4), `token2022-smoke.ts` (2). Last reported state: **99/99 passing**. Also referenced as 93/93 in an earlier CLAUDE.md snapshot — numbers diverge because test files grew after that note. Run `anchor test` to re-confirm.
- **Full frontend** live on Vercel: Trade (Deribit-style chain), Write, Portfolio, Markets, Docs
- **On-chain Black-Scholes** pricing + 5 Greeks via solmath (~50K CU)
- **Live spot prices** via CoinGecko + Jupiter, with static fallbacks
- **Shared vault liquidity system (V2)** — the current default, driven by `USE_V2_VAULTS = true`
- **Crank bot** for auto-settle / auto-exercise / auto-expire on devnet
- Two published security audit reports in repo ([FRONTEND_AUDIT_REPORT.md](FRONTEND_AUDIT_REPORT.md), [FRONTEND_AUDIT_REPORT_2.md](FRONTEND_AUDIT_REPORT_2.md)) plus 5 rounds of Rust audit summarized in [CLAUDE.md](CLAUDE.md)

### Recent wins (last week of work)
- Pre-demo cleanup: markets + trade filtered to V2 only, collateral breakdown, fresh seed (commit `5393429`)
- Buffer polyfill fix for Vercel production builds (commit `5da2a17`)
- Vault filtering unified across all pages + on-chain metadata verified (commit `67c0d0c`)

---

## 7. Current State — In Progress / Known Gaps

### Known TODO/FIXME/HACK markers in code

| File | Note |
|---|---|
| [programs/butter-options/src/instructions/settle_market.rs:5](programs/butter-options/src/instructions/settle_market.rs#L5) | **HACKATHON NOTE** — admin passes settlement price directly instead of reading from Pyth. Pyth integration point is documented at line 55. |
| [crank/pricing-crank.ts:61](crank/pricing-crank.ts#L61) | `TODO: Replace with live Pyth price fetching before mainnet` |

### Known workarounds / fragile spots
- **Settlement** is admin-only (not permissionless) — documented as a hackathon shortcut
- **Hardcoded devnet price map** in crank bot ([crank/bot.ts:40](crank/bot.ts#L40)) — SOL $195, BTC $105k, ETH $3,600, XAU $3,100
- **Buffer polyfill** — had to write a manual `app/src/polyfills.ts` because `vite-plugin-node-polyfills` broke on Vite 8 (per memory `feedback_buffer_polyfill.md`)

### Incomplete for mainnet
- Permissionless settlement via Pyth oracle
- Live Pyth price fetching in pricing crank
- Removal of hardcoded devnet faucet/price maps

---

## 8. Key Decisions & Design Choices

- **Token-2022 over classic SPL** — needed TransferHook + PermanentDelegate + MetadataPointer to make options "self-aware" (expiry enforcement, auto-burn, on-chain term sheet). This is the protocol's core narrative.
- **Options represented as tradable tokens** — anyone holding them can exercise. Enables DEX listing and a built-in P2P resale market.
- **European-style settlement, USDC-only** — simpler to audit and price; leaves American-style for future work.
- **Two liquidity models side-by-side** — V1 isolated P2P escrow + V2 shared vaults. UI currently hides V1 (`USE_V2_VAULTS = true`) but the code is still in place.
- **On-chain Black-Scholes** via solmath — expensive (~50K CU) but enables CPI composability and AI-agent-readable pricing without trusting an off-chain oracle.
- **Admin-only settlement for hackathon** — scoped down deliberately; Pyth swap-in point documented inline.
- **Single repo, two program workspace** — `Cargo.toml` at root defines workspace, programs in `programs/*`.
- **Security:** 5 Rust audit rounds + 2 frontend audits, **18 findings fixed, 0 remaining** (per [CLAUDE.md](CLAUDE.md)). Critical/High/Medium/Low findings, exploits, and fixes are all documented with commit hashes and test names.

---

## 9. External Dependencies & People

- **Contributors:** only `nankolib` (Nanko) in git log. Per memory: non-developer biz/strategy person building entirely via Claude Code.
- **External services:** Pyth (on-chain), CoinGecko + Jupiter (UI spot), Vercel (hosting), GitHub (source), Solana devnet RPC (`clusterApiUrl("devnet")`)
- **Deadlines:** **Colosseum Frontier Hackathon — April 2026** (README line 133). Demo-ready state per latest commits. Today is 2026-04-18.

---

## 10. Immediate Next Steps

Based on recent commit momentum and open TODOs:

1. **Demo / submission polish** — most recent commits (`5393429`, `67c0d0c`) are pre-demo cleanup. Hackathon judging is the near-term gate.
2. **Live Pyth fetching in crank** — remove hardcoded price map before any mainnet talk.
3. **Permissionless settlement** — swap `settle_market` parameter for a Pyth oracle read.

No explicit blockers flagged in docs right now. The project is in "demo-ready, waiting for hackathon verdict" mode.

---

## 11. Gotchas for a New Claude / Engineer

### Environment
- **All Solana scripts run from WSL**, not Windows. Keypair lives at `/home/nanko/.config/solana/id.json`. (memory: `feedback_wsl_scripts.md`)
- **Before `anchor deploy`, sync WSL `.so` files** — otherwise you'll overwrite devnet with stale binaries. (memory: `feedback_wsl_deploy.md`)
- **Devnet clock skew:** add 30–60s buffer when waiting for expiry in test scripts. (memory: `feedback_devnet_clock_skew.md`)

### Build / runtime
- **Buffer polyfill must be imported first** in `main.tsx` via `app/src/polyfills.ts` — separate file, not `vite-plugin-node-polyfills`. (memory: `feedback_buffer_polyfill.md`)
- **800K CU compute-budget bump** needed for anything touching Token-2022 extensions + transfer hook.
- **Token-2022 ATA creation must be idempotent** in the frontend. (memory: `feedback_token2022_frontend.md`)

### Language / UX
- **Say "contracts", not "tokens"** in UI copy. (memory: `feedback_coding_style.md`)
- **Simple PowerShell instructions only** — the user runs Windows and isn't a dev.
- **Don't circle around a task** — user prefers direct action.

### Code org
- **PDA seeds are string constants** repeated in both Rust and TS — if you rename one, rename both ([app/src/utils/constants.ts:15-31](app/src/utils/constants.ts#L15-L31) mirrors the Rust seeds).
- **`USE_V2_VAULTS` feature flag** gates which flows the UI exposes. V1 code still exists but is hidden.
- **IDL generation** — `b83b23f` regenerated the IDL to reflect all 24 instructions. Re-generate after any instruction signature change.
- **Tests named `zzz-audit-fixes.ts`** run last on purpose (mocha alpha ordering) because they depend on earlier fixtures.

### Repo hygiene
- `.context/` is gitignored — contains audit outputs and PoCs, never commit
- `*-keypair.json`, `id.json`, `.env*` are gitignored — never commit secrets
- `TODO.md` (this team board) is gitignored — local coordination only
- `CLAUDE.md` is the source of truth for audit findings + fix history

### Memory files to read (at `C:\Users\pc\.claude\projects\d--claude-everything-butter-options\memory\`)
Start with `MEMORY.md` index. Key ones: `project_butter_options.md`, `project_v2_frontend_build.md`, `project_shared_vault_system.md`, `project_security_audit.md`, and all `feedback_*.md` files.

---

## TL;DR

- **Butter Options** = permissionless any-asset options on Solana using Token-2022 "living" option tokens; 2 programs, 24 instructions, full Deribit-style frontend.
- **Stage:** devnet + Vercel, hackathon-ready for Colosseum Frontier (April 2026). Not mainnet.
- **Test state:** 99/99 last reported; 5 Rust audit rounds + 2 frontend audits, 18 findings fixed, 0 open.
- **Only remaining mainnet blockers:** permissionless Pyth-oracle settlement and replacing the hardcoded devnet price map in the crank bot.
- **Biggest gotcha:** import `polyfills.ts` first in `main.tsx` or Buffer breaks on Vercel builds (`vite-plugin-node-polyfills` is broken on Vite 8).
