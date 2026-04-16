# BUTTER OPTIONS — FRONTEND AUDIT REPORT

**Date:** 2026-04-17
**Scope:** `app/` directory, v1 → v2 vault migration (Phases 1-4)
**Contracts audited against:** `programs/butter-options/src/` (devnet `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq`)

## Build Status

| Check | Result |
|---|---|
| `npx tsc -b` | ✅ Clean, 0 errors |
| `npx vite build` | ✅ Built in 28.37s, 1 chunk >500 kB (main bundle), 1 `eval` warning from `@protobufjs/inquire` (transitive dep — not actionable) |

---

## Critical Issues (will cause runtime failures)

### C-1 — BuyVaultModal slippage check will reject every purchase > 1 contract
**File:** `app/src/components/trade/BuyVaultModal.tsx:41`

```ts
const maxPremium = toUsdcBN(premiumPerContract * 1.05); // 5% slippage buffer
```

Rust check in `programs/butter-options/src/instructions/purchase_from_vault.rs:60-65`:
```rust
let total_premium = quantity.checked_mul(vault_mint.premium_per_contract)?;
require!(total_premium <= max_premium, SlippageExceeded);
```

Frontend sends `max_premium = premium_per_contract × 1.05` — **missing `× qty`**. Buying 10 contracts at $100 ⇒ `total_premium = 1,000`, `max_premium = 105` ⇒ `SlippageExceeded`. Only `qty == 1` succeeds.

**Fix:** `toUsdcBN(premiumPerContract * qty * 1.05)`.

### C-2 — `exercise_from_vault` is NEVER called from the frontend
**Evidence:** `Grep` for `exerciseFromVault` returns hits only in the IDL files. `app/src/pages/Portfolio.tsx:371` only calls the v1 `exerciseOption`.

After a v2 vault settles, buyers holding Living Option Tokens from `mint_from_vault` / `purchase_from_vault` have **no UI path to exercise**. The HeldTab filters on `optionPosition` accounts (v1), but v2 purchases don't create an `OptionPosition` — they only produce Token-2022 balances in the buyer's ATA. Those holdings are invisible to the Portfolio.

**Fix scope:** add a v2 held-tokens view (scan Token-2022 ATAs, join against `VaultMint.optionMint`, render exercise button) and wire `exerciseFromVault` with accounts from `exercise_from_vault.rs:148-205`.

### C-3 — `withdraw_from_vault` (pre-settlement) is NEVER called from the frontend
**Evidence:** `Grep` for `withdrawFromVault` returns hits only in the IDL files. `VaultPositions.tsx` only has `handleWithdrawPost` (post-settlement).

Writers cannot reclaim free (uncommitted) collateral from an active vault. Only escape is to wait for expiry + settlement. Combined with **M-4** (disabled Mint button), a writer whose mints were burned/expired has no way to recover capital until expiry.

---

## High Issues (will cause incorrect behavior)

### H-1 — `useVaults.getUnclaimedPremium` formula is dimensionally wrong
**File:** `app/src/hooks/useVaults.ts:100-111`

```ts
const earned = cumulative.sub(debt).mul(shares).div(PRECISION);
```

On-chain `premium_per_share_cumulative` is 1e12-scaled; `premium_debt` is stored as absolute micro-USDC (`deposit_to_vault.rs:91-98`). Subtracting them mixes scales.

Rust formula (`claim_premium.rs:30-45`):
```
claimable = (shares * cumulative / 1e12) - debt - claimed
```

Worked example (2nd depositor joins after cumulative=1e12, then cumulative→2e12):
- Rust claimable = 1 USDC
- Frontend displays ≈ 2 USDC

For first/sole depositors (debt=0) the formulas agree, so custom vaults look fine. For epoch vaults with staggered deposits, **the Claim button shows and offers an inflated amount** — the transaction either over-claims or reverts depending on vault balance.

**Fix:** `earned = shares.mul(cumulative).div(PRECISION).sub(debt)`.

### H-2 — Portfolio "Token Holdings" tab cannot surface v2-purchased options
**File:** `app/src/pages/Portfolio.tsx:62-83`

```ts
const held = positions.filter((p) => ... heldMints.has(p.account.optionMint.toBase58()))
```

`positions` = `OptionPosition` accounts (v1 only). V2 mints come from `VaultMint` records — they are never in `positions`. Result: a user who buys v2 tokens sees nothing in the Portfolio > Token Holdings tab, even though their wallet holds Token-2022 balances. Pairs with C-2 (no exercise UI anyway).

### H-3 — Max-premium slippage display (same root cause as C-1)
**File:** `app/src/components/trade/BuyVaultModal.tsx:143`

UI shows "Max premium (slippage): $X" using `premiumPerContract * 1.05`, not the total. Users see a misleading cap.

---

## Medium Issues (poor UX or edge-case bugs)

### M-1 — Missing error codes in `errorDecoder.ts`
**File:** `app/src/utils/errorDecoder.ts`

Cross-referenced `programs/butter-options/src/errors.rs` variant ordering. Missing mappings:

| Code | Variant | Reachable from UI? |
|---|---|---|
| 6004 | InvalidPythFeed | No (admin-only) |
| 6029 | UnauthorizedPricingUpdate | No |
| 6030 | VolTooLow | Indirect (price hook fallback) |
| 6031 | VolTooHigh | Indirect |
| 6032 | OptionExpired | Possible |
| 6033 | PricingCalculationFailed | Possible |
| 6034 | OracleStaleOrInvalid | Yes |
| 6048 | ExpiryMismatch | **Yes** — `create_shared_vault` |
| 6049 | InvalidOptionType | **Yes** — `create_shared_vault` |

Unmapped errors render as `Program error 6049`. 6048/6049 are plausible create-vault failures.

### M-2 — BuyVaultModal quantity defaults to 1 on empty input, bypassing validation
**File:** `app/src/components/trade/BuyVaultModal.tsx:39-41`

```ts
const qty = parseInt(quantity) || 1;
```

If the user clicks "Confirm Buy" without entering a quantity, `qty === 1` and the `disabled={qty <= 0}` guard never fires. Same pattern in `Write.tsx:369` / `Trade.tsx:520`, where `|| available` silently buys everything.

### M-3 — `useVaults` runs unconditionally even when `USE_V2_VAULTS=false`
**Files:** `app/src/pages/Trade.tsx:49`, `app/src/pages/Portfolio.tsx:33`

`useVaults()` is called at the top level of `Trade` and `Portfolio`, firing four `getProgramAccounts` RPCs (`sharedVault`, `writerPosition`, `vaultMint`, `epochConfig`) on every mount regardless of the flag. Not a correctness issue while flag is `true`, but if the flag is flipped off for a v1-only demo, wasted RPCs remain.

### M-4 — `Mint` button disabled when `maxContracts === 0`, no "Deposit More" affordance
**File:** `app/src/components/write/MintFromVault.tsx:183-187`

If the writer burned/sold everything, UI goes empty. No button to return to DepositModal → dead-end UX (recoverable by navigating away).

### M-5 — USDC faucet uses `window.solana.signTransaction` directly
**File:** `app/src/components/Header.tsx:89-95`

Bypasses wallet-adapter. Solflare (listed in `WalletContext.tsx:27`) and other non-Phantom wallets don't inject `window.solana`, so the faucet silently fails with "Please use Phantom wallet". Should use `sendTransaction` from `useWallet()`.

### M-6 — BN→Number conversions at risk above 2^53
Every display-layer `.toNumber()` assumes values fit in JS safe-integer range. Micro-USDC micro-shares exceed 2^53 around $9B:

- `app/src/components/write/DepositModal.tsx:27-28` (`totalShares`, `myShares`)
- `app/src/components/portfolio/VaultPositions.tsx:153-160` (`totalShares`, `myShares`, `unclaimed/1_000_000`)
- `app/src/components/write/MintFromVault.tsx:38-40`
- `app/src/utils/format.ts:9, 18, 24` (all `formatUsdc`/`usdcToNumber`/`toUsdcBN`)

Low risk for devnet demo; flag for prod.

### M-7 — Faucet button doesn't verify cluster
**File:** `app/src/components/Header.tsx:43-55`

Devnet is hardcoded in `WalletContext.tsx:24`, so this is mostly academic — but if the endpoint is ever swapped, the faucet code paths (both SOL airdrop and USDC faucet) will try to run against mainnet. Add a cluster sanity check.

---

## Low Issues (cleanup)

### L-1 — Unused import
`app/src/components/portfolio/VaultPositions.tsx:8`: `deriveVaultUsdc` is imported but never referenced (code reads `vault.account.vaultUsdcAccount` directly).

### L-2 — DEVNET_FAUCET_KEYPAIR is a plaintext secret
`app/src/utils/constants.ts:39-44`: 64-byte secret key embedded in source. Labeled "DO NOT use on mainnet" ✓. For devnet hackathon demo acceptable; anyone cloning the repo gets the keypair. Consider scripts/env-based injection before any production fork.

### L-3 — `useTokenMetadata` iterates fetches sequentially
`app/src/hooks/useTokenMetadata.ts:24-33`: a `for` loop awaits one at a time. A parallel variant (`fetchBatchMetadata`) already exists in `app/src/utils/tokenMetadata.ts:36-57` but is unused.

### L-4 — Rent sysvar PublicKey hardcoded as raw string
`app/src/pages/Write.tsx:414, 429`: `new PublicKey("SysvarRent111111111111111111111111111111111")`. `SYSVAR_RENT_PUBKEY` is already available from `@solana/web3.js` (used correctly in `MintFromVault.tsx:104`). Just inconsistency.

### L-5 — Fragile `isCall ? 0 : 1` optionTypeIndex derivation
`app/src/components/write/CreateCustomVault.tsx:56`: derives from `"call" in mkt.optionType`. Rust enum layout: `Call = 0, Put = 1` (`state/*.rs`) — matches. Low risk, but adding a helper `optionTypeToIndex(optionType)` would make the invariant explicit.

---

## Info (observations, no action needed)

- **Account discriminators in `useFetchAccounts.ts:16-25` match IDL byte-for-byte** for all 7 account types (verified against `app/src/idl/butter_options.json:3330-3446`).
- **All PDA derivations in `app/src/hooks/useAccounts.ts` match Rust seeds** (`SHARED_VAULT_SEED`, `VAULT_USDC_SEED`, `WRITER_POSITION_SEED`, `VAULT_OPTION_MINT_SEED`, `VAULT_PURCHASE_ESCROW_SEED`, `VAULT_MINT_RECORD_SEED`, `EPOCH_CONFIG_SEED`). `strike_price` as 8-LE u64 and `expiry` / `created_at` as 8-LE (BN positive-only) are correct.
- **Transfer-hook PDAs** (`extra-account-metas`, `hook-state`) correctly derived using `TRANSFER_HOOK_PROGRAM_ID` in `constants.ts:48-60`, not the main program.
- **Token-2022 is used correctly** for option-mint ATAs (`BuyVaultModal.tsx:61`, `Portfolio.tsx:353, 396, 505, 533`). USDC ATAs use regular `TOKEN_PROGRAM_ID`. No crossovers spotted.
- **Instruction account structs verified** for `create_shared_vault`, `deposit_to_vault`, `mint_from_vault`, `purchase_from_vault`, `claim_premium`, `burn_unsold_from_vault`, `settle_vault`, `withdraw_post_settlement` — every account argument from the Rust `#[derive(Accounts)]` is present and named consistently in the corresponding `.accountsStrict({...})` blocks.
- **V1 regression**: v1 components (`WriteOptionPanelV1` in `Write.tsx:500`, `BuyConfirmModal` in `Write.tsx:355` / `Trade.tsx:506`, v1 `WrittenTab`/`HeldTab` in `Portfolio.tsx:193-385`) call `writeOption`, `purchaseOption`, `exerciseOption`, `cancelOption`, `expireOption`, `buyResale`, `cancelResale`, `listForResale` with full v1 account sets. Untouched by v2 additions.
- **Idempotent ATA creation** is used before Token-2022 transfers — good pattern.
- **Error handling wrapping**: every v2 `.rpc()` call is wrapped in try/catch and routes errors through `decodeError()`. ✓

---

## Verification Summary

| Check | Status | Notes |
|---|---|---|
| Instruction accounts match | ⚠️ | 8/10 instructions clean. `withdraw_from_vault` + `exercise_from_vault` never wired up (C-2, C-3). |
| PDA seeds correct | ✅ | All 7 helpers byte-match Rust. |
| Data types consistent | ✅ | BN used correctly; enums passed as `{ call: {} }` objects. Display-layer `.toNumber()` risk flagged (M-6). |
| Token-2022 handling | ✅ | Option ATAs use Token-2022; USDC uses SPL. Transfer-hook PDAs derived from hook program ID. |
| Feature flag works | ⚠️ | V1 preserved correctly. `useVaults` still runs when flag is `false` (M-3). |
| Hook lifecycle correct | ✅ | No obvious stale-dep or infinite-render issues. |
| Math verified | ❌ | **H-1** premium formula wrong. **C-1** slippage max_premium wrong. |
| Error handling complete | ⚠️ | try/catch + `decodeError` everywhere; 9 codes unmapped (M-1). |
| Imports valid | ✅ | Build passes. 1 unused import (L-1). |
| Security clean | ✅ | Faucet keypair marked devnet-only; admin-gated on `isAdmin` check. |
| Build passes | ✅ | tsc 0 errors, vite OK. |
| V1 regression | ✅ | All v1 instructions still called with correct account sets. |

---

## Recommended order before demo recording

1. **Fix C-1** (1-line change in BuyVaultModal) — blocks all multi-contract v2 buys
2. **Fix H-1** (reorder BN operations in useVaults) — prevents over-claim errors on epoch vaults
3. **Decide on C-2/C-3 scope**: either build the missing v2 exercise + pre-settlement withdraw UI, or explicitly scope the demo to single-writer custom vaults that settle + use `withdrawPostSettlement` for the full lifecycle. The demo script should not touch epoch vaults with multiple writers until H-1 is fixed.
4. **M-1 / M-2 / M-5** are cosmetic but visible on camera — quick wins.
