<!-- markdownlint-disable MD024 -->
# Migration Log — v2-Only Refactor (Items 1+2)

Tracks the structural shift from v1 P2P + v2 vaults to v2-only.
Each stage = one commit. Read in order.

The commit hash for each stage is intentionally not embedded — see
`git log` for authoritative hashes (per the durable rule against
self-referencing-paradox doc anchors). Stage commits use the form
`feat(stage-N): …` so they're trivial to locate via `git log --grep`.

## Stage 1 — Setup & Archive

Date: 2026-04-28
Commit: `git log --grep "stage-1"` (master)

### What changed

- v1 P2P instruction handlers and state types were moved out of the
  active cargo workspace into a top-level `archive/` folder. The active
  program now exposes only initialize_protocol, create_market,
  settle_market, plus the 11 v2 vault instructions. Behavior of the v2
  surface is unchanged — this stage is pure code relocation.
- The cargo workspace root now declares `exclude = ["archive"]`, so the
  archived files are never compiled even if anchor's build script
  walks the tree.
- The two crank bots (settlement bot + pricing crank) were v1-only and
  would crash on first tick after Stage 2 reshapes Market. They are
  archived now to prevent the demo state from running stale code; their
  rewrite is Item 3, not part of this refactor block.

### What was archived

10 instruction files (programs/opta/src/instructions/ → archive/v1-instructions/):

- `write_option.rs`, `purchase_option.rs`, `exercise_option.rs`,
  `expire_option.rs`, `cancel_option.rs`, `list_for_resale.rs`,
  `buy_resale.rs`, `cancel_resale.rs`, `initialize_pricing.rs`,
  `update_pricing.rs`

2 state files (programs/opta/src/state/ → archive/v1-state/):

- `position.rs` (OptionPosition account + POSITION_SEED, ESCROW_SEED,
  OPTION_MINT_SEED, PURCHASE_ESCROW_SEED, RESALE_ESCROW_SEED,
  MIN_PREMIUM_BPS, MAX_PREMIUM_BPS)
- `pricing.rs` (PricingData account + PRICING_SEED, MIN_VOL_BPS,
  MAX_VOL_BPS, RISK_FREE_RATE_SCALE)

3 crank files (crank/ → archive/cranks/):

- `bot.ts`, `pricing-crank.ts`, `README.md`

The now-empty `crank/` directory was removed.

### What was modified

- `programs/opta/src/state/mod.rs` — removed `pub mod position;`,
  `pub mod pricing;`, and the corresponding `pub use` lines.
- `programs/opta/src/instructions/mod.rs` — removed 10 v1 `pub mod`
  declarations and their matching `pub use` lines.
- `programs/opta/src/lib.rs` — removed 10 v1 handler functions inside
  `#[program] pub mod opta`. Updated the file-header instruction list
  to reflect the v2-only surface.
- `Cargo.toml` (root) — added `exclude = ["archive"]` under
  `[workspace]`.

### What was added

- `archive/README.md` — explains what's in archive/, why each piece was
  retired, and how to resurrect any of it.
- `MIGRATION_LOG.md` (this file) — Stage 1 entry.

### What to watch for if something breaks later

- If any future stage's `anchor build` fails with an unresolved
  reference to `OptionPosition`, `PricingData`, `POSITION_SEED`,
  `ESCROW_SEED`, `OPTION_MINT_SEED`, `PURCHASE_ESCROW_SEED`,
  `RESALE_ESCROW_SEED`, `PRICING_SEED`, `MIN_PREMIUM_BPS`,
  `MAX_PREMIUM_BPS`, `MIN_VOL_BPS`, `MAX_VOL_BPS`, or
  `RISK_FREE_RATE_SCALE`: that means Stage 2-onward inadvertently
  reintroduced a v1 type into a v2 file. The fix is to read the value
  from `SharedVault` (post-Stage-3) or `SettlementRecord` (post-Stage-3)
  instead — not to resurrect the v1 type.
- v1 error variants in `programs/opta/src/errors.rs` were intentionally
  left untouched in Stage 1. Stage 2 prunes them. If a v2 instruction
  references a variant whose name overlaps with a v1-only one (e.g.
  `MarketAlreadySettled`, `MarketNotSettled`), Stage 2 must keep that
  variant and reuse it for the v2 settlement check.
- The active `crank/` directory no longer exists. Anything referencing
  `crank/bot.ts` or `crank/pricing-crank.ts` (e.g. README text, package
  scripts, deploy docs) will be stale. Item 3 rewrites both — until
  then, settlement happens via direct admin calls or test fixtures.

### Verified safe

Pre-flight grep confirmed no v2 instruction (or `events.rs`, or
`utils/`) references any v1 type or constant. The 12-file move is
behavior-neutral for the v2 surface; build was green before and remains
green after.

## Stage 2 — Refactor State + create_market

Date: 2026-04-28
Commit: `git log --grep "stage-2"` (master)

### What changed

- `OptionsMarket` reshaped to be an asset registry record. Five fields
  removed: `strike_price`, `expiry_timestamp`, `option_type`,
  `is_settled`, `settlement_price`. Four kept: `asset_name`, `pyth_feed`,
  `asset_class`, `bump`. Market PDA seed reduced to
  `["market", asset_name.as_bytes()]`.
- `create_market` rewritten: admin-only, idempotent via
  `init_if_needed`, name normalization contract enforced (caller must
  pre-normalize: 1..=16 ASCII uppercase letters or digits, no
  lowercase/special chars). New 3-arg signature
  `(asset_name, pyth_feed, asset_class)`. Validates the triple against a
  hardcoded 5-asset registry (BTC/SOL/ETH/XAU/AAPL with their devnet
  Pyth pull-oracle pubkeys). Idempotent re-call with matching metadata
  is a silent Ok; mismatch reverts with `AssetMismatch`.
- `OptionType` enum stays in `state/market.rs` — `SharedVault` reuses it.
- Audit-fix M-01 cross-validations on `create_shared_vault.rs:71-73`
  retired (Market no longer carries the fields they validated against).
  The (asset, strike, expiry, type) uniqueness invariant is still
  enforced by the `SharedVault` PDA seed.
- `mint_from_vault.rs` rebound: strike, expiry, option_type now read
  from `vault.X` instead of `market.X`. Token-2022 metadata still emits
  the same key-value pairs (asset_name, asset_class, pyth_feed sourced
  from market; strike_price, expiry, option_type sourced from vault).
- `settle_vault.rs` Stage 2 transitional shape: takes
  `settlement_price: u64` as an admin-signed instruction argument
  (mirroring the deleted `settle_market`). Stage 3 will replace this
  arg with a per-(asset, expiry) `SettlementRecord` PDA read.
- `settle_market.rs` instruction file DELETED entirely. Settlement
  flow is now vault-direct in Stage 2; Stage 3 introduces
  `settle_expiry` + `SettlementRecord`.

### What was added

- `OptaError::UnknownAsset` — registry validation failure.
- `OptaError::AssetMismatch` — idempotent re-call with diverging
  metadata.
- `OptaError::UnsupportedCollateral` — staged for Stage 3 vault
  collateral_mint validation.
- Hardcoded 5-asset registry constant inside `create_market.rs`.

### What was deleted

- `programs/opta/src/instructions/settle_market.rs` (instruction file).
- 17 v1-only `OptaError` variants:
  `AlreadyInitialized`, `InvalidPythFeed`, `MarketAlreadySettled`,
  `MarketExpired`, `PositionNotActive`, `NotTokenHolder`,
  `TokensAlreadySold`, `NotListedForResale`, `AlreadyListedForResale`,
  `NotResaleSeller`, `CannotBuyOwnResale`, `CannotExpireItmOption`,
  `PremiumTooLow`, `WritePremiumTooLow`, `WritePremiumTooHigh`,
  `UnauthorizedPricingUpdate`, `VolTooLow`, `VolTooHigh`,
  `PricingCalculationFailed`, `OracleStaleOrInvalid`,
  `InvalidAssetClass`, `ExpiryMismatch`, `InvalidOptionType`.
  (Some of these were referenced only by archived v1 instructions; some
  by the deleted `settle_market`/Market cross-validations. Conservative
  variants like `MarketNotExpired`, `MarketNotSettled`,
  `InvalidSettlementPrice` were kept — Stage 3's `settle_expiry` /
  reshaped `settle_vault` will reuse them.)

### What to watch for if something breaks later

- Test suite is broken from this commit through Stage 4. Frontend is
  broken from this commit through Stage 5. Both expected.
- Anchor IDL changed shape: `OptionsMarket` is smaller, `create_market`
  takes 3 args (was 6), `settle_vault` takes 1 arg (was 0). Any
  externally cached IDL will be stale.
- `init_if_needed` was already feature-enabled in
  `programs/opta/Cargo.toml:24`; no Cargo edit required.
- `events.rs` still has 8 v1 `#[event]` declarations
  (`OptionWritten`, `OptionPurchased`, `OptionExercised`,
  `OptionExpired`, `OptionCancelled`, `MarketSettled`,
  `OptionListedForResale`, `OptionResold`, `ResaleCancelled`). They no
  longer have emitters. Not removed in Stage 2 because they don't fail
  the build; they bloat the IDL by ~20 lines. Sweep candidate for a
  later cleanup commit (post-Stage 6).
- The hardcoded asset registry in `create_market.rs` uses
  `Pubkey::from_str` at instruction-execution time. If this becomes
  hot, switch to `pubkey!` const macro — same Pubkey value, no runtime
  parse cost.

### Known architectural debt

- asset_class is metadata-only today. Pricing logic
  (blackScholes.ts, solmath bs_full_hp) keys off assetName strings,
  not asset_class. Future work: drive vol smile, default vol, and
  dividend assumptions from asset_class to remove the hardcoded
  per-ticker string matching. Not blocking for v2-only refactor.

## Stage 3 — SettlementRecord + collateral_mint

Date: 2026-04-28
Commit: `git log --grep "stage-3"` (master)

### What changed

- New `SettlementRecord` account: one PDA per (asset, expiry) tuple.
  Records the canonical settlement price set once by the admin via
  `settle_expiry`. Every `SharedVault` for that (asset, expiry) reads
  the same record during `settle_vault` — all vaults agree on the same
  price.
- New `settle_expiry` instruction: admin-only, post-expiry,
  one-shot-per-(asset, expiry). Plain `init` on the SettlementRecord
  PDA, so a second call for the same tuple reverts naturally.
- `SharedVault` gains a `collateral_mint: Pubkey` field. Stored on the
  vault so every USDC ATA-mint constraint is self-describing. USDC-only
  enforced via runtime check in `create_shared_vault`.
- `settle_vault` rewritten: dropped its Stage 2 transitional inline
  `settlement_price` argument and admin-only check. Now permissionless;
  reads price from the SettlementRecord PDA via cross-account seeds
  `[SETTLEMENT_SEED, market.asset_name.as_bytes(), &shared_vault.expiry.to_le_bytes()]`.
  If no record exists, anchor's seed validation + Account
  deserialization fails before the handler runs.
- `create_shared_vault` takes a new `collateral_mint: Pubkey` argument
  (validated against `protocol_state.usdc_mint` and
  `usdc_mint.key()`), writes it to `vault.collateral_mint`. The
  pre-existing `usdc_mint.key() == protocol_state.usdc_mint` account
  constraint stays as belt-and-braces (option (a) in the proposal).

### What was added

- `programs/opta/src/state/settlement_record.rs` (new account type +
  `SETTLEMENT_SEED` constant)
- `programs/opta/src/instructions/settle_expiry.rs` (new instruction)
- `SharedVault.collateral_mint: Pubkey` field
- 1 new handler in `lib.rs` (`settle_expiry`)

### What was modified

- `programs/opta/src/state/mod.rs` (registered settlement_record module)
- `programs/opta/src/state/shared_vault.rs` (added collateral_mint)
- `programs/opta/src/instructions/mod.rs` (registered settle_expiry)
- `programs/opta/src/instructions/create_shared_vault.rs` (added
  collateral_mint arg + 2 validations + field write + #[instruction] update)
- `programs/opta/src/instructions/settle_vault.rs` (full rewrite — drops
  price arg + admin check; adds market + settlement_record accounts)
- 6 vault-context instructions: ATA-mint constraint repointed from
  `protocol_state.usdc_mint` → `shared_vault.collateral_mint`:
  `deposit_to_vault.rs:153`, `claim_premium.rs:123`,
  `exercise_from_vault.rs:189`, `purchase_from_vault.rs:263`,
  `withdraw_from_vault.rs:178`, `withdraw_post_settlement.rs:185`
- `programs/opta/src/lib.rs` (added settle_expiry handler, updated
  create_shared_vault signature, dropped settle_vault price arg)

### What to watch for if something breaks later

- The 6 ATA-mint repoints are wire-to-wire identical effect today
  (USDC enforced everywhere, just from a different source pubkey). If
  a future caller passes a non-USDC ATA, the error will surface from
  `shared_vault.collateral_mint` rather than `protocol_state.usdc_mint`
  — same constraint message ("constraint was violated"), different
  source field.
- `create_shared_vault` clients now need to forward `collateral_mint`
  as the 5th positional arg (after `vault_type`). Frontend
  (`useWriteSubmit.ts`) still passes only 4 args — updated in Stage 5.
- `settle_vault` clients now need to provide the `market` and
  `settlement_record` accounts and drop the inline price arg. Tests
  rewritten in Stage 4.
- The SettlementRecord PDA seed includes `expiry.to_le_bytes()`. TS
  clients deriving this PDA must use the same little-endian 8-byte
  encoding (`new BN(expiry).toArrayLike(Buffer, "le", 8)`).
- `settle_vault` is now permissionless. Any caller can settle any
  vault once its (asset, expiry) record exists. This is intentional —
  reduces operator load and matches the original v2 design before the
  Stage 2 transitional shim made it admin-only.

### Edge cases handled

- Duplicate `settle_expiry` for same (asset, expiry): plain `init`
  reverts.
- `settle_vault` before `settle_expiry`: anchor seed-derives a PDA that
  doesn't exist on-chain → Account deserialization fails →
  instruction reverts.
- `settle_vault` already-settled vault: `require!(!vault.is_settled)`
  reverts with `VaultAlreadySettled`.
- `settle_expiry` pre-expiry: handler reverts with `MarketNotExpired`.
- `settle_expiry` zero price: handler reverts with `InvalidSettlementPrice`.
- `settle_expiry` non-admin signer: handler reverts with `Unauthorized`.
- `settle_expiry` for an unregistered asset: market PDA derivation
  fails (no such Market account) → instruction reverts before handler.
- `create_shared_vault` with non-USDC `collateral_mint`: handler
  reverts with `UnsupportedCollateral`.

## Stage 4 — Tests refactor + frontend audit

Date: 2026-04-28
Commit: `git log --grep "stage-4"` (master)

### What changed

- Test suite refactored to v2-only. `tests/opta.ts` reduced from 2083
  lines (95 v1 + v2 tests) to 396 lines (16 v2-only tests covering
  `initialize_protocol`, `create_market` registry validation, and
  `settle_expiry`). All v1 describe blocks deleted: write_option,
  purchase_option, cancel_option, post-expiry, list_for_resale +
  buy_resale, partial fills, Token-2022 extension verification (v1
  flow), premium-bounds (v1 write_option bounds), pricing-pda (v1
  initialize_pricing/update_pricing).
- `tests/shared-vaults.ts` and `tests/zzz-audit-fixes.ts` updated
  surgically:
  - `deriveMarketPda` helper switched to 1-seed form (extra params kept
    for API compatibility with existing call sites).
  - `deriveSettlementPda` helper added.
  - All `createMarket(...)` calls switched to 3-arg signature with the
    real Solana Pyth feed pubkeys (`REGISTRY.SOL` from the on-chain
    Stage 2 hardcoded registry).
  - `admin: payer.publicKey` field renamed to `creator: payer.publicKey`
    in createMarket account blocks.
  - All `createSharedVault(...)` calls now pass `usdcMint` as the new
    5th positional `collateral_mint` argument.
  - All `settleMarket(...)` calls (4 sites) replaced with
    `settleExpiry(assetName, expiry, price)` calls. The corresponding
    `settleVault()` calls drop their old `protocolState` account ref
    and add `settlementRecord` (Stage 3 SettlementRecord PDA).
  - All zzz-audit-fixes.ts test scenarios switched to SOL-for-all per
    Stage 4 design decision. Strike values differentiated per describe
    block ($100 / $110 / $120 / $130 / $140 / $150) so vault PDAs stay
    unique under the asset-only Market PDA. Two deposits bumped to
    accommodate the new strikes (CRITICAL-01-OTM at $110 needs $1200
    deposit for 5 contracts; HIGH-01 at $120 needs $1300).
  - `tests/poc-C1-expire-before-settle.ts` deleted entirely (412 lines,
    v1-only PoC).
  - `tests/pricing.ts` and `tests/token2022-smoke.ts` unchanged — pure
    JS / pure Token-2022 tests with no opta program calls.
- TypeScript IDL strict-typing escape: every `program.methods` call in
  `shared-vaults.ts` and `zzz-audit-fixes.ts` cast to
  `(program as any).methods` to bypass anchor 0.32's strict
  `ResolvedAccounts` typing. Pragmatic test-file workaround that
  preserves runtime correctness; production code (frontend) will use
  proper IDL types in Stage 5.
- New tests added per Stage 4 plan:
  - `create_market`: idempotent, idempotent-mismatch (AssetMismatch),
    non-admin (Unauthorized), unknown asset (UnknownAsset), lowercase
    name (InvalidAssetName), empty name (InvalidAssetName), second
    asset (BTC).
  - `settle_expiry`: pre-expiry reject (MarketNotExpired), zero-price
    reject (InvalidSettlementPrice), non-admin reject (Unauthorized),
    unregistered-asset reject (market PDA fails), happy-path post-expiry
    record creation, double-settle reject (init duplicate).
  - `create_shared_vault`: non-USDC collateral_mint reject
    (UnsupportedCollateral) — uses real USDC for `usdc_mint` account
    so the line-149 constraint passes, but a fake pubkey for the
    `collateral_mint` arg so the handler-body check fires first.
  - `settle_vault`: missing-SettlementRecord reject (anchor seed
    validation fails before handler).

### What was added

- 13 net-new test cases across opta.ts (12) and shared-vaults.ts (1).
- TS asset-registry constants in opta.ts, shared-vaults.ts, and
  zzz-audit-fixes.ts mirroring the on-chain hardcoded list.
- `deriveSettlementPda(assetName, expiry)` helpers in shared-vaults.ts
  and zzz-audit-fixes.ts.
- This file got `<!-- markdownlint-disable MD024 -->` at the very top
  to silence the duplicate-heading warnings each stage entry produces
  (each stage uses the same locked template — duplicates by design).

### What was deleted

- `tests/poc-C1-expire-before-settle.ts` entirely (v1 PoC, 412 lines).
- ~1700 lines of v1 describe blocks from `tests/opta.ts`.

### What to watch for if something breaks later

- `anchor test` itself fails to start the validator on this Windows/WSL
  setup ("Unable to get latest blockhash" — the validator initializes
  successfully but anchor's startup-detection times out). Workaround:
  run `solana-test-validator` manually with the BPF programs loaded,
  then run `npx ts-mocha` directly with `ANCHOR_PROVIDER_URL` and
  `ANCHOR_WALLET` env vars set. Documented in this entry for future
  stages — Stage 6 deploy uses `anchor deploy` (different code path)
  which is known to work.
- The `(program as any).methods` casts in shared-vaults.ts and
  zzz-audit-fixes.ts work around anchor's strict IDL typing. If the
  IDL changes shape again (e.g. Item 4 adding new instructions), the
  TS strictness won't catch missing/extra account fields in those
  files. Verify against the IDL by hand or revert to typed `.accounts`
  for new test code.
- Asset rotation in zzz-audit-fixes.ts: every audit-fix test now uses
  `"SOL"` on-chain. The `setupVaultScenario` helper logs the original
  test label (e.g. "CITM") but the on-chain identity is always SOL.
  If a future test author adds a new describe block, they must pick a
  unique strike (≥ $160 to avoid colliding with $100-$150) to keep
  the vault PDA unique within the same test run.
- `Anchor.toml` `bind_address = "127.0.0.1"` and `startup_wait = 60000`
  restored to original values after debug attempts. Neither change
  fixed the anchor test issue. If `anchor test` is needed in the
  future, try removing bind_address or setting startup_wait to a
  large value (120000+).

### Verification

- 73 tests passing, 0 failing under the manual-validator + ts-mocha
  workaround. Test-count breakdown:
  - opta.ts: 16 (Stage 4 v2-only)
  - shared-vaults.ts: 23 (Stage 3 + Stage 4 collateral_mint test)
  - zzz-audit-fixes.ts: 13 (Stage 3 settle path + Stage 4 strike
    differentiation)
  - pricing.ts: 19 (unchanged)
  - token2022-smoke.ts: 2 (unchanged)
- Test count delta: 73 vs original 95. Reduction is entirely from v1
  surface deletion, not from skipped tests. Every v2 path that had
  test coverage before still has coverage; new SettlementRecord and
  collateral_mint paths got new coverage.

### Stage 5 audit deliverable

`/tmp/STAGE_5_PLAN.md` produced with full file:line edit map for the
frontend refactor. Identified ~30-40 frontend edit operations split
into Stage 5a (IDL + write/create flows) and Stage 5b (read-side +
portfolio). Open question flagged: AdminTools.tsx keep-or-delete
decision needed before Stage 5b.

## Stage 2-amend-lite — Strip hardcoded registry and admin gate

Date: 2026-04-28
Commit: `git log --grep "stage-2-amend-lite"` (master)

### Why amend-lite, not full Pyth Pull migration

Stage 2's create_market gated calls to admin only and validated
(asset_name, pyth_feed, asset_class) against a hardcoded 5-entry
SUPPORTED_ASSETS array. Pre-amendment verification (this session)
discovered that the legacy Pyth push oracle this design depended on
is dead on devnet:

- Pyth officially sunsetted the legacy push oracle on **2024-06-30**
  (per [Pyth Pull Oracle Launches on Solana blog post](https://www.pyth.network/blog/pyth-network-pull-oracle-on-solana))
- Devnet feed accounts (SOL `J83w...`, BTC `HovQ...`) have been
  **frozen since 2024-08-30** — verified empirically with 5 reads
  ~12s apart all returning identical timestamps (1724967841)
- ETH/XAU/AAPL pubkeys hardcoded in the frontend SUPPORTED_ASSETS
  table don't even exist on devnet (`AccountNotFound`)

A full migration to the Pyth Pull oracle (pyth-solana-receiver-sdk
PriceUpdateV2 accounts, 32-byte hex feed IDs, off-chain Hermes
client) is the right answer but requires a dedicated session — too
much new architecture (ephemeral price-update accounts, staleness
enforcement, admin migrate_pyth_feed instruction, crank rewrite
against Hermes) to fold into this block.

This amend-lite leaves create_market in an honest placeholder state
until that session lands.

### What changed

- `create_market`: removed admin signer check; removed SUPPORTED_ASSETS
  array; removed registry_matches helper; removed UnknownAsset revert.
  Added an explicit `asset_class <= MAX_ASSET_CLASS` check (was
  implicit-via-registry before; now explicit since registry is gone).
- Top-of-file doc comment rewritten to describe the placeholder state
  and reference the upcoming Pyth Pull session.
- Per-handler `///` comment block added explaining: pyth_feed stored
  opaquely without on-chain validation, settle_expiry continues to use
  admin-mocked prices, next session migrates to Pyth Pull.

### Errors

- Removed: `OptaError::UnknownAsset` (no longer triggered)
- Re-added: `OptaError::InvalidAssetClass` (was pruned in original
  Stage 2 alongside other v1-only variants because the registry made
  the check redundant; now needed as an explicit check)

### Tests

- Deleted: `it("rejects non-admin signer (Unauthorized)")` from the
  `create_market` describe block — admin gating is no longer the
  design.
  - Note: the `it("rejects non-admin signer (Unauthorized)")` test in
    the `settle_expiry` describe block STAYS — settle_expiry remains
    admin-only (Stage 3 design, unchanged).
- Deleted: `it("rejects unknown asset / wrong Pyth feed (UnknownAsset)")`
  — registry is gone, can't trigger the error.
- Tightened: `it("idempotent re-call with different feed reverts
  AssetMismatch")` — was tolerantly accepting either UnknownAsset or
  AssetMismatch; now strictly asserts AssetMismatch (the only correct
  outcome).
- Added: `it("anyone can create a market — permissionless")` — uses a
  non-admin keypair, asset name "TEST", `SystemProgram.programId` as
  a stand-in pyth_feed pubkey. Demonstrates the new permissionless
  contract.

### What did NOT change

- Stage 3 SettlementRecord / settle_expiry / settle_vault /
  collateral_mint — independent of the Pyth question, untouched.
- Stage 4 test infrastructure — manual ts-mocha workflow unchanged.
- Frontend — `SUPPORTED_ASSETS` still has 5 entries with phantom
  ETH/XAU/AAPL pubkeys. Per the user's spec, Stage 5 picks up the
  frontend after Pyth Pull lands.
- Cargo.toml — `pyth-solana-receiver-sdk = "1.1.0"` already present
  from earlier work; will be used in the next session.

### Verification

- 72 tests passing (was 73 before amend-lite). Delta: -1 admin test
  -1 unknown-asset test +1 permissionless test = net -1.
- anchor build green.
- Manual ts-mocha workflow confirmed (anchor test still broken on
  this WSL setup, per Stage 4 finding).

### Known abuse vector (deferred)

With admin gating removed and no Pyth validation, anyone with ~0.01
SOL on devnet can spam Market PDAs ("AAAA", "AAAB", ...). Mitigation
options for the Pyth Pull session: (a) per-asset rent burn at
create_market, (b) restore admin gating once we have a real
validation gate, (c) leave permissionless and accept the spam risk
on a public protocol. Locked decision deferred to next session.

### Open Items 3 + 4 picture

Both depend on Pyth Pull being real first:

- Item 3 crank: must iterate all OptionsMarket PDAs dynamically
  (locked decision from today — no hardcoded asset list), pull fresh
  Hermes price updates, call settle_expiry, sweep vaults.
- Item 4 v2 resale: VaultResaleListing PDA, three new instructions,
  requires settled vaults to behave cleanly.

## Stage P2 — settle_expiry consumes PriceUpdateV2, permissionless

Date: 2026-04-28
Commit: `git log --grep "stage-p2"` (master)

### What changed

- `settle_expiry` rewritten:
  - Drops the inline `price: u64` argument
  - Drops the admin-only signer check — now permissionless
  - Adds `price_update: Account<'info, PriceUpdateV2>` to the accounts
    struct (from `pyth-solana-receiver-sdk` 1.1.0, already in Cargo.toml)
  - Drops `protocol_state` from the accounts struct (no admin check)
  - Renames `admin` field to `caller`
  - Body calls `price_update.get_price_no_older_than(&clock,
    PYTH_MAX_AGE_SECS, &market.pyth_feed_id)` which enforces (in one
    call) feed_id match (`MismatchedFeedId`), publish_time freshness
    (`PriceTooOld`), and verification level == Full
    (`InsufficientVerificationLevel`)
  - Adds `pub const PYTH_MAX_AGE_SECS: u64 = 300` at top of the file
  - Reuses `crate::utils::solmath_bridge::pyth_price_to_usdc` to
    normalize Pyth's `(i64 price, i32 exponent)` to USDC 6-dec u64.
    `solmath_bridge.rs` was dead code from Stage 1; it's now
    load-bearing again.

### Test infrastructure (new)

- `tests/_pyth_fixtures.ts`: deterministic Borsh serializer for
  PriceUpdateV2 + matching deserializer (self-consistency roundtrip).
  No new npm deps — uses Node built-ins only.
- `tests/_write_fixtures.ts`: CLI entry point that emits 5 fixture
  JSON files under `/tmp/pyth_*.json` and prints the
  `--account <PUBKEY> <FILE>` arguments solana-test-validator needs.
- `tests/opta.ts`: added a "pyth fixture roundtrip" describe block as
  the first test. Catches Borsh layout drift in the serializer before
  any settle_expiry test runs.
- 5 fixtures pre-loaded at validator startup:
  - `sol-180-fresh` (publish_time = launch-time - 30s)
  - `sol-180-stale` (publish_time = launch-time - 400s)
  - `btc-fresh` (BTC feed_id, used for wrong-feed test)
  - `sol-250-fresh` (zzz CRITICAL-ITM)
  - `sol-50-fresh` (zzz CRITICAL-OTM, HIGH-01, DUST)

### Test runner workflow (new)

`anchor test` is still broken on Windows/WSL (Stage 4 finding). The
manual ts-mocha workflow now requires a fixture-write preflight:

```bash
cd /mnt/d/claude\ everything/butter_options

# 1. Preflight — write 5 fixtures + capture --account args
PYTH_ARGS=$(npx ts-node tests/_write_fixtures.ts)

# 2. Launch validator with fixture --account flags + program flags
rm -rf .anchor/test-ledger
solana-test-validator --reset --quiet \
  --bpf-program CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq target/deploy/opta.so \
  --bpf-program 83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG target/deploy/opta_transfer_hook.so \
  $PYTH_ARGS \
  --ledger .anchor/test-ledger > /tmp/validator.log 2>&1 &
sleep 15

# 3. Run tests
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
  ANCHOR_WALLET=/home/nanko/.config/solana/id.json \
  npx ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"
```

The fixture file timestamps are wall-clock-relative; regenerating
before each test run keeps the "fresh" / "stale" distinction valid.

### Test changes per file

- `tests/opta.ts`: settle_expiry describe rewritten end-to-end.
  Deleted: `rejects zero price (InvalidSettlementPrice)`,
  `rejects non-admin signer (Unauthorized)`. Added: `rejects stale
  PriceUpdateV2 (PriceTooOld)`, `rejects wrong-feed PriceUpdateV2
  (MismatchedFeedId)`. Plus the new fixture-roundtrip smoke test.
- `tests/zzz-audit-fixes.ts`: 4 settleExpiry call sites updated
  (drop price arg, swap `admin` for `caller`, drop `protocolState`,
  add `priceUpdate` referencing the matching SOL_*_FRESH fixture).

### Errors

No new variants. All failure modes propagate via existing types:

- `OptaError::MarketNotExpired` — pre-expiry call (unchanged)
- `OptaError::InvalidSettlementPrice` — `price <= 0` after Pyth read
  (rejected inside `solmath_bridge::pyth_price_to_usdc`)
- `OptaError::MathOverflow` — exponent normalization overflow
- `GetPriceError::PriceTooOld` (Pyth, error code 10000+) — staleness
- `GetPriceError::MismatchedFeedId` — feed_id mismatch
- `GetPriceError::InsufficientVerificationLevel` — partial-verification
  rejection (only triggered if a fixture sets verification_level to
  Partial; our fixtures all use Full)

### What did NOT change

- `OptionsMarket.pyth_feed_id` still `[u8; 32]` (P1 shape preserved)
- `errors.rs` — no new variants
- `Cargo.toml` — no new deps (Receiver SDK already there from earlier)
- `package.json` — no new deps (fixture helper uses Node built-ins)
- `tsconfig.json` — unchanged (BigInt literals avoided via `BigInt(...)`
  ctor calls; ES6 target preserved)
- All other instruction files — untouched
- Frontend — broken since P1, fixed in P4

### Verification

- 73 tests passing (was 72; +1 from fixture-roundtrip smoke test).
- anchor build green.

### What to watch for if something breaks later

- The fixture roundtrip smoke test runs FIRST in the suite. If it
  fails, every settle_expiry test fails downstream — fix the
  serializer in `_pyth_fixtures.ts` first, then re-run.
- The Pyth Receiver SDK's `PriceUpdateV2` struct layout could change
  in a future SDK version. If the on-chain code starts rejecting
  fixtures even though the smoke test passes, that's the signal — the
  serializer matches itself but no longer matches the SDK.
- Fixture timestamps are launch-time-relative. If a test run takes
  more than ~10 minutes (validator + fixture preflight + all tests),
  the "fresh" fixture (-30s at launch) could drift past the 300s
  staleness threshold by the end. Mitigation: keep test runs fast
  (current full run is ~2 minutes).
- `solmath_bridge.rs` was dead code from Stage 1 onward; P2 brings it
  back to life via `pyth_price_to_usdc`. If P0's Investigation 6 was
  wrong about the helper's correctness, the smoke test catches it.

### Next session preview (Stage P3)

- New `migrate_pyth_feed` admin instruction for the rare case where
  Pyth rotates a feed_id. Single-line update of
  `OptionsMarket.pyth_feed_id`. Admin-gated.

Neither can begin until create_market has its Pyth Pull shape
locked.

---

## Stage P3 — `migrate_pyth_feed` admin instruction (2026-04-28)

A one-shot admin-only instruction to rotate the `pyth_feed_id` on an
existing `OptionsMarket`. Intended for the rare case where Pyth retires
or re-issues a feed (e.g. asset re-listing). 99% of the time this
instruction is never called; markets are immutable in practice.

### Why this exists

Stage P2 made `OptionsMarket.pyth_feed_id` the single source of truth for
which Pyth feed `settle_expiry` consumes. Without a migration path, a
feed retirement upstream would orphan every market for that asset.

### What changed

- `programs/opta/src/instructions/migrate_pyth_feed.rs` (new ~75 lines):
  - Handler `handle_migrate_pyth_feed(ctx, asset_name, new_pyth_feed_id)`.
  - Admin gate: `require_keys_eq!(admin.key(), protocol_state.admin,
    OptaError::Unauthorized)`. Reuses the existing `Unauthorized`
    variant — no new error code.
  - Idempotent: if `market.pyth_feed_id == new_pyth_feed_id`, returns
    `Ok(())` silently. Otherwise overwrites and logs the rotation.
  - No `PriceUpdateV2` in context — pure registry mutation, no oracle
    consultation. The next `settle_expiry` call picks up the new
    feed_id naturally.
- `programs/opta/src/instructions/mod.rs`: added `pub mod
  migrate_pyth_feed;` and `pub use migrate_pyth_feed::*;` alongside
  `settle_expiry`.
- `programs/opta/src/lib.rs`: added the dispatch wrapper after
  `settle_expiry` (~10 lines).
- IDL regenerated and copied to `app/src/idl/{opta.json,opta.ts}`
  (frontend wiring follows in Stage P4).

### Test changes

`tests/opta.ts`: new `describe("migrate_pyth_feed")` block placed AFTER
`settle_expiry` so SOL-dependent tests run first against an unrotated
feed_id. Four tests:

1. Admin migrates BTC feed_id to a new value (verifies pre/postcondition
   on `OptionsMarket.pythFeedId`).
2. Idempotent re-call with same feed_id (no-op, `Ok` silently).
3. Rejects non-admin signer — funds a fresh `Keypair`, expects
   `Unauthorized`.
4. Rejects nonexistent market — passes a `GHOST` PDA that was never
   initialized; Anchor's account validation rejects before the handler
   runs.

BTC was chosen for the happy-path mutation because no other test
in the suite reads BTC's `pyth_feed_id` after creation. SOL, by
contrast, has dependent tests in both `opta.ts::settle_expiry` and
`zzz-audit-fixes.ts` that would break if rotated.

### Tooling tweak

`tests/_write_fixtures.ts` updated:

- Now accepts `outDir` from `process.argv[2]` or `OPTA_FIXTURE_DIR`
  env var (default `/tmp`). Mitigates WSL2 auto-clearing `/tmp`
  between sessions — fixtures can live in `~/.opta_fixtures` instead.
- CLI body wrapped in `if (require.main === module) { ... }` because
  ts-mocha globs `tests/**/*.ts` and imports this file before tests
  run; without the guard the import would try to write fixtures into
  `mocha`'s argv[2] (which is `--require`) and crash the suite.

### What did NOT change

- `state/market.rs` — `pyth_feed_id` field shape unchanged.
- `errors.rs` — no new variants (reuses `Unauthorized`).
- `Cargo.toml` / `package.json` — no new deps.
- All other instructions — untouched.
- Frontend — Stage P4 (still broken since P1).

### Verification

- 77 tests passing (was 73; +4 from new `migrate_pyth_feed` block).
- anchor build green.

### Next session preview (Stage P4)

- Frontend rebuild for new IDL shape: NewMarketModal,
  useWriteSubmit, useFetchAccounts, read-side files. ~30-40 edits.
- Stage P5: deploy to devnet + reseed + update HANDOFF.md.
