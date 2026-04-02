# Frontend Handoff — For Designers

Hi! This doc explains how the Butter Options frontend is set up so you can make design changes without breaking anything.

## How to Run It

Open a terminal (PowerShell on Windows) and run:

```
cd app
npm install
npm run dev
```

Then open **http://localhost:5173** in your browser. The page auto-refreshes when you save changes.

## Where Things Are

### Pages (the main screens)

All pages are in `app/src/pages/`. Each file is one screen:

| File | What it is | Route |
|------|-----------|-------|
| `Landing.tsx` | Home page — hero section, feature cards, how-it-works | `/` |
| `Markets.tsx` | Table of all option markets | `/markets` |
| `Trade.tsx` | Write and buy options (two panels) | `/trade` |
| `Portfolio.tsx` | Your positions — written and bought tabs | `/portfolio` |

### Shared Components

In `app/src/components/`:

| File | What it is |
|------|-----------|
| `Header.tsx` | Top navigation bar — logo, nav links, wallet button |
| `Toast.tsx` | Pop-up notifications (success/error messages) |

### Where to Change Text & Copy

- **Landing page headline, subtitle, feature descriptions** → `app/src/pages/Landing.tsx`
- **Navigation links** → `app/src/components/Header.tsx`
- **Page titles and descriptions** → Each page file in `app/src/pages/`

Just search for the text you want to change — it's all inline in the components.

## Colors & Theme

All colors are defined in one place: `app/src/index.css`

Here's the color palette:

| Name | Hex | Used for |
|------|-----|----------|
| Background | `#0A0A0B` | Main page background (near-black) |
| Surface | `#141416` | Card backgrounds (charcoal) |
| Border | `#1E1E22` | Subtle borders |
| **Gold** | `#D4A843` | Brand accent — buttons, highlights, logo |
| Green | `#14F195` | Solana green — Call options, profit, success |
| Purple | `#9945FF` | Solana purple — Put options, devnet badge |
| Red | `#EF4444` | Loss, errors |
| Text Primary | `#F5F5F5` | Main text (almost white) |
| Text Secondary | `#9CA3AF` | Descriptions, labels |
| Text Muted | `#6B7280` | Dimmed text, timestamps |

To change a color, edit the `@theme` section at the top of `app/src/index.css`.

## Font

The app uses **Inter** from Google Fonts. It's loaded in `app/index.html`. To change the font, edit the Google Fonts link there and update the `font-family` in `app/src/index.css`.

## Styling

We use **Tailwind CSS** — styles are written directly in the HTML as class names (like `className="text-gold bg-bg-surface rounded-xl"`). You don't need a separate CSS file.

Quick Tailwind guide for designers:
- `text-gold` → gold text color
- `bg-bg-surface` → charcoal background
- `rounded-xl` → rounded corners
- `p-6` → padding
- `mb-4` → margin bottom
- `text-sm` → small text
- `font-semibold` → semi-bold weight

## What NOT to Touch

These folders contain smart contract code and blockchain logic. Changing them can break the entire app:

- **`programs/`** — The Solana smart contract (Rust code)
- **`tests/`** — Smart contract tests
- **`scripts/`** — Deployment scripts
- **`sdk/`** — TypeScript SDK
- **`app/src/hooks/`** — Blockchain connection logic
- **`app/src/utils/`** — Pricing calculations and data formatting
- **`app/src/idl/`** — Auto-generated blockchain interface (never edit manually)
- **`app/src/contexts/`** — Wallet connection setup

**Safe to edit:**
- `app/src/pages/` — Page layouts and content
- `app/src/components/` — Shared UI components
- `app/src/index.css` — Colors and global styles
- `app/index.html` — Page title, fonts, meta tags
- `app/public/` — Favicon and static assets

## Page Descriptions

### Landing Page (`/`)
The first thing hackathon judges see. Dark background with subtle gold and purple glow effects. Features:
- "Live on Solana Devnet" badge at top
- Big headline: "The Composable Options Primitive for Solana"
- Connect Wallet button (gold, prominent)
- Three feature cards with icons
- Supported assets strip (SOL, BTC, ETH, Gold, Oil)
- Three-step "How It Works" section
- Footer with hackathon branding

### Markets Page (`/markets`)
A data table showing all option markets. Has filter tabs at the top (All, SOL, BTC, etc.) and a "Create Market" button. Each row shows: asset name, call/put badge, strike price, expiry date, and status (Active/Expired/Settled).

### Trade Page (`/trade`)
Split into two panels side by side:
- **Left (gold accent):** "Write Option" form — dropdown to pick a market, inputs for collateral/premium/size
- **Right (green accent):** "Available Options" — cards showing options for sale with a Buy button on each. Shows the Black-Scholes fair price estimate.

### Portfolio Page (`/portfolio`)
Two tabs:
- **Written (gold tab):** Options you sold — shows status, collateral, premium. Cancel button for unsold ones.
- **Bought (green tab):** Options you purchased — shows PnL in green (profit) or red (loss). Exercise button for expired options.

## Questions?

Ask the dev team (or Claude Code) — they can explain any component in detail.
