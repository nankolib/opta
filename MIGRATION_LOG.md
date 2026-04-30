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

---

## Operational issue logged 2026-04-28 — Solana public devnet RPC rate-limiting

During the P4c smoke test the public devnet endpoint
`https://api.devnet.solana.com` returned HTTP 429 (rate-limited) on
several `getProgramAccounts` calls fired by `safeFetchAll`. The frontend
currently has no retry / fallback wired, so a 429 surfaces as a
load-time fetch failure (Markets/Trade/Portfolio show empty rows).

**Not blocking P4d.** Documenting here so we pick a remediation in P4e
or P5 before any public demo.

### Remediation options (one decision needed)

1. **Switch the default RPC endpoint.** Helius, QuickNode, and Alchemy
   all hand out devnet endpoints with much higher limits on free tier.
   Lowest-effort fix — change one URL in the provider config and add
   the API key as a Vercel env var. Trade-off: introduces an external
   service dependency the user has to provision.

2. **Add exponential-backoff retry.** Wrap `safeFetchAll`'s
   `connection.getProgramAccounts` call in a retry loop that re-attempts
   on 429 with a small backoff (e.g. 250ms → 500ms → 1s → give up after
   3 tries). Keeps the public RPC, just makes us a friendlier consumer.
   Trade-off: slower load when limits are hit; doesn't help under
   sustained load.

3. **Reduce concurrent RPC calls.** Today every page that needs both
   markets + positions + vaults + vault mints fires those concurrently
   via `Promise.all`. Serializing or batching them via `getMultipleAccountsInfo`
   would cut RPC load. Trade-off: more invasive refactor across multiple
   hooks; partial benefit only.

### Resolution — 2026-04-28 (P4c-rpc-hotfix, commit ba4fb79)

**Status: RESOLVED.** Adopted Option 1 (switch RPC endpoint). The
frontend now reads `VITE_RPC_URL` from `app/.env.local` at Vite
build/dev startup and falls back to `clusterApiUrl("devnet")` if
unset (see `app/src/contexts/WalletContext.tsx`). The `.env.local`
file is gitignored via `app/.gitignore`'s `.env*` glob; an
`.env.example` is committed alongside as documentation of the
expected variable name (no real key in it). The Helius URL itself
never enters the repo or any chat.

Option 2 (exponential-backoff retry) is not implemented — the
endpoint switch fully eliminates 429s under demo-scale load, so
the retry layer is unnecessary for now. Option 3 (concurrent-RPC
reduction) remains a P5+ optimisation candidate independent of
this issue.

Recommended pairing: **(1) + (2)**. Switch to a free-tier provider for
demo reliability, keep retry logic as a backstop. Park option (3) for
when we're at production scale.

---

## Stage P4c hotfix 2026-04-28 — Hermes-Beta catalog URL

The P4b catalog fetch used `/v2/price_feeds?asset_type=all`, which
Hermes rejects with HTTP 400 (`"all"` is not a valid asset_type variant
— Hermes recognises `crypto`, `fx`, `equity`, `metal`, `rates`,
`commodities`, `crypto_redemption_rate`, `crypto_index`, `crypto_nav`,
`eco`, `kalshi`). Phase 0 never live-probed this exact URL, so the bug
landed unnoticed until the P4c smoke test.

**Fix:** drop the query parameter entirely; bare `/v2/price_feeds`
returns the full multi-class catalog with the same response shape
`parseEntries` already handles. Plus added a `console.error` on the
cold-start no-cache failure path so DevTools shows the underlying
network error instead of leaving the modal looking hung.

Single-file change to `app/src/utils/hermesCatalog.ts`.

---

## Stage P4d — Permissionless settle button (2026-04-29)

Replaced the broken admin-only `settleMarket(price)` flow with a
permissionless Pyth Pull settle button on the Portfolio page. Clicking
"Settle" on any expired (asset, expiry) tuple submits an atomic tx
that posts a fresh Hermes `PriceUpdateV2` and calls `settle_expiry`
to create the canonical `SettlementRecord` PDA. The same click then
fires N batched `settle_vault` IXs (chunked at 5 per tx) to flip
every vault's `is_settled` flag.

The client-side `settle_vault` batching is the **temporary manual
replacement for the not-yet-built crank bot**. Once a crank exists
(post-Colosseum), Phase 2 of `settleAllForExpiry` becomes redundant —
the crank watches for `SettlementRecord` events and fires
`settle_vault` per vault in the background. Phase 1 (the atomic
Pyth tx) stays user-triggered either way.

Resume path: if the atomic tx already ran on a previous attempt
(`SettlementRecord` exists but some vaults still have
`is_settled = false` due to a partial-failure mid-batch), clicking
"Settle" again skips Phase 1 and only runs Phase 2 against the
remaining stuck vaults. The confirmation modal heading flips from
"Settled" to "Resumed" in that case.

Files touched:

- NEW `app/src/utils/pythPullPost.ts` (~270 lines): Pyth SDK wrapper
  around `addPostPriceUpdates` (atomic via `closeUpdateAccounts: true`),
  plus the `settleAllForExpiry` orchestrator.
- REWRITE `app/src/components/portfolio/AdminTools.tsx`: dropped admin
  gate, dropped manual price input, dropped loss-color "danger zone"
  framing. Tuple-grouped UI with post-click confirmation modal.
- RENAME `app/src/pages/portfolio/AdminToolsSection.tsx` →
  `SettleExpiriesSection.tsx`: dropped `protocolState.admin` gate;
  section title now "Settle expired markets".
- MODIFY `app/src/pages/portfolio/PortfolioPage.tsx`: eager
  `safeFetchAll` for `settlementRecord` accounts; pass to renamed
  section.
- MODIFY `app/src/hooks/useFetchAccounts.ts`: added
  `settlementRecord` to the discriminator hardcode and `AccountName`
  union (discriminator: `[172, 159, 67, 74, 96, 85, 37, 205]` =
  `sha256("account:SettlementRecord")[..8]`).
- New npm dep: `@pythnetwork/pyth-solana-receiver` `0.14.0` (exact
  pin via `-E`).

Known minor UX: while the confirmation modal is open, other "Settle"
buttons in the list remain technically clickable through the
overlay. Not blocking; deferred to P4e polish.

---

## Stage P5 — Devnet redeploy on Pyth Pull IDL (2026-04-29)

Both Solana programs upgraded to the post-P4e source. After P1/P2/P3 the
on-chain `opta` binary still expected the old `settle_expiry(price)`
admin-only shape; the new frontend's permissionless settle button would
have hit `InstructionDidNotDeserialize` until this deploy.

### Deploys

| Program | Program ID | Tx signature | Slot |
| --- | --- | --- | --- |
| opta | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` | `5qMtBLJApp2zRoor3HW4SN469vV1ykLJcQxPVx8CCGroCdLetxYJ557eiNCtWvSVmotAjdpdboDi76aUv1qUAafq` | 458866752 |
| opta_transfer_hook | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` | `PKoAnn54EYZERoCZD3N8xeqAe73uiE4d68TVSxv34bi8DiiEGH3GN8Agq3bvfDZoL833xGvd9tXXZ4KqbcMmzss` | 458867413 |

Both program IDs preserved (in-place upgrade via `solana program deploy
--program-id`); upgrade authority unchanged
(`5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk`). No frontend constants
required updating; IDL files in `app/src/idl/` were already in sync with
`target/idl/` (last copied during P3 commit `baea0a6`, untouched since).

### Cost

- opta upgrade: 0.00357 SOL (24s deploy duration)
- opta_transfer_hook upgrade: 0.00118 SOL (19s deploy duration)
- Total: **0.00475 SOL**

Cost was minimal because both programs were upgrades (existing
ProgramData accounts reused) rather than fresh deploys. Helius RPC kept
buffer-write rounds tight — typical public-devnet-RPC deploys for this
binary size run 1-5 minutes; both came in under 25 seconds.

### opta_transfer_hook diff context

Pre-deploy sha256 differed between local build and on-chain (1.09% of
bytes, distributed across `.text` section). Source had no logic
changes since the last on-chain deploy — only Phase 2 cosmetic renames
(commits `f51cb45` + `bb89a4a`). The byte differences were almost
certainly compiler emit-order non-determinism (same instructions,
different basic-block ordering). Redeployed anyway under the principle
that for a hackathon demo, a fraction of a SOL beats carrying any
uncertainty about a Token-2022 transfer hook that mediates every
option-token transfer.

### What now lives on devnet

- `settle_expiry(asset_name, expiry)` consumes a `PriceUpdateV2`
  account and is permissionless (P2 shape).
- `migrate_pyth_feed(asset_name, new_pyth_feed_id)` admin instruction
  available (P3).
- `OptionsMarket.pyth_feed_id` is `[u8; 32]` (P1 shape); legacy
  `pyth_feed: Pubkey` is gone.
- `create_market(asset_name, pyth_feed_id, asset_class)` permissionless
  and idempotent (Stage 2-amend-lite).
- `create_shared_vault` requires `collateral_mint: Pubkey` as the 5th
  positional arg (Stage 3).

### Operational housekeeping

- Three orphaned write-buffer accounts owned by our wallet exist on
  devnet from earlier deploy sessions (not P5). All have 0 SOL balance,
  no rent to recover. Cleanup is `solana program close <buffer-pubkey>`
  later if desired; not blocking.
- `solana config` was switched from `localhost:8899` to
  `https://api.devnet.solana.com` for the deploy. Switch back to
  localhost if running local validator tests.

### Smoke handoff

Live tx behavior post-deploy is the user's to verify:

1. Connect wallet on the dev server.
2. Markets → "+ New Market" → pick a Pyth-cataloged asset → create.
3. Write → pick the new market → write an option.
4. Wait for expiry (or pick a near-term test).
5. Portfolio → click Settle on the expired tuple.
6. Confirm the settle modal shows price + tx signature.

## Test harness gotchas (discovered Step 2 of auto-finalize, commit d0edd10)

Three things to know before running the test suite on this machine, all learned the hard way during the holder-side test work.

The `anchor test` command does not work on the current WSL setup. Anchor's "validator did not start" timeout fires even when `solana-test-validator` is actually up and accepting RPC — the `.anchor/test-ledger/validator.log` shows a healthy startup, but Anchor's harness gives up before noticing. Use the manual fixture-write + `ts-mocha` invocation chain documented earlier in this log instead.

Pyth Pull oracle price updates expire after 300 seconds. The `settle_expiry` instruction consumes a `PriceUpdateV2` account whose `publish_time` was set at fixture-generation time, and the on-chain check rejects updates older than five minutes (`PriceTooOld`, Pyth Receiver error 16000). If fixture-write and test-run happen in separate `wsl -- bash -lc` invocations more than roughly five minutes apart, the late-running tests in the suite fail in cascade: `PriceTooOld` on `settle_expiry` means no `SettlementRecord` is ever written, which means `settle_vault` reverts with `AccountNotInitialized`, which means downstream `exercise_from_vault` / `withdraw_post_settlement` revert with `VaultNotSettled`. The cascade can look like a code regression but is purely a fixture-staleness artifact. Chain fixture-write and test-run in a single shell session to keep `publish_time` fresh through the whole run.

The `.test-fixtures/run-tests.sh` helper (committed in d0edd10, with the `.test-fixtures/` directory itself gitignored) does the chaining correctly: it rewrites all five Pyth fixtures, launches the validator with the matching `--account` flags, waits for RPC readiness, runs the requested test files, and kills the validator on exit. Future sessions running the suite should use it as the reference workflow rather than reinventing the orchestration each time.

## Step 6 smoke results — auto-finalize on devnet (2026-04-30)

End-to-end smoke of the auto-finalize arc against Solana devnet. Deploys the post-Step-5 program, settles a fresh ITM vault, runs the crank live, finalizes three real vaults (the Apr 29 vault, the fresh ITM vault, and one leftover settled-but-unfinalized vault from earlier devnet activity), confirms post-state matches expectations.

### Phase 1 — deploy

| Field | Value |
|---|---|
| Program | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` |
| Pre-deploy slot | `458866752` (matches the post-Stage-P6 slot in HANDOFF.md) |
| Post-deploy slot | `459143156` |
| Deploy tx sig | `GSCPwhHmTYXECL6FVAZerdEh65A8eudd6ZV6JUVA6HY5cY2aN54Kpkfk2dCHcizLxyphfYPHRAY9GxXjs9cXQsH` |
| Authority | `5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk` (operator wallet) |
| Net cost | ~0.004 SOL fees; program rent reused |

The new binary fits the existing 1,178,384-byte ProgramData allocation, so no rent reallocation was needed. The new instruction surface (`auto_finalize_holders`, `auto_finalize_writers`) is now live and callable on devnet — the on-chain handlers correspond exactly to commits a7924d2 + ecdc7a3 + 9069441.

### Apr 29 vault (`DsFhwmU4ph4yLz4QXUCHUF8qcW4urneQiqjXYJBJPStW`) — before / after

| Field | Pre (Phase 2) | Post (Phase 7) |
|---|---|---|
| `is_settled` | true | true |
| `settlement_price` | $83.001853 | $83.001853 |
| `total_shares` | 3,600,000,000 | 0 |
| `collateral_remaining` | $3,600 | $0 |
| `vault_usdc_account` (`5BceHXHV…`) | alive, $3,600.000005 | **closed** |
| Buyer (`DnExEYn…`) option ATA | 5 tokens | 0 tokens |
| Buyer USDC ATA | $81,400.883208 | $82,200.883208 (+$800 — see footnote) |
| Operator (writer, `GkG1UX8…`) USDC ATA | $996,399.761435 | $999,999.761439 (+$3,600.000004 = $3,600 collateral + ~$0.000004 premium) |
| Operator wallet SOL | 29.973577781 | 29.975422181 (+0.001844 SOL = `writer_position` rent) |
| Writer position (`9QJRHDw…`) | alive, shares = 3.6 B | **closed** |

The +$800 to the buyer's USDC ATA is **not from this vault** — `DnExEYnZGuEu7xgpmNupJVXJLbMbkNdf3E7f28Zv6LUQ` happens to be both the buyer of the Apr 29 vault AND the writer of the third leftover vault `6DbpdnqycE2zUgxArEHqZwj2gLT5Z4TdWW6FNrsBLzVi`, where they had deposited $800 with no options ever minted. The writer pass on the third vault refunded that full $800 deposit; the holder pass on the Apr 29 vault burned the 5 OTM tokens with zero USDC movement (correct OTM call behavior — settlement $83.00 < strike $90 → payout 0). Verified by tracing the writer-finalize tx for the third vault (`4dqPZcAxFeQ9JaGRbe4HMPCR8n7Ej3T1UxR5GzCbzPN63se8EnjKseNSGQ6MWkjMcxUKs3aK9HAMjXh7av8pDGqV`): preTokenBalances show $800 in the third vault's USDC, postTokenBalances show that $800 moved to DnExEY's USDC ATA.

Major tx sigs from Phase 6 for this vault:

- Holder pass (burn 5 tokens, no USDC): `2HHdbU6CE3v4NsNB1opgsCfA3K164qtVWBgmVARcgNBqktxphnmGihd6i4Bgeytst7Cz3WdgtjgBAEFzU4YCTyk8`
- Writer pass (claim $3,600 + premium, dust 1 micro-USDC to treasury): `4qXAAMB6MVPVD9rM6oB2mMnFSHY5CoZn9ssMQBSP8QgvE3VEYeEz2Byz9vmsHjzfFprzdCDaDs7be8YLnkBWAm5`

### Fresh ITM vault (`2edjtmYXLb9aFHRZRFyxkLUgDoaouTv8pKch5Ni7m8bq`) — before / after

Created in Phase 3 with: SOL CALL, strike $50, qty 5 (3 sold to a fresh buyer + 2 left in operator's escrow), expiry 15 minutes out. Settled in Phase 4 via the existing `settleAllForExpiry` helper.

| Field | Pre (post-Phase-4) | Post (Phase 7) |
|---|---|---|
| `is_settled` | true | true |
| `settlement_price` | $83.392904 | $83.392904 |
| Strike | $50 | — |
| `total_shares` | 600,000,000 | 0 |
| `collateral_remaining` | $600 | $0 |
| `vault_usdc_account` (`Hd32cuoK…`) | alive, $603.015 | **closed** |
| Buyer (`6xWE9Nz…`) option ATA | 3 tokens | 0 tokens |
| Buyer USDC ATA | ~$96.985 (after Phase 3 purchase from $100 balance) | $197.178712 (+$100.193712 = 3 × ($83.39 − $50) plus rounding) |
| Writer (deployer, `5YRMuuoY…`) USDC ATA | (Phase 3 balance) | $10,873,225.721288 |
| Writer position (`6CP2Kx7e…`) | alive, shares = 600 M | **closed** |

The 2 unsold tokens parked in the operator's `purchase_escrow` were silently filtered by the holder pass (owner == protocol_state PDA, the documented filter from auto_finalize_holders.rs). They remain on chain and need a separate `burn_unsold_from_vault` call to clean up — that's expected, NOT a finalize bug, and matches the design call documented in docs/AUTO_FINALIZE_PLAN.md §6 question 1.

Major tx sigs from Phase 6 for this vault:

- Holder pass (burn 3 ITM tokens + pay $100.19 USDC): `LA9yCYfWbGQ8zQ6rh1mccMWnbfQDpXubbrzTtcjMNHGsThL1MNu43Uh1hP5m7rz4uip3TJfq1SwegyaLz7fMsqZ`
- Writer pass (claim ~$499.81 collateral + premium share): `oia84ArffKE9UYyw5yxiMBjXyaXE1uQfRwQAfDwykRwwnDYtB7McjGjJxwZ1wyqNqWWo1L8N3aEdn56L94FjBX6`

Phase 3/4 setup tx sigs:

- create_shared_vault: `541mjx4ukuJqFGP6d5e7BDYN249mXor2XGEDhAuTeNd8y1Jfq8pwdLUnx4qiQTd219ydtyv26zauvLqSTimkx1n`
- deposit_to_vault: `2RyaE73cZmogDrFa5EarkN2ym8qgW9XgwsLCVjUuwZ8auMV8YcZzBhHALKiTgY4Yec1B2YE3vX8tHKFqUDFsd19u`
- mint_from_vault (5 contracts): `32pNLG21ezMp12LbdZank4MrXg7vwkcgQWuKu6338Wy67ueS11CvXfBKXgoDCYR15LfQ6ogM6UDjZ9Ryfkb2CMwn`
- purchase_from_vault (3 contracts): `74n7MuC3d9jHWM4FcACzaJRjhEqBfVZmPhRpQUHep6pgcjWs9bWiEY1Rdzj5NJqkiAyiuT2nY3cWJwhNU77f3id`
- settle (atomic Pyth-update + settle_expiry): `6sJkHCevfdJyPZFNrtf81YATZSFsciYpKRAGqj1M8XWVgfLnMYyvnZhib18mAAZuSJM9RAXQmwN8xhaEKYq2xtx`
- settle_vault: `5KmLv9ouuBU3GZ1vTKmX47T8R59JL461TFjWLf3xTJvHZxk275vFGewP2HpuFNsWYkt9C1Fopfs8cn8f76z1izSD`

### Third vault (`6DbpdnqycE2zUgxArEHqZwj2gLT5Z4TdWW6FNrsBLzVi`) — leftover from earlier devnet activity

Discovered during the Phase 5 dry-run sweep — a settled vault from prior development that had a writer position with $800 collateral but zero options ever minted. Processed by Phase 6 alongside the two intentional vaults.

| Field | Pre | Post |
|---|---|---|
| `total_shares` | non-zero | 0 |
| `vault_usdc_account` | alive, $800 | **closed** |
| Writer position | alive (owner = `DnExEYn…`) | **closed** |
| Writer USDC delta | — | +$800 (full deposit refund — vault never minted, so writer's entire share = collateral_remaining) |

Writer-pass tx sig: `4dqPZcAxFeQ9JaGRbe4HMPCR8n7Ej3T1UxR5GzCbzPN63se8EnjKseNSGQ6MWkjMcxUKs3aK9HAMjXh7av8pDGqV`

### Treasury — before / after

| Field | Pre (Phase 2) | Post (Phase 7) | Delta |
|---|---|---|---|
| Treasury USDC | $140.100479 | $140.115480 | +$0.015001 |
| Treasury SOL lamports | 2,039,280 | 8,157,120 | +6,117,840 |

USDC delta breakdown:

- 15,000 micro-USDC = 0.5% × $3 = the protocol fee from the fresh vault's `purchase_from_vault` call (Phase 3, before Phase 6).
- 1 micro-USDC = the dust swept from the Apr 29 vault during its writer pass (the rounding remainder of `premium_per_share_cumulative * shares / 1e12` math).
- 0 dust from the fresh vault and the third vault (both had perfect-integer math).

SOL delta of 6,117,840 lamports = exactly 3 × 2,039,280 — the rent refund for the three closed `vault_usdc_account` accounts, all routed to treasury as designed.

### Token-2022 layout sanity check (Step 5 open question)

Phase 2's holder enumeration on the Apr 29 vault ran my Step 5 byte-offset assumption (data[0..32] = mint, data[32..64] = owner, data[64..72] = amount) against real on-chain Token-2022 accounts. **Both holder accounts had `data.length` in {171, 175}** — well above the 72-byte threshold the runner relies on. The variable extra bytes are the per-account TransferHook extension data appended after the base 165-byte SPL-Token layout. **The Step 5 assumption holds for every holder we encountered.** Recommend keeping the validation in mind for any future session that processes a vault with non-default Token-2022 extension stacks (different feature flags could in principle change the data layout below offset 72, though I see no evidence of that in the current Token-2022 program).

### Crank "fully finalized" cache — confirmed

Phase 6's tick-2 log emitted `vault marked fully finalized (process-lifetime cache)` for all three vaults:

- `6DbpdnqycE2zUgxArEHqZwj2gLT5Z4TdWW6FNrsBLzVi` (timestamp 16:04:50)
- `2edjtmYXLb9aFHRZRFyxkLUgDoaouTv8pKch5Ni7m8bq` (timestamp 16:04:59)
- `DsFhwmU4ph4yLz4QXUCHUF8qcW4urneQiqjXYJBJPStW` (timestamp 16:05:09)

A subsequent third tick (truncated at the 180-second wall-clock budget) would have skipped all three via the cache, sparing ~6 RPC calls and any sendable batches.

### Step 6 follow-ups

Two cosmetic cleanups deferred from this run:

**1. On-chain IDL update for opta program.** `anchor idl upgrade` failed during Phase 1 because the new IDL is 10,679 bytes while the existing on-chain IDL account is 9,904 bytes (`RequireGteViolated`, `Left: 9904, Right: 10679`). The deployed program code is correct and the local IDL at `app/src/idl/opta.json` is in sync — the on-chain IDL account is metadata for explorers (Solscan, wallet UIs, third-party indexers) only and does not affect program execution or the crank's local-IDL-driven behavior. To update later: run `anchor idl close CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` followed by `anchor idl init CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq -f target/idl/opta.json`. Net cost ~0.005 SOL (close reclaims 9,904-byte rent, init pays 10,679-byte rent), runtime ~30 seconds. No reason this can't slip; it's purely "explorer pages will show old instruction set until refreshed."

**2. Orphaned write-buffer.** The Phase 1 deploy left a zero-balance write-buffer at `574mMdbmjHyQ9qyXVPJ4itCXe46UokSuPkzK6HaYwCRn`, owned by the operator wallet — the same harmless pattern as the three orphans listed in HANDOFF.md §7 housekeeping. Cosmetic only; clean up with `solana program close 574mMdbmjHyQ9qyXVPJ4itCXe46UokSuPkzK6HaYwCRn` whenever convenient.

### Surprises encountered

- **The third vault.** Leftover state from earlier devnet sessions. Surfaced in Phase 5; reviewed and approved as part of the live run because the auto-finalize crank is by design vault-agnostic (it processes ALL settled-but-unfinalized vaults on the program). Approving rather than special-casing keeps the crank simple.
- **Public devnet RPC excludes Token-2022 from secondary indexes.** The first Phase 2 attempt against `https://api.devnet.solana.com` failed at the holder-enumeration step with "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb excluded from account secondary indexes" — `getProgramAccounts` is unsupported on the public devnet for Token-2022. Switched to the operator's Helius devnet endpoint (already in `app/.env.local`) and the rest of the smoke ran cleanly. Operationally this means the crank cannot run against public devnet — Helius (or any full-feature provider) is required. Not a surprise per se since HANDOFF.md already says public devnet is not viable for sustained operation, but worth flagging because the failure mode is fatal-on-first-tick rather than gradual rate-limiting.

### What this validates

- Step 1's holder-side instruction works end-to-end on devnet against real Token-2022 mints with TransferHook extensions.
- Step 3's writer-side instruction works end-to-end including the manual-close idiom (lamport drain + assign + resize) and the dust sweep to treasury.
- Step 5's crank wiring correctly enumerates, filters, and batches holders and writers across multiple vaults; the in-memory `fullyFinalized` cache converges in two ticks.
- The "purchase_escrow filtered off-chain" path the plan documented works as intended — neither vault's protocol-PDA-owned escrow account caused a tx revert, nor did the on-chain handler's silent-skip path need to fire (we filtered before sending).

The auto-finalize arc is **functionally complete on devnet**. Mainnet readiness is a separate concern (would need a fresh security audit per HANDOFF.md §10 Tier 3 item 9, plus Helius mainnet RPC, plus the on-chain IDL upgrade).

## Cleanup chores (post-Step-6)

Three deferred housekeeping items, all on devnet, ran in a single session on 2026-04-30. **Two clean, one surfaced an architectural observation worth recording.**

### Chore 1 — On-chain IDL update (CLEAN)

Closed the undersized 9,904-byte IDL account and re-initialized at the canonical IDL pubkey `9hP1piv1yQgdW7S9afYjzwVvDReCFK5MKkpk4DAHSVs` with the post-arc 10,679-byte IDL.

- `anchor idl close CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq --provider.cluster devnet` returned `Idl account closed: 9hP1piv1yQgdW7S9afYjzwVvDReCFK5MKkpk4DAHSVs`. Rent refunded: ~0.070 SOL.
- `anchor idl init … --filepath target/idl/opta.json --provider.cluster devnet` wrote the new IDL in 18 chunks (600-byte chunks of the 10,679-byte total) and finalized via SetBuffer. Final tx sig: `23kx8fz7zzsJeeAdtZPpGgoRSTY5yD9Bo9iww7zppzHhWHTCnPb8HmE5mnX678T1BCLXXtWij5kCzHiqXE3nc5WS`.
- Verification: `anchor idl fetch … --provider.cluster devnet` now contains both `auto_finalize_holders` and `auto_finalize_writers` instructions and both `HoldersFinalized` and `WritersFinalized` events. Explorer pages and any third-party indexer will pick up the post-arc surface from now on.

Net cost: ~0.080 SOL — higher than the ~0.005 SOL net-rent estimate in the Step 6 follow-ups. The extra ~0.075 SOL went to chunk-write fees + any temporary buffer rent during the multi-step write. Cost is well within budget; flagging the discrepancy because the original estimate was the rent-only delta.

### Chore 2 — Orphan write-buffer cleanup (NO-OP)

`solana program show --buffers` listed `574mMdbmjHyQ9qyXVPJ4itCXe46UokSuPkzK6HaYwCRn` (operator authority, 0 SOL balance). `solana program close 574mMdbmjHyQ9qyXVPJ4itCXe46UokSuPkzK6HaYwCRn --bypass-warning` returned `Error: Unable to find the account 574mMdbmjHyQ9qyXVPJ4itCXe46UokSuPkzK6HaYwCRn` — the on-chain account had already been GC'd (zero balance triggers Solana's auto-collection at slot finalization), but the RPC indexer still references it in its `--buffers` listing. Stale-but-harmless. The three older orphans listed in HANDOFF.md (`2Tw7L2C…`, `A841WoZ…`, `5E9FmYo…`) similarly do not appear under our authority and are presumed already GC'd.

Net cost: 0 SOL. Net effect: zero — nothing to actually clean up.

### Chore 3 — Burn unsold purchase_escrow tokens (BLOCKED — surfaced an architectural observation)

**Cannot complete via `burn_unsold_from_vault`.** The instruction's `Accounts` struct requires the `WriterPosition` PDA to deserialize as a live account (see `programs/opta/src/instructions/burn_unsold_from_vault.rs`'s `writer_position: Box<Account<'info, WriterPosition>>` constraint). The auto-finalize arc's `auto_finalize_writers` handler manually closes that account via lamport drain + `assign(system_program)` + `resize(0)`. After Phase 6 ran, both vaults' writer positions are in the closed-account state; calling `burn_unsold_from_vault` reverts at simulation with:

```text
AnchorError caused by account: writer_position. Error Code: AccountNotInitialized. Error Number: 3012.
```

(Captured live against the fresh vault — `purchase_escrow` `2VuFxDH1tiCcdtBmxxASJ24VzGYj3uXNPxCsphD5KDrt` still holds 2 unsold tokens; calling burn fails as above.)

Independent second blocker for the Apr 29 vault: its writer is `GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx`, a wallet whose keypair this session does not have. Even if the writer position were alive, signing authority is absent.

**Architectural observation, not strictly a code bug.** The on-chain code does what each handler advertises. But the combination — auto-finalize-writers closes the writer position, burn-unsold-from-vault requires the writer position to exist — creates a stranding scenario the original design didn't fully address. The HANDOFF.md "Step 6 follow-ups" note that said writers could call `burn_unsold_from_vault` after auto-finalize was overoptimistic about the cleanup window. Practical consequence: the 17 unsold tokens (15 in the Apr 29 vault's `HdSviDXNNkHXvYsPTMcJ6vxHTCka94kLDcBbQ3PerVGr` escrow + 2 in the fresh vault's `2VuFxDH…` escrow) are permanently inert in protocol-PDA-owned token accounts. They:

- Cannot be transferred (TransferHook blocks transfers post-expiry).
- Cannot be burned via the existing instructions (no path authorizes a protocol-owned-escrow burn except `burn_unsold_from_vault`, which now reverts).
- Hold no economic value — the writer's collateral was already returned via `auto_finalize_writers`, and the buyer paid in full for tokens they never bought (these tokens were never sold).

Net effect on the protocol: ~0.004 SOL of rent is locked in two protocol-PDA-owned token accounts forever (or until a future protocol change adds a permissionless `burn_protocol_escrow` instruction — surface for future work, not a Tier-1 item). The tokens themselves never enter circulation and never affect any user.

**Surfacing rather than fixing inline per the prompt's "no code changes" rule.** A proper fix would be either:

1. Reorder the auto-finalize crank to call `burn_unsold_from_vault` BEFORE the writer-finalize pass, while writer positions still exist. Requires Apr-29-vault-style scenarios to detect and handle unsold escrow. Crank-only change, no on-chain code change.
2. Add a new permissionless on-chain instruction `auto_burn_unsold_escrow` that takes the protocol_state PDA as the burn authority (same pattern `burn_unsold_from_vault.rs:50` already uses) and doesn't require `WriterPosition`. Closes the escrow + reclaims rent to the original writer (who's recorded on `VaultMint.writer`). Two purposes: cleans up stranded escrow now, and prevents the same scenario going forward.

Both paths are post-Step-6 work and out of scope for this cleanup chore.

### Aggregate verification

- **Operator SOL pre-cleanup:** 12.159210957 SOL.
- **Operator SOL post-cleanup:** 12.079697357 SOL.
- **Net delta:** −0.079513600 SOL — entirely from Chore 1's IDL re-init (close refund + init pay + chunk-write fees). Chores 2 and 3 cost 0 SOL each (Chore 2 was a stale-listing no-op; Chore 3's failure surfaced at simulation, before any tx fee).
- **Treasury USDC:** 140,115,480 micro-USDC ($140.115480) — **unchanged** from Phase 7 of Step 6 ✓.
- **Treasury SOL lamports:** 8,157,120 — **unchanged** from Phase 7 ✓.
- **No vault state was altered** by any of the three chores.
- **No on-chain protocol state was altered** beyond the IDL account replacement.

### One-sentence summary

**Two clean, one blocked.** IDL is now correct on-chain at `9hP1piv1yQgdW7S9afYjzwVvDReCFK5MKkpk4DAHSVs`; orphan-buffer chore was a stale-indexer no-op; the unsold-escrow burn surfaced a real auto-finalize-vs-burn-unsold ordering issue worth a follow-up, but the affected tokens are inert and the affected SOL rent is small (~0.004 SOL, locked indefinitely barring a new instruction).
