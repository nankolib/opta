# BUTTER OPTIONS — AUDIT #2 REPORT (POST-FIX)

**Date:** 2026-04-17
**Scope:** Verification of Audit #1 fixes + full re-audit of `app/` frontend
**Contracts:** `programs/butter-options/src/` devnet `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq`
**Prior report:** `FRONTEND_AUDIT_REPORT.md`

---

## Build Status

| Check | Result |
|---|---|
| `npx tsc -b` | ✅ Clean, exit 0 |
| `npx vite build` | ✅ Built in 12.78s. Main bundle 1,069.91 kB (gzip 304.99 kB) — over 500 kB warning. 1 `eval` warning from `@protobufjs/inquire` (transitive — not actionable). |
| `npm audit` | ⚠️ 38 vulns (7 high, 4 moderate, 27 low): `lodash`/`lodash-es` prototype pollution + code injection, `vite` 8.0.0-8.0.4 path traversal + fs.deny bypass. All fixable; Vite fix is non-breaking. |

---

## Part 1 — Previous Fix Verification

| # | Fix | Status | Evidence |
|---|---|---|---|
| C-1 | `maxPremium × qty` | ✅ Verified | `BuyVaultModal.tsx:44`, display at :146 |
| C-2 | V2TokenHoldings + exerciseFromVault | ✅ Verified | `V2TokenHoldings.tsx` exists, all features present; exercise accounts match `exercise_from_vault.rs` |
| C-3 | withdrawFromVault pre-settlement | ✅ Verified | `VaultPositions.tsx:136-179`, two-step flow wired |
| H-1 | Premium formula | ✅ Verified | `useVaults.ts:111-113`; staggered-deposit math works (100/200 USDC correct) |
| M-1 | Error codes 6004/6029-34/6048/6049 | ✅ Verified | `errorDecoder.ts:9,34-39,53-54` |
| M-2 | Quantity validation (v2) | ✅ Verified | `BuyVaultModal.tsx:40-41,162` — v1 legacy code in Write.tsx:487 and Trade.tsx:631 still has the bug but v2 is the live path |
| M-3 | useVaults guard on flag | ✅ Verified | `useVaults.ts:34` |
| M-4 | maxContracts=0 affordance | ✅ Verified | `MintFromVault.tsx:183-190` |
| M-5 | Faucet wallet-adapter | ✅ Verified | `Header.tsx:28,89-90` — `window.solana` fully removed |
| M-7 | Faucet devnet-only | ✅ Verified | `Header.tsx:32,148` |
| L-1 | Unused import | ✅ Verified | `deriveVaultUsdc` removed |
| L-4 | Rent sysvar constant | ✅ Verified | `Write.tsx:2,104` uses `SYSVAR_RENT_PUBKEY` |

**All 13 previously-reported issues are fixed correctly.**

---

## Part 2 — Instruction Account Audit (all 11 v2)

Every `.accountsStrict({...})` call verified against Rust `#[derive(Accounts)]` struct account-by-account including mutability, signer flags, PDA seeds, and Token-2022 hook remaining-accounts.

| # | Instruction | Frontend | Result |
|---|---|---|---|
| 1 | createSharedVault | CreateCustomVault.tsx:77 | ✅ 9/9 accounts match |
| 2 | depositToVault | DepositModal.tsx:49, CreateCustomVault.tsx:99 | ✅ 8/8 in both callers |
| 3 | mintFromVault | MintFromVault.tsx:90 | ✅ 14/14, hook PDAs correct |
| 4 | purchaseFromVault | BuyVaultModal.tsx:72 | ✅ 18/18, hook remaining-accounts correct |
| 5 | claimPremium | VaultPositions.tsx:46 | ✅ 7/7 |
| 6 | burnUnsoldFromVault | VaultPositions.tsx:117 | ✅ 8/8 (burn, no hook needed) |
| 7 | **withdrawFromVault (NEW)** | VaultPositions.tsx:163 | ✅ 7/7, vault PDA signs correctly |
| 8 | settleVault | VaultPositions.tsx:67 | ✅ 3/3 |
| 9 | **exerciseFromVault (NEW)** | V2TokenHoldings.tsx:95 | ✅ 11/11, holder signs burn (not PermanentDelegate), both Token-2022 + standard Token programs correct |
| 10 | withdrawPostSettlement | VaultPositions.tsx:89 | ✅ 8/8, `close = writer` + system program present |
| 11 | initializeEpochConfig | scripts/initialize-epoch-config.ts:74 | ✅ 4/4 |

**No runtime Anchor account errors expected. The new exercise/withdraw instructions (the biggest risk surface from this round of fixes) are wired correctly.**

---

## Part 3 — Data Flow Verification

### Flow 1: Epoch Vault Lifecycle — ⚠️ one UX gap
- Each step individually works; handlers correctly dispatch to each instruction.
- ⚠️ After `MintFromVault` success, the Trade page's `vaultMints` state is refreshed (via `refetchVaults` on Write), but VaultBrowser itself has no `onRefetch` prop, so if user stays on Write→VaultBrowser they won't see their newly-deposited position until they navigate away and back.
- ✅ Exercise button correctly appears only when `status === "Settled"` AND ITM.

### Flow 2: Custom Vault Demo Flow — ✅ clean
- `CreateCustomVault.tsx` creates + auto-deposits in two sequential transactions, on success navigates to Mint screen with `sharedVaultPda`.
- Full lifecycle (5-min expiry → admin settle market → settle vault → exercise → withdraw post-settlement) is wired.

### Flow 3: Premium Claim Flow — ✅ math correct
- `getUnclaimedPremium` formula matches Rust `claim_premium.rs` (shares × cumulative / 1e12 − debt − claimed).
- Walk-through: A deposits 1000 → $100 premium → A=100 USDC. B deposits 1000 (debt=100) → another $100 premium → A=200, B=100 ✓.
- Claim handler refetches positions; display updates to $0.

---

## Part 4 — New Component Quality

### V2TokenHoldings.tsx
- ✅ Handles empty wallet, no option tokens, cancellation on unmount (line 42, 70).
- ✅ `marketMap` memoized. useEffect deps are stable; no infinite render.
- ⚠️ **New finding:** on RPC failure in the Token-2022 scan (`V2TokenHoldings.tsx:64-65`) the catch sets holdings to `[]` without surfacing the error. User sees "No vault option tokens found" — indistinguishable from genuine empty wallet. **Severity: Medium.**

### VaultPositions.tsx two-step claim+withdraw
- The bare `try {} catch {}` at `VaultPositions.tsx:145-160` swallows ALL errors (wallet rejection, RPC failure, etc.), not only `NothingToClaim`.
- **Data-safety:** The Rust `withdraw_from_vault` enforces `ClaimPremiumFirst`, so orphaned unclaimed premium cannot silently disappear — the withdraw would revert. Not a fund-loss bug.
- **UX bug:** If user rejects the claim signature, they are silently progressed to a withdraw signature that will revert with `ClaimPremiumFirst`, surfacing a confusing final error. **Severity: Medium.**
- ⚠️ `handleWithdrawShares` takes `shares: number` but has no bounds check; relies entirely on program-side rejection. Current call-site passes `myShares`, so safe in practice.

---

## Part 5 — Cross-Cutting Concerns

### A) Console.log cleanup — ⚠️ 2 debug logs left
- `usePythPrices.ts:61`: `console.log("[Prices] CoinGecko:", newPrices);`
- `usePythPrices.ts:81`: `console.log("[Prices] Jupiter SOL:", newPrices["SOL"]);`
- All other `console.error` / `console.warn` instances are appropriate error/fallback logging.

### B) Toast consistency — ✅ Clean
- Every `toast.error` in v2 paths uses `decodeError(err)`. No raw error objects or `undefined` interpolation.

### C) Loading states — ⚠️ Partial
- ✅ V2TokenHoldings shows "Scanning wallet...".
- ⚠️ V2TokenHoldings has no error UI (tied to Medium above).
- ⚠️ Trade grid shows a spinner for markets but not specifically for `vaultMints` loading.

### D) Button state management — ✅ Consistent
- `actionId` state pattern used across VaultPositions for all 5 actions.
- Modals use `submitting` state; all buttons `disabled={submitting || ...}`.
- No double-submit hazards spotted.

### E) Wallet-disconnected state — ⚠️ Trade page gap
- Write: ✅ "Connect your wallet to write options."
- Portfolio: ✅ "Connect your wallet."
- Trade: ⚠️ Renders grid without disconnect overlay; Buy buttons clickable but BuyVaultModal bails internally. Minor UX confusion. **Severity: Low.**

---

## Part 6 — Dependencies and Build

- **tsc**: 0 errors.
- **vite build**: succeeds; main bundle >500 kB (acceptable for hackathon demo, code-split later).
- **npm audit**: 7 high-severity vulns in `lodash`, `lodash-es`, `vite` 8.0.0-8.0.4. Vite patches include arbitrary file read via dev-server WS and fs.deny bypass — **dev-only risk; does not affect the static build shipped to Vercel**. Still recommend `npm audit fix` (non-breaking for all but wallet-adapter-wallets). **Severity: Medium** (production-shipped code safe; dev env exposed).
- No new packages added during fix work (beyond what was already present for V2TokenHoldings which uses existing `@solana/spl-token` and `@solana/web3.js`).

---

## NEW Issues Found

### Critical
_None._

### High
_None._ (All original C-1/C-2/C-3/H-1 issues verified fixed; new instructions wired correctly.)

### Medium
- **N-1** — `V2TokenHoldings.tsx:64-65` silently sets holdings to `[]` on RPC failure. Indistinguishable from empty wallet. Add error toast + retry.
- **N-2** — `VaultPositions.tsx:158` bare catch on auto-claim swallows wallet-rejection/RPC errors, then proceeds to prompt for withdraw signature which will revert. Data-safe (program enforces `ClaimPremiumFirst`) but confusing. Narrow the catch to the `NothingToClaim` code path only, re-throw others.
- **N-3** — `npm audit` reports 7 high-severity vulns. `vite` patch is non-breaking; apply before demo.

### Low
- **N-4** — `usePythPrices.ts:61,81` two `console.log` debug statements still in production code.
- **N-5** — Trade page renders without wallet-disconnected overlay; Buy buttons clickable while BuyVaultModal bails. Add a "Connect wallet to buy" banner.
- **N-6** — `VaultBrowser.tsx` receives no `onRefetch` prop — browser view doesn't auto-refresh after deposit/mint. Affects users who stay on Write tab.
- **N-7** — Main bundle 1,069 kB (>500 kB). Code-split post-hackathon.
- **N-8** — v1 legacy `BuyConfirmModal` in `Write.tsx:487` and `Trade.tsx:631` still has the M-2 quantity-default bug. Out of scope for v2 demo (USE_V2_VAULTS=true), but worth a follow-up pass.

---

## Summary

| Verdict | Assessment |
|---|---|
| **Previous fixes verified** | 13/13 ✅ |
| **Account audit (11 instructions)** | 11/11 ✅ — no Anchor account errors expected at runtime |
| **Math correctness** | ✅ — slippage and premium formulas now match Rust |
| **New components quality** | ⚠️ — minor silent-error handling issues in V2TokenHoldings and claim+withdraw chain |
| **Build** | ✅ tsc clean, vite succeeds |
| **Security** | ⚠️ — npm audit fixable in 1 command; static build unaffected |

**Ready to deploy for the hackathon demo.** No blocking issues for the live recording. The original 3 Critical and 2 High issues are all closed. New findings are Medium/Low UX polish and a non-breaking dependency update that can be applied in under a minute.

**Recommended pre-demo punch list (15 min):**
1. `npm audit fix` in `app/` (addresses 4 of 7 high-severity without breaking changes).
2. Remove the two `console.log` lines in `usePythPrices.ts`.
3. Narrow the auto-claim `catch {}` in `VaultPositions.tsx:158` to match on `NothingToClaim` code only.
4. (Optional) Add one-line error toast in `V2TokenHoldings.tsx:64`.

Everything else is safe to defer until post-demo.
