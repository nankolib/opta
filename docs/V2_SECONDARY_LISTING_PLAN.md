# V2 Secondary Listing Architecture Proposal

> **Status:** planning, no code written. This document covers the design of an on-chain pre-expiry marketplace for V2 vault-minted option tokens, closing the §10 #1 / §7 "remaining big gap" item in `HANDOFF.md`.
>
> **Audit basis:** read of `programs/opta/src/instructions/{mint_from_vault,purchase_from_vault,exercise_from_vault,withdraw_post_settlement,burn_unsold_from_vault,auto_finalize_holders,auto_finalize_writers}.rs`, `programs/opta/src/state/{shared_vault,vault_mint,writer_position,protocol,market}.rs`, `programs/opta/src/{lib,errors,events}.rs`, `programs/opta-transfer-hook/src/lib.rs`, `archive/v1-instructions/{list_for_resale,buy_resale,cancel_resale}.rs`, `crank/bot.ts`, and `app/src/utils/constants.ts` on 2026-05-01. Line numbers below were verified against the current tree, not copied from the handoff.

---

## 1. Audit findings

Reading the V2 vault flow end-to-end, plus the transfer-hook program and the archived V1 P2P resale code, surfaces a few facts that meaningfully shape the design and one outright contradiction with `HANDOFF.md` §10 #2.

### 1.1 `purchase_from_vault` — `programs/opta/src/instructions/purchase_from_vault.rs`

- **Token ownership chain post-purchase:** option tokens move `purchase_escrow` (PDA owned by `protocol_state`, see [`mint_from_vault.rs:333-342`](../programs/opta/src/instructions/mint_from_vault.rs#L333-L342)) → `buyer_option_account` (a regular Token-2022 ATA owned by the buyer's wallet). After this point, **the buyer's wallet is the sole owner of those tokens.** There's no protocol-side reference to who currently holds them. Any secondary trade has to either (a) move the tokens via Token-2022 transfer (which runs the transfer hook) or (b) burn them via PermanentDelegate (which doesn't run the hook).
- **No on-chain hook into post-purchase flows:** the only place the protocol re-touches a held token after purchase is in `exercise_from_vault` (holder-signed burn) or `auto_finalize_holders` (PD burn). Nothing tracks "how many of mint M is wallet W currently holding" — that's pure Token-2022 account state, queryable only via `getProgramAccounts(TOKEN_2022_PROGRAM_ID, [memcmp on mint])`.
- **Premium/fee path:** at purchase, buyer pays `total_premium = quantity * vault_mint.premium_per_contract`, fee = `total_premium * fee_bps / 10000` goes to treasury, the writer share goes to `vault_usdc_account`. **The same fee model is the natural reuse for V2 resale** — fee on the secondary trade goes to treasury, seller gets the rest.

No surprises. Just confirming that post-purchase, tokens are 100% in the buyer's regular ATA with no protocol record of the holding.

### 1.2 `exercise_from_vault` — `programs/opta/src/instructions/exercise_from_vault.rs`

Already documented in `docs/AUTO_FINALIZE_PLAN.md` §1.3, but worth re-stating one fact relevant here: **OTM tokens cannot be cleaned up via this path** — `require!(payout_per_contract > 0, OptaError::OptionNotInTheMoney)` at line 65 reverts on OTM. So for OTM listings, the seller cannot voluntarily clear out their listed tokens via `exercise_from_vault` even after settlement; they're dependent on `auto_finalize_holders` (which now exists).

### 1.3 `withdraw_post_settlement` — `programs/opta/src/instructions/withdraw_post_settlement.rs`

- **WriterPosition lifecycle is NOT correlated with token holdings.** A writer who burns all their unsold inventory via `burn_unsold_from_vault`, who has no live `options_minted`, can still call `withdraw_post_settlement` post-settlement — the only checks are `is_settled` (line 25), `owner` (line 26), `shares > 0` (line 27). **A writer who is also a holder of post-purchase tokens is not blocked by either `withdraw_post_settlement` or `auto_finalize_writers` from receiving their writer-side payout.** The token holdings are accounted for separately by the holder pass.
- This is critical for the "writer who is also their own listing's seller" edge case (test 5.2 #4 below).

### 1.4 `burn_unsold_from_vault` — `programs/opta/src/instructions/burn_unsold_from_vault.rs`

- **No `is_settled` check** (already noted in `AUTO_FINALIZE_PLAN.md` §1.5). However, post-`auto_finalize_writers`, the `writer_position` account is closed (see [`auto_finalize_writers.rs:225-244`](../programs/opta/src/instructions/auto_finalize_writers.rs#L225-L244)), and `burn_unsold_from_vault` requires a live `WriterPosition` (line 27-30). **This means `burn_unsold` is inapplicable post-finalize.** Documented as known gap in `HANDOFF.md` §7. Doesn't directly affect the listing flow but is an example of the lifecycle ordering trap that the listing flow has to avoid.

### 1.5 `auto_finalize_holders` — `programs/opta/src/instructions/auto_finalize_holders.rs`

This is the load-bearing finding for the entire listing design. Three sub-points:

- **The crank uses `getProgramAccounts(TOKEN_2022_PROGRAM_ID, [memcmp(offset:0, bytes:option_mint)])`** to enumerate every Token-2022 account holding the mint (per `AUTO_FINALIZE_PLAN.md` §4.1). **A new `VaultResaleListing` escrow PDA, if it's a Token-2022 account holding the option mint, will appear in this enumeration.** It can't be filtered out by `dataSize` (Token-2022 accounts are variable-length). The crank can filter it off-chain by checking `owner == protocol_state` if it knows that's a marker for "skip" — but that same check matches the existing `purchase_escrow` accounts, so the off-chain filter has to be more nuanced (e.g., "owner == protocol_state AND not in known listings set" or just "always pass these and rely on the in-instruction skip path").

- **The in-instruction skip path is silent and depends on USDC-ATA matching** (lines [99-153](../programs/opta/src/instructions/auto_finalize_holders.rs#L99-L153)). For each holder ATA, the handler reads the ATA's `owner` field (bytes 32..64) and verifies the paired `holder_usdc_ata` has matching `owner`. If a listing escrow is owned by `protocol_state`, then "the holder" is `protocol_state`. The crank would have to pair it with `protocol_state`'s USDC ATA (which is the protocol treasury). Treasury pubkey IS pinned via `protocol_state.treasury` constraint in `auto_finalize_writers.rs:344-348` but is NOT a constraint on the holder side — so technically the crank *could* pair the listing escrow with the treasury and the burn would proceed, with the ITM payout going to treasury. **That's the wrong economic outcome** (the seller of the listing should get the payout, not the treasury). The skip path is a footgun, not a safety rail, here.

- **The burn happens BEFORE the USDC ATA mismatch check fires** — wait, re-reading: lines 99-153 first read the holder ATA's amount/owner/mint, then read the USDC ATA's mint/owner. **Both reads happen before the burn** at lines 167-182. If the USDC ATA `mint` doesn't match `collateral_mint` (line 143), `continue` — burn skipped. ✓ So if the crank pairs a listing escrow with anything that isn't the right USDC ATA, both burn and transfer are skipped. **The risk is the crank correctly pairing the escrow with treasury USDC ATA**, in which case burn happens and USDC goes to treasury. The fix is either: (a) the crank explicitly excludes listing escrows from its holder enumeration, OR (b) the listing flow has its own pre-finalize "auto-cancel-listings" pass, OR (c) `auto_finalize_holders` adds an on-chain owner check that rejects `protocol_state`-owned ATAs (would also reject the existing `purchase_escrow` skip path — so this would be a behavior change, but a benign one if the writer's `burn_unsold_from_vault` is still expected to handle escrow burns).

  **Status: this needs an explicit decision.** See Open Question #1 below.

### 1.6 `auto_finalize_writers` — `programs/opta/src/instructions/auto_finalize_writers.rs`

- **Closes `writer_position`** by manual lamport drain + reassign + resize (lines [225-244](../programs/opta/src/instructions/auto_finalize_writers.rs#L225-L244)). Once closed, the seller-as-writer can no longer be referenced via their `writer_position` PDA — but the seller-as-listing-creator referenced via `VaultResaleListing.seller` is independent, so the listing's identity is preserved across writer-side close.
- **However, the writer's wallet receives the rent SOL** (line 238-241), which means the seller still has a wallet to receive listing-related payouts (USDC, returned escrow rent, etc.) regardless of `writer_position` lifecycle. No coupling problem there.
- **Last-writer dust-sweep + vault USDC close** at lines [261-305](../programs/opta/src/instructions/auto_finalize_writers.rs#L261-L305). After this fires, `vault_usdc_account` is closed. **If a listing's seller is owed a payout from the listing escrow's tokens AND the listing happens to be processed AFTER the last writer's auto-finalize**, there's no `vault_usdc_account` left to source the payout from. **Whatever cleanup-listings instruction we add must run BEFORE `auto_finalize_writers`'s last-writer pass closes the vault USDC account.** This is the core ordering constraint the crank has to honor.

### 1.7 `mint_from_vault` PDA derivation cross-check — `programs/opta/src/instructions/mint_from_vault.rs:148-155`

The vault-minted option mint PDA is `["vault_option_mint", vault, writer, created_at_le_8]`, and its purchase escrow is `["vault_purchase_escrow", vault, writer, created_at_le_8]`. Both are `protocol_state`-owned token accounts after init (line 339). **A new resale escrow PDA will need a similar shape**: `["vault_resale_escrow", listing_pda, ...]` — see §3 below. The `protocol_state` ownership choice for the escrow buys us the post-expiry transferability noted in §1.8.

### 1.8 Transfer-hook post-expiry behavior — `programs/opta-transfer-hook/src/lib.rs:259-291`

**Critical:** the transfer hook explicitly allows any transfer where **either source OR destination** is owned by `protocol_state`, **even after expiry** (lines 286-291). This is what makes the existing `auto_finalize_holders` USDC payout path work post-expiry (the `vault_usdc_account` is the source — wait, that's USDC not the option token, hook only runs on option-token transfers. Let me re-state). The hook runs on option-token Token-2022 transfers; for those, post-expiry transfers are allowed iff one side is `protocol_state`-owned.

**Implication for listings:** if the resale escrow is `protocol_state`-owned, then `cancel_v2_resale` can return tokens from the escrow back to the seller's regular ATA **even post-expiry** — source is protocol-owned → hook approves. This is what gives us the ability to design a clean "auto-cancel listings at expiry" pass. If we instead made the escrow PDA-owned by the listing's own PDA, post-expiry returns would be blocked by the hook.

### 1.9 V1 archive shape — `archive/v1-instructions/list_for_resale.rs`, `buy_resale.rs`, `cancel_resale.rs`

The V1 P2P pattern already proved out:

- **Per-position `RESALE_ESCROW_SEED` PDA** keyed by `OptionPosition` ([`list_for_resale.rs:48-52`](../archive/v1-instructions/list_for_resale.rs#L48-L52)). One escrow per option position. Token-2022 account, owned by `protocol_state`.
- **Listing state lived ON the OptionPosition account** as four added fields (`is_listed_for_resale`, `resale_premium`, `resale_token_amount`, `resale_seller`) — not a separate account.
- **Partial fills supported** via proportional pricing in `buy_resale.rs:42-52`, with re-derived `resale_premium` and `resale_token_amount` after each partial fill ([lines 119-137](../archive/v1-instructions/buy_resale.rs#L119-L137)).
- **Cancel returned tokens to seller** via Token-2022 transfer signed by `protocol_state` PDA ([`cancel_resale.rs:32-58`](../archive/v1-instructions/cancel_resale.rs#L32-L58)).

The V2 design lifts the *shape* but has to reify listings into their own account because there's no per-position record in V2 to glue listing state onto — only `VaultMint` (one per writer-mint, not per holder) and `WriterPosition` (per writer, never per buyer). Hence the new `VaultResaleListing` account.

### 1.10 Surprises and gotchas

These are the things the casual reader might miss:

- **Two escrows per holder if they list:** the writer's own `purchase_escrow` is unrelated to a buyer's listing escrow. The buyer (now seller-of-listing) needs their own `VaultResaleListing` escrow. So at peak, a single mint can have: 1 purchase_escrow per writer + N resale_escrows per active listing.
- **Multiple listings per (mint, seller) is design-allowed but probably bad UX.** If we PDA-key the listing as `["vault_resale_listing", mint, seller]`, only one listing per (mint, seller) pair. If we add a nonce (`["vault_resale_listing", mint, seller, nonce_le_8]`), arbitrarily many. **Recommendation: one listing per (mint, seller).** Less rope, simpler account derivation, simpler frontend ("you have one active listing per option mint"). See Open Question #2.
- **The transfer hook fires on listing AND on cancel.** Both directions. Pre-expiry both succeed. Post-expiry the hook permits the cancel direction (source = protocol-owned escrow), but **listing post-expiry is structurally meaningless** — the seller couldn't transfer their tokens TO the escrow because hook would block (source = seller, dest = protocol; protocol-owned dest → allowed. Wait — re-reading line 286: `source_owner == hook_state.protocol_state || dest_owner == hook_state.protocol_state`. **Either** side. So actually post-expiry listings would *also* succeed at the hook layer.). The protection has to be an explicit `is_settled`/`expiry` check in `list_v2_for_resale`.
- **`HANDOFF.md` §10 #2 claim — "3 new Rust instructions + new state account + new escrow PDA + frontend marketplace UI"** — this is **incomplete**. The audit shows we also need either (a) a fourth instruction (`auto_cancel_listings` or `auto_finalize_listings`), (b) extensions to `auto_finalize_holders` to handle listing escrows, or (c) explicit crank-side filtering plus a hard rule that all listings must be cancelled by the seller before expiry (poor UX). Whichever choice we make, **the handoff's "3 instructions" undercounts** unless we accept option (c). Flagging in TL;DR.
- **`HANDOFF.md` §10 #2 says "the transfer-hook architecture allows pre-expiry token transfers in principle"** — confirmed exactly true (line 261 of the hook, `clock.unix_timestamp < hook_state.expiry → return Ok(())`). The handoff's framing is correct.

---

## 2. Proposed instructions

Three core instructions, with a strong recommendation in §4 that we add a fourth (`auto_cancel_listings`) per Open Question #1's resolution.

### 2.1 `list_v2_for_resale(price_per_contract: u64, quantity: u64)`

**Purpose:** seller transfers `quantity` of option tokens from their wallet ATA into a per-(mint, seller) escrow PDA, and creates a `VaultResaleListing` PDA recording the ask.

**Accounts struct:**

```
seller                       Signer, mut (pays rent for listing PDA + escrow)
shared_vault                 SharedVault (read; not mut — listing has no vault state effect)
market                       OptionsMarket (read; constraint: market.key == shared_vault.market)
vault_mint_record            VaultMint (read; constraint: vault_mint_record.vault == shared_vault.key
                             AND vault_mint_record.option_mint == option_mint.key)
option_mint                  UncheckedAccount, mut (Token-2022 mint)
seller_option_account        UncheckedAccount, mut (Token-2022 ATA owned by seller — source)
listing                      VaultResaleListing, init,
                             seeds=[VAULT_RESALE_LISTING_SEED, option_mint, seller],
                             payer = seller, space = 8 + VaultResaleListing::INIT_SPACE
resale_escrow                UncheckedAccount, mut, init-via-CPI,
                             seeds=[VAULT_RESALE_ESCROW_SEED, listing], bump
                             (Token-2022 account, owner = protocol_state, mint = option_mint;
                             init done in handler via system_instruction::create_account +
                             initialize_account3 — same pattern as mint_from_vault.rs:303-342)
protocol_state               ProtocolState (read; seeds=[PROTOCOL_SEED]; required as escrow owner)
transfer_hook_program        UncheckedAccount, constraint == opta_transfer_hook::ID
extra_account_meta_list      UncheckedAccount (for transfer hook)
hook_state                   UncheckedAccount (for transfer hook)
token_2022_program           Program<Token2022>
system_program               Program<System>
rent                         Sysvar<Rent>
```

**Reads:** `shared_vault.is_settled`, `shared_vault.expiry`, `vault_mint_record.option_mint`, `seller_option_account.amount` (raw read at bytes 64..72, same pattern as [`list_for_resale.rs:30-36`](../archive/v1-instructions/list_for_resale.rs#L30-L36)).

**Writes:** `listing.{seller, vault, option_mint, listed_quantity, price_per_contract, created_at, bump}`; creates and initializes `resale_escrow` (Token-2022 account); does NOT mutate `shared_vault` or `vault_mint_record`.

**Tokens moved:** `quantity` option tokens from `seller_option_account` → `resale_escrow` via `spl_token_2022::onchain::invoke_transfer_checked` signed by `seller` (not by protocol PDA — same shape as [`list_for_resale.rs:79-100`](../archive/v1-instructions/list_for_resale.rs#L79-L100)).

**Authority:** `seller` signs.

**Idempotency:** plain `init` on the listing PDA — second call with the same `(option_mint, seller)` reverts naturally with `account already in use`. **Intentional** per §1.10 ("one listing per (mint, seller)") and Open Question #2.

**Failure modes / new error variants needed:**
- `OptaError::VaultAlreadySettled` (existing, line 71 of `errors.rs`) — if `shared_vault.is_settled`. Required check.
- `OptaError::VaultExpired` (existing, line 74) — if `clock.unix_timestamp >= shared_vault.expiry`. Required check.
- `OptaError::InvalidContractSize` (existing, line 42) — if `quantity == 0`.
- `OptaError::InvalidPremium` (existing, line 44) — if `price_per_contract == 0`.
- `OptaError::InsufficientOptionTokens` (existing, line 54) — if `quantity > seller's balance`.
- `OptaError::InvalidVaultMint` (existing, line 101) — if `vault_mint_record` doesn't pin to `(vault, option_mint)`.
- **No new error variants needed for `list_v2_for_resale`.**

**Events emitted:**
- `VaultListingCreated { listing: Pubkey, vault: Pubkey, mint: Pubkey, seller: Pubkey, listed_quantity: u64, price_per_contract: u64, created_at: i64 }` — new event.

### 2.2 `buy_v2_resale(quantity: u64, max_total_price: u64)`

**Purpose:** buyer pays `quantity * price_per_contract` USDC; receives `quantity` option tokens from the listing escrow. Listing's `listed_quantity` decremented; if zero, listing is closed and rent refunded to seller.

**Accounts struct:**

```
buyer                        Signer, mut
shared_vault                 SharedVault (read; needed for vault.collateral_mint constraint
                             on buyer_usdc + seller_usdc + treasury)
market                       OptionsMarket (read; constraint = shared_vault.market)
vault_mint_record            VaultMint (read; constraint pin vault + option_mint)
listing                      VaultResaleListing, mut,
                             seeds=[VAULT_RESALE_LISTING_SEED, option_mint, listing.seller],
                             close-if-empty path uses close=seller (manual or via
                             AccountInfo if close-condition is dynamic — see Failure mode
                             "auto-close on full fill")
seller                       UncheckedAccount, mut (rent destination on listing close;
                             constraint: seller.key == listing.seller — required because
                             rent flows to this wallet)
option_mint                  UncheckedAccount, mut
resale_escrow                UncheckedAccount, mut,
                             seeds=[VAULT_RESALE_ESCROW_SEED, listing], bump
buyer_option_account         UncheckedAccount, mut (Token-2022 ATA owned by buyer — destination;
                             frontend creates ATA before calling, idempotent)
buyer_usdc_account           Account<TokenAccount>, mut, constraints: owner == buyer
                             AND mint == shared_vault.collateral_mint
seller_usdc_account          Account<TokenAccount>, mut, constraints: owner == listing.seller
                             AND mint == shared_vault.collateral_mint
                             (frontend pre-creates if missing, same pattern as
                             auto_finalize_holders ATA pre-create plan)
treasury                     Account<TokenAccount>, mut, seeds=[TREASURY_SEED], bump,
                             constraint == protocol_state.treasury
protocol_state               ProtocolState, mut (for fee_bps, total_volume increment)
transfer_hook_program        UncheckedAccount
extra_account_meta_list      UncheckedAccount
hook_state                   UncheckedAccount
token_program                Program<Token>            (for USDC transfers)
token_2022_program           Program<Token2022>        (for option-token transfer)
system_program               Program<System>
```

**Reads:** `listing.{listed_quantity, price_per_contract, seller}`, `protocol_state.fee_bps`, `resale_escrow.amount` (sanity check; should equal `listing.listed_quantity` always).

**Writes:** `listing.listed_quantity -= quantity`; `protocol_state.total_volume += total_price`. If `listing.listed_quantity` becomes zero, close `listing` (rent → seller).

**Tokens moved:**
1. USDC: `buyer_usdc_account` → `seller_usdc_account` for `seller_share = total_price - fee` (signed by buyer).
2. USDC: `buyer_usdc_account` → `treasury` for `fee = total_price * fee_bps / 10000` (signed by buyer).
3. Option tokens: `resale_escrow` → `buyer_option_account` for `quantity`, signed by `protocol_state` PDA (same pattern as [`buy_resale.rs:86-110`](../archive/v1-instructions/buy_resale.rs#L86-L110)).

**Authority:** `buyer` signs. Listing escrow is `protocol_state`-owned, so PDA signs the option-token transfer with `[PROTOCOL_SEED, &[protocol_state.bump]]`.

**Idempotency:** none required — each call is a discrete partial fill. The state mutation (`listing.listed_quantity -= quantity`) is the natural debounce; if a buyer tries to buy more than `listing.listed_quantity` allows, it reverts.

**Auto-close on full fill:** when the in-handler `listing.listed_quantity` hits zero AFTER decrement, close the `listing` account by manual lamport drain → seller's wallet (because `close = X` derive can't be conditional in Anchor 0.32.1 — same idiom as [`auto_finalize_writers.rs:225-244`](../programs/opta/src/instructions/auto_finalize_writers.rs#L225-L244)). Also close the now-empty `resale_escrow` Token-2022 account (rent → seller) via `spl_token_2022::instruction::close_account` signed by protocol PDA (same pattern as [`burn_unsold_from_vault.rs:74-88`](../programs/opta/src/instructions/burn_unsold_from_vault.rs#L74-L88)). **One transaction does buy+close-on-fill atomically** — natural and clean.

**Failure modes / new error variants needed:**
- `OptaError::VaultExpired` (existing) — must check `clock < shared_vault.expiry`. Confirmed in `purchase_from_vault.rs:36`. Required check (mirrors `BuyResale` v1's `MarketExpired` check at [`buy_resale.rs:27`](../archive/v1-instructions/buy_resale.rs#L27)).
- `OptaError::VaultAlreadySettled` (existing) — required check (mirrors `purchase_from_vault.rs:37`).
- `OptaError::CannotBuyOwnOption` (existing, line 50) — buyer.key != listing.seller. **Reuses the existing variant** since "buying your own listing" is the same logical error as "buying your own write".
- `OptaError::InvalidContractSize` (existing) — quantity > 0.
- `OptaError::SlippageExceeded` (existing, line 92) — `total_price > max_total_price`.
- **New error variant required:** `OptaError::ListingExhausted` — if `quantity > listing.listed_quantity`. (Could reuse `InsufficientOptionTokens` line 54, but the listing-quantity-exhaustion case is semantically different — the escrow really does hold zero, and the error should hint at "listing exhausted" not "you don't own enough tokens".)

**Events emitted:**
- `VaultListingFilled { listing: Pubkey, mint: Pubkey, seller: Pubkey, buyer: Pubkey, quantity: u64, total_price: u64, fee: u64, listing_remaining: u64, listing_closed: bool }` — new event.

### 2.3 `cancel_v2_resale()`

**Purpose:** seller closes their own listing. All escrow tokens return to the seller's regular ATA. Listing PDA closed, rent refunded.

**Accounts struct:**

```
seller                       Signer, mut (rent destination via close = seller)
shared_vault                 SharedVault (read)
listing                      VaultResaleListing, mut, close = seller,
                             seeds=[VAULT_RESALE_LISTING_SEED, option_mint, seller], bump,
                             constraint: listing.seller == seller.key
option_mint                  UncheckedAccount, mut (constraint: option_mint.key ==
                             listing.option_mint)
resale_escrow                UncheckedAccount, mut,
                             seeds=[VAULT_RESALE_ESCROW_SEED, listing], bump
seller_option_account        UncheckedAccount, mut (destination ATA; frontend creates if
                             missing — idempotent)
protocol_state               ProtocolState (read; signs the escrow-source transfer)
transfer_hook_program        UncheckedAccount
extra_account_meta_list      UncheckedAccount
hook_state                   UncheckedAccount
token_2022_program           Program<Token2022>
system_program               Program<System>
```

**Reads:** `listing.{seller, option_mint, listed_quantity}` (although `listed_quantity` is informational here — we transfer whatever the escrow actually holds, which matches via construction).

**Writes:** Closes `listing` (Anchor `close = seller`). Closes `resale_escrow` Token-2022 account (rent → seller) via `spl_token_2022::instruction::close_account` signed by protocol PDA — same pattern as [`burn_unsold_from_vault.rs:74-88`](../programs/opta/src/instructions/burn_unsold_from_vault.rs#L74-L88).

**Tokens moved:** `escrow_balance` option tokens from `resale_escrow` → `seller_option_account`, signed by `protocol_state` PDA via `invoke_transfer_checked` (same pattern as [`cancel_resale.rs:32-58`](../archive/v1-instructions/cancel_resale.rs#L32-L58)). **The transfer hook permits this even post-expiry** because source is `protocol_state`-owned (per §1.8). So this works whether or not the vault has expired or settled.

**Authority:** seller signs.

**Idempotency:** none — second call reverts because listing PDA no longer exists.

**Failure modes / new error variants needed:**
- `OptaError::NotResaleSeller` — seller's pubkey doesn't match `listing.seller`. **New variant needed.** (V1 had this exact name in `errors.rs` but it was pruned in Stage 2 per `MIGRATION_LOG.md` Stage 2 "What was deleted" list.) **Re-introduce with the same name and message.**

**Events emitted:**
- `VaultListingCancelled { listing: Pubkey, mint: Pubkey, seller: Pubkey, returned_quantity: u64 }` — new event.

### 2.4 Summary of new error variants needed

Adding to `programs/opta/src/errors.rs`:

```
#[msg("listing has fewer tokens available than requested")]
ListingExhausted,
#[msg("only the listing's seller can cancel it")]
NotResaleSeller,
```

And depending on Open Question #1 resolution, optionally:
```
#[msg("listing escrow does not belong to this vault")]
InvalidListingEscrow,
```
(only if we add `auto_cancel_listings` and want it to validate escrow PDA derivation against vault).

### 2.5 Summary of new events needed

Adding to `programs/opta/src/events.rs`:

```
#[event]
pub struct VaultListingCreated { listing, vault, mint, seller, listed_quantity, price_per_contract, created_at }
#[event]
pub struct VaultListingFilled { listing, mint, seller, buyer, quantity, total_price, fee, listing_remaining, listing_closed }
#[event]
pub struct VaultListingCancelled { listing, mint, seller, returned_quantity }
```

(Plus `VaultListingsAutoCancelled` if Open Question #1 lands on the "auto-cancel-listings pass" answer — mirroring `HoldersFinalized`.)

---

## 3. Proposed state

### 3.1 `VaultResaleListing` account

**File:** `programs/opta/src/state/vault_resale_listing.rs` (new).

**Fields (in declaration order — Anchor `InitSpace` derives byte layout from this):**

```rust
#[account]
#[derive(InitSpace)]
pub struct VaultResaleListing {
    /// Wallet that created the listing. Receives sale proceeds.
    pub seller: Pubkey,                    // 32 bytes
    /// Which SharedVault this option mint was minted from.
    /// Stored for reverse lookup + crank enumeration efficiency.
    pub vault: Pubkey,                     // 32 bytes
    /// The Token-2022 mint being resold.
    pub option_mint: Pubkey,               // 32 bytes
    /// Tokens currently sitting in the resale_escrow PDA.
    /// Decremented on each partial fill.
    pub listed_quantity: u64,              // 8 bytes
    /// USDC per contract (6 decimals), set at listing time, immutable.
    pub price_per_contract: u64,           // 8 bytes
    /// Unix timestamp when listing was created.
    pub created_at: i64,                   // 8 bytes
    /// PDA bump seed.
    pub bump: u8,                          // 1 byte
}

pub const VAULT_RESALE_LISTING_SEED: &[u8] = b"vault_resale_listing";
pub const VAULT_RESALE_ESCROW_SEED: &[u8] = b"vault_resale_escrow";
```

**Total size:** 8 (Anchor discriminator) + 32 + 32 + 32 + 8 + 8 + 8 + 1 = **129 bytes**.

**Rent (devnet, ~`0.00000348 SOL/byte` at standard rent-exempt):** ~0.001895 SOL per listing, refunded to seller on cancel or full fill.

**PDA seeds:** `[VAULT_RESALE_LISTING_SEED, option_mint, seller]` — one listing per (mint, seller). See Open Question #2 for the alternative (nonced multi-listing).

### 3.2 Resale escrow PDA

**Type:** Token-2022 account (NOT a custom Anchor account).

**PDA seeds:** `[VAULT_RESALE_ESCROW_SEED, listing.key()]` — keyed by the listing PDA, not by (mint, seller), so derivation is clean and cancel/buy can recompute it from `listing` alone.

**Owner:** `protocol_state` PDA (set during `initialize_account3` in handler — same pattern as [`mint_from_vault.rs:333-342`](../programs/opta/src/instructions/mint_from_vault.rs#L333-L342)).

**Why protocol_state and not the listing PDA itself?**

Two-fold:
1. **Post-expiry transferability:** the transfer hook (§1.8) permits transfers where source OR dest is `protocol_state`-owned. If the escrow is owned by the listing PDA, that's a different pubkey from `protocol_state`, and the hook would block post-expiry returns to the seller. Cancellation post-expiry would fail. With `protocol_state` ownership, cancel_v2_resale works at any time.
2. **Code reuse:** `purchase_escrow` is already `protocol_state`-owned. The CPI shape for "PDA signs token-2022 transfer out" is identical (see [`buy_resale.rs:88-110`](../archive/v1-instructions/buy_resale.rs#L88-L110), [`cancel_resale.rs:34-57`](../archive/v1-instructions/cancel_resale.rs#L34-L57), [`burn_unsold_from_vault.rs:50-71`](../programs/opta/src/instructions/burn_unsold_from_vault.rs#L50-L71)). Reusing the protocol_state seeds means no new authority codepath.

**The PermanentDelegate authority is also `protocol_state`** ([`mint_from_vault.rs:184-192`](../programs/opta/src/instructions/mint_from_vault.rs#L184-L192)), which is a happy coincidence — if Open Question #1 lands on "let `auto_finalize_holders` burn listing escrow tokens", PD authority and account-owner authority both belong to the same PDA, so either burn path works.

**Size:** Token-2022 account with `TransferHookAccount` extension (per `mint_from_vault.rs:303-307`). At present, `ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[ExtensionType::TransferHookAccount])` returns ~175 bytes.

**Rent:** ~0.00203928 SOL per escrow (standard Token-2022 ATA-with-extension rent), refunded to seller on cancel or full fill.

### 3.3 Total seller cost per listing

~0.00394 SOL of rent locked while listing is open, fully refunded on cancel or full fill. Plus ~0.00001 SOL transaction fee. Cheap enough to ignore in UX copy.

---

## 4. WriterPosition / auto-finalize interaction

This is the section the chat session flagged as the central concern. Treating it as the load-bearing design discussion.

### 4.1 What happens to an open listing when the vault hits expiry?

**The listing PDA itself is unaffected by expiry** — it's a plain Anchor account, no time logic. **The escrow tokens are also unaffected at the moment of expiry** — they sit in the protocol-owned escrow with `amount = listed_quantity`.

**What changes at expiry:**
- The transfer hook starts blocking user-to-user option-token transfers (line 286-291 of the hook). But since the escrow is protocol-owned, transfers in or out of the escrow are **still permitted by the hook**.
- `buy_v2_resale` should be guarded by `require!(clock < shared_vault.expiry)` so buyers can't fill an expired listing (matches the `purchase_from_vault.rs:36` pattern). Open question: do we hard-block at expiry, or at settlement? **Recommendation: block at expiry.** Same as `purchase_from_vault`. After expiry, the option's economic value is locked but unknown until the Pyth Pull oracle posts the price; allowing buys in that window would be a guessing game.

### 4.2 Is the listing automatically cancelled, force-filled, or left dangling?

This is the open call. Three concrete designs, scored:

**Design A — Auto-cancel-listings pass added to crank**

A new permissionless instruction `auto_cancel_listings` (like the existing `auto_finalize_holders` pattern) walks `(listing_pda, resale_escrow, seller_option_account)` triples in `remaining_accounts`. For each: returns escrow tokens to seller's regular ATA (transfer signed by protocol PDA), closes the escrow account (rent → seller), closes the listing account (rent → seller). The crank runs this **before** the holder-finalize pass on every settled vault. Then `auto_finalize_holders` picks up the seller's now-augmented holder ATA naturally.

- **Pro:** clean separation of concerns; no extension to `auto_finalize_holders`; reuses the holder pass as-is; the seller's payout goes through the standard holder path with no special-casing.
- **Pro:** seller's `seller_option_account` ATA might not exist (they may have moved their entire balance to the listing). The crank pre-creates the seller's ATA in the same pattern it pre-creates holder USDC ATAs (`OPTA_AUTO_FINALIZE_MAX_ATAS_PER_TICK` budget is already there).
- **Con:** one extra crank pass per tick; minor.
- **Con:** if there are many listings, batching tooling is the same shape as auto_finalize_holders — not novel work, but still LOC.

**Design B — Extend `auto_finalize_holders` to burn listing escrows + pay seller**

`auto_finalize_holders` would accept triples `(option_ata_or_escrow, usdc_ata, optional_listing_pda)` instead of pairs. If the third element is non-default, it's a listing pass: the handler reads `listing.seller`, derives the seller's USDC ATA, burns the escrow tokens via PD, pays seller the ITM USDC, closes listing + escrow.

- **Pro:** one fewer crank pass.
- **Con:** breaks the homogeneous-batch property that makes `auto_finalize_holders` simple. Triples-with-optional-third-element heterogeneous batches are exactly the failure mode noted in `AUTO_FINALIZE_PLAN.md` §2 Option A ("heterogeneous remaining_accounts parsing is fragile"). We rejected that pattern for the auto-finalize arc; rejecting it again here is consistent.
- **Con:** changes the IDL of `auto_finalize_holders`, which means the deployed crank's existing batching code has to be rewritten too. Coupling that we already paid down.

**Design C — Seller is responsible for cancelling pre-expiry; on-chain has no auto-handling**

Just a strict pre-expiry deadline. Frontend warns. If the seller forgets, their tokens are stuck in the escrow forever (no path to retrieve post-finalize because `vault_usdc_account` is closed by the time the user wakes up).

- **Pro:** zero new crank work, zero new instructions.
- **Con:** terrible UX. The whole pitch of the protocol is "no clicks at expiry." This makes resale sellers an exception to that pitch. **Inconsistent with thesis.**
- **Con:** dust-recovery becomes a help-desk problem.

**Recommendation: Design A.** Costs ~150 LOC of one new on-chain instruction + ~80 LOC of crank wiring + ~6 new test cases, and preserves the homogeneous-batch property that has worked well for the auto-finalize arc.

### 4.3 Does `auto_finalize_holders` need to know about resale escrows when enumerating holders?

**With Design A: no.** The auto-cancel-listings pass runs first, returns tokens to sellers, closes escrows. By the time the holder-enumeration `getProgramAccounts` runs, no listing escrows exist on-chain; the snapshot only contains regular holder ATAs + writer purchase escrows.

**Without Design A (Design C): the crank must filter listing escrows out of its enumeration off-chain.** The marker: account-owner == `protocol_state` AND PDA derived from `[VAULT_RESALE_ESCROW_SEED, listing_pda]` — but the crank would have to derive every active listing PDA to match. Cheaper to just skip *all* `protocol_state`-owned ATAs (which would include `purchase_escrow` and `resale_escrow` both). That's a minor change to `crank/autoFinalize.ts` enumeration but doesn't change the on-chain handler.

### 4.4 Does `cancel_v2_resale` need an `is_settled` check?

**No.** Cancellation post-settlement is not only safe, it's the only way for a user to recover their tokens if the auto-cancel-listings crank pass hasn't run yet (or if Design C is chosen and we never add it). The transfer hook explicitly permits the cancel direction (§1.8). And recovering tokens to your own wallet post-expiry doesn't grant any new economic privilege — those tokens then either get exercised (if ITM and seller calls `exercise_from_vault` themselves) or get auto-burned by `auto_finalize_holders` on the next crank tick. Either way, the seller ends up with the same outcome they would have had if they'd never listed.

**However:** if `auto_finalize_writers` has already run for the seller's vault and the `vault_usdc_account` is closed, then ITM payouts to the seller are no longer reachable via `auto_finalize_holders` (it would try to transfer USDC from the closed account and fail). So the chronological ordering matters even with Design A — listings must be cleaned up before the writer pass closes the vault USDC. That's a crank-ordering constraint, not an on-chain constraint.

### 4.5 If a listing's escrow holds N tokens at expiry, does the seller get the writer-side payout, the holder-side payout, or both, or neither?

**Holder-side. Always.** A listing seller is a holder by virtue of having purchased those tokens on the vault. Their `WriterPosition` (if they happen to be a writer too) is independent and pays them on the writer side independently. Two separate payouts for two separate roles, never coupled.

**With Design A**, the auto-cancel pass returns tokens to seller's wallet → holder-finalize burns them and pays the seller (if ITM). With Design B, the burn happens directly from the escrow with seller as payout destination. Either way: holder-side payout, paid to the listing's `seller` wallet.

### 4.6 Open question, flagged

The big call here is Design A vs B vs C above. **I propose Design A. Open Question #1 captures this for Nanko's sign-off.**

---

## 5. Crank changes (if any)

### 5.1 Tick ordering after the listing arc lands

Per Design A above, the crank's tick gains one new pass. New ordering, per settled vault:

1. **Phase 1 (existing):** `settle_expiry` + `settle_vault` for any expired non-settled vault (unchanged from current `crank/bot.ts:360-400`).
2. **Phase 2a (new):** `auto_cancel_listings` for the vault. Enumerate `VaultResaleListing` accounts via `program.account.vaultResaleListing.all([memcmp(8, vault.toBase58())])` (vault field is at offset 8 after Anchor disc, then 32 bytes of seller; vault is at offset 8+32 = 40). Pre-create any seller `seller_option_account` ATAs that don't exist yet. Batch into transactions of ~15 listings per tx (each listing requires 3 accounts in remaining_accounts: listing, escrow, seller_option_ata; plus the wallet for rent — call it 4. With ~10 fixed accounts: 4×15 + 10 = 70; need to keep under the 64-account ceiling, so probably **batch size ~12**).
3. **Phase 2b (existing):** `auto_finalize_holders` (unchanged — but with the assurance that listing escrows have already been drained, so the gpa enumeration only contains regular holder ATAs + writer purchase_escrows).
4. **Phase 2c (existing):** `auto_finalize_writers` (unchanged — last-writer dust sweep + vault USDC close still happens at the end as today).

### 5.2 Enumeration cost

A single extra `program.account.vaultResaleListing.all([memcmp])` call per settled vault per tick. At devnet scale, negligible. At mainnet scale, comparable to the existing per-vault `WriterPosition` enumeration.

### 5.3 ATA pre-create budget

The existing `OPTA_AUTO_FINALIZE_MAX_ATAS_PER_TICK` budget (`crank/bot.ts:421`) is shared across holder and writer passes. Listings would join the same pool — the auto-cancel-listings pass might pre-create a seller's `seller_option_account` (Token-2022 ATA) before returning tokens to it. **Single budget, three consumers** (holder USDC ATAs, writer USDC ATAs, seller option ATAs).

### 5.4 LOC estimate

- ~80 LOC in `crank/autoFinalize.ts` for `runListingsAutoCancel(...)` mirroring `runHolderFinalize`/`runWriterFinalize`.
- ~30 LOC of wiring in `crank/bot.ts` to invoke it between Phase 1 and Phase 2a, plus a new `listingsCancelled` counter in `TickResult`.
- ~10 LOC of env-var parsing for `OPTA_AUTO_CANCEL_LISTINGS_BATCH` (default 12).

Total: ~120 LOC of crank changes.

---

## 6. Frontend changes (sketched only — implementation deferred)

**The user explicitly said: "Frontend marketplace UI is part of the eventual scope but the PLAN should cover it; implementation will be deferred per session."** Sketch only.

### 6.1 New components / pages

- **`/marketplace` route or `/trade` tab:** browse all open `VaultResaleListing` accounts, grouped by underlying option mint. Each row: option metadata (asset, strike, expiry, type from `VaultMint` → mint metadata), seller (truncated), `listed_quantity`, `price_per_contract`, total ask, age. Call-to-action: **Buy** (opens `BuyListingModal`).
- **`BuyListingModal`:** quantity slider (1 to `listed_quantity`), live total price, slippage check vs `max_total_price`, idempotent buyer USDC ATA + buyer option ATA pre-create, sends `buy_v2_resale` instruction.
- **`Portfolio → My Listings` section:** below the existing Positions table, list the wallet's own active `VaultResaleListing` accounts with **Cancel** button (sends `cancel_v2_resale`).
- **`Portfolio → Sell button` per holding:** on each option-position row in the Portfolio, add a **List** action that opens `ListForResaleModal`.
- **`ListForResaleModal`:** quantity input (max = wallet's current balance), price-per-contract input, indicative total. Sends `list_v2_for_resale`. Pre-creates the buyer-side accounts via Anchor's idempotent ATA pattern.

### 6.2 Hook changes

- **New hook `useResaleListings`:** mirrors `useVaults` shape — `program.account.vaultResaleListing.all()` plus filter helpers (by mint, by seller, etc.).
- **`useTokenMetadata`** likely needs no changes; listings reference an `option_mint` whose metadata is already cacheable via the existing hook.
- **`useFetchAccounts`** gets one new entry in its account-type list (`vaultResaleListing`).

### 6.3 PDA / constants additions

- `app/src/utils/constants.ts:62` — add:
  - `VAULT_RESALE_LISTING_SEED = "vault_resale_listing"`
  - `VAULT_RESALE_ESCROW_SEED = "vault_resale_escrow"`
- Helper `deriveResaleListingPda(mint, seller)` and `deriveResaleEscrowPda(listing)`.

### 6.4 Copy / UX

- "Contracts" not "tokens" everywhere (per `feedback_coding_style` memory).
- "Sell on the secondary market" or "List for resale" as the action verb.
- Surface in the option's own term sheet view: "X contracts available from N sellers, prices from $Y to $Z."
- Indicative-vs-listed pricing comparison: show the Black-Scholes fair value next to the listed ask, so buyers see the discount/premium vs theoretical (the same `blackScholes.ts` machinery already used in the Indicative Premium panel).

### 6.5 Rough effort estimate

For a single Claude session on the frontend side (when we're ready to do it):

- Recon + plumbing pass: ~1 hour (hook + constants + IDL refresh).
- Listings list + buy modal: ~2 hours.
- My Listings + cancel modal: ~1 hour.
- Sell modal on existing positions: ~1 hour.
- Polish + edge cases (empty states, USDC/option-ATA pre-create idempotency, decoding errors): ~1 hour.

**~6 hours of focused implementation, +1 hour for live devnet smoke.** Comparable in shape to the V2 vault frontend build (`project_v2_frontend_build`).

---

## 7. Test matrix

All tests go in `tests/zzz-secondary-listing.ts` (the `zzz-` prefix keeps them last per the `feedback_migration_lessons` memory and `tests/zzz-audit-fixes.ts` precedent).

### 7.1 Happy path

1. **List → buy → settle → buyer auto-paid.** Writer mints from V2 vault, buyer A purchases, lists 5 contracts at $X, buyer B fills full 5 contracts → seller (buyer A) gets USDC seller-share, treasury gets fee, buyer B gets 5 option tokens. Vault settles ITM via Pyth Pull mock. Crank runs `auto_finalize_holders`. Buyer B receives ITM payout to their USDC ATA with no further action. **Headline demo flow.**
2. **List → cancel → seller has tokens back.** Same setup; instead of buy, seller calls `cancel_v2_resale`. All escrow tokens return to seller's regular ATA. Listing PDA closed, rent refunded to seller wallet.
3. **Partial fill, then second buyer fills the remainder.** Buyer C fills 3 of 5 contracts, listing.listed_quantity drops to 2. Buyer D fills remaining 2; listing auto-closes (rent refund), escrow auto-closes.
4. **Partial fill, then seller cancels remainder.** Same as above through buyer C, then seller cancels the remaining 2. Tokens return; listing closed.

### 7.2 Edge cases

5. **List → expiry hits with listing still open.** No buyer ever fills. After expiry, crank runs `auto_cancel_listings` first (Design A); seller's tokens return to their regular ATA. Then `auto_finalize_holders` burns them and pays the seller if ITM. Reconcile USDC balances to the lamport.
6. **Seller is also a writer in the same vault, lists their own holder tokens.** Independent payout: writer-side payout via `auto_finalize_writers` lands in seller's USDC ATA; holder-side payout (post auto-cancel pass) also lands in seller's USDC ATA. Test asserts both arrived.
7. **Listing across the auto-finalize-holders pass (Design A safety).** Settle a vault, then DON'T run `auto_cancel_listings` (simulate crank lag). Run `auto_finalize_holders` directly. Test asserts the listing escrow's tokens are NOT burned (the gpa enumeration would find them; the in-instruction skip path should leave them alone because the crank never paired the escrow with the treasury USDC ATA in the first place — and if it did, that's a crank bug, not a handler bug. Test the handler in isolation: feed it the escrow paired with the treasury USDC ATA and assert the burn-then-USDC-to-treasury path either fails or is explicitly disallowed by an added owner check). **This test exposes the choice in §4.3 / Open Question #1.**
8. **Listing for a vault whose epoch differs from another listing.** Two listings on two different mints from two different vaults; cancel one, fill the other. Independence check.
9. **Seller has zero tokens in their wallet but tries to list.** Reverts with `InsufficientOptionTokens`.
10. **Seller has fewer tokens than they try to list.** Reverts with `InsufficientOptionTokens`.
11. **Listing for more tokens than seller actually holds (must reject).** Same as #10 but with `quantity = balance + 1`. Reverts.

### 7.3 Race / concurrency

12. **Two buyers race for the same listing.** Buyer X submits `buy_v2_resale(quantity = 3)` while buyer Y submits `buy_v2_resale(quantity = 4)` for a listing of 5. Whichever lands second reverts with `ListingExhausted` (one tx may fully succeed at 3, the other at 4 reverts because escrow only has 2 left after the first; or if first sees quantity=3 and second sees quantity=2 after refresh, both succeed; the test asserts no double-spend regardless).
13. **Buyer fills full listing while seller submits cancel.** Two txs in flight; one wins, the other reverts (one with `account already closed` if cancel won the close race, or with the buy succeeding and the cancel reverting because the listing is gone). Test asserts one outcome happens cleanly.

### 7.4 Negative

14. **Buyer with no USDC ATA.** Reverts with the standard SPL Token "TokenAccount not initialized" error from the constraint check. Frontend pre-creates ATA before calling, but the test confirms the on-chain reverts cleanly when ATA is missing.
15. **Buyer is the seller (`buyer.key == listing.seller`).** Reverts with `CannotBuyOwnOption`.
16. **Buy with `total_price > max_total_price` (slippage).** Reverts with `SlippageExceeded`.
17. **Buy from an exhausted listing.** Reverts with `ListingExhausted`.
18. **Cancel called by non-seller.** Reverts with `NotResaleSeller`.
19. **List against an already-settled vault.** Reverts with `VaultAlreadySettled`.
20. **List against an expired-but-not-settled vault.** Reverts with `VaultExpired`.
21. **Buy against an expired-but-not-settled vault.** Reverts with `VaultExpired`.

### 7.5 Idempotency / double-listing

22. **List twice with same (mint, seller) pair.** Second `init` reverts with "account already in use". (Confirms the design choice in Open Question #2.)

### 7.6 Total estimate

**~22 new test cases.** Mocha runtime addition: ~6-9 minutes on devnet (each test requires fixture setup: vault + writer position + minted mint + buyer purchase + listing creation; the auto-finalize-holders integration tests take longer because they need the full settlement pipeline).

---

## 8. Open questions

These are design calls Nanko should weigh in on before Step 1 starts.

1. **Listing-vs-auto-finalize-holders coordination — Designs A, B, or C?** §4.2 lays out the trade-off in detail. **My recommendation: A** (a separate `auto_cancel_listings` instruction + crank pass). It preserves the homogeneous-batch property of `auto_finalize_holders` that we paid down for in the previous arc; it adds ~150 LOC of one new instruction + ~120 LOC of crank wiring; it's testable in isolation; it scales without coupling. The cost is one extra instruction in the IDL and one extra crank pass per tick. **B** (extending `auto_finalize_holders` to be triple-aware) is fewer-instructions but reintroduces heterogeneous batches. **C** (no on-chain auto-handling, sellers must cancel themselves) is cheap but breaks the "no clicks at expiry" thesis for sellers specifically, which feels off-message. **This is the single biggest call. Until it's locked, the test matrix can't be finalized and the "3 instructions" framing in HANDOFF.md §10 #2 stays incomplete.**

2. **One-listing-per-(mint, seller) vs nonced multi-listings?** §1.10 / §3.1. Trade-off: single-listing simplifies frontend ("you have one active listing per option") and makes PDA derivation deterministic without state lookup; nonced multi-listings let sellers list at multiple prices simultaneously (e.g., 5 contracts at $10, 10 contracts at $9). **My recommendation: single-listing.** The price-discovery argument for nonced multi-listings is real for sophisticated traders but doesn't pay back the complexity within the demo window. Frontend can always re-fill the seller's UI as "edit your listing" rather than "create a second one."

3. **Fee charged on resale: same `fee_bps` as primary, or separate `resale_fee_bps` field on `ProtocolState`?** Argument for same: simplicity, one fee number to communicate. Argument for separate: secondary trades have different economics (no underwriting risk to compensate, may want to incentivize liquidity by going lower). **My recommendation: same `fee_bps` for now**, add a separate field later if the market actually uses it. Keeps the IDL stable.

4. **Should `buy_v2_resale` include a hard `is_settled` check?** Right now the recommendation is "block at `expiry`, not at `is_settled`" (matches `purchase_from_vault.rs:36`). But if a vault has been settled but `auto_cancel_listings` hasn't run yet, the listing would technically still be on-chain with stale tokens. Adding `require!(!shared_vault.is_settled)` is a belt-and-braces guard. **My recommendation: add the check.** The cost is one line of Rust; the benefit is the buyer can never accidentally fill a stale listing on a settled vault.

5. **What happens to the fee on a buy that fills the last unit and closes the listing in the same tx?** The fee transfers happen first, then the listing close. This is fine — the listing close is unrelated to the fee transfer. Confirming for completeness; no design call.

6. **Seller's USDC ATA missing at fill time?** Right now the design says "frontend pre-creates if missing." But on-chain we should decide: does `buy_v2_resale` revert if the seller's USDC ATA doesn't exist, or does it pre-create it as part of the tx? **My recommendation: revert.** The buyer shouldn't pay for the seller's ATA rent; that's the seller's responsibility. The frontend can prompt the seller to create their own USDC ATA before listing (or even include it in the `list_v2_for_resale` flow). Same as the holder-USDC-ATA decision in `AUTO_FINALIZE_PLAN.md` §6 #4 (which landed on "pre-create from the crank").

7. **Should the listing PDA store a `purchased_at` or fill history?** No — events handle that. Keeps the account small and rent-cheap. Listed for completeness.

---

## 9. Risks

Honest list of what makes me nervous:

- **gpa cost on Helius for listing enumeration.** The new `vaultResaleListing.all([memcmp(40, vault)])` call adds one more gpa per settled vault per tick. Multiplied across vault counts, this could push the crank toward Helius rate limits on a busy day. Mitigation: cache `fullyFinalized` set already exists for vaults that have nothing to do; extend the same caching pattern to "vaults with no active listings" and only re-query when an event indicates a state change (or every Nth tick). Same cost-management story as the existing auto-finalize gpa calls.

- **Escrow-PDA ownership choice locks us in.** Choosing `protocol_state` ownership is structurally right for hook compatibility (§1.8) and code reuse (§3.2), but it means **the listing escrow is conceptually fungible with `purchase_escrow` from the on-chain crank's point of view** — both are protocol_state-owned Token-2022 accounts holding the same mint. The off-chain `auto_cancel_listings` enumeration and the off-chain `auto_finalize_holders` exclusion both depend on the crank correctly distinguishing them. If we ever want to change escrow ownership later, that's a hard migration. Lock it in here, then don't revisit.

- **Listing-vs-auto-finalize race.** Even with Design A, the crank's tick ordering must run auto-cancel-listings BEFORE auto-finalize-writers (specifically before the last-writer pass that closes `vault_usdc_account`). If a future crank refactor reorders the passes, listings on the last-writer-pass tick would lose their seller's ITM payout (because the source USDC account is gone). **Mitigation:** add a code comment + a regression test asserting tick ordering. Also: `auto_cancel_listings` could itself check whether `vault_usdc_account.lamports() > 0` and refuse to proceed if the account is already closed — surfaces the bug as a clean revert instead of a silent payout-loss.

- **Frontend complexity creep eating the demo-prep window.** Six hours of frontend work is the optimistic estimate. Real-world: list-buy modals tend to balloon with edge cases (slippage UX, partial-fill UX, decoding old listings, error recovery). Past experience from `project_v2_frontend_build`: budget ~1.5x the rough estimate. **Mitigation:** ship the on-chain instructions and crank wiring first (Steps 1-5 of an eventual implementation arc). Frontend marketplace UI can ship as a Phase 2 even if the on-chain side is live. Resale will work via direct CLI / Anchor-script in the meantime if needed.

- **Test-suite drift.** `HANDOFF.md` §6 says the suite currently has 77 tests with 11 failures from migration-arc fixture staleness. Adding 22 new resale tests on top of an already-shaky baseline means we should refresh the suite (Tier 2 #4 from HANDOFF) **before or alongside** this arc, not after. Otherwise the 22 new tests inherit the ambient failure rate and we lose signal.

- **Token-2022 transfer-hook re-entry surprises.** Every transfer in this flow goes through the hook. We've validated the hook's behavior on the `protocol_state`-owned source/dest path (§1.8), but hook CPI re-entry is one of the historically subtle areas of Token-2022 (Anchor 0.32 mostly hides this, but if Token-2022 ever changes its hook dispatch, listing flows would be the most exposed path). **Mitigation:** every test that exercises a transfer should also assert the hook's `OptionExpired` error for negative cases, so we have signal if a future runtime change weakens the hook's protection.

- **The "biggest open architectural decision is unresolved" risk.** Open Question #1 is genuinely ambiguous, and the test matrix's shape (test #7 specifically) depends on the resolution. If we lock A and later discover that the crank-side filtering is fragile in production, switching to B mid-implementation rewrites both the on-chain handler and the crank. **Mitigation:** prototype the gpa-and-pair logic in the crank as a dry-run script before locking the on-chain design. Cheap insurance.

- **Overlap with parked V1 resale code.** The archived V1 P2P listing code lives at `archive/v1-instructions/{list_for_resale,buy_resale,cancel_resale}.rs`. Nothing currently imports it; it's never compiled (the `Cargo.toml` `exclude = ["archive"]` rule from MIGRATION_LOG.md Stage 1 ensures this). But if a future Claude session sees the archive and thinks it's a starting point for V2, they'll write code shaped around `OptionPosition` (the V1 account type that no longer exists in active code). **Mitigation:** the V2 instruction names are different (`list_v2_for_resale` etc.) precisely to prevent confusion. Plus this plan document, when written, becomes the canonical reference.

- **Mainnet-only Pyth feeds + Solana devnet runtime.** Already known (HANDOFF.md §11 Hermes/Pyth specifics). Unrelated to listings but worth re-flagging because the resale tests will mock or fixture Pyth updates the same way the auto-finalize tests do, and any drift in Pyth Pull behavior on devnet hits both.

---

## TL;DR

Three new permissionless instructions — `list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale` — plus one new state account `VaultResaleListing` and one Token-2022 escrow PDA owned by `protocol_state`. **Likely also a fourth instruction `auto_cancel_listings` and a new crank pass** to handle the listing-at-expiry case cleanly without breaking the homogeneous-batch property of the existing `auto_finalize_holders`; that's the single largest open call and is captured in Open Question #1. The transfer-hook architecture (`opta-transfer-hook/src/lib.rs:286-291`) already permits the protocol-PDA-source/dest transfer pattern that makes the escrow design work post-expiry, which is the key enabler. Estimated scope: ~22 new tests (~6-9 min mocha runtime addition), three (or four) instruction handlers (~150-200 LOC each), one new state file, ~120 LOC of crank changes, IDL regen, redeploy. **Six-day demo-prep window verdict: the on-chain + crank work fits in the window; the frontend marketplace UI does not — recommend shipping on-chain + crank first, frontend in a follow-on session, with CLI-side resale validation in the gap.** Risk profile is moderate: the patterns mirror existing audited code (V1 archive + V2 vault flows + auto-finalize arc), but the listing-vs-finalize ordering and the gpa cost both need empirical validation on devnet before the implementation arc starts.
