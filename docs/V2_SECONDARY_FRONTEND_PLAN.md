# V2 Secondary Listing — Frontend Marketplace Plan

> **Status:** planning, no code written. Companion to `docs/V2_SECONDARY_LISTING_PLAN.md`. Covers the user-facing UI for the V2 secondary marketplace now that the on-chain handlers (`list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale`, `auto_cancel_listings`) and the crank wiring are shipped on devnet (HEAD `2036822`, May 1 2026).
>
> **Audit basis:** read of `app/src/App.tsx`, `app/src/main.tsx`, `app/src/components/{AppNav,Toast,MoneyAmount,Header}.tsx`, every page under `app/src/pages/{trade,portfolio,markets,write}/`, every hook under `app/src/hooks/`, every utility under `app/src/utils/`, and the four smoke scripts (`scripts/smoke-{list,cancel,buy,auto-cancel}-v2.ts`) on 2026-05-02. Line numbers below were verified against the current tree, not copied from prior docs.
>
> **Scope locked by user:** "Full marketplace UI (everything in V2_SECONDARY_LISTING_PLAN.md §6)" — list, cancel, browse, and buy from the resale market, fully wired into the existing app.

---

## 1. Audit findings

### 1.1 Routing — `app/src/App.tsx`

- Six routes registered today (lines 53–61): `/` (Landing), `/markets` (Markets), `/trade` (Trade), `/write` (Write), `/portfolio` (Portfolio), `/docs/*` (Docs index + per-section).
- `HEADER_HIDDEN_PATHS` (line 30) lists every paper-surface route — the global `Header` is suppressed and each page mounts its own nav (`AppNav` for the four trader surfaces). **Any new top-level marketplace page must be added to this list.**
- `matchesAny` (line 37) treats the listed prefixes as descendants too (`/portfolio/x` would also hide the header) — not relevant today, but means a future `/marketplace/<mint>` deep route would behave consistently.
- **What needs to change:** add a new route — either standalone (`/marketplace`) or nested under an existing route — and add its prefix to `HEADER_HIDDEN_PATHS`. See OQ#1 (nav placement).

### 1.2 App-shell nav — `app/src/components/AppNav.tsx`

- Five active nav entries today (lines 60–64): Markets / Trade / Write / Portfolio / Docs. Each is an `AppNavLink` with the active-route crimson 2px under-bar.
- `+ New Market` CTA on the right (lines 68–74) opens `NewMarketModal`. **This is the same modal-from-nav pattern noted as a bug in HANDOFF §7** (the modal owns its own state; closing it doesn't refetch the active page's data).
- `AppNavLink` (line 121–140) is a pure NavLink wrapper — adding a sixth entry is a one-line change. The five-then-six visual rhythm at `gap-7` (line 59) needs no other adjustments — there's room.
- **What needs to change:** add a sixth `AppNavLink` (`Marketplace`) OR keep the five-link nav and surface marketplace inside an existing surface (Trade or Portfolio). See OQ#1.

### 1.3 Trade page — the load-bearing reference for "browse → modal → buy → refetch"

`TradePage.tsx` (lines 27–163) + `BuyModal.tsx` (lines 36–242) + `usePurchaseFlow.ts` (lines 57–154) + `useTradeData.ts` (lines 94–442) form the canonical pattern that the marketplace UI should mirror end-to-end. Key facts:

- **Page composition** (`TradePage.tsx:93-162`): `usePaperPalette()` → `<PaperGrain />` → `<AppNav />` → main wrapper at `pt-[120px]` to clear the fixed nav → statement header → market context strip → expiries → chain table → 5-cell summary band → footer. **Modal mounted on demand** at the very bottom (`TradePage.tsx:150-160`), driven by a single `buyTarget` state and dismissed on close.
- **Modal lifecycle** (`BuyModal.tsx:36-242`): three states — Form / Submitting / Confirmed. Esc dismiss (lines 61-67), click-outside dismiss (line 137), USDC balance fetched on mount via `getAccountInfo` + manual `readBigUInt64LE(64)` (lines 70-99), CTA swaps to "Connect Wallet" when disconnected (line 226). Confirmed state replaces the form area with a tx-signature block + Solscan link + "View on Portfolio" CTA (lines 260-295). **Toast fires on success AND error** (lines 105-120).
- **Action hook** (`usePurchaseFlow.ts:57-154`): returns `{ submitting, submit }`. Submit derives PDAs, pre-creates the buyer's option ATA via `createAssociatedTokenAccountIdempotentInstruction` (lines 100-113), bumps CU to 800K (line 31), applies a 5% slippage guard via `toUsdcBN(best.premium * quantity * 1.05)` (line 116), calls `program.methods.purchaseFromVault(...).accountsStrict({...}).preInstructions([EXTRA_CU, createAtaIx]).rpc()`. Throws `Error(decodeError(err))` on any failure for the toast pipeline.
- **Data hook** (`useTradeData.ts`): bundles `useVaults` + `safeFetchAll(program, "optionsMarket")` + `usePythPrices`. Exposes a `refetch` (lines 105-116) that the modal's `onSuccess` invokes (`TradePage.tsx:155-158`). **This is the canonical "refresh after a tx" loop.**
- **Deep-link handling** (`useTradeData.ts:171-195`): URL params `?asset=&expiry=&strike=&type=` trigger a one-shot apply via a ref-locked effect that retries until vaults load. The marketplace browse view should accept `?listing=<pda>` for direct links (e.g., from a Solscan transaction or social share).

**Verdict: this pattern is genuinely good and reusable. The marketplace browse + buy view should clone it almost verbatim — same shell, same modal lifecycle, same data-hook + refetch loop, same paper aesthetic. That's the largest scope-de-risker.**

### 1.4 Portfolio page — list + cancel land here

`PortfolioPage.tsx` (lines 57–377) is the load-bearing surface for **list-from-holdings** and **cancel-my-listing** because every action is dispatched off a per-position row.

- **Action plumbing already exists** for the four buyer-side verbs via `handleAction` (lines 289-310): `exercise`, `list-resale`, `cancel-resale`, `burn`. The `list-resale` branch opens `ResaleModal` via `setResaleTarget(p)` (line 297); `handleResaleSubmit` (lines 312-319) routes to `actions.listResale(...)`. **The wiring is wrong-target today** (V1 only) but the dispatch shape is reusable.
- **`usePortfolioActions.ts`** (lines 57-146) bundles `{ busyId, exercise, listResale, cancelResale, burn }`. `listResale`/`cancelResale` (lines 80-122) gate on `p.source.kind !== "v1"` and silently early-return for V2 — that's the dead-end. We need to extend each branch with V2 paths.
- **`positions.ts:177`** sets `isListedForResale: false` for every V2 position with the inline comment `"v2 has no on-chain resale path"`. **`positions.ts:245`** returns `"none"` from `deriveAction` when the position is V2 + active, regardless of listing state. **Both lines need to flip** once V2 listings are real, and the positions builder needs a `listingByMint` lookup so the `isListedForResale` field is populated from real on-chain data.
- **Existing modal** (`ResaleModal.tsx`, V1) is paper-aesthetic, reads on-chain ATA balance on open (lines 63-91), shows B-S suggested per contract via `calculateCallPremium`/`calculatePutPremium` (lines 55-57), validates via `canSubmit` (lines 96-101). **Visual layer is excellent and lifts directly to V2.** The `onSubmit` callback shape `(premiumUsd, tokenAmount) => Promise<void>` maps cleanly to V2 — V2's `list_v2_for_resale` takes `(price_per_contract, quantity)` per `smoke-list-v2.ts:193` (price first as a USDC scaled BN, then quantity).
- **Section structure**: `OpenPositionsSection` (§ 01) and `ClosedPositionsSection` (§ 02) bracket the open vs settled-OTM split. **My Listings would naturally fit as § 1.5 or § 03** — see §2 below.

### 1.5 Markets page — sibling pattern, less critical

`MarketsPage.tsx` (lines 27–116) + `useMarketsData.ts` (lines 68–210) + `MarketsTable.tsx` + `MarketsSection.tsx` (lines 19–98) follow the same shell → statement → summary → section → table pattern. Markets uses `<MarketFilters>` with multi-select pill groups (Side / Asset / Status) and a search field (`MarketFilters.tsx:48-110`). **The marketplace browse view's filter row should mirror this** — same paper-aesthetic pills, same hairline rhythm.

The Markets row → Trade row deep-link via `tradeHref` (`MarketsTable.tsx:74`) is the same pattern the marketplace browse → buy modal can adopt.

### 1.6 Hooks

#### `useFetchAccounts.ts` — discriminator already wired ✅

- **`vaultResaleListing` discriminator already in the table** (line 29: `[122, 137, 187, 45, 94, 125, 117, 110]`).
- **`AccountName` union already includes `vaultResaleListing`** (line 35).
- **Special-case validators (lines 71-80) do NOT touch `vaultResaleListing`** — there's no stale-layout filter to write because the account didn't exist before this arc. Decode-fail-and-skip is sufficient defensively.
- **No code change needed in this file** for V2 secondary listings. ✅

#### `useProgram.ts` — read-only, no change

Returns `{ program, provider }`; provider is null when wallet disconnected. The new hooks should accept this and degrade gracefully (browse marketplace as a guest is fine; list/cancel/buy require a wallet).

#### `useAccounts.ts` — needs two new derive helpers

- File exposes V2 PDA derivations for `sharedVault`, `vaultUsdc`, `writerPosition`, `vaultOptionMint`, `vaultPurchaseEscrow`, `vaultMintRecord`, `epochConfig` (lines 94–195). It does NOT expose `vaultResaleListing` or `vaultResaleEscrow` derivations.
- Smoke scripts derive these inline: `["vault_resale_listing", option_mint, seller]` (`smoke-list-v2.ts:135-142`) and `["vault_resale_escrow", listing_pda]` (`smoke-list-v2.ts:143-146`).
- **What needs to change:** add `deriveVaultResaleListing(optionMint, seller)` and `deriveVaultResaleEscrow(listing)` matching the existing helper signatures.

#### `useVaults.ts` — no change

Bundles `safeFetchAll` for `sharedVault`/`writerPosition`/`vaultMint`/`epochConfig`. The marketplace consumes these via the same hook (cross-references each listing's `option_mint` to its `VaultMint` for term-sheet metadata, and each listing's `vault` to the `SharedVault` for expiry/strike/option-type).

#### `useTokenMetadata.ts` — no change

Caches Token-2022 metadata by mint. Used today only for fallback symbol lookup when `safeFetchAll`'s strict validator drops a market. Will be useful in the marketplace if the listing's mint metadata is the source-of-truth display for asset/strike/expiry.

#### `usePythPrices.ts` — no change

Hermes-only spot prices, mainnet default. Marketplace reuses for "fair-value vs ask" comparisons.

#### `index.ts` (hooks barrel) — needs one re-export

Currently exports `useReveal`, `useNavOverDark`, `usePaperPalette`, `useParticleField`, `useHeroParallax`, `useScrollSpy`. **Should add `useResaleListings`** once written (consistent with the `usePortfolioActions` / `useTradeData` pattern of co-locating page-specific hooks under their page directory rather than the global hook barrel — but if the marketplace is its own page, the page-local pattern wins; nothing to add here).

### 1.7 Utilities

#### `constants.ts` — missing both V2 secondary seeds

- File contains `RESALE_ESCROW_SEED = "resale_escrow"` (line 52) — **this is the V1 seed; the V2 seeds are different strings** (`vault_resale_listing` and `vault_resale_escrow` per `smoke-list-v2.ts:137,144`).
- Missing: `VAULT_RESALE_LISTING_SEED` and `VAULT_RESALE_ESCROW_SEED`.
- **What needs to change:** add the two new seed constants. Leave V1's `RESALE_ESCROW_SEED` alone — it's referenced by the soon-to-be-retired V1 `listResaleV1` / `cancelResaleV1` paths in `usePortfolioActions.ts`. Remove the V1 seed only if/when those paths are deleted (see §6 below).

#### `format.ts` — no change

`usdcToNumber`, `toUsdcBN`, `formatUsdc`, `truncateAddress`, `daysUntilExpiry`, `isExpired` all reusable. Marketplace card layouts will lean on `truncateAddress` for the seller pubkey display.

#### `errorDecoder.ts` — needs four new entries

- Decode map (lines 4–56) covers errors 6000–6050. **Errors 6051+ (the new V2 secondary errors) are NOT mapped** — `decodeError` will fall through to `Program error 6051` for `ListingExhausted`, etc.
- The four new error variants (per `programs/opta/src/errors.rs` extensions during the secondary arc): `ListingExhausted`, `NotResaleSeller`, `InvalidListingEscrow`, `ListingMismatch`.
- **What needs to change:** add the four new map entries with user-friendly messages. See §5 below for proposed strings + exact code numbers (which need to be confirmed against the live `errors.rs` since the previously planned `NotResaleSeller` may collide with the existing 6022 `"Only the resale seller can cancel the listing"` from V1).

#### `blackScholes.ts` — no change

`calculateCallPremium`/`calculatePutPremium`/`getDefaultVolatility`/`applyVolSmile` already used by the existing buy/list modals. Reusable for the marketplace's "fair value vs listed price" comparison column.

#### `vaultFilters.ts` — no change

Helpers for "active vaults", "vault assets", "vault expiries". Marketplace can reuse `getActiveVaultMarketKeys` if it wants to gate listings by "the underlying vault is still alive" (which it must, per OQ#4 of the on-chain plan — buys against settled vaults are blocked on-chain anyway, but the UI should hide them too).

#### `tokenMetadata.ts` — no change

Token-2022 metadata fetch helper. Already used by `useTokenMetadata`.

#### `env.ts` — no change

Hermes endpoint resolver. Marketplace doesn't touch Hermes directly.

### 1.8 Components

- **`MoneyAmount.tsx`** — paper-aesthetic dollar formatter with split integer/cents. Reusable in every marketplace cell that shows USDC. ✅
- **`Toast.tsx`** — global pub/sub toast with success/error/info types and a tx-signature deep-link to Solscan. **Note: the Solscan URL in `Toast.tsx:63` hardcodes `cluster=devnet`** — fine for now, becomes a mainnet bug. Already in HANDOFF §7's spirit (the MAINNET-vs-devnet header copy). Not a blocker for the marketplace ship; just mention in passing.
- **`HairlineRule.tsx` / `SectionNumber.tsx` / `MetaLabel.tsx` / `PaperGrain.tsx`** (under `components/layout/`) — all paper-aesthetic primitives reusable in marketplace pages without modification.
- **`AppNav.tsx`** — already audited above.

### 1.9 Surprises and gotchas

- **The portfolio's V1-only `ResaleModal` and `usePortfolioActions.listResale/cancelResale` paths are effectively dead code today** — they early-return on V2 and V1 is archived on-chain. The action labels in `PositionsTable.tsx:189-191` still render `"List for Resale"` and `"Cancel Listing"` if a V1 position appears, but no V1 positions exist post-Phase-2 cutoff. **Decision needed**: do we (a) keep V1 paths intact + add V2-aware branches, or (b) delete the V1 paths entirely as part of this arc since they no longer fire? See OQ#3.
- **`NotResaleSeller` was the V1 error code at 6022** ("Only the resale seller can cancel the listing"). The new `NotResaleSeller` error variant for V2 (added during the secondary arc per `V2_SECONDARY_LISTING_PLAN.md` §2.3) gets a NEW error code (6051+). **Don't double-map 6022 to V2 semantics** — it still belongs to V1 as long as V1 errors are visible. Verify by reading `programs/opta/src/errors.rs` before writing the strings. (Resolution: just add new entries; don't touch the existing 6020-6023 entries.)
- **Wallet-disconnected flow.** Every modal in the codebase (BuyModal, ResaleModal, NewMarketModal) handles disconnected wallets by swapping the primary CTA to "Connect Wallet" → `setVisible(true)`. Marketplace must do the same: browsing is permissionless, but list/cancel/buy gate on a connected wallet.
- **`refetch` is the convention, not invalidation.** No central react-query / swr / cache layer. Each page hook owns its own `refetch` callback that re-runs `safeFetchAll` and updates local state. Modals call `onSuccess` after a confirmed tx; the parent page wires `onSuccess → data.refetch()`. **Keep this convention.** A central cache invalidation framework is a refactor, not a marketplace feature.
- **Smoke-script PDA derivation order matters.** `smoke-list-v2.ts:135-142` derives the listing PDA via `[VAULT_RESALE_LISTING_SEED, option_mint, seller]` — option_mint THEN seller. `smoke-list-v2.ts:143-146` derives the escrow PDA via `[VAULT_RESALE_ESCROW_SEED, listing_pda]` — keyed by the listing alone. Get the order wrong in the helper and every listing fetch fails silently. **Test the helper against a real on-chain listing before shipping.**
- **`buy_v2_resale` requires the seller's USDC ATA to already exist** (per the on-chain plan's OQ#6 resolution: "revert if missing — the buyer shouldn't pay for the seller's ATA rent"). **The list flow MUST pre-create the seller's USDC ATA**, not the buy flow. Otherwise the first buy reverts and the seller has to manually create their ATA before any buyer can fill — terrible UX and not auto-recoverable.

---

## 2. Proposed pages / page changes

### 2.1 New `/marketplace` page (or integrated tab — see OQ#1)

**File:** `app/src/pages/marketplace/MarketplacePage.tsx` (new), plus sibling files `MarketplaceSection.tsx`, `MarketplaceFilters.tsx`, `MarketplaceTable.tsx`, `BuyListingModal.tsx`, `MarketplaceStatementHeader.tsx`, `useMarketplaceData.ts`, `useResaleBuyFlow.ts`, `index.ts`.

**Responsibility:** browse all open `VaultResaleListing` accounts in the program, grouped or filtered by underlying. Allow a connected wallet to fill any listing (other than their own). Allow a connected wallet to navigate to "My Listings" view.

**Wireframe sketch:**
```
[AppNav]
─────────────────────────────────────
§ Statement · May 2026 · Mainnet · Solana · v0.1.5         [As of 02 May …][USDC|SOL]
Marketplace.

[Filter row: Side (All|Calls|Puts) · Asset pills · Status pills · Search field]

§ 01 · Open listings    Showing 12 of 14
[Table:
  Asset | Side | Strike | Expiry | Listed Qty | Ask / Contract | Total Ask | Fair Value | Disc/Prem | Seller | Action ]
  SOL   call  $50.00   18 May 2026  3          $1.00            $3.00       $1.42       -29%       hQ8…q9P   [Buy →]
  ...
[Empty state: "No marketplace listings yet — write something on Write."]

§ 02 · My listings   ↓ collapsed by default
[Table: Asset | Side | Strike | Expiry | Listed Qty | Ask / Contract | Created | Action]
  ETH put $2000  10 Jun 2026  5  $0.50  29 Apr  [Cancel listing]
```

**Hooks consumed:** `useResaleListings`, `useVaults` (for `vaultMints` and `vaults` to enrich each listing with strike/expiry/option-type/asset), `useProgram`, `useWallet`, `usePythPrices` (for fair-value comparison), `usePaperPalette`.

**Tx flow on Buy:** open `BuyListingModal` with `{ listing, vaultMint, vault, market }` → buyer enters quantity (slider, max = `listing.listedQuantity`) → confirm fires `useResaleBuyFlow.submit`. See §6.3.

**Tx flow on Cancel** (from My Listings row): direct call to `usePortfolioActions.cancelResale` (extended to handle V2 — see §3.3). No modal — cancel is a single confirm-via-wallet action with a busy spinner on the row.

### 2.2 Portfolio additions

**Modify:** `app/src/pages/portfolio/PortfolioPage.tsx`, `app/src/pages/portfolio/positions.ts`, `app/src/pages/portfolio/usePortfolioActions.ts`, `app/src/pages/portfolio/ResaleModal.tsx`.

- **Position rows now show `isListedForResale` accurately for V2.** `positions.ts:112-179` (`buildPositions`) takes a new `listingsByMint: Map<string, ResaleListing[]>` param; for each V2 position, `isListedForResale = listingsByMint.has(mintBase58) && listingsByMint.get(mintBase58)!.some(l => l.seller === connectedPublicKey)`. The `deriveAction` v2 branch (line 245) flips: when active + not-listed → `"list-resale"`, when active + listed → `"cancel-resale"`.
- **`PortfolioPage.tsx:57-377`** consumes `useResaleListings({ seller: publicKey })` to get the wallet's own active listings, passes through `buildPositions`, and the existing `handleAction` switch (lines 289-310) routes to V2-aware backends.
- **`ResaleModal.tsx`** — visual layer kept verbatim; the V1-specific branch at lines 63-91 (`if (position.source.kind !== "v1") return`) is replaced with V2 reading: derive the V2 mint via `position.source.vaultMint.account.optionMint`, then fetch the seller's ATA balance the same way. **The B-S suggested-per-contract math is already V2-compatible** (lines 50-57 reads `position.asset/strike/expiry/side` which are populated for V2 already).
- **`usePortfolioActions.ts`** — `listResale` and `cancelResale` get new V2 branches that build the V2 instruction (per smoke scripts). The V1 branch is either kept for symmetry (no V1 positions ever appear post-Phase-2 cutoff anyway) or removed entirely. See OQ#3.

### 2.3 Routing changes — `app/src/App.tsx`

- Add `<Route path="/marketplace" element={<MarketplacePage />} />` to the `<Routes>` block.
- Add `"/marketplace"` to `HEADER_HIDDEN_PATHS` (line 30).
- Update the comment block at lines 17-29 to list `/marketplace` alongside the four existing trader surfaces.
- **No `/marketplace/<id>` deep route in v1.** Single-page list with `?listing=<pda>` query param (consumed by `useMarketplaceData` to scroll-to + highlight a row). Deep-routing per listing is post-launch.

### 2.4 AppNav changes — `app/src/components/AppNav.tsx`

If OQ#1 lands on "new top-level page", add `<AppNavLink to="/marketplace">Marketplace</AppNavLink>` at line 64 (or 60 — placement TBD; suggest between Trade and Write since the buy-flow lives on Trade and the list-flow lives on Write/Portfolio, so Marketplace bridges them visually). At 6 links and `gap-7`, the nav still fits on standard md+ screens; the `hidden md:flex` (line 59) means narrow screens fall back to the existing wallet chip + CTA cluster.

If OQ#1 lands on "integrate into Trade page", AppNav stays at five links; the resale layer sits underneath the primary chain on Trade as a collapsible "Secondary market" section.

### 2.5 Optional Trade-page integration (parallel to a standalone marketplace)

Even if `/marketplace` is its own page, the Trade page's `OptionsChain` could surface "N resale listings available" hint chips on rows that have active listings, with a click → `/marketplace?asset=X&strike=Y` deep-link. **Recommendation: defer.** Adds complexity; not part of locked scope. Flag as Phase-2.

### 2.6 Docs entry — `app/src/pages/docs/sections.ts`

Adding a Marketplace section to the docs sidebar is in scope per "full marketplace UI" — write a markdown chapter explaining the resale flow, link from the Portfolio section. **Recommendation: defer to Phase 2.** The marketplace UI itself is the documentation; explainer copy can land separately.

---

## 3. Proposed hooks

### 3.1 `useResaleListings` — `app/src/pages/marketplace/useResaleListings.ts` (new)

```ts
export type ResaleListing = {
  publicKey: PublicKey;          // listing PDA
  account: {
    seller: PublicKey;
    vault: PublicKey;
    optionMint: PublicKey;
    listedQuantity: BN;
    pricePerContract: BN;
    createdAt: BN;
    bump: number;
  };
};

export type UseResaleListingsOptions = {
  /** If set, only return listings where account.seller === this pubkey. */
  seller?: PublicKey | null;
  /** If set, only return listings where account.vault is in this set. */
  vaultKeys?: Set<string>;
  /** If set, only return listings where account.optionMint === this pubkey. */
  optionMint?: PublicKey;
};

export type UseResaleListings = {
  listings: ResaleListing[];
  loading: boolean;
  refetch: () => Promise<void>;
  /** Map keyed by optionMint base58 → listings for that mint. Cached. */
  listingsByMint: Map<string, ResaleListing[]>;
  /** Map keyed by listing PDA base58 → listing. Cached. */
  listingsByPda: Map<string, ResaleListing>;
};

export function useResaleListings(options?: UseResaleListingsOptions): UseResaleListings;
```

- Implementation: `safeFetchAll(program, "vaultResaleListing")` (the discriminator is already wired). Apply `options` filters JS-side (keeps the impl identical to `useTradeData`'s vault filtering pattern). Build the two maps via `useMemo`.
- Refetch on demand from caller. **No automatic polling** — same convention as `useVaults` and `useTradeData`. Modal `onSuccess` callbacks invoke `refetch`.
- **Caching/invalidation:** none beyond React state. Refetch is cheap (under devnet conditions; a few hundred listings would still be sub-second).
- **Consumes:** `useProgram`. Does NOT consume `useVaults` or `useTokenMetadata` — keeps the hook narrowly scoped. The page composes `useResaleListings + useVaults + useTokenMetadata + usePythPrices` to enrich each row.

### 3.2 `useResaleBuyFlow` — `app/src/pages/marketplace/useResaleBuyFlow.ts` (new)

```ts
export type ResaleBuyInput = {
  listing: ResaleListing;
  /** SharedVault for the listing's vault (passed in to avoid extra fetch). */
  vault: { publicKey: PublicKey; account: any };
  /** OptionsMarket account for the listing's vault.market. */
  market: any;
  /** VaultMint record for the listing's optionMint. */
  vaultMint: { publicKey: PublicKey; account: any };
  /** How many contracts to buy. 1 ≤ quantity ≤ listing.listedQuantity. */
  quantity: number;
};

export type ResaleBuyResult = { txSignature: string };

export type UseResaleBuyFlow = {
  submitting: boolean;
  submit: (input: ResaleBuyInput) => Promise<ResaleBuyResult | null>;
};

export function useResaleBuyFlow(): UseResaleBuyFlow;
```

- Mirrors `usePurchaseFlow.ts` exactly: derive PDAs (protocol_state, treasury, hook accounts via existing helpers + new `deriveVaultResaleEscrow`), pre-create buyer's option ATA AND buyer's USDC ATA (idempotent), apply 5% slippage guard via `toUsdcBN(price_per_contract * quantity * 1.05)` mapped to the `max_total_price` arg of `buy_v2_resale`, fire `program.methods.buyV2Resale(quantity, maxTotalPrice).accountsStrict({...}).preInstructions([EXTRA_CU, ataIxs...]).rpc()`. Per the smoke-buy-v2 shape (lines 285-308) — 17 accounts strict.
- Throws `Error(decodeError(err))` on failure for the toast pipeline.

### 3.3 Extensions to `usePortfolioActions` — `app/src/pages/portfolio/usePortfolioActions.ts` (modify)

Add a V2 branch to `listResale` and `cancelResale`. Implementation pattern lifted from `smoke-list-v2.ts` and `smoke-cancel-v2.ts`:

```ts
const listResale = useCallback(
  async (p: Position, premiumUsd: number, tokenAmount: number) => {
    if (!program || !publicKey) return;
    setBusyId(p.id);
    try {
      if (p.source.kind === "v2") {
        await listResaleV2({ program, publicKey, position: p, premiumUsd, tokenAmount });
      } else {
        await listResaleV1({ program, publicKey, position: p, premiumUsd, tokenAmount });
      }
      showToast({ type: "success", title: "Listed for resale", message: `Asking $${premiumUsd.toFixed(2)}` });
      onSuccess();
    } catch (err: any) {
      showToast({ type: "error", title: "Listing failed", message: decodeError(err) });
    } finally {
      setBusyId(null);
    }
  },
  [...],
);

async function listResaleV2({ ... }) {
  // mirrors smoke-list-v2.ts: derive PDAs, build accountsStrict (15 accounts),
  // pre-create seller's USDC ATA (mainnet USDC; protocol_state.usdcMint),
  // pre-create seller's option ATA (idempotent, redundant since they hold tokens
  // already, but cheap insurance), call program.methods.listV2ForResale(price, qty)
  // with EXTRA_CU pre-instruction.
}
```

Same shape for `cancelResaleV2` — derive PDAs from `position.source.vaultMint.account.optionMint`, build accountsStrict per `smoke-cancel-v2.ts:151-165` (12 accounts), call `program.methods.cancelV2Resale().accountsStrict({...}).rpc()`. **No user-facing args** for cancel; the listing PDA is fully derived from `(option_mint, seller)`.

---

## 4. Proposed utilities

### 4.1 `app/src/utils/constants.ts` — add two seed constants

```ts
// === V2 Secondary Listing Seeds (Stage Secondary, May 2026) ===
export const VAULT_RESALE_LISTING_SEED = "vault_resale_listing";
export const VAULT_RESALE_ESCROW_SEED = "vault_resale_escrow";
```

Add in the seed-constants block at lines 44-61. Keep V1's `RESALE_ESCROW_SEED` line 52 as-is (still referenced by V1 dead-code paths in `usePortfolioActions`; remove only when those paths are deleted per OQ#3).

### 4.2 `app/src/hooks/useAccounts.ts` — add two derive helpers

```ts
/** Seeds: ["vault_resale_listing", option_mint, seller] */
export function deriveVaultResaleListing(
  optionMint: PublicKey,
  seller: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_RESALE_LISTING_SEED), optionMint.toBuffer(), seller.toBuffer()],
    programId,
  );
}

/** Seeds: ["vault_resale_escrow", listing] */
export function deriveVaultResaleEscrow(
  listing: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_RESALE_ESCROW_SEED), listing.toBuffer()],
    programId,
  );
}
```

Add at end of file (after `deriveEpochConfig` at line 195). Imports: `VAULT_RESALE_LISTING_SEED`, `VAULT_RESALE_ESCROW_SEED` from `../utils/constants`.

### 4.3 New shared types (no new file — co-locate with hooks)

The `ResaleListing` view-model lives in `useResaleListings.ts`. The `ResaleBuyInput`/`ResaleBuyResult` live in `useResaleBuyFlow.ts`. **No new shared-types file.** Co-location matches the existing convention (e.g. `ChainBest`/`ChainRow`/`TradeSummary` live in `useTradeData.ts`).

### 4.4 `app/src/utils/format.ts` — no change, but worth noting

`truncateAddress` at line 49 returns `"FIRS...LAST"` (with three dots between 4 and 4). The marketplace seller column should use this (or a 4-underscore-4 variant matching `AppNav.tsx:117-119`'s wallet chip — pick one for consistency). Use `truncateAddress` since it already exists.

---

## 5. Error handling

### 5.1 New error decoder entries — `app/src/utils/errorDecoder.ts`

The four new V2 secondary error variants need user-friendly strings. Exact codes need to be confirmed against `programs/opta/src/errors.rs` (lines added during the secondary arc; per the on-chain plan and the smoke runs they should be 6051+). Proposed entries to add to `CUSTOM_ERRORS` (after the existing 6050 `"Claim all premium before withdrawing shares"`):

```ts
6051: "Listing has fewer contracts available than requested",
6052: "Only the listing's seller can cancel it",
6053: "This listing escrow does not belong to the expected vault",
6054: "Listing PDA does not match the expected vault and option mint",
```

**Tone matches the existing decoder** — sentence case, ends without a period (per the existing rows), specific not generic. The codes should be re-verified against the deployed errors.rs before shipping; if any number has shifted (e.g., a hidden 6051 from another arc), re-key accordingly.

**Reuse-from-existing rows:**
- `CannotBuyOwnOption` (existing, code 6017 / 6023) — already has a user-friendly message; the V2 buy flow re-uses 6017 ("Cannot buy your own option") per `V2_SECONDARY_LISTING_PLAN.md` §2.2's "reuses the existing variant" decision.
- `VaultExpired` (existing, 6038) — already mapped: "Vault expiry has passed".
- `VaultAlreadySettled` (existing, 6037) — already mapped: "Vault has been settled — no more deposits allowed". **Slightly off-tone for resale** — "no more deposits" doesn't apply to a resale buy. Add a special-case in `decodeError` if the calling instruction is `buyV2Resale`? **Recommendation: no.** Generic "vault settled" message is correct enough; the user gets the gist.
- `SlippageExceeded` (existing, 6044) — already mapped: "Premium exceeds your maximum (slippage protection)". Carries over to resale buy.
- `InvalidContractSize` (existing, 6013), `InvalidPremium` (existing, 6014), `InsufficientOptionTokens` (existing, 6018) — all already mapped.

### 5.2 Toast taxonomy

Three success toasts and three error toasts, all via the existing `showToast` from `app/src/components/Toast.tsx`:

| Toast | Type | Title | Message |
|---|---|---|---|
| List success | success | "Listed for resale" | `${qty} contracts at $${price}/contract` |
| Cancel success | success | "Listing cancelled" | "Contracts returned to your wallet." |
| Buy success | success | "Listing filled" | `${qty} contracts purchased for $${total}` (+ Solscan link via `txSignature`) |
| List failed | error | "Listing failed" | `decodeError(err)` |
| Cancel failed | error | "Cancel listing failed" | `decodeError(err)` |
| Buy failed | error | "Purchase failed" | `decodeError(err)` |

---

## 6. Tx-flow sketches

### 6.1 List from Portfolio row

1. **User clicks "List for Resale"** on an active V2 position row in `OpenPositionsSection`.
2. **`PortfolioPage.handleAction(p, "list-resale")`** sets `resaleTarget = p`, opens `ResaleModal`.
3. **Modal mounts** (`ResaleModal.tsx`): reads on-chain ATA balance via `getAccountInfo` + `readBigUInt64LE(64)` — pre-fills quantity field; shows B-S suggested premium per contract.
4. **User adjusts quantity + price**, clicks "List for $X.XX".
5. **`PortfolioPage.handleResaleSubmit(premiumUsd, tokenAmount)`** → **`actions.listResale(p, premiumUsd, tokenAmount)`** → V2 branch fires.
6. **V2 branch (in `usePortfolioActions.listResaleV2`):**
   - Derive PDAs: `protocol_state` (`[PROTOCOL_SEED]`), `vault_resale_listing` (`[VAULT_RESALE_LISTING_SEED, optionMint, publicKey]`), `vault_resale_escrow` (`[VAULT_RESALE_ESCROW_SEED, listingPda]`), hook PDAs, `vaultMintRecord`.
   - Pre-flight: confirm `tokenAmount > 0`, `premiumUsd > 0`, `position.source.vaultMint.account.vault === vault.publicKey`.
   - Pre-create the seller's USDC ATA via `createAssociatedTokenAccountIdempotentInstruction` (TOKEN_PROGRAM_ID, USDC mint = `protocol_state.usdcMint`). **Required** so future buyers don't revert on missing ATA.
   - Build accountsStrict (15 accounts per `smoke-list-v2.ts:194-211`).
   - Send tx with `[EXTRA_CU, createSellerUsdcAtaIx, listIx]` pre-instructions.
   - On success: `showToast({type:"success", title:"Listed for resale", message:"…"})`, call `onSuccess` → `refetchAll` on PortfolioPage → re-renders with `isListedForResale = true`, action flips to "Cancel Listing".
7. **Frontend pre-checks** that gate `canSubmit`:
   - Wallet connected (modal shows "Connect Wallet" otherwise).
   - `tokenAmount` between 1 and seller's actual ATA balance (re-read on modal open).
   - `premiumUsd > 0`.
   - **Not yet listed** at the same `(option_mint, seller)` pair — derived listing PDA must not exist on-chain. Check via `getAccountInfo(listingPda)` on modal open; if non-null, replace the modal body with "You already have an active listing for this contract — view it on Marketplace" + a deep-link to `/marketplace?listing=<pda>`.
8. **Error states the UI must handle:**
   - `VaultAlreadySettled` (vault settled mid-input) → toast.
   - `VaultExpired` → toast.
   - `InvalidContractSize` / `InvalidPremium` → guarded by `canSubmit`, but defensive toast if it slips through.
   - `InsufficientOptionTokens` → user transferred or burned tokens between modal-open and confirm → toast + auto-close modal + refetch portfolio.
   - Wallet rejection → "Transaction rejected in wallet." (already handled by `decodeError`).

### 6.2 Cancel my listing

1. **User clicks "Cancel listing"** on a V2 position row that has `isListedForResale = true` (Portfolio § 01) OR on a row in My Listings on Marketplace (§ 02).
2. No modal — direct call to **`actions.cancelResale(p)`** → V2 branch.
3. **V2 branch:**
   - Derive PDAs: listing, escrow, hook accounts.
   - Pre-create seller's option ATA (idempotent — they may have closed it manually after listing).
   - Build accountsStrict (12 accounts per `smoke-cancel-v2.ts:151-165`).
   - Send tx with `[EXTRA_CU, createSellerAtaIx, cancelIx]`.
   - On success: toast, refetch.
4. **Frontend pre-checks:** wallet connected. Listing still exists on-chain (re-read just before submit; auto-cancel crank could have run). If listing doesn't exist anymore: toast "Listing already cancelled" + refetch.
5. **Error states:**
   - `NotResaleSeller` (impossible if our derive is correct, but defensive) → toast.
   - Wallet rejection → standard.

### 6.3 Buy from marketplace

1. **User clicks "Buy →"** on a marketplace row.
2. **`MarketplacePage.handleBuyClick(listing)`** sets `buyTarget = { listing, vault, market, vaultMint }`, opens `BuyListingModal`.
3. **Modal mounts** (`BuyListingModal.tsx`):
   - Quantity input (default 1, max = `listing.listedQuantity`). Slider OR number input — recommend number input + +/- steppers (matches `BuyModal` minimalism).
   - Live total = `quantity * pricePerContract`.
   - Fair-value comparison — show B-S premium for the underlying via `applyVolSmile + calculateCallPremium/calculatePutPremium` (already used by Trade page chain build); display as `Fair value: $X.XX (you save Y%)` or `(premium of Y%)`.
   - USDC balance read on mount (same as `BuyModal:70-99`).
   - Seller pubkey shown via `truncateAddress`.
   - Disconnected → CTA swaps to "Connect Wallet".
4. **User clicks "Confirm Purchase →"**.
5. **`BuyListingModal.handleConfirm`** → **`useResaleBuyFlow.submit({ listing, vault, market, vaultMint, quantity })`**.
6. **Submit flow:**
   - Derive PDAs (treasury, escrow, hook, vaultMintRecord, etc.).
   - Pre-create buyer's option ATA (Token-2022) and buyer's USDC ATA (TOKEN_PROGRAM_ID), both idempotent.
   - Apply 5% slippage: `maxTotalPrice = toUsdcBN(usdcToNumber(pricePerContract) * quantity * 1.05)`.
   - Build accountsStrict (17 accounts per `smoke-buy-v2.ts:285-308`).
   - Send tx with `[EXTRA_CU, createBuyerOptionAtaIx, createBuyerUsdcAtaIx, buyIx]`.
   - Throw `Error(decodeError(err))` on failure.
7. **On success:** modal switches to Confirmed state — Solscan link + "View on Portfolio" CTA + Dismiss; toast fires; **caller's `onSuccess` invokes `data.refetch()` on `useMarketplaceData`** so the row reflects the partial-fill remaining qty (or disappears entirely if fully filled).
8. **Frontend pre-checks:**
   - Wallet connected.
   - `1 ≤ quantity ≤ listing.listedQuantity`.
   - `buyer !== listing.seller` — guard via `if (publicKey?.equals(listing.account.seller))` and disable Confirm with hint "You can't buy your own listing".
   - Vault still alive — re-derive `vault.account.expiry > now` and `!vault.account.isSettled`. If either fails on mount, replace modal body with "This vault has expired or settled — listing can no longer be filled".
9. **Error states:** `ListingExhausted` (race with another buyer), `VaultExpired`, `VaultAlreadySettled`, `SlippageExceeded`, `CannotBuyOwnOption`, `InsufficientOptionTokens` (off-chain pre-check should prevent), wallet rejection. All decoded by `decodeError` → toast.

---

## 7. State refresh patterns

After a successful list/cancel/buy:

| Action | Hook(s) to refetch | Where |
|---|---|---|
| List succeeds | `PortfolioPage.refetchAll` (refetches positions + token balances), `useResaleListings.refetch` (if marketplace is open) | `usePortfolioActions.listResale` calls `onSuccess` which already invokes `refetchAll` |
| Cancel succeeds | Same as List | Same |
| Buy succeeds | `useMarketplaceData.refetch` (drops or decrements the filled listing), `PortfolioPage.refetchAll` if user is a watcher (out of scope — different page) | `BuyListingModal.onSuccess` → `data.refetch()` |
| Crank's `auto_cancel_listings` runs (background, not user-driven) | None directly — listings disappear on-chain; the next time the user lands on Marketplace or Portfolio, the next `safeFetchAll` reflects the new state | Next page-mount `useEffect` fires |

**No global state-management framework needed.** The marketplace page owns its own `useResaleListings` instance; portfolio owns its own; cross-page consistency is "next mount sees fresh data" — the same convention as Markets / Trade today. **A user listing on Portfolio and then immediately navigating to Marketplace will see their fresh listing** because `MarketplacePage` mounts and fires `useEffect → refetch` on the new instance.

**Edge case:** if a user has both Portfolio and Marketplace open in different browser tabs, listing on Portfolio doesn't push to Marketplace. **Acceptable** — same as every other state-change today (writing on Write doesn't push to Markets in the other tab). Not in scope to fix.

---

## 8. Test matrix

The marketplace UI will be tested by manual browser-driven smoke (no Playwright/Cypress in repo). All scenarios must be runnable end-to-end on devnet against the live deployment.

### 8.1 Happy path

1. **List, then see in Marketplace.** Connect wallet A. Buy 5 contracts on Trade. Go to Portfolio. Click "List for Resale" on the new position. Enter qty=3 at $1.20/contract. Confirm. Toast appears. Position row's action flips to "Cancel listing". Open Marketplace in same tab. The new listing appears with the right asset/strike/expiry/qty/price.
2. **Cancel from Portfolio, see disappear from Marketplace.** Same wallet A, same position. Click "Cancel listing" on Portfolio. Toast. Position row action flips back to "List for Resale". Refresh Marketplace. Listing is gone. Wallet A's ATA balance restored to 5.
3. **Buy from another wallet (full fill).** Wallet A lists 1 contract @ $1. Switch to wallet B. Open Marketplace. See A's listing. Click Buy. Confirm. Toast + Solscan link. Wallet B has the contract on Portfolio. Wallet A has +$0.995 USDC, treasury +$0.005. Listing disappears from Marketplace.
4. **Partial fill from another wallet.** Wallet A lists 5 contracts @ $1. Wallet B buys 2. Toast. Listing on Marketplace now shows "Listed Qty: 3" instead of 5. Wallet B's Portfolio shows 2 contracts. Wallet A's USDC up by $1.99.

### 8.2 My Listings view

5. **My Listings collapses when empty, expands when populated.** Connect wallet A with no listings. Marketplace § 02 reads "No active listings — list one from Portfolio." Click "Cancel listing" on a listing on Portfolio. Refresh. § 02 still empty. Now list a new one. Refresh Marketplace. § 02 shows the listing with a Cancel button. Click Cancel → row disappears.

### 8.3 Edge cases

6. **List then expiry hits, then crank auto-cancels.** List 1 contract on a vault that expires in 5 minutes. Wait 6 minutes. Crank's `auto_cancel_listings` pass runs. Refresh Portfolio → listing is gone, contracts back in wallet. Refresh Marketplace → listing gone. **No user clicks at expiry — the crank handled it.**
7. **Buy when fair-value math says undervalued.** List a deep-ITM call at half its B-S fair value. Open from another wallet. Modal shows "Fair value: $4.20" alongside ask "$2.00", with a positive "you save 52%" pill. Buy succeeds.
8. **Connect wallet from Marketplace browse.** Visit `/marketplace` disconnected. Listings render. Click Buy on any listing → modal opens with "Connect Wallet" CTA. Click → wallet modal opens. Connect → modal still up; CTA flips to "Confirm Purchase".
9. **Refresh during pending buy.** Click Confirm. Before tx confirms, hard-refresh the page. Tx still goes through (wallet has the signed tx). Listing reflects partial fill on next manual refresh. Confirms there's no stuck state on page-reload.
10. **Two browsers, race a buy.** Wallet A lists 1 contract. Wallet B in browser 1 + wallet C in browser 2 both click Buy at the same moment. One succeeds, the other gets `ListingExhausted` toast + the listing disappears from their view on next refetch.

### 8.4 Negative

11. **Buy your own listing.** Wallet A clicks Buy on their own listing. Modal opens but Confirm is disabled with hint "You can't buy your own listing." (Belt-and-braces: if user bypasses, on-chain reverts with `CannotBuyOwnOption` → toast.)
12. **List for more contracts than wallet holds.** Open ResaleModal, type a quantity > balance. CTA disabled. If user bypasses (devtools): on-chain reverts → toast.
13. **List with $0 price.** CTA disabled (`canSubmit` requires `premiumUsd > 0`).
14. **List against an expired vault.** ResaleModal opens, but if vault expired between mount and confirm, toast `VaultExpired` and refetch portfolio.
15. **Buy with insufficient USDC.** SPL Token "insufficient funds" → `decodeError` returns "Insufficient USDC balance. Use the faucet to get test USDC." → toast.
16. **Cancel after auto-cancel crank already ran.** User clicks Cancel; on-chain reverts because listing PDA no longer exists. Toast: "Listing already cancelled — refreshing your view." Auto-refetch.

### 8.5 Resilience

17. **`safeFetchAll` decode-fail tolerance.** Manually deploy a stale-layout `vault_resale_listing` account (not realistic in practice — the discriminator ensures it). Confirms `useResaleListings` skips it without throwing.
18. **Wallet disconnect mid-tx.** Click Confirm, wallet rejects. Toast "Transaction rejected in wallet." Modal stays open; user can re-confirm.
19. **Modal Esc + click-outside dismiss.** Press Esc on any open modal → closes. Click outside the modal → closes. Same as Trade's BuyModal — pattern reused verbatim.

### 8.6 Total estimate

**~19 manual smoke scenarios.** No new Mocha tests for frontend. Total time to run all 19 against devnet: ~30-45 min including wallet switches and crank waits.

---

## 9. Open questions

These are design calls that need Nanko's sign-off before Step 7.1 (implementation) starts.

1. **Where does the marketplace live in the nav?**
   - **Option A — new top-level `/marketplace` page**, sixth `AppNavLink`. Cleanest — own surface, full statement-header treatment, dedicated `useMarketplaceData` hook, parallel to Trade. Adds one nav slot (Markets / Trade / Marketplace / Write / Portfolio / Docs) which still fits at md+.
   - **Option B — integrate into Trade page**, as a collapsible "Secondary market" section beneath the primary chain. Keeps the nav at five links, surfaces resale liquidity in the same place buyers already are. **More work to design the disambiguation** between primary mints and resale escrows in the same chain row.
   - **Option C — integrate into Portfolio**, as § 03. Browse-others'-listings sits below your-own-positions. **Awkward** — Portfolio is "my stuff", marketplace is "everyone's stuff"; mixing them confuses the surface's purpose.
   - **My recommendation: A.** Cleanest separation, mirrors the existing trader-surface pattern. Adds one nav link.

2. **Does the marketplace separate "buyable" vs "my listings", or merge them?**
   - **Option A — single table** with a "Mine" badge on rows where `seller === wallet`. One-table simplicity, but the "Buy" button has to disable on own rows.
   - **Option B — two sections** (§ 01 "Open listings (others)" + § 02 "My listings") with different action columns. Cleaner mental model: buyable on top, my-stuff below. Mirrors the Open + Closed split on Portfolio.
   - **My recommendation: B.** Matches the existing § 01 / § 02 rhythm. Cancel button only ever appears on My Listings rows.

3. **Do we delete the V1 `listResaleV1` / `cancelResaleV1` paths in `usePortfolioActions.ts`?**
   - **Pro delete:** They early-return for V2; no V1 positions exist post-Phase-2 cutoff; less dead code.
   - **Pro keep:** Tiny risk that some pre-Phase-2 v1 position resurfaces (it shouldn't — `isPostPhase2Position` filter at `useFetchAccounts.ts:104` blocks them). Keeping costs ~70 LOC.
   - **My recommendation: delete in this arc** as a separate cleanup commit alongside the V2 wiring. Fewer paths = fewer surprises. If the user prefers to defer the V1 sweep, fine — it's truly dead and harmless.

4. **Should the marketplace show fair-value vs ask comparison?**
   - **Pro:** Distinguishes Opta from a generic OTC; uses the existing Black-Scholes machinery; gives buyers a "discount/premium" pill that makes the secondary market feel like an actual market.
   - **Con:** B-S fair value depends on Pyth spot — if the asset's Hermes feed isn't live (rare but happens), the column reads "—" and looks broken.
   - **My recommendation: yes, show it.** Fall back to "—" when spot is missing (matches Trade's `IndicativePremium` behavior). Risk of "looks broken" is small; the upside of "feels like a real market" is meaningful.

5. **On a partial fill, is the buy modal a slider, a number input, or a "fill all" toggle?**
   - **Slider:** visually rich, but hard to land on exactly N for low quantities (snapping needed).
   - **Number input + steppers:** unambiguous, matches `BuyModal` exactly.
   - **Fill All / Custom toggle:** simplest UX (most users will fill all); custom drops to a number input.
   - **My recommendation: number input + steppers.** Matches the existing primary-buy pattern; no new visual primitive to design.

6. **When a vault is settled, do we hide its listings entirely or show them with an indicator until the auto-cancel crank cleans them up?**
   - **Hide:** UI lies briefly (the on-chain listing exists; the UI says it doesn't), but no buyer can fill (on-chain blocks). Cleaner.
   - **Show with "Settled — pending auto-cancel" badge:** more honest, but a stale state most users will never see (auto-cancel runs every 5 min).
   - **My recommendation: hide.** Filter `listings.filter(l => !vaultByPda.get(l.vault).isSettled && vaultByPda.get(l.vault).expiry > now)` in `useMarketplaceData`'s row build. The on-chain listing PDA still exists for the few minutes before the crank cleans it; the UI just doesn't surface it.

7. **Does AppNav's `+ New Market` button stay where it is, or do we add a `+ List for Resale` shortcut alongside?**
   - **My recommendation: leave AppNav alone.** The list flow is contextual to a specific position (you list from a row, not from a global CTA). Adding a global "New Listing" button would confuse — which position would it list?

8. **Does the marketplace page need a New Position CTA in its statement header (Portfolio's `<Link to="/write">New Position</Link>` pattern at `StatementHeader.tsx:76-83`)?**
   - **My recommendation: no.** The marketplace is a buyer-side and seller-management surface; "new position" sends the user to Write, which is unrelated. Right cluster: timestamp + USDC|SOL toggle only. No CTA.

9. **Default sort order in the marketplace browse view?**
   - Options: newest first (by `createdAt`), best-discount-first (by ask vs B-S fair value), expiry-ascending (most-urgent first), asset alphabetical.
   - **My recommendation: best-discount first.** That's the marketplace's value prop — find a deal. If fair value is missing, fall back to expiry-ascending.

10. **Should listing my contracts also expose a "Cancel + relist at new price" combo flow?**
    - **My recommendation: no, defer.** Two separate clicks (cancel, then list) is fine for v1. A combo flow saves one wallet sig but adds modal complexity.

---

## 10. Risks

Honest list of what makes me nervous:

- **AppNav modal stale-list bug applies to the new pages too.** `HANDOFF.md` §7 flags that `+ New Market` from AppNav doesn't refetch the active page's data when closed. **The same architectural issue would hit the marketplace if we add a global "+ List for Resale" CTA to AppNav** (which OQ#7 recommends against — the recommendation is partly to dodge this bug). **Per-page modals (List from Portfolio, Buy from Marketplace) avoid the bug because they're owned by the page, not the nav.** Marketplace UI doesn't make this bug worse, but doesn't fix it either. **Tier-2 fix from HANDOFF, not a marketplace-arc concern.**

- **MAINNET-vs-devnet copy in `StatementHeader.tsx:46`.** The eyebrow hardcodes `"Mainnet · Solana"` — visible across Portfolio, Marketplace (if we reuse the same StatementHeader), Trade if it adopts a similar header. **Existing bug, not introduced by us.** The Marketplace page should use the same StatementHeader pattern, so we'll inherit the bug if it isn't fixed first. **Recommendation: include a one-line copy fix as part of this arc** since we're mounting the same component on a new surface — it'd be jarring to ship a new surface that lies about the cluster. Trivial fix, ~2 LOC.

- **`Toast.tsx:63` Solscan URL hardcodes `cluster=devnet`.** Same family of bug as above. The marketplace's success toasts will use the same Toast component → inherit the hardcode. **Not a marketplace-arc bug; same fix scope.** Defer with the cluster-copy cleanup.

- **`positions.ts:177` will lie until we wire the real `isListedForResale` field.** Today every V2 position is marked `isListedForResale: false` and `action: "none"`. Once we add the real lookup, **a wallet with stale closures or weird state could see incorrect action labels** (e.g., a listing that was cancelled by the auto-cancel crank but the position still appears as "Cancel listing" until the next refetch). Mitigation: refetch immediately after every action, and on every PortfolioPage mount.

- **`buy_v2_resale` requires the seller's USDC ATA to exist; the list flow is the only place we create it.** If a seller lists a contract in v1 of this UI (where we may forget to pre-create the seller USDC ATA), every buy attempt reverts. **Critical guardrail:** the listResale handler MUST always pre-create the seller's USDC ATA, idempotent. Add a pre-flight assert in tests.

- **`useResaleListings` returns ALL listings on every call** — at marketplace scale, this could grow. Devnet + hackathon scale is fine; mainnet scale is the worry. **Mitigation: post-launch, add filtering at the gPA level using `[memcmp(8 + 32, vault)]` for per-vault views.** Out of scope here.

- **Race conditions on partial fills.** Two buyers race; whichever lands second gets `ListingExhausted`. **The toast clearly communicates this AND the refetch makes the next buy attempt show the right remaining qty**, so the UX is acceptable. Confirmed by smoke scenario #10.

- **The full marketplace UI is exactly the scope option flagged as "risk-eating-into-buffer" in `V2_SECONDARY_LISTING_PLAN.md` §9.** Original estimate from the on-chain plan: ~6 hours focused implementation + 1 hour devnet smoke for the frontend, but with a 1.5x real-world multiplier from `project_v2_frontend_build` lessons → ~9-12 hours. **Today's date: May 2 2026.** Demo / judging window is the near-term gate (HANDOFF §10 lists Tier-1 as "must ship before judging touch-points"). **Honest assessment: the locked "full marketplace UI" scope is tractable but doesn't have a lot of slack.** If the user wants to ship-and-polish, focus on §2.1 (Marketplace page browse + buy) and §2.2 (Portfolio list + cancel) — that's the load-bearing UX. The OQ#4 fair-value column, OQ#9 sort order, fancy filters, and the docs section can all defer to v1.5 without losing the demo story.

- **The "browse listings as guest, no wallet connected" path needs explicit verification.** `useResaleListings` should work read-only via `useProgram`'s null-provider branch (lines 26-40 of `useProgram.ts`). **Confirm in scenario #8 of the smoke test.** If it fails, marketplace becomes a wallet-required surface, which is a worse demo.

- **No test coverage for the marketplace data hook or the buy flow.** All testing is manual click-through. **Acceptable for hackathon scope; a Tier-2 follow-up would add Playwright/Cypress.** Out of scope.

- **The `decodeError` mapping for codes 6051+ depends on the exact numbers in deployed `errors.rs`.** If the secondary arc bumped the error numbers and a 6051 already exists from another arc, my proposed mapping in §5.1 is wrong. **Mitigation: read `programs/opta/src/errors.rs` first, copy the actual numbers, and only then write the decoder entries.** ~3 minute pre-check before coding.

- **Token-2022 hook re-entry edge cases on the buy flow.** The buy_v2_resale flow does USDC transfers AND a Token-2022 transfer in one tx — same shape as the existing purchase_from_vault, so well-trodden. No new risk vs the existing UI. Flagged for completeness only.

- **Vercel deploy hot path.** No new concerns. The marketplace adds new components but no new dependencies; the existing build chain (Vite + Tailwind + Buffer polyfill) handles them. Same deploy workflow as every other UI change since Phase 4.

---

## TL;DR

A new top-level `/marketplace` page (paper-aesthetic, mirrors Trade's shell + modal pattern) plus extensions to Portfolio's existing `usePortfolioActions` to wire V2 list/cancel into the already-shipped action plumbing. **Scope is well-bounded because the existing infrastructure already does most of the heavy lifting:** `safeFetchAll` knows the new discriminator, `Position.isListedForResale` and `PositionAction.list-resale/cancel-resale` are already in the type system, the `ResaleModal` visual layer lifts directly from V1, and the BuyModal/usePurchaseFlow/useTradeData triple is the canonical template the Marketplace page clones. Only ~7 net-new files needed: `MarketplacePage.tsx`, `MarketplaceFilters.tsx`, `MarketplaceTable.tsx`, `BuyListingModal.tsx`, `useMarketplaceData.ts` (or `useResaleListings.ts`), `useResaleBuyFlow.ts`, plus the shared `MarketplaceStatementHeader`. Modifications to ~5 existing files: `App.tsx` (route), `AppNav.tsx` (link), `useAccounts.ts` (2 derive helpers), `constants.ts` (2 seeds), `errorDecoder.ts` (4 codes), `usePortfolioActions.ts` (V2 branches), `positions.ts` (real isListedForResale + flipped deriveAction), `ResaleModal.tsx` (V2 read path). Estimated effort: **~9-12 hours of focused implementation + 1 hour devnet smoke, tractable in the remaining demo window but without much slack.** Risk profile: low-to-moderate — the patterns mirror existing audited code; the largest live risks are (a) the `buy_v2_resale` requirement to pre-create the seller's USDC ATA at LIST time (one missed pre-create = unfillable listing), and (b) the unresolved nav-placement question in OQ#1 which gates how the marketplace surface gets discovered. Both are addressable before Step 7.1 starts.
