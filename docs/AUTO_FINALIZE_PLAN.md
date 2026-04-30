# Auto-Finalize Architecture Proposal

> **Status:** planning, no code written. This document covers the design of the post-settlement auto-burn + auto-distribute pass that closes the §7 gap in `HANDOFF.md` ("the living token").
>
> **Audit basis:** read of `programs/opta/src/instructions/{settle_expiry,settle_vault,exercise_from_vault,withdraw_post_settlement,burn_unsold_from_vault,mint_from_vault}.rs`, `programs/opta/src/state/*.rs`, `programs/opta/src/lib.rs`, `programs/opta/src/{errors,events}.rs`, and `crank/bot.ts` on 2026-04-30. Line numbers below were verified against the current tree, not copied from the handoff.

---

## 1. Audit findings

Reading each handler end-to-end, plus the mint creation site, confirms the handoff's high-level claim ("`settle_vault` is mark-only, PermanentDelegate exists but is unused for multi-holder iteration") and pins down a few details the handoff doesn't spell out.

### 1.1 `settle_expiry` — `programs/opta/src/instructions/settle_expiry.rs`

- **Reads:** `OptionsMarket` (for `pyth_feed_id`, `bump`), `PriceUpdateV2` (Pyth Pull oracle account), `Clock`.
- **Writes:** initializes a fresh `SettlementRecord` PDA with `asset_name`, `expiry`, `settlement_price`, `settled_at`, `bump`. PDA seeds: `["settlement", asset_name, expiry_le_bytes]` (line 105–109).
- **Tokens moved:** none.
- **Authority:** permissionless. Caller is the `init` payer for the rent.
- **Idempotency:** plain `init` on `settlement_record` (line 104) — second call for the same `(asset, expiry)` reverts with the standard "account already in use" error.

No surprises vs. the handoff.

### 1.2 `settle_vault` — `programs/opta/src/instructions/settle_vault.rs`

This is the load-bearing finding. Confirmed mark-only.

- **Reads:** `SharedVault`, `OptionsMarket` (for `asset_name` to derive the SettlementRecord PDA), `SettlementRecord`, `Clock`.
- **Writes:** `vault.is_settled = true`, `vault.settlement_price = record.settlement_price`, `vault.collateral_remaining = vault.total_collateral` (line 74). Note: per the CRITICAL-01 fix from the April re-audit, `collateral_remaining` does NOT pre-deduct exercise payouts; each exercise deducts its own.
- **Tokens moved:** zero. The accounts struct (line 94–121) contains exactly: `authority` (signer), `shared_vault`, `market`, `settlement_record`. **No `option_mint`, no holder ATAs, no `vault_usdc_account`, no Token-2022 program, no SPL Token program.** By structure, this instruction cannot burn tokens or transfer USDC.
- **Authority:** permissionless. The signer is just there to authorize the tx; their pubkey is never read.
- **Emits:** `VaultSettled { vault, settlement_price, total_payout, collateral_remaining }`. Note: `total_payout` here is the *expected* payout if everyone exercises — diagnostic only, not used for accounting.

Surprise: the handoff says "settle_vault flips is_settled and records the settlement price." It also computes a `total_payout` figure for the event but discards it. That figure is never persisted on-chain. Auto-finalize will need to recompute payouts per-holder anyway, so this isn't a concern, but it's worth knowing the cap-at-`total_collateral` logic at line 68 is *not* what gates per-exercise payouts — that gate lives in `exercise_from_vault.rs:72`.

### 1.3 `exercise_from_vault` — `programs/opta/src/instructions/exercise_from_vault.rs`

- **Reads:** `SharedVault`, `OptionsMarket`, `VaultMint`, holder's option ATA (raw — reads `amount` at bytes 64..72 by hand, line 35–38), holder's USDC ATA, `vault_usdc_account`, `ProtocolState`.
- **Writes:** `vault.collateral_remaining -= total_payout` (line 132–135).
- **Tokens moved:**
  1. Burns `quantity` option tokens from `holder_option_account`. **Holder signs as the burn authority** (line 80–94) — this is *not* a PermanentDelegate burn. The handoff is right that PermanentDelegate is installed but unused; this instruction is the proof point.
  2. Transfers `total_payout` USDC from `vault_usdc_account` → `holder_usdc_account`, signed by the `shared_vault` PDA with seeds `[SHARED_VAULT_SEED, market, strike(8), expiry(8), option_type(1), bump]` (line 106–113).
- **Authority:** holder signs.
- **Reverts on OTM:** `require!(payout_per_contract > 0, OptaError::OptionNotInTheMoney)` at line 65. **This is a meaningful constraint.** Holders cannot use this instruction to "burn for zero" — OTM tokens can't be cleaned up via this path at all today. They sit in the holder's wallet as zero-value Token-2022 dust forever.

### 1.4 `withdraw_post_settlement` — `programs/opta/src/instructions/withdraw_post_settlement.rs`

The pattern auto_finalize_writers will mirror most closely.

- **Reads:** `SharedVault`, `WriterPosition`, `vault_usdc_account`, `writer_usdc_account`, `ProtocolState`.
- **Writes:**
  - Auto-claims all unclaimed premium (line 30–48). Math: `total_earned = (shares * premium_per_share_cumulative) / 1e12`, `unclaimed = total_earned - premium_debt - premium_claimed`.
  - Computes writer's share of remaining collateral: `writer_remaining = (shares * collateral_remaining) / total_shares` (line 44–48).
  - Decrements `vault.collateral_remaining`, `vault.total_shares`, `vault.total_collateral` (line 100–109).
  - Closes the `writer_position` account (returning rent to writer) via `close = writer` (line 170).
  - On the last writer (`vault.total_shares == 0`), sweeps any USDC dust to the last writer and closes `vault_usdc_account` (line 117–144).
- **Tokens moved:** USDC out of the vault (premium + collateral share) signed by `shared_vault` PDA. Then USDC dust + close-account on the last writer.
- **Authority:** writer signs. The instruction enforces `writer_pos.owner == writer.key()` at line 26.

The line-21–28 validations are: `is_settled`, `owner`, `shares > 0`. Auto-finalize will keep these but make `writer.key()` come from `writer_position.owner` rather than a signer.

### 1.5 `burn_unsold_from_vault` — `programs/opta/src/instructions/burn_unsold_from_vault.rs`

- **Reads:** `VaultMint`, `WriterPosition`, `SharedVault`, `purchase_escrow` (raw — reads amount at bytes 64..72), `ProtocolState`.
- **Writes:** `vault_mint.quantity_minted -= unsold`, `writer_pos.options_minted -= unsold`, `vault.total_options_minted -= unsold`.
- **Tokens moved:**
  1. Burns the unsold count from `purchase_escrow`. **The protocol PDA signs as the token-account owner** (line 50–71) — this works because the purchase_escrow is a Token-2022 account with `owner = protocol_state` (set in `mint_from_vault.rs:339`). Note: this is NOT a PermanentDelegate burn either; it's owner-authority.
  2. Closes the `purchase_escrow` token account, returning rent to the writer (line 74–88).
- **Authority:** writer signs (`require!(vault_mint.writer == writer.key())`).
- **Surprise:** there is no `is_settled` check here. A writer can call `burn_unsold` at any time, including post-expiry. This is fine, just worth knowing — it means auto-finalize doesn't need to "race" to clean up unsold escrow; the writer can do it before or after the crank's auto-finalize pass.

### 1.6 State accounts

All confirmed against disk:

- **`SharedVault`** — `programs/opta/src/state/shared_vault.rs`. Key fields used post-settle: `is_settled`, `settlement_price`, `collateral_remaining`, `total_shares`, `total_collateral`, `total_options_sold`, `vault_usdc_account`, `collateral_mint`, `option_type`, `strike_price`, `expiry`, `market`, `bump`. Layout discriminator at bytes 0..8; `market` is the first Pubkey at bytes 8..40 (after the discriminator).

- **`VaultMint`** — `programs/opta/src/state/vault_mint.rs`. PDA seed: `["vault_mint_record", option_mint]` (1:1 with the Token-2022 mint). Fields: `vault`, `writer`, `option_mint`, `premium_per_contract`, `quantity_minted`, `quantity_sold`, `created_at`, `bump`.

- **`SettlementRecord`** — `programs/opta/src/state/settlement_record.rs`. PDA seed: `["settlement", asset_name, expiry_le_bytes]`. Fields: `asset_name`, `expiry`, `settlement_price`, `settled_at`, `bump`. Comment on line 32–34 says "today admin-supplied (Pyth-mocked)" — this is stale comment text from the pre-Pyth-Pull era. The actual write path (`settle_expiry.rs:60`) now derives the price from a verified `PriceUpdateV2`.

- **`ProtocolState`** — `programs/opta/src/state/protocol.rs`. PDA seed: `b"protocol_v2"` (line 48 — note `_v2`, not just `protocol`). Holds `admin`, `fee_bps`, `treasury`, `usdc_mint`, `total_markets`, `total_volume`, `bump`. **This PDA is the PermanentDelegate authority on every option mint** (see §1.7).

- **`WriterPosition`** — `programs/opta/src/state/writer_position.rs`. PDA seed: `["writer_position", vault, owner]`. Layout (after 8-byte discriminator): `owner` (32, bytes 8..40), `vault` (32, bytes 40..72), `shares` (8), `deposited_collateral` (8), `premium_claimed` (8), `premium_debt` (16), `options_minted` (8), `options_sold` (8), `deposited_at` (8), `bump` (1).

### 1.7 Mint creation — `programs/opta/src/instructions/mint_from_vault.rs:184-192`

```rust
// Extension 2: PermanentDelegate — protocol PDA can burn tokens from any holder
invoke(
    &spl_token_2022::instruction::initialize_permanent_delegate(
        &token_2022_key,
        mint_info.key,
        &ctx.accounts.protocol_state.key(),  // <-- delegate authority
    )?,
    &[mint_info.clone()],
)?;
```

Confirmed: PermanentDelegate authority on every vault-minted option = `protocol_state` PDA. Signer seeds for invoking this authority: `[b"protocol_v2", &[protocol_state.bump]]` (matches `burn_unsold_from_vault.rs:50` exactly). The capability is real; nothing in the deployed program currently exercises it across multiple holders.

---

## 2. Architecture options

Three concrete shapes considered, in increasing order of granularity.

### Option A — One unified instruction `auto_finalize_vault`

A single permissionless instruction that takes a heterogeneous `remaining_accounts` slice containing some holder ATAs and some writer positions in the same call.

**Holder/writer differentiation:** branch on the account discriminator. Token-2022 accounts have a different memory layout than `WriterPosition`s — readable from the first 8 bytes (`writer_position` has the Anchor account discriminator; Token-2022 ATAs do not).

**Pros:**
- One transaction, atomic across both phases. If we want "holders all burned and writers all paid in the same block," this is the only shape that gives it.
- One CU budget, one fee, one signature.

**Cons:**
- Heterogeneous `remaining_accounts` parsing is fragile and hard to validate. Anchor doesn't natively support variant-typed `remaining_accounts`; we'd be doing manual `try_borrow_data()` + first-byte sniffing.
- Account count blow-up: each holder needs (option_ata, usdc_ata) and each writer needs (writer_position, writer_usdc_ata), but the fixed accounts (vault, vault_usdc, protocol_state, mint, vault_mint_record, token programs, signer) are shared. In a 64-account-per-tx Solana world we'd fit ~20 holders OR ~25 writers but not both.
- Failure mode: if any single account in the batch trips a constraint, the whole tx reverts. With 30+ accounts in one tx, the per-batch failure rate goes up sharply.
- CU budget: holder burn (~50K) + writer payout (~30K) per item; mixing both means the per-tx item count is bounded by the heavier op. Worse throughput than two specialized instructions.

**When right:** never, in this codebase. The composability gain isn't real (the crank can sequence two txs in the same slot if it wants atomic-ish behavior). The complexity cost is real.

### Option B — Split: `auto_finalize_holders` + `auto_finalize_writers` *(recommended)*

Two homogeneous-batch instructions, each handling one phase.

**`auto_finalize_holders(vault)`**

Takes pairs `(holder_option_ata, holder_usdc_ata)` in `remaining_accounts`. For each holder:
1. Read amount at bytes 64..72 of `holder_option_ata`. If zero, **skip silently** (already-burned, exercised, or never-held — idempotent no-op).
2. Read `owner` at bytes 32..64 of `holder_option_ata`. Verify `holder_usdc_ata.owner == that owner` and `holder_usdc_ata.mint == vault.collateral_mint`. If not, skip silently (caller passed a mismatched USDC ATA).
3. Compute `payout_per_contract` from `vault.option_type`, `vault.settlement_price`, `vault.strike_price` (same formula as `exercise_from_vault.rs:46-63`).
4. Compute `total_payout = quantity * payout_per_contract`, capped at `vault.collateral_remaining`.
5. **Burn** `quantity` tokens from `holder_option_ata` via PermanentDelegate. CPI shape:
   ```rust
   invoke_signed(
       &spl_token_2022::instruction::burn(
           &token_2022_program_key,
           holder_option_ata.key,
           option_mint.key,
           &protocol_state.key(),  // PermanentDelegate authority
           &[],
           quantity,
       )?,
       &[holder_option_ata, option_mint, protocol_state],
       &[&[b"protocol_v2", &[protocol_state.bump]]],
   )?;
   ```
6. If `total_payout > 0`: transfer USDC from `vault_usdc_account` → `holder_usdc_ata` signed by the `shared_vault` PDA (same pattern as `exercise_from_vault.rs:99-126`).
7. Decrement `vault.collateral_remaining` by the payout.

Fixed accounts (~10): `caller` (signer), `shared_vault` (mut), `market`, `vault_mint_record`, `option_mint` (mut), `vault_usdc_account` (mut), `protocol_state`, `token_2022_program`, `token_program`. Then 2× holders in `remaining_accounts`. With ~10 fixed and 64-account ceiling, that gives **~27 holders per tx** by account count, **~25 holders per tx** if we cap CU at 1.4M (each holder ~50K).

**`auto_finalize_writers(vault)`**

Takes pairs `(writer_position, writer_usdc_ata)` in `remaining_accounts`. For each writer:
1. Deserialize `writer_position` (anchor `Account` deserialization in handler via `try_from`). If this fails (account was closed by a prior call), **skip silently**.
2. Verify `writer_position.vault == vault.key()`. If not, error (caller passed wrong-vault position).
3. Compute unclaimed premium and writer's share of `collateral_remaining` (same formula as `withdraw_post_settlement.rs:30-48`).
4. Transfer USDC for premium + share, signed by `shared_vault` PDA.
5. Decrement `vault.collateral_remaining`, `vault.total_shares`, `vault.total_collateral`.
6. Close the `writer_position` account by transferring its lamports to `writer_position.owner`'s wallet (NOT to the caller — preserves the "writer eventually gets their rent back" guarantee). Achievable via manual lamports drain rather than Anchor's `close = X` because the closure is in a loop over `remaining_accounts`.
7. If `vault.total_shares == 0` after this writer: sweep `vault_usdc_account` dust into `writer_usdc_ata` and close `vault_usdc_account`. Mirrors `withdraw_post_settlement.rs:117-144`.

Fixed accounts (~5): `caller`, `shared_vault` (mut), `vault_usdc_account` (mut), `protocol_state`, `token_program`. Then 2× writers. Account ceiling: **~29 writers per tx**. CU ceiling at 30K each: **~45 writers**. Realistic: **~25 writers per tx**.

**Pros:**
- Homogeneous batches → cleaner Anchor code, easier validation, easier tests.
- Each instruction's accounts struct is sane and reads like the existing `withdraw_post_settlement` style.
- Different phases can be sequenced or interleaved by the crank without protocol changes.
- Independent CU budgeting — holder burns are fatter than writer distributions, so tuning batch size per phase wins ~20% throughput vs. Option A.
- Failure isolation: a bad writer position doesn't block holder cleanup, and vice versa.

**Cons:**
- Two instructions in the IDL instead of one. Marginally more crank code.
- Not atomically "finalized in one block" — but neither is the existing crank flow (settle_expiry and settle_vault are already separate txs).

**When right:** this codebase, this scope. It's the natural extension of the existing patterns.

### Option C — Per-account instructions (`auto_finalize_holder_one`, `auto_finalize_writer_one`)

Each call processes exactly one holder or one writer.

**Pros:**
- Simplest possible instruction code.
- Trivially idempotent.
- Failure of one account never affects another.

**Cons:**
- Tx count blowup: a vault with 100 holders + 20 writers = 120 separate txs. At ~5000 lamports each + priority fees, that's measurably more expensive than batching, and *much* slower (Solana confirmation rate × tx count). For a 200-holder vault the crank takes minutes vs. seconds.
- Doesn't actually simplify on-chain code by much — the per-batch loop in Option B is short and the validation logic is unchanged.

**When right:** if we ever needed `getProgramAccounts`-free finalization (e.g. user-initiated "burn my own OTM token for zero" as a janitor action). Even then, `auto_finalize_holders` with a 1-element batch covers it.

---

## 3. Recommendation

**Option B.** It mirrors the existing instruction shapes (`exercise_from_vault`, `withdraw_post_settlement`) which are already audited and battle-tested, and it splits along the natural seam where holder and writer state, account requirements, and CU costs differ. The protocol already runs the crank in two passes today (`settle_expiry` then `settle_vault`); adding two more passes (`auto_finalize_holders` then `auto_finalize_writers`) keeps the mental model linear. Option A's "one atomic instruction" appeal isn't real because the crank is the only caller and it can sequence cleanly. Option C's tx-count cost is unacceptable for any vault with double-digit holder counts.

---

## 4. Crank changes

Post-settle, the crank gains a third and fourth pass per `(asset, expiry)` tuple. Both run only after `settle_vault` has flipped `vault.is_settled = true`.

### 4.1 Holder enumeration

For each settled vault that hasn't yet been auto-finalized:

```ts
const filters = [
  { memcmp: { offset: 0, bytes: optionMint.toBase58() } },  // mint at bytes 0..32
];
const holderAccounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
  filters,
  encoding: "base64",
});
```

**Important:** do NOT add a `dataSize` filter — Token-2022 ATAs with the `TransferHookAccount` extension have variable length. Filter only on the mint at offset 0 (Token-2022 account layout: `mint` 0..32, `owner` 32..64, `amount` 64..72).

For each returned account, parse owner (32..64) and amount (64..72). Drop any with `amount == 0` (already-burned remnants — there will be many, especially after natural transfer churn). The `purchase_escrow` PDAs owned by `protocol_state` will appear in this list too; the crank can either include them in the holder batch (the in-instruction `mismatched USDC ATA` skip path will silently drop them since the protocol PDA's USDC ATA isn't a holder USDC ATA) or filter them off-chain by checking `owner == protocol_state`.

### 4.2 Writer enumeration

```ts
// WriterPosition layout: 8-byte discriminator, 32-byte owner, 32-byte vault, ...
// Anchor's account discriminator for "WriterPosition" = sha256("account:WriterPosition")[..8]
const filters = [
  { memcmp: { offset: 0, bytes: bs58.encode(WRITER_POSITION_DISCRIMINATOR) } },
  { memcmp: { offset: 8 + 32, bytes: vault.toBase58() } },  // vault field at offset 40
];
const writerPositions = await program.account.writerPosition.all(filters);
```

`anchor.Program.account.writerPosition.all(filters)` already prepends the discriminator filter automatically; we only need the vault-memcmp at offset `8 + 32 = 40`.

### 4.3 Batching into transactions

Per vault, in this order:

1. Pre-create any missing holder USDC ATAs that have `payout > 0` (idempotent ATA create is already a pattern in the frontend per memory `feedback_token2022_frontend.md`). Skip OTM holders since no USDC will move.
2. Chunk holders into batches of **20** (leaves CU headroom; can be tuned via env `OPTA_AUTO_FINALIZE_HOLDER_BATCH`). Send `auto_finalize_holders` txs in series with `confirmed` commitment.
3. Chunk writers into batches of **20**. Send `auto_finalize_writers` txs in series. The last batch will trigger the dust-sweep + close-vault-usdc path naturally.

### 4.4 Partial failure / retries

- **Tx-level failure:** the crank wraps each batch in a try/catch (same pattern as `crank/bot.ts:264-272` in the existing tick loop). On failure, log + move to next batch. Next tick will pick up the unfinalized vault again because the gpa snapshot will still see live tokens / live writer positions.
- **Mid-batch user race:** if a user calls `exercise_from_vault` between snapshot and tx, the in-instruction `amount == 0` skip path turns it into a no-op for that holder. Same story for a writer who calls `withdraw_post_settlement` mid-batch — their position is closed, deserialization fails, instruction skips them.
- **Mid-batch `burn_unsold_from_vault`:** same — purchase_escrow's tokens are gone, `amount == 0`, skip.
- **RPC flake / timeout:** standard `runForever` retry on next tick (same as today's `settle_vault` retry).
- **"Vault stuck"** detection: if a vault has been settled for more than `OPTA_AUTO_FINALIZE_STALE_S` seconds (default 1 hour) and still has any holder ATAs with non-zero balance OR any writer positions, log a `warn` so we notice. Real failure modes (constraint mismatch, IDL drift) won't self-heal across ticks.

### 4.5 Stop condition

A vault is "fully finalized" when `vault.total_shares == 0` (last writer paid + vault_usdc closed). The crank's `computeExpiredTuples` filter at `crank/bot.ts:101-127` already drops settled-but-unfinalized vaults via `if (v.account.isSettled) continue;`. This needs to change: the new filter is "is_settled && total_shares > 0" → still needs auto_finalize_writers; "is_settled && total_shares == 0 && any holder ATA has amount > 0" → still needs auto_finalize_holders.

Actually, simpler: the crank tracks "fully finalized" off-chain via a small persistent set (or just always checks both gpa queries — they're cheap enough at devnet scale). When both come back empty for a vault, drop it from the work list.

---

## 5. Test scope

All tests go in `tests/zzz-auto-finalize.ts` (the `zzz-` prefix keeps them last per `feedback_migration_lessons.md` and the existing `tests/zzz-audit-fixes.ts` precedent).

### 5.1 Happy path

1. **OTM-only call vault** — 3 holders, 2 writers, settlement < strike. After `auto_finalize_holders`: all 3 holder ATAs hit zero amount. After `auto_finalize_writers`: all writers receive collateral pro-rata + premium; vault USDC account closes; positions closed.
2. **OTM-only put vault** — symmetric, settlement > strike.
3. **ITM-only call vault** — 3 holders, 2 writers, settlement > strike. Each holder receives `(price - strike) * quantity` USDC. Writers split `total_collateral - total_payouts` pro-rata.
4. **ITM-only put vault** — symmetric.
5. **Mixed pool** — ITM call vault where some holders sold their tokens to other wallets pre-expiry. Confirm secondary-market holders are paid correctly.
6. **Single holder, single writer** — degenerate case. Confirm dust sweep on the lone writer.
7. **Holder owns multiple ATAs of the same mint** — Token-2022 lets a wallet hold multiple ATAs (rare but possible via direct `initialize_account3`). Both ATAs should burn cleanly.

### 5.2 Edge cases

8. **Single-holder, max-batch-1** — confirm a 1-element batch works.
9. **Max-batch holder count** — fill `auto_finalize_holders` to its 20-account max; confirm CU stays under 1.4M and tx succeeds.
10. **Race vs. manual exercise** — between snapshot and `auto_finalize_holders` tx, holder calls `exercise_from_vault`. Crank tx must skip them silently. Vault accounting must remain consistent.
11. **Race vs. `withdraw_post_settlement`** — same idea on the writer side.
12. **Race vs. `burn_unsold_from_vault`** — writer burns unsold mid-batch. The escrow is closed; if it was in the holder batch, that account fails to deserialize. Instruction must handle gracefully (skip).
13. **Holder USDC ATA doesn't exist** — ITM holder, no USDC ATA. Crank must pre-create it OR instruction must skip and crank retry post-create. Test the chosen behavior.
14. **All writers withdraw manually before crank's writer pass** — `auto_finalize_writers` with all-deserialization-failure batch. Tx should succeed with zero work.
15. **Vault with zero buyers (all unsold)** — `total_options_sold = 0`. Holder pass is a no-op (no holders); writer pass distributes full `total_collateral` back. Confirm purchase_escrow is either burned by writer pre-tick or naturally skipped.

### 5.3 Idempotency

16. **Re-run `auto_finalize_holders` on a fully-burned vault** — second call must succeed with zero work.
17. **Re-run `auto_finalize_writers` after all positions closed** — second call must succeed with zero work.
18. **Partial-finalize then resume** — finalize half the holders, kill the crank, restart. Second pass must finish the remaining holders correctly without double-paying anyone.

### 5.4 Negative

19. **Pre-settlement call** — `auto_finalize_holders` on a non-`is_settled` vault must revert with `VaultNotSettled`.
20. **Wrong-vault writer position** — `auto_finalize_writers` with a `writer_position` whose `vault` doesn't match the passed vault. Must revert.
21. **Caller passes a Token-2022 account from a different mint** — `auto_finalize_holders` must skip or revert (verify `holder_option_ata` mint matches `option_mint`).

### 5.5 Total estimate

**~21 new test cases.** Reasonable mocha runtime addition: 5-8 min on devnet (each requires fresh fixtures: vault + 2-3 writers + 2-3 holders + settle pass).

---

## 6. Open questions

These are design calls that shouldn't be made without input:

1. **Should `auto_finalize_holders` also burn unsold tokens sitting in `purchase_escrow` accounts?** Currently `burn_unsold_from_vault` is writer-signed and has no expiry check. Two options:
   - (a) Leave `burn_unsold` alone, let the crank skip purchase_escrows in its holder enumeration.
   - (b) Make `auto_finalize_holders` permissionless-burn purchase_escrows too (requires a different signer path — protocol PDA as account owner, not as PermanentDelegate).
   - Trade-off: (b) makes "vault fully cleaned up" automatic; (a) keeps the writer in control of when their unsold inventory is burned, which preserves the writer's option to re-strategize before expiry.

2. **Should the SharedVault account itself be closed when `total_shares == 0`?** Currently no instruction closes it; it just sits there post-settlement with `is_settled = true`, `total_shares = 0`, `vault_usdc_account = closed-pubkey`. Closing it would reclaim ~0.003 SOL of rent per vault and reduce gpa noise. But it would break any frontend caching that displays historical vaults. Worth ~2 SOL across hundreds of vaults eventually; not urgent.

3. **What's the desired UX for OTM holders' zero-balance ATAs?** After `auto_finalize_holders` burns their tokens, the ATAs still exist as zero-balance Token-2022 accounts (~0.002 SOL of rent each, locked). Only the holder can close their own ATA. Do we want a frontend "Reclaim rent from expired tokens" button? Not part of this auto-finalize scope, but it's the natural follow-up.

4. **Should the crank pre-create missing ITM holder USDC ATAs, or should `auto_finalize_holders` skip and retry?** Pre-create is cheaper (one tx, idempotent) but adds another phase. Skip-and-retry is simpler but means an ITM holder without a USDC ATA never gets paid until they touch their wallet. Lean toward pre-create.

5. **How aggressive should batching be?** I proposed 20 holders / 20 writers per tx as a starting point. Real CU profiling on devnet should set the final number; current Token-2022 burn CU costs may have moved since the last measurement.

6. **Premium dust to the protocol treasury vs. last writer?** The current `withdraw_post_settlement` sweeps dust to the *signer* writer (line 117–132). Auto-finalize has no signer writer — the caller is the crank, which shouldn't keep the dust. Sending dust to `vault.creator` or to `protocol.treasury` are both options; treasury is probably cleaner.

7. **Discriminator constant for `WriterPosition`** — we'll need `sha256("account:WriterPosition")[..8]` as a constant in the crank. Anchor 0.32.1 generates this; just confirm it's exported on the IDL or compute it once.

---

## 7. Risks

Honest list of what makes me nervous:

- **gpa cost on Helius.** `getProgramAccounts(TOKEN_2022_PROGRAM_ID, { filters: [mint memcmp] })` is a heavy query — Token-2022 has millions of accounts. The mint filter helps but providers vary in how they handle indexed memcmps. Worst case: the crank's per-tick cost goes up 10× and we hit Helius quota. Mitigation: rate-limit the auto-finalize pass to "once per `(vault)` per N ticks" and short-circuit when already finalized.

- **Compute-budget drift.** The 20-per-batch number is based on rough per-op estimates. If Token-2022 burn CU costs have crept up (they did during the v1.18 → v1.18.x runtime updates), batches may revert mid-roll-out. Need empirical CU profiling on a fresh deploy before locking the batch size.

- **Pre-creating USDC ATAs costs SOL.** Each missing ATA pre-create is ~0.002 SOL, paid by the crank wallet. If a vault has 50 ITM holders without USDC ATAs, that's 0.1 SOL out of pocket per vault. Devnet is fine; on mainnet this needs a fee design. Not in scope here but worth flagging.

- **Holder ATAs that aren't actually ATAs.** A token-2022 token can be held by a non-ATA token account (`initialize_account3`). The gpa filter catches them. `auto_finalize_holders` will burn them via PermanentDelegate exactly the same way — but the holder won't necessarily have a paired USDC ATA. We must skip USDC transfer on the mismatch path, not revert.

- **Wormhole / Pyth feed migration during finalize.** If `migrate_pyth_feed` runs against an asset mid-finalize, the `vault.settlement_price` was already locked at `settle_vault` time, so it's safe. But `vault_mint_record.option_mint` is also fixed. Confident this is fine; flagging because Pyth Pull migrations are recent.

- **Idempotency assumption: zero-amount skip.** The "skip if amount == 0" pattern is the linchpin of holder-side idempotency. If a future Token-2022 update changes the layout (amount offset moves), we silently break the no-op skip and start double-burning errors. Worth a unit test that hardcodes the byte offset and panics if Token-2022's layout changes. Same applies to the writer-position discriminator filter.

- **Account-rent reclaim path.** Auto-closing `writer_position` accounts in a loop without `close = X` requires manual lamports drain via `**account.lamports.borrow_mut() = 0;` and writing destination. Easy to get wrong. The Anchor 0.32.1 idiom for this is well-known but still error-prone — needs careful PR review.

- **Test-suite drift.** §10 of HANDOFF.md says tests haven't been refreshed for the migration arc. If we add 21 new tests against an IDL that's already partially incompatible with the older 95, we may need a test-suite refresh as a prerequisite, not a follow-up. Could expand scope significantly.

- **Mainnet-only Pyth feeds + Solana devnet runtime.** Already known. Unrelated to auto-finalize but worth re-flagging because any future "ship to Solana mainnet" plan needs to revisit *both* the Hermes endpoint *and* the auto-finalize CU profile (mainnet may have different transaction limits / pricing dynamics).

---

## TL;DR

Two new permissionless instructions — `auto_finalize_holders` and `auto_finalize_writers` — plus a third/fourth pass in the crank. Both instructions take homogeneous batches of ~20 accounts via `remaining_accounts`, use the existing PermanentDelegate authority on `protocol_state` (verified at `mint_from_vault.rs:184-192`), and lean on "amount == 0 → skip" / "deserialize fail → skip" for idempotency. Estimated scope: ~21 new tests, two instruction handlers (~150-200 LOC each), crank changes (~150 LOC), one IDL regen, one redeploy. Risk profile is moderate — the patterns mirror existing audited code, but the gpa cost and CU profile both need empirical validation on devnet before lock-in.
