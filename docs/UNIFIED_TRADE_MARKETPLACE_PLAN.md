# Unified Trade × Marketplace — Implementation Plan

> **Status:** plan locked, no code written yet. Companion to the design pass conducted on 2026-05-02 (chat transcript) which collapsed `/marketplace` into `/trade` per the "options as a primitive — one liquid surface" thesis.
>
> **Audit basis:** read of [TradePage.tsx](../app/src/pages/trade/TradePage.tsx), [OptionsChain.tsx](../app/src/pages/trade/OptionsChain.tsx), [useTradeData.ts](../app/src/pages/trade/useTradeData.ts), [BuyModal.tsx](../app/src/pages/trade/BuyModal.tsx), [usePurchaseFlow.ts](../app/src/pages/trade/usePurchaseFlow.ts), [MarketplacePage.tsx](../app/src/pages/marketplace/MarketplacePage.tsx), [useMarketplaceData.ts](../app/src/pages/marketplace/useMarketplaceData.ts), [BuyListingModal.tsx](../app/src/pages/marketplace/BuyListingModal.tsx), [useResaleBuyFlow.ts](../app/src/pages/marketplace/useResaleBuyFlow.ts), [useResaleCancelFlow.ts](../app/src/pages/marketplace/useResaleCancelFlow.ts), [MarketplaceTable.tsx](../app/src/pages/marketplace/MarketplaceTable.tsx), [MyListingsSection.tsx](../app/src/pages/marketplace/MyListingsSection.tsx), [AppNav.tsx](../app/src/components/AppNav.tsx), [App.tsx](../app/src/App.tsx), [usePortfolioActions.ts](../app/src/pages/portfolio/usePortfolioActions.ts), [positions.ts](../app/src/pages/portfolio/positions.ts), and [V2_SECONDARY_FRONTEND_PLAN.md](V2_SECONDARY_FRONTEND_PLAN.md). Line numbers in this doc were verified against the current tree on 2026-05-02 — not copied from prior docs.
>
> **Scope locked by user (chat transcript 2026-05-02):**
> - Full v1 with expanded panel — cut path REJECTED.
> - Single-source fills only. No split-fills.
> - Soft-redirect `/marketplace → /trade`, drop redirect after one release cycle.
> - Vault-first then resale-ascending in expanded panel.
> - Confirm label: `Buy 5 from Resale · sQk_…` with full pubkey on hover.
> - `·your listing` muted tag on cells where the connected wallet is a seller; expanded panel renders that row but greys out its Buy CTA.
> - Defer the "you own N of these — list some" affordance.
> - No Portfolio changes in this arc.
> - `Toast.tsx` cluster hardcode is already addressed by Step 7.5 — out of scope here.
> - Behavior change to call out in commit body: cells whose vault is fully written-out but have active resale listings will newly light up.

---

## TL;DR

Seven slices, ~22 focused hours total (incl. ~3.5h buffer absorbed across slices), strict topological order, reviewable propose-then-apply cadence matching Steps 7.1–7.5. Ship order: data joins → chain UI trim + depth badge → offerings panel scaffolding → unified buy modal + source routing → edge-case polish + your-listing tag → migration cleanup + redirect + nav → final polish + devnet smoke. Each slice ends in a single commit prefixed `feat(stage-trade-merge-N.M): …`. After Slice 7 lands, `/marketplace` is a `<Navigate replace />` to `/trade`, AppNav shows five links, and Trade is the canonical buyer surface for both vault primary and resale secondary.

---

## 0. Decisions locked from the brainstorm

| Decision | Outcome |
|---|---|
| Cell display | Best-ask number + `·N` depth badge when offerings > 1 |
| Default sort in expanded panel | Vault first; then resale ascending by price |
| Buy routing | Hybrid: cheapest pre-selected, user can override |
| Qty > inventory | Block + inline hint pointing at next-cheapest with enough; no split fills |
| Selling side | Untouched — minting on Write, list/cancel on Portfolio |
| Marketplace migration | Soft-redirect via `<Navigate replace to="/trade" />`; AppNav loses link day 1; redirect dropped after one release cycle |
| Self-listing in chain | Cell carries `·your listing` muted tag; panel includes the row but greys out its Buy CTA |
| Toast cluster hardcode | Out of scope — already addressed in Step 7.5 |

---

## 1. Slice overview

| Slice | Title | Hours | Files (new / edited / deleted) |
|---|---|---|---|
| 1 | Data unification — fetch + join resale into the chain | 4.0 | 0 / 1 / 0 |
| 2 | Chain UI trim — drop stub columns + depth badge | 2.0 | 0 / 2 / 0 |
| 3 | Offerings panel — vault card + resale rows | 4.0 | 1 / 0 / 0 |
| 4 | Unified BuyModal — Source union + routing | 2.5 | 1 lift / 1 / 0 |
| 5 | Edge cases — your-listing tag + qty>inventory hint | 2.0 | 0 / 3 / 0 |
| 6 | Migration cleanup — delete `/marketplace`, redirect, AppNav | 1.5 | 0 / 2 / 8 |
| 7 | Polish + devnet smoke pass | 2.5 | 0 / 0–2 / 0 |
| **Total** | | **18.5** | |

Buffer (~3.5h) is reserved for the unknowable — TS gnarl, Vite oddities, vendored type drift, IDE-only "looks fine" bugs that surface on devnet. Real-world budget: 22h.

Each slice produces a self-contained commit. The repo typechecks (`tsc --noEmit`) and builds (`pnpm build`) at the end of every slice. **No "in-progress, will fix in the next slice" commits.**

---

## 2. Slice 1 — Data unification

**Title:** `feat(stage-trade-merge-1): join resale listings into the chain row data`

**Estimated hours:** 4.0

**Dependencies:** none — kicks off the arc.

**Files:**
- Edit: `app/src/pages/trade/useTradeData.ts`

**What it does:** Extends `useTradeData` to fetch `vaultResaleListing` accounts in addition to `optionsMarket`, joins each listing to its parent `vaultMint`, and exposes a per-row `callOfferings: Offering[]` and `putOfferings: Offering[]`. Also recomputes `callBest`/`putBest` to be the cheapest source across `(vault unsold inventory ∪ resale listings)`. Self-listings (where `seller === connected wallet`) are kept in the offerings array but tagged so downstream UI can render them differently in Slice 5.

This is the **only** slice that introduces a behavior change visible in the UI without any UI work: the cheapest-price number on a chain cell can now drop below what the vault's unsold inventory would have shown, because a cheaper resale listing might exist. That's the merge starting to work.

### 2.1 New type shapes (added to `useTradeData.ts`)

```ts
export type Offering =
  | {
      kind: "vault";
      premium: number;            // pricePerContract (USD)
      inventory: number;          // minted - sold
      vaultMint: { publicKey: PublicKey; account: any };
      vault: { publicKey: PublicKey; account: any };
      market: any;
    }
  | {
      kind: "resale";
      premium: number;            // pricePerContract (USD)
      qty: number;                // listing.listedQuantity, decremented by partial fills
      seller: PublicKey;
      createdAt: number;
      isSelfListing: boolean;     // seller.equals(connectedWallet)
      listing: { publicKey: PublicKey; account: any };
      vaultMint: { publicKey: PublicKey; account: any };
      vault: { publicKey: PublicKey; account: any };
      market: any;
    };
```

`ChainBest` (existing, line 16) stays for back-compat in Slice 1 — Slices 3+4 phase it out by routing through `Offering` directly.

### 2.2 Per-row additions to `ChainRow`

```ts
export type ChainRow = {
  // ... existing fields preserved verbatim ...
  callOfferings: Offering[];   // NEW — sorted by premium ascending
  putOfferings: Offering[];    // NEW — sorted by premium ascending
};
```

`callBest` and `putBest` are recomputed: pick the offering with the lowest `premium` whose `inventory` (vault) or `qty` (resale) is `> 0`. If multiple sources tie on price, prefer vault > earliest createdAt resale. Self-listings ARE eligible to be `callBest`/`putBest` for now (filtered out in Slice 5 via the explicit `·your listing` tag path).

### 2.3 Implementation notes

- Add `safeFetchAll(program, "vaultResaleListing")` to the existing `Promise.all` in `refetch` (line 109) — same shape as the `optionsMarket` fetch.
- Build `listingsByOptionMint: Map<base58, ResaleListing[]>` once per render (memoised) — keyed off each listing's `account.optionMint`.
- In the chain row build (lines 223–315), after the existing `for vm of vaultMints` loop, add a parallel loop walking listings whose option mint matches one of this strike's vault mints. Filter out listings whose parent vault is settled or past expiry — same gate `useMarketplaceData.ts:144-148` already applies.
- Sort each cell's offerings ascending by premium before stashing on the row.
- `useWallet().publicKey` enters this hook for the `isSelfListing` flag — it doesn't today; add it.

### 2.4 Smoke check

- `pnpm dev` from `app/`, open `http://localhost:5173/trade`.
- Devtools console: `__lastUseTradeData` (TODO: add a window-level export only in dev mode? — DROP IT, just inspect React DevTools for the rows prop on `OptionsChain`).
- Pick any cell that you know has resale listings (use `/marketplace` as it exists today to confirm at least one listing is live before deleting it later).
- Confirm in DevTools: that row's `callOfferings` (or `putOfferings`) array contains both a `kind: "vault"` entry and one or more `kind: "resale"` entries.
- Confirm: the headline `callBest.premium` (or `putBest.premium`) equals `min(offerings.map(o => o.premium))`.
- Open the chain, glance at any cell. The headline number may be visibly lower than yesterday on cells that have cheap resale listings. **Note this in the commit body.**

### 2.5 Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| `safeFetchAll(program, "vaultResaleListing")` decode-fail-and-skip semantics fire on stale-layout accounts | Already wired at `useFetchAccounts.ts:29,35` — discriminator is in the table; decode-fail paths just drop the row | n/a — this is the existing convention |
| `useWallet()` re-render storms when the wallet object identity flips | Memoise `connectedWalletBase58` rather than capturing the `PublicKey` instance; same pattern Portfolio uses | Revert the slice; one-file revert |
| Performance hit from joining listings with vaults across all rows | Listing count on devnet is single-digits; mainnet scaling is a post-launch concern (gPA filtering would land then) | Acceptable per design doc §9; revert is one-file |

**Rollback plan:** `git revert <slice-1-sha>` — single file edit, no migrations, no on-chain state involved.

---

## 3. Slice 2 — Chain UI trim + depth badge

**Title:** `feat(stage-trade-merge-2): trim chain to 5 cols + add depth badge`

**Estimated hours:** 2.0

**Dependencies:** Slice 1 (depth count comes from `callOfferings`/`putOfferings` length).

**Files:**
- Edit: `app/src/pages/trade/OptionsChain.tsx`
- Edit: `app/src/pages/trade/TradePage.tsx` (only if the FiveCellBand summary needs touching — likely no edits, see §3.4)

**What it does:** Collapses the 11-column options chain to 5 columns (`OI · PREMIUM | STRIKE | PREMIUM · OI`) by removing the always-stub `BID`, `LAST`, and the inline `DELTA` columns per side. Adds a `·N` depth badge to `PremiumButton` when `offerings.length > 1`. ATM hairline + label + opacity dimming preserved verbatim.

### 3.1 Column changes in `OptionsChain.tsx`

Today's `<thead>` (lines 67–79) lists 11 cells. Drop:
- Lines 69–70 (`Bid`, `Last`) on the calls side
- Line 71 (`Delta`) on the calls side
- Lines 75–77 (`Last`, `Bid`) on the puts side — `Delta` is already on line 75 in the puts section, also drop
- Line numbers will shift; the edit deletes 6 `<Th>` elements total

Resulting header:

```tsx
<tr className="border-b border-rule">
  <Th align="right">OI</Th>
  <Th align="right">Premium</Th>
  <Th align="center">Strike</Th>
  <Th align="left">Premium</Th>
  <Th align="left">OI</Th>
</tr>
```

Body (`ChainRowEl`, lines 136–215): drop the corresponding `<Td>` cells. Keep the strike `<td>` (lines 187–196) verbatim — italic Fraunces + ATM label is the visual anchor. Keep the row-level dimming + `border-t border-b` rhythm verbatim.

Per row, the remaining `<Td>`s are:

```tsx
<Td align="right">{row.callOi > 0 ? row.callOi.toLocaleString() : "—"}</Td>
<Td align="right">
  {row.callBest ? (
    <PremiumButton
      value={row.callBest.premium}
      depthCount={row.callOfferings.length - 1}
      onClick={() => onBuyClick(row.callBest!, "call")}
    />
  ) : (
    <FairPremium value={row.callPremium} />
  )}
</Td>
{/* strike */}
<Td align="left">
  {row.putBest ? (
    <PremiumButton
      value={row.putBest.premium}
      depthCount={row.putOfferings.length - 1}
      onClick={() => onBuyClick(row.putBest!, "put")}
    />
  ) : (
    <FairPremium value={row.putPremium} />
  )}
</Td>
<Td align="left">{row.putOi > 0 ? row.putOi.toLocaleString() : "—"}</Td>
```

### 3.2 Depth badge in `PremiumButton`

```tsx
const PremiumButton: FC<{
  value: number;
  depthCount: number; // count of OTHER offerings beyond the headline; 0 hides the badge
  onClick: () => void;
}> = ({ value, depthCount, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="font-mono text-[12.5px] text-ink hover:text-crimson border-b border-transparent hover:border-crimson transition-colors duration-200 inline-flex items-baseline gap-1.5"
  >
    <MoneyAmount value={value} />
    {depthCount > 0 && (
      <span
        title={`${depthCount} more offering${depthCount === 1 ? "" : "s"}`}
        className="font-mono text-[10.5px] opacity-55"
      >
        ·{depthCount}
      </span>
    )}
  </button>
);
```

The `title` attribute is the hover tooltip — same pattern as the wallet-chip truncation tooltip elsewhere.

### 3.3 `OptionsChain` props

`onBuyClick` signature stays `(best: ChainBest, side: "call" | "put") => void` until Slice 4 widens it to take `Offering` instead. Slice 2 keeps the existing back-compat path.

### 3.4 FiveCellBand summary — no edits

Per locked scope: 24H Vol and IV Skew stub cells stay (separate stub cleanup, not in this arc). The FiveCellBand at `TradePage.tsx:175-191` is untouched.

### 3.5 Smoke check

- Open `/trade`. Confirm 5-column layout, calls left + strike centre + puts right.
- Find a cell with `offerings.length > 1` (Slice 1 verified at least one such cell exists). Confirm `·N` badge renders with the count one less than `offerings.length`.
- Hover the badge — confirm the tooltip reads "N more offerings".
- ATM row still has the hairline above + `ATM` crimson label; deep-OTM rows still fade to ~55% opacity.
- Click any premium cell — buy modal still opens (with today's `BuyModal`, since Slice 4 hasn't unified it yet).

### 3.6 Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Column trim breaks visual rhythm on cells without a headline (FairPremium fallback) | `FairPremium` already exists at lines 241–245; reuse verbatim. The 5-column grid still aligns since the strike column is the visual anchor. | Revert; two-file revert at most |
| Depth badge eats horizontal whitespace on narrow viewports | The `·N` glyph + 10.5px font + 1.5 gap is tight; mobile users are out-of-scope per existing chain (already requires `overflow-x-auto`) | Acceptable; if egregious, drop badge to `pages/trade` mobile breakpoint as a future polish |
| `row.callOfferings.length` is undefined on an old-cache render mid-deploy | TS will catch this since Slice 1 added the field as required; but if a Vercel deploy lands in mid-flight it won't matter — the bundle is atomic | n/a |

**Rollback plan:** `git revert <slice-2-sha>` — restores the 11-column layout. No data implications since Slice 1's data shape is additive.

---

## 4. Slice 3 — Offerings panel scaffolding

**Title:** `feat(stage-trade-merge-3): scaffold the unified offerings panel UI`

**Estimated hours:** 4.0

**Dependencies:** Slice 1 (offerings array on rows). Slice 2 is parallel — can be implemented in either order, but committed AFTER Slice 2 to keep the topological chain clean.

**Files:**
- Create: `app/src/pages/trade/OfferingsPanel.tsx`

**What it does:** Builds the panel UI as a standalone component — the rich top half of the unified BuyModal that Slice 4 will assemble. Display-only at this stage. Renders: vault card (premium · inventory · "at fair" pill · pre-selected indicator), then resale rows sorted ascending by price (premium · qty · seller · age · vs-fair pill · pre-selected indicator), with a sort caption and a "Best ask · X · up to Y contracts" footer line. Selection state lifts up via `selected: Offering | null` + `onSelect: (o: Offering) => void` props.

The component is **not yet wired into the chain** — Slice 4 mounts it inside `BuyModal`. Slice 3 just builds it and ensures it typechecks alongside today's chain (no consumers).

### 4.1 Component shape

```tsx
type OfferingsPanelProps = {
  asset: string;
  side: "call" | "put";
  strike: number;
  expiry: number;
  spot: number | null;
  fairPremium: number;
  ivSmiled: number;     // smile-adjusted IV used for fairPremium derivation
  offerings: Offering[]; // already sorted ascending by premium per Slice 1
  selected: Offering | null;
  onSelect: (o: Offering) => void;
  /** Connected wallet for self-listing dimming. Null when disconnected. */
  connectedWallet: PublicKey | null;
};

export const OfferingsPanel: FC<OfferingsPanelProps>;
```

### 4.2 Layout sketch

```
┌──────────────────────────────────────────────────────────────────┐
│  SOL · CALL · $100 · 18 May 2026                              ✕ │   <-- header owned by BuyModal in Slice 4
│  Spot $94.20 · Fair $3.41 · IV 78.4% · 16D                     │
├──────────────────────────────────────────────────────────────────┤
│  ┌── VAULT ──────────────────────────────────────────────────┐   │
│  │  $3.40    47 available    at fair       [pre-selected]   │   │
│  │  Live premium · Black-Scholes derived                     │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                   │
│  RESALE LISTINGS                                       sorted ↑  │
│  ─────────────────────────────────────────────────────────────   │
│  $3.10    2 contracts   8.8% below fair   sQk_…f9R    1d ago   →│
│  $3.20    5 contracts   6.2% below fair   nKp_…2zV    3h ago   →│
│  $3.55    3 contracts   4.1% above fair   t1m_…aaP    14h ago  →│
│                                                                   │
│  ─────────────────────────────────────────────────────────────   │
│  Best ask $3.10 · Up to 2 contracts at this price                │
└──────────────────────────────────────────────────────────────────┘
```

The header strip (asset · side · strike · expiry · spot · fair · IV · DTE) is rendered by `OfferingsPanel` itself — it travels with the panel into the modal. The ✕ + outer modal shell are owned by `BuyModal` in Slice 4.

### 4.3 Vault card

- Bordered card (`border border-rule rounded-md`), full ink, paper background.
- Three columns: `$premium · N available · vs-fair pill`.
- Sub-line: `Live premium · Black-Scholes derived`.
- Click anywhere on the card → `onSelect({ kind: "vault", … })`.
- Selected state: thicker border (`border-ink` instead of `border-rule`) + `bg-paper-2` tint.

When `vault` offering is absent (vault fully written-out), render a muted card: `Vault · fully written` with no Buy CTA. Resale rows below still drive the panel.

### 4.4 Resale rows

- Each row: hairline-divided list (`border-b border-rule-soft`), opacity 0.85 by default.
- Columns: `$premium · qty · vs-fair pill · seller · age · arrow`.
- Vs-fair pill: green `< -0.5%`, crimson `> +0.5%`, muted ink otherwise — same `DiscountPill` logic from `MarketplaceTable.tsx:228-243`.
- Seller: `truncateAddress(seller.toBase58())` — `4 dots 4` format.
- Age: relative time from `createdAt` — same `formatRelative` helper from `MarketplaceTable.tsx:273-281`.
- Selected state: full opacity, `bg-paper-2` background, `border-ink` row borders.
- Self-listings (`isSelfListing === true`): row renders but with opacity 0.4, the arrow drops to a `·your listing` tag, and `onSelect` is **no-op** (the modal's CTA in Slice 4 + 5 disables Buy when a self-listing is selected; Slice 3 just makes the row inert).

### 4.5 Footer line

`Best ask $X.XX · Up to Y contracts at this price` — derived from the cheapest non-self offering's `premium` and `inventory` (vault) / `qty` (resale). When all offerings are self-listings, the footer reads `No third-party offerings — your own listings shown above`.

### 4.6 Helpers to lift

The following utilities live in `MarketplaceTable.tsx` today and need to come along — copy them into `OfferingsPanel.tsx` for now (they get deleted with `MarketplaceTable.tsx` in Slice 6):
- `formatTableDate(unix)` (`MarketplaceTable.tsx:255-261`)
- `formatRelative(unix)` (`MarketplaceTable.tsx:273-281`)
- `DiscountPill` component (`MarketplaceTable.tsx:228-243`)

Slice 6 deletes the `MarketplaceTable.tsx` originals.

### 4.7 Smoke check

Slice 3 mounts a brief dev-only preview to eyeball the layout in isolation:

- `pnpm tsc --noEmit` — clean.
- Add a temporary `<OfferingsPanel … />` mount inside `TradePage.tsx` behind a `?devPanel=1` query-flag gate. The mount picks the first non-empty cell on the rendered chain and feeds its offerings into the panel. Open `/trade?devPanel=1`.
- Eyeball: vault card renders at top with full ink + bordered card; resale rows render below sorted ascending by price; vs-fair pill colour-codes correctly; self-listings (if any in the picked cell) dim to opacity 0.4 with `·your listing` label; footer line reads `Best ask $X · Up to Y contracts at this price`.
- **Remove the temp mount before commit.** Five minutes of insurance now catches layout bugs in Slice 3 instead of Slice 4 where they'd be tangled with modal-lifecycle issues.

### 4.8 Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Lifting `DiscountPill`/`formatRelative` duplicates code with `MarketplaceTable.tsx` | Acceptable — Slice 6 deletes the originals; the duplication window is two slices wide | n/a |
| Self-listing dimming logic relies on `connectedWallet` plumbing not yet present in `OptionsChain → BuyModal` flow | Slice 4 wires it; Slice 3 just defines the prop | Revert Slice 3 if the prop shape proves wrong; one-file revert |
| Panel layout breaks on a cell with zero offerings | Defensive: `OfferingsPanel` early-returns a "No offerings — close panel" message when both vault and resale are absent. (Cells without offerings don't open the panel at all in Slice 4 — but defensive copy is cheap.) | n/a |

**Rollback plan:** `git revert <slice-3-sha>` — single file delete (the new component had no consumers).

---

## 5. Slice 4 — Unified BuyModal with Source routing

**Title:** `feat(stage-trade-merge-4): unify BuyModal with vault+resale Source routing`

**Estimated hours:** 2.5

**Dependencies:** Slice 3 (panel), Slice 1 (offerings on rows).

**Files:**
- Lift: `app/src/pages/marketplace/useResaleBuyFlow.ts` → `app/src/pages/trade/useResaleBuyFlow.ts`
- Edit: `app/src/pages/trade/BuyModal.tsx`
- Edit: `app/src/pages/trade/OptionsChain.tsx` (widen `onBuyClick` signature)
- Edit: `app/src/pages/trade/TradePage.tsx` (update `buyTarget` state shape)

**What it does:** Replaces the existing `BuyModal` with a unified version that mounts `OfferingsPanel` + qty input + total cost + Confirm. Selection drives a `Source` discriminated union — `{ kind: "vault", best } | { kind: "resale", row }` — and the Confirm dispatcher routes to either `usePurchaseFlow.submit` (existing) or `useResaleBuyFlow.submit` (lifted). Confirm label reads `Buy 5 from Vault` or `Buy 5 from Resale · sQk_…f9R` per locked OQ#5; full pubkey on hover via `title` attribute. The qty input caps at the selected source's inventory.

### 5.1 Lift `useResaleBuyFlow`

- `git mv app/src/pages/marketplace/useResaleBuyFlow.ts app/src/pages/trade/useResaleBuyFlow.ts` (or copy + delete; the marketplace original goes away in Slice 6 anyway, but cleaner to lift now).
- Update the import in `BuyListingModal.tsx` (still under `pages/marketplace/`) to `from "../trade/useResaleBuyFlow"` — Slice 6 deletes that file, so this import is throwaway.
- Update `useResaleBuyFlow.ts`'s import of `ResaleListingRow` from `./useMarketplaceData` → `from "./useTradeData"` (Slice 1 added the type) OR keep a thin re-export in `useTradeData.ts` for now and clean up in Slice 6. **Recommend the re-export path** — minimises Slice 6's blast radius.

### 5.2 New `Source` type in `BuyModal.tsx`

```ts
export type Source =
  | { kind: "vault"; offering: Extract<Offering, { kind: "vault" }> }
  | { kind: "resale"; offering: Extract<Offering, { kind: "resale" }> };
```

A `Source` is just a constrained `Offering` — the union exists only to make the dispatcher's switch exhaustive.

### 5.3 `BuyModal` shape

```ts
type BuyModalProps = {
  asset: string;
  side: "call" | "put";
  strike: number;
  expiry: number;
  spot: number | null;
  fairPremium: number;
  ivSmiled: number;
  offerings: Offering[];   // sorted ascending by premium per Slice 1
  /** Cheapest non-self offering, pre-selected. Null only if every offering is a self-listing. */
  initialSelected: Offering | null;
  onClose: () => void;
  onSuccess: () => void;
};
```

Internal state:
- `selected: Offering | null` — initialised from `initialSelected`.
- `quantity: string` — number input, capped at selected's inventory.
- `usdcBalance: number | null` — read from chain on mount, same pattern as today's `BuyModal:75-99`.
- `confirmedTx: string | null` — confirmed-state lifecycle marker.

### 5.4 Confirm label

```ts
const sourceLabel = useMemo(() => {
  if (!selected) return "—";
  if (selected.kind === "vault") return "Vault";
  return `Resale · ${truncateAddress(selected.seller.toBase58())}`;
}, [selected]);

const confirmLabel = `Buy ${qtyNum} from ${sourceLabel}`;
const confirmTitle = selected?.kind === "resale" ? selected.seller.toBase58() : undefined;
```

Render:

```tsx
<button
  type="button"
  onClick={connected ? handleConfirm : () => setVisible(true)}
  disabled={connected && !canSubmit}
  title={confirmTitle}
  className="..."
>
  {!connected ? "Connect Wallet" : submitting ? "Confirming…" : `${confirmLabel} →`}
</button>
```

The full pubkey-on-hover comes from the native `title` attribute — same approach as the depth badge tooltip in Slice 2.

### 5.5 Confirm dispatcher

```ts
const handleConfirm = async () => {
  if (!selected) return;
  try {
    let result: { txSignature: string } | null = null;
    if (selected.kind === "vault") {
      const best: ChainBest = {
        vaultMint: selected.vaultMint,
        vault: selected.vault,
        market: selected.market,
        premium: selected.premium,
      };
      result = await purchaseFlow.submit({ best, quantity: qtyNum });
    } else {
      const row: ResaleListingRow = /* derive from `selected` — see §5.6 */;
      result = await resaleBuyFlow.submit({ row, quantity: qtyNum });
    }
    if (result) {
      setConfirmedTx(result.txSignature);
      showToast({
        type: "success",
        title: selected.kind === "vault" ? "Contracts purchased" : "Listing filled",
        message: `${qtyNum} ${asset} ${side.toUpperCase()} @ $${strike.toFixed(2)} from ${sourceLabel}`,
        txSignature: result.txSignature,
      });
      onSuccess();
    }
  } catch (err: any) {
    const msg: string = err?.message ?? "Unknown error";
    showToast({ type: "error", title: "Purchase failed", message: msg });
    // Race-detected errors auto-close + parent refetches — copied from BuyListingModal.tsx:147-162
    const isStaleStateError =
      msg.includes("contracts left in this listing") ||
      msg.includes("Listing data mismatch") ||
      msg.includes("ListingExhausted") ||
      msg.includes("InvalidListingEscrow") ||
      msg.includes("ListingMismatch");
    if (isStaleStateError) setTimeout(() => onSuccess(), 1500);
  }
};
```

### 5.6 Bridging `Offering` ↔ `ResaleListingRow`

`useResaleBuyFlow` takes a `ResaleListingRow` (defined today in `useMarketplaceData.ts:17-37`). The `Offering` type from Slice 1 is a strict superset for the resale variant. Two options:

**Option A:** Pass `Offering` directly to `useResaleBuyFlow`, modify the hook's input type. **Recommend** — kills the duplicated type once Slice 6 deletes `useMarketplaceData.ts`. `ResaleListingRow` becomes an alias for `Extract<Offering, { kind: "resale" }>` & extra display fields, and we can probably collapse it.

**Option B:** Construct a `ResaleListingRow` from the `Offering` at the dispatcher call site. Throwaway shim. **Reject** — temporary.

Slice 4 chooses **A**: edit `useResaleBuyFlow.ts`'s input type and `ResaleListingRow` consumers. Then in Slice 6 the alias goes away when `useMarketplaceData.ts` is deleted.

### 5.7 Self-listing guard

Already in `useResaleBuyFlow.ts:71` (`if (publicKey.equals(row.seller)) return null;`) and on-chain via `CannotBuyOwnOption`. Modal's `canSubmit` adds a third defense:

```ts
const isSelfListing =
  selected?.kind === "resale" &&
  publicKey != null &&
  selected.seller.equals(publicKey);

const canSubmit =
  !submitting &&
  selected != null &&
  qtyNum >= 1 &&
  qtyNum <= selectedInventory &&
  !isSelfListing &&
  !insufficient;
```

Self-listing rendering of the row stays inert (set up in Slice 3). Slice 5 adds the cell-level `·your listing` tag.

### 5.8 OptionsChain `onBuyClick` widening

```ts
// before (Slice 2):
onBuyClick: (best: ChainBest, side: "call" | "put") => void;

// after (Slice 4):
onBuyClick: (offerings: Offering[], side: "call" | "put") => void;
```

`TradePage.tsx`'s `buyTarget` state widens accordingly:

```ts
const [buyTarget, setBuyTarget] = useState<{
  offerings: Offering[];
  side: "call" | "put";
  asset: string;
  strike: number;
  expiry: number;
  fairPremium: number;
  ivSmiled: number;
  spot: number | null;
} | null>(null);
```

The chain's row owns `asset` (selected at page level), `strike`, `expiry` (selected via `ExpiryTabs`), `fairPremium` (`row.callPremium`/`row.putPremium`), and `spot`. `ivSmiled` is computed in `useTradeData.ts:247` for the row build — expose it on `ChainRow` (`callIvSmiled`/`putIvSmiled`).

### 5.9 Smoke check

Manual on devnet, two wallets (A and B, both holding USDC):

1. **Vault buy still works.** Wallet A. Open `/trade`, click a cell where the cheapest source is the vault. Modal opens with vault pre-selected. Confirm reads `Buy 1 from Vault`. Click — toast `Contracts purchased … from Vault`. Solscan link works. Portfolio shows the new position.
2. **Resale buy from cheapest.** Wallet A. Open `/trade`, click a cell where wallet B has a cheap resale listing AND the vault has inventory at a higher price. Modal opens with the resale row pre-selected. Confirm reads `Buy 1 from Resale · BBBB_…BBBB`. Hover Confirm → tooltip shows wallet B's full pubkey. Click — toast `Listing filled … from Resale · BBBB_…BBBB`. Solscan + Portfolio show the contract.
3. **Resale buy from non-cheapest.** Wallet A. Click a cell with multiple resale rows, click the second-cheapest row in the panel. Confirm label updates immediately. Click — succeeds.
4. **Race-error path.** Wallet A. Open the modal on a single-contract listing. In a separate browser, wallet B clicks the same listing first. Wallet A clicks Confirm. Toast: `Purchase failed: ListingExhausted` (or the decoder string). After 1.5s, modal auto-closes; chain refetches; the listing decremented or vanished.
5. **Self-listing case.** Wallet A's own listing renders inertly in the panel (opacity 0.4 + `·your listing` label). Clicking it does nothing. Cheapest non-self offering stays pre-selected. (`·your listing` cell-level tag lands in Slice 5 — not yet visible at the cell.)

### 5.10 Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| `useResaleBuyFlow`'s 17-account `accountsStrict` block depends on `vaultMintRecord` having an `optionMint` field — present on `Offering`'s resale variant | Verified in Slice 1's type construction | n/a |
| Lifting the hook breaks the marketplace page mid-arc (Slice 6 deletes the page anyway, but in the meantime…) | Update `BuyListingModal.tsx`'s import path; that file is alive between Slices 4 and 6 | Single-line import revert |
| `Offering`'s vault variant lacks the `purchaseFromVault` PDAs that `ChainBest` carries | The dispatcher constructs a `ChainBest` from the `Offering` at call time (§5.5); `ChainBest`'s 4 fields are all present on the vault variant of `Offering` | n/a |
| `usePurchaseFlow`'s 5% slippage cushion vs `useResaleBuyFlow`'s exact-price multiplied — easy to copy/paste the wrong rule | Each hook owns its own slippage rule (existing — `usePurchaseFlow.ts:116` uses `* 1.05`; `useResaleBuyFlow.ts:133` uses exact). Don't unify them. The dispatcher just picks which to call. | n/a |

**Rollback plan:** `git revert <slice-4-sha>` reverts the modal unification — chain still works (5-cell layout from Slice 2), data still works (joined offerings from Slice 1), but click → buy reverts to the old `purchaseFromVault`-only path.

---

## 6. Slice 5 — Edge cases + your-listing tag

**Title:** `feat(stage-trade-merge-5): your-listing tag + qty>inventory hint + Confirm guards`

**Estimated hours:** 2.0

**Dependencies:** Slice 4.

**Files:**
- Edit: `app/src/pages/trade/OptionsChain.tsx`
- Edit: `app/src/pages/trade/BuyModal.tsx`
- Edit: `app/src/pages/trade/useTradeData.ts`

**What it does:** Three edges:

1. **Cell-level `·your listing` muted tag** when the connected wallet has any offering at that (strike, side) on the rendered chain — sits next to the `·N` depth badge.
2. **Qty > selected source's inventory** — Confirm disables, the modal renders an inline hint pointing at the next-cheapest source with enough inventory: `Only 2 available at $3.10. The vault has 47 available at $3.40. [Switch source]`.
3. **`callBest`/`putBest` excludes self-listings** for the headline display — prevents the chain showing a "buy" price that's actually the user's own ask. Self-listings still appear in the panel (greyed, see Slice 3).

### 6.1 `useTradeData.ts` — exclude self-listings from headline

In the `callBest`/`putBest` recompute (Slice 1), filter out offerings where `kind === "resale" && isSelfListing === true` BEFORE picking the cheapest. Effect: `callBest.premium` is the cheapest *third-party* ask. Headline number is what a third-party buyer would actually pay, not what the user has listed.

```ts
const visibleOfferings = callOfferings.filter(
  (o) => !(o.kind === "resale" && o.isSelfListing)
);
const callBest = visibleOfferings[0] ?? null; // already sorted ascending
```

### 6.2 Cell-level `·your listing` tag in `OptionsChain.tsx`

Add a sibling glyph to the depth badge:

```tsx
<button …>
  <MoneyAmount value={value} />
  {depthCount > 0 && (
    <span title={`${depthCount} more offering${depthCount === 1 ? "" : "s"}`} className="font-mono text-[10.5px] opacity-55">
      ·{depthCount}
    </span>
  )}
  {hasSelfListing && (
    <span title="You have an active listing here" className="font-mono text-[10.5px] opacity-55 italic">
      ·your listing
    </span>
  )}
</button>
```

`hasSelfListing` is a new boolean on `ChainRow`: `callOfferings.some(o => o.kind === "resale" && o.isSelfListing)`. Same for the puts side.

### 6.3 Qty > inventory inline hint in `BuyModal.tsx`

```tsx
const selectedInventory = selected
  ? selected.kind === "vault" ? selected.inventory : selected.qty
  : 0;
const exceedsInventory = qtyNum > selectedInventory;

const nextCheapestWithEnough = useMemo(() => {
  if (!exceedsInventory) return null;
  return offerings.find((o) => {
    if (o === selected) return false;
    if (o.kind === "resale" && o.isSelfListing) return false;
    const inv = o.kind === "vault" ? o.inventory : o.qty;
    return inv >= qtyNum;
  }) ?? null;
}, [offerings, selected, qtyNum, exceedsInventory]);
```

Render the hint when `exceedsInventory && nextCheapestWithEnough`:

```tsx
<div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-crimson mb-3">
  Only {selectedInventory} available at <MoneyAmount value={selected.premium} />.{" "}
  {nextCheapestWithEnough.kind === "vault" ? "Vault" : `Resale · ${truncateAddress(nextCheapestWithEnough.seller.toBase58())}`}{" "}
  has {nextCheapestWithEnough.kind === "vault" ? nextCheapestWithEnough.inventory : nextCheapestWithEnough.qty} at{" "}
  <MoneyAmount value={nextCheapestWithEnough.premium} />.{" "}
  <button className="underline text-crimson" onClick={() => setSelected(nextCheapestWithEnough)}>
    Switch source
  </button>
</div>
```

When `exceedsInventory && !nextCheapestWithEnough`, render: `Only N available across all sources at any price. Reduce quantity to ≤ N.`

`canSubmit` already excludes `qtyNum > selectedInventory` (set in Slice 4); leave that as the gate. The hint is informational, not a different gate.

### 6.4 Smoke check

Reusing wallet A (no listings) and wallet B (one resale listing):

1. **Headline excludes self-listing.** Wallet A is wallet B for this test. List a contract on Portfolio (existing flow, no changes there). Open `/trade`. Confirm: the cell's headline `callBest.premium` (or `putBest.premium`) is **not** wallet A's own listing price — even if it's the lowest. The `·your listing` tag appears next to the headline number. The depth badge `·N` count is one less than the offering total (excludes the self-listing? — no, Slice 5 keeps it in the count — see §6.5). Actually re-spec: depth count counts ALL non-headline offerings INCLUDING self-listings, since the panel renders them all. So `·N = offerings.length - 1`. Verify the badge count matches what the panel displays.
2. **Qty > inventory hint.** Wallet A. Open the panel on a cell where the cheapest source has 2 contracts; type `5` in the qty input. Confirm disables; inline hint reads `Only 2 available at $X. The vault has 47 available at $Y. [Switch source]`. Click `Switch source` — selected flips, qty stays at 5, hint disappears, Confirm enables.
3. **No next-cheapest.** Type a qty larger than every source's inventory across all sources. Hint reads `Only N available across all sources at any price. Reduce quantity to ≤ N.`
4. **Self-listing dimmed in panel + cannot be selected.** From wallet B (with the listing), open the panel on its own listing's cell. The self-listing row renders at opacity 0.4, the arrow is replaced by `·your listing`. Clicking does nothing. Confirm stays disabled if the only non-self offering in the panel is also exhausted (rare).
5. **Cell-level tag at the chain.** Wallet B. Open `/trade`, glance at the chain. Cells where wallet B has a listing show `·your listing` next to the headline. Cells where wallet B has no listing don't show the tag.

### 6.5 Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Excluding self-listings from headline drops the headline below the panel-pre-selected source | Pre-selection in Slice 4 was already the cheapest non-self offering — same filter; the headline and the panel pre-selection match | n/a |
| Cell width inflates with both `·N` and `·your listing` glyphs | Both glyphs are 10.5px mono, single-line; total width ≤ 90px in worst case (e.g., `$1234.56 ·12 ·your listing`); `whitespace-nowrap` already applied | If egregious, drop the `·your listing` glyph to a tooltip-only treatment as a follow-up |
| `nextCheapestWithEnough` is undefined and the hint reads junk | The render guards on `nextCheapestWithEnough` being truthy; when null, fall through to the "no source has enough" copy | n/a |

**Rollback plan:** `git revert <slice-5-sha>` — three-file revert. Chain reverts to Slice 4's behavior: headline can be a self-listing, no qty>inventory hint, no `·your listing` cell tag. Panel still excludes self-listings from selection (Slice 3 logic stands).

---

## 7. Slice 6 — Migration cleanup

**Title:** `feat(stage-trade-merge-6): retire /marketplace, redirect, drop AppNav link`

**Estimated hours:** 1.5

**Dependencies:** Slice 4 (BuyModal handles resale buys natively); Slice 5 (your-listing tag in place so users don't lose visibility).

**Files:**
- Edit: `app/src/App.tsx`
- Edit: `app/src/components/AppNav.tsx`
- Delete: `app/src/pages/marketplace/MarketplacePage.tsx`
- Delete: `app/src/pages/marketplace/MarketplaceStatementHeader.tsx`
- Delete: `app/src/pages/marketplace/MarketplaceFilters.tsx`
- Delete: `app/src/pages/marketplace/MarketplaceTable.tsx`
- Delete: `app/src/pages/marketplace/BuyableListingsSection.tsx`
- Delete: `app/src/pages/marketplace/MyListingsSection.tsx`
- Delete: `app/src/pages/marketplace/BuyListingModal.tsx`
- Delete: `app/src/pages/marketplace/useMarketplaceData.ts`
- Delete: `app/src/pages/marketplace/useResaleCancelFlow.ts` — `usePortfolioActions.cancelResale` already does V2 cancel
- Delete: `app/src/pages/marketplace/index.ts`
- Delete: `app/src/pages/marketplace/` (the directory itself, once empty)

**What it does:** Replaces the `/marketplace` route with a `<Navigate replace to="/trade" />`, drops the `Marketplace` link from `AppNav`, removes the `/marketplace` entry from `HEADER_HIDDEN_PATHS`, and deletes the now-unused page files. `useResaleBuyFlow.ts` already lifted to `pages/trade/` in Slice 4.

### 7.1 `App.tsx` route change

Today (line 58):

```tsx
<Route path="/marketplace" element={<MarketplacePage />} />
```

After:

```tsx
<Route path="/marketplace" element={<Navigate replace to="/trade" />} />
```

Add the `Navigate` import to the existing `react-router-dom` line. Drop the `MarketplacePage` import from line 7. Drop `/marketplace` from `HEADER_HIDDEN_PATHS` at line 32 — `Navigate` doesn't render the paper surface, so the global Header would briefly flash. Actually keep the entry in `HEADER_HIDDEN_PATHS` until the redirect itself is dropped (one release cycle later); during the redirect's lifetime, suppressing the global Header on `/marketplace` keeps the UX clean during the brief redirect frame.

Update the comment block at lines 17–29 to remove the `/marketplace` line.

### 7.2 `AppNav.tsx` link removal

Drop line 62: `<AppNavLink to="/marketplace">Marketplace</AppNavLink>`. Five-link nav: Markets / Trade / Write / Portfolio / Docs.

### 7.3 File deletions

Delete each file listed in §7's Files section. For directory cleanup, `rmdir app/src/pages/marketplace` after files are gone.

### 7.4 Re-export cleanup

If any other file in the codebase imports from `pages/marketplace`, those imports are dead. Do a `Grep` pass for `from "../marketplace"` and `from "./pages/marketplace"` — should be zero results after Slice 4 lifted `useResaleBuyFlow`. The ResaleListingRow re-export shim from Slice 4 (in `useTradeData.ts`) becomes the canonical home; clean it up by inlining the type definition there.

### 7.5 Smoke check

1. **Soft-redirect.** Visit `http://localhost:5173/marketplace` directly. Land on `/trade`. URL bar updates.
2. **Bookmark with query string.** Visit `http://localhost:5173/marketplace?asset=SOL` (no such param exists today, just simulating an old deep link). Lands on `/trade`. (We don't preserve the query string — locked decision; the new chain has its own `?asset=&expiry=&strike=&type=` deep-link grammar from `useTradeData.ts:171-195`.)
3. **AppNav.** Open `/trade`. Five links visible. No Marketplace link.
4. **Vault buy.** Re-run smoke from Slice 4 — vault buy works, resale buy works, panel renders, your-listing tag renders.
5. **Build clean.** `pnpm build` from `app/` — completes with the three pre-existing warnings (per `feedback_vite_build_warnings.md`) and no others.
6. **Typecheck clean.** `pnpm tsc --noEmit` — zero errors.
7. **Grep dead imports.** Run a `Grep` for `pages/marketplace` across `app/src/` — zero matches.

### 7.6 Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Hidden import from another file pulling from `pages/marketplace/` | Pre-deletion grep pass (§7.4); if found, fix before deleting | If a grep miss surfaces post-commit, follow-up commit to fix |
| Browser caches `/marketplace` route serving old bundle, breaks for users mid-deploy | Vercel atomic deploy — no mixed-bundle window in practice | n/a |
| `<Navigate replace />` strips the URL hash; loses anchor links into `/marketplace` (none exist today) | Verified in audit: no `#section` consumers | n/a |
| Deleting `useResaleCancelFlow.ts` breaks something — it's referenced only in `MarketplacePage.tsx` (deleted in same slice) | Pre-deletion grep `Grep "useResaleCancelFlow"` — should be one match (the now-deleted page) and the export from `index.ts` (also deleted) | n/a |

**Rollback plan:** `git revert <slice-6-sha>` restores the page, the route, and the AppNav link. Trade still works (the merge is in place from Slices 1–5); Marketplace works again as a parallel surface. **This is the cleanest "uh oh" exit** — restoring the parallel surface gives users a fallback while the merge is debugged.

---

## 8. Slice 7 — Polish + devnet smoke pass

**Title:** `feat(stage-trade-merge-7): final polish + devnet smoke verification`

**Estimated hours:** 2.5

**Dependencies:** Slice 6.

**Files:**
- Edit (if needed): `app/src/pages/trade/OfferingsPanel.tsx`
- Edit (if needed): `app/src/pages/trade/BuyModal.tsx`
- Edit (if needed): `app/src/pages/trade/OptionsChain.tsx`

**What it does:** No new behavior. End-to-end devnet verification + any micro-polish surfaced during the smoke (depth-badge spacing, panel transitions, mobile column behavior, copy tweaks). The slice exists to bound the polish work — without it, polish drips into the buffer indefinitely.

### 8.1 Full smoke matrix

Run all of these against devnet, two wallets (A = buyer, B = seller). Document the run in the commit body.

#### A. Happy path — vault buy

1. Wallet A. `/trade`. Click a cell where vault is cheapest. Modal opens.
2. Verify panel: vault card pre-selected, resale rows below sorted ascending.
3. Verify Confirm label `Buy 1 from Vault`.
4. Confirm. Toast `Contracts purchased … from Vault`. Solscan link valid. Portfolio shows the position.

#### B. Happy path — resale buy from cheapest

5. Wallet B has at least one listing cheaper than the vault on some cell. (Use Portfolio's existing list-resale flow to seed.)
6. Wallet A. `/trade`. Click that cell. Panel pre-selects the cheapest resale row.
7. Verify Confirm label `Buy 1 from Resale · BBBB_…BBBB`. Hover → tooltip with full pubkey.
8. Confirm. Toast `Listing filled … from Resale · BBBB_…BBBB`. Portfolio shows the position. Wallet B's USDC balance up by `0.995 * price`. Treasury up by `0.005 * price`.

#### C. Happy path — resale buy from non-cheapest

9. Wallet A. `/trade`. Click a cell with multiple resale rows. Click the second-cheapest row in panel.
10. Confirm label updates. Confirm. Succeeds.

#### D. Headline excludes self-listing

11. Wallet B. `/trade`. Go to the cell where B has a listing. Verify headline is NOT B's own price; verify `·your listing` tag.
12. Click cell. Panel shows B's listing greyed out, opacity 0.4, `·your listing` label, no arrow.
13. Cheapest non-self offering pre-selected.

#### E. Qty > inventory

14. Wallet A. Click a cell whose cheapest source has < 5 contracts. Type `5`. Confirm disables.
15. Inline hint reads `Only N available at $X. <next-cheapest> has M at $Y. [Switch source]`. Click Switch source. Selection flips. Confirm enables.

#### F. Race-error path

16. Wallet B has a 1-contract listing. Wallet A and Wallet C (third browser session) both open the modal on it.
17. Wallet C clicks Confirm first. Wallet A clicks. Toast `Purchase failed: ListingExhausted`. Modal auto-closes after 1.5s. Chain refetches; the row's headline changes (or vanishes if vault was also empty).

#### G. Connect-wallet flow

18. Wallet disconnected. `/trade`. Click any cell. Modal opens; CTA reads `Connect Wallet`. Click — wallet adapter modal opens. Connect wallet A. Modal stays up; CTA flips to `Buy N from Source →`.

#### H. Soft-redirect

19. Visit `/marketplace` directly. Land on `/trade`. URL bar reads `/trade`.

#### I. AppNav

20. Verify five-link nav across all paper-surface routes. No Marketplace link anywhere.

#### J. Resale buy refreshes chain

21. Wallet A buys 2 from a 5-contract listing. Toast confirms. Modal closes. Chain refetches automatically (`onSuccess` → `data.refetch`). Click that cell again — panel shows 3 remaining on the listing row.

#### K. Buy from a vault-fully-sold cell

22. Find a cell where vault `unsold === 0` but a resale listing exists. Verify the cell is now lit up (was dark pre-merge). Buy succeeds via the resale path. **Mention this case in the commit body per the locked-decision §0 callout.**

#### L. Build + typecheck

23. `pnpm tsc --noEmit` — clean.
24. `pnpm build` — completes; only the three pre-existing warnings (crypto external, protobufjs eval, 500kB chunk).

### 8.2 Polish budget

If any smoke-pass issue surfaces, fix it inline in this slice. Examples likely to surface:
- Depth badge `·N` clipping into the next column on very narrow viewports → adjust gap or whitespace-nowrap rules.
- Panel transitions feel abrupt → add a 150ms fade-in (matches modal backdrop's existing transition).
- Confirm label wraps at long pubkey hashes → enforce `whitespace-nowrap`.
- Vault card "vs fair" pill renders `+0.0%` for at-fair → swap to "at fair" copy.

If the polish list grows beyond ~1h of work, defer the long tail to a Slice 8 follow-up. **Don't let polish absorb the buffer indefinitely.**

### 8.3 Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Smoke surfaces a regression in the on-chain dispatcher | Treat as a bug; fix in this slice; if fix > 1h, revert slice and address in follow-up | Slice-level revert |
| Mobile breakpoints look broken | Existing chain already requires `overflow-x-auto`; mobile is out-of-scope per existing UX baseline | Defer; not a launch blocker |
| Polish list grows | Hard cap at 1h; defer rest | n/a |

**Rollback plan:** `git revert <slice-7-sha>` removes only the polish patches. Slices 1–6 remain shipped. Trade is functional without Slice 7.

---

## 9. Definition of Done

The arc is shipped when **all** of the following are true. Verify each before declaring victory.

| # | Criterion | How to verify |
|---|---|---|
| 1 | `/trade` chain renders 5 columns + depth badges + your-listing tags | Open `/trade`; visual + DevTools `OptionsChain` props |
| 2 | Clicking any premium cell opens the unified `BuyModal` with `OfferingsPanel` | Click cell; modal mounts; vault card + resale rows visible |
| 3 | Vault buys still work via `purchase_from_vault` | Smoke A passes; Solscan tx visible |
| 4 | Resale buys work via `buy_v2_resale` | Smoke B passes; Solscan tx visible; seller USDC balance updates |
| 5 | Self-listings are dimmed in the panel + cannot be bought | Smoke D passes |
| 6 | Qty > inventory hint guides to next-cheapest source | Smoke E passes |
| 7 | Race-error → 1.5s auto-close + chain refetch | Smoke F passes |
| 8 | `/marketplace` redirects to `/trade` via `<Navigate replace />` | Smoke H passes |
| 9 | AppNav shows 5 links — no Marketplace link | Smoke I passes |
| 10 | All `pages/marketplace/` files deleted; directory gone | `Grep "pages/marketplace"` returns zero |
| 11 | Build clean: `pnpm build` succeeds with only the 3 pre-existing warnings | Run from `app/` |
| 12 | Typecheck clean: `pnpm tsc --noEmit` zero errors | Run from `app/` |
| 13 | Vault-fully-sold-but-resale-active cells light up | Smoke K passes; behavior noted in Slice 1 commit body |
| 14 | Confirm label format `Buy N from <Source>` with full pubkey on hover | Smoke B + C pass |
| 15 | Panel sort: vault first, resale ascending by price | Visual confirm — vault always at top regardless of price |
| 16 | Portfolio is unchanged | `git diff main -- app/src/pages/portfolio/` returns zero |
| 17 | No new TS errors, no new ESLint errors, no new build warnings | `pnpm build` and `pnpm tsc --noEmit` baseline-clean |
| 18 | Devnet smoke matrix (12 scenarios in §8.1 A–L) all pass | Document run in Slice 7 commit body |

If any criterion fails, the arc is not done. No "we'll fix it next sprint" — fix it before declaring complete.

---

## 10. Order of execution (strict)

```
1 ──▶ 2
1 ──▶ 3 ──▶ 4 ──▶ 5 ──▶ 6 ──▶ 7
```

- Slice 1 unblocks Slices 2 and 3 in parallel.
- Slices 2 and 3 are commit-independent (no shared files), but they're committed in order to keep the topological sort linear and reviewable.
- Slice 4 depends on Slice 3.
- Slice 5 depends on Slice 4.
- Slice 6 depends on Slice 5 (your-listing tag must be in place before the marketplace page is removed — otherwise users with active listings briefly lose visibility).
- Slice 7 depends on Slice 6.

**No reordering.** No "let me just move 5 before 4 because it's smaller." No batching slices into one commit. Each slice is one commit, in this order.

---

## 11. Cadence

For each slice:

1. **Propose** — branch from `master`, audit the touched files, write the commit message and diff plan, present to user.
2. **Approve** — user reviews, locks (any changes go in via a re-propose).
3. **Apply** — make the edits.
4. **Verify** — run `pnpm tsc --noEmit` and `pnpm build`. Run the slice's smoke check.
5. **Commit** — single commit with the standard footer. Do NOT push to remote until the user requests.
6. **Confirm done** — report what was done, what was verified, and which slice is next.

This matches Steps 7.1–7.5 (V2 secondary frontend) and the user's `feedback_propose_approve.md` rhythm.

---

## 12. Out of scope

Explicitly NOT in this arc:

- `Toast.tsx` cluster hardcode — already addressed in Step 7.5.
- Mainnet copy in `StatementHeader.tsx`.
- Mobile-specific chain layout improvements.
- `BuyModal` modal-from-AppNav stale-list bug (HANDOFF §7).
- Split fills (vault + resale in one transaction).
- Per-listing deep links (`/trade?listing=<pda>`).
- "You own N of these — list some" affordance in the expanded panel.
- IV/Greek columns on the chain.
- Aggregated "Markets → Trade" deep-link grammar changes.
- Portfolio-side changes of any kind.
- Write-page changes of any kind.
- Docs section for the merged surface.
- Any on-chain handler modifications.

If a slice's smoke surfaces an out-of-scope bug, file a follow-up note. Don't expand the slice.

---

## 13. Reference: file map after the arc

```
app/src/pages/trade/
├── BuyModal.tsx              (heavily edited, Slice 4 + 5)
├── ExpiryTabs.tsx            (untouched)
├── MarketContextStrip.tsx    (untouched)
├── OfferingsPanel.tsx        (NEW — Slice 3)
├── OptionsChain.tsx          (edited, Slices 2 + 5)
├── TradeFooter.tsx           (untouched)
├── TradePage.tsx             (lightly edited, Slice 4 — buyTarget shape)
├── TradeStatementHeader.tsx  (untouched)
├── index.ts                  (lightly edited if exports added)
├── useResaleBuyFlow.ts       (LIFTED from marketplace — Slice 4)
├── usePurchaseFlow.ts        (untouched)
└── useTradeData.ts           (heavily edited, Slices 1 + 5)

app/src/pages/marketplace/    (DELETED — Slice 6)

app/src/components/
└── AppNav.tsx                (one line removed — Slice 6)

app/src/App.tsx               (route → Navigate; comment block updated — Slice 6)

app/src/pages/portfolio/      (untouched — locked decision)
app/src/pages/write/          (untouched)
```

---

## 14. Handoff checklist (for each slice's executor)

When picking up a slice mid-stream:

- [ ] Re-read this plan's slice section in full.
- [ ] Re-read the design doc (chat transcript 2026-05-02) for the relevant question.
- [ ] Verify the previous slice's commit is on `master` (or whatever working branch).
- [ ] Run `pnpm tsc --noEmit` from `app/` — confirm baseline clean.
- [ ] Run `pnpm build` from `app/` — confirm baseline clean (3 pre-existing warnings expected).
- [ ] Branch / worktree per the user's working norm.
- [ ] Make the edits described.
- [ ] Run the slice's smoke check.
- [ ] Run typecheck + build again.
- [ ] Commit with the slice's title.
- [ ] Report.

---

**End of plan.**
