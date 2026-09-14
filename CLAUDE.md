# Opta

P2P composable tokenized options protocol on Solana (Token-2022).

## Public-repo rule

`nankolib/opta` is public. Nothing in this tree may carry server IPs, SSH logins, local usernames or machine paths (home directories, drive letters), investor or contact names, third-party social handles, or session diaries; use `<VPS_IP>`, `<VPS_USER>`, `$HOME` and `<REPO_ROOT>` placeholders in docs and comments, and resolve key paths in code from `HOME`/`USERPROFILE`. The ops narrative (the HANDOFF diary, migration log, runbooks, audit reports) lives in the private repo `nankolib/opta-ops`, cloned as a sibling at `../opta-ops`: at session close, write the HANDOFF block to `../opta-ops/HANDOFF.md` and commit + push there, never here. The public `HANDOFF.md` is a three-line stub and must stay one. A local pre-commit gate (`.context/snapshot/secret-scan.js`, list in `.context/snapshot/forbidden.txt`) blocks any commit that stages a forbidden string or a secret-shaped value; fix the file rather than passing `--no-verify`.

## Security

### Audit — April 4, 2026

Full security audit completed across both programs (`butter-options`, `butter-transfer-hook`).

**Tools used:** tiny-auditor (quick scan), smart-contract-audit (deep multi-expert analysis with triager validation), foundry-poc (Anchor TS exploit PoC)

**Findings and fixes:**

| ID | Severity | Finding | Fix | Status |
|----|----------|---------|-----|--------|
| C-01 | Critical | `expire_option` callable before settlement — writer steals all collateral | Added `require!(market.is_settled)` + OTM check in `expire_option.rs:23-32`. New error: `CannotExpireItmOption` | Fixed |
| M-01 | Medium | `buy_resale` allows purchasing expired tokens (transfer hook bypassed via protocol escrow) | Added `market` account to `BuyResale` struct + `require!(clock < expiry)` in `buy_resale.rs` | Fixed |
| L-01 | Low | Integer truncation in proportional pricing rounds premium to zero for dust amounts | Added `require!(proportional_premium > 0)` in `purchase_option.rs`. New error: `PremiumTooLow` | Fixed |

**Verification:**
- 25/25 existing tests pass after all fixes
- C-01 PoC exploit test (`tests/poc-C1-expire-before-settle.ts`) now fails with `MarketNotSettled` — attack blocked
- Full audit report at `.context/outputs/1/audit-report.md`

### Re-Audit — April 12, 2026

Post-fix re-audit of shared vault system. All findings fixed, 93/93 tests passing.

| ID | Severity | Finding | Fix | Status |
|----|----------|---------|-----|--------|
| CRITICAL-01 | Critical | `settle_vault` + `exercise_from_vault` double-deduction — exercise pool subtracted twice, funds stuck forever | `settle_vault.rs`: `collateral_remaining = total_collateral` (no pre-deduction) | Fixed |
| HIGH-01 | High | `withdraw_post_settlement` closes writer_position, destroying unclaimed premium | `withdraw_post_settlement.rs`: auto-claim premium before closing position | Fixed |
| MEDIUM-01 | Medium | `withdraw_from_vault` doesn't adjust premium_debt — premium lost on share withdrawal | `withdraw_from_vault.rs`: require all premium claimed first (`ClaimPremiumFirst` error) | Fixed |
| LOW-01 | Low | `burn_unsold_from_vault` missing PDA validation on purchase_escrow | `burn_unsold_from_vault.rs`: added PDA seed constraint | Fixed |

**Verification:**
- 93/93 tests pass (83 existing + 10 new audit-fix tests)
- New tests at `tests/zzz-audit-fixes.ts`: ITM/OTM settlement lifecycle, auto-claim premium, claim-before-withdraw
