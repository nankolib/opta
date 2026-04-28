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
