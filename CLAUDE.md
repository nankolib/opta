# Butter Options

P2P composable tokenized options protocol on Solana (Token-2022).

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
