import type { PublicKey } from "@solana/web3.js";
import {
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { usdcToNumber } from "../../utils/format";
import { AMERICAN_ENABLED_UI } from "../../utils/constants";
import {
  earlyExerciseAvailability,
  type PotFundingView,
} from "../../utils/earlyExerciseAvailability";

export type PositionState =
  | "active"
  | "settled-itm"
  | "settled-otm"
  | "expired-unsettled";

export type PositionAction =
  | "exercise"
  | "exercise-american"
  | "list-resale"
  | "cancel-resale"
  | "burn"
  | "none";

interface VaultAccount {
  publicKey: PublicKey;
  account: any;
}
interface VaultMintAccount {
  publicKey: PublicKey;
  account: any;
}
interface ResaleListingAccount {
  publicKey: PublicKey;
  account: any;
}

export type PositionSource = {
  kind: "v2";
  vault: VaultAccount;
  vaultMint: VaultMintAccount;
  market: any | null;
};

export type Position = {
  /** Stable id — option-mint base58. Unique across both v1 and v2 because each holds its own SPL mint. */
  id: string;
  source: PositionSource;
  /**
   * Vault PDA — drives the Solscan icon link target on each row.
   */
  vaultPda: PublicKey;
  asset: string;
  side: "call" | "put";
  /** Vault exercise style — drives the EUR/AMER badge. Defaults european. */
  exerciseStyle: "european" | "american";
  /**
   * Set when the row's action is offered but cannot currently succeed, with the
   * sentence to show instead. Today's only case is early exercise on a vault
   * whose collateral has not been swept in yet — see earlyExerciseAvailability.
   * `null` means the action is live.
   */
  blockedReason?: string | null;
  /**
   * The series has a writer-ask pot (present in `potByMint`). Early exercise on
   * a first-party-oracle market must then carry the pot accounts, or the program
   * reverts 6084 whenever the vault alone cannot cover the payout.
   */
  hasWriterAskPot: boolean;
  strike: number;
  expiry: number;
  contracts: number;
  costBasis: number;
  currentValue: number;
  pnl: number;
  pnlPercent: number;
  state: PositionState;
  isListedForResale: boolean;
  action: PositionAction;
};

const KNOWN_ASSETS = new Set([
  "SOL",
  "BTC",
  "ETH",
  "AAPL",
  "XAU",
  "XAG",
  "WTI",
  "TSLA",
  "NVDA",
]);

/**
 * Parse a Token-2022 metadata symbol like "OPTA-SOL-100C-APR24" → "SOL".
 * Mirrors V2TokenHoldings's fallback for v2 mints whose market PDA isn't
 * reachable through marketMap (e.g. dropped by safeFetchAll's strict
 * validator). Filters against a known-asset allowlist so we don't render
 * garbage tickers if a metadata symbol drifts.
 */
export function tickerFromMetadataSymbol(symbol: string | undefined): string | null {
  if (!symbol) return null;
  const candidate = symbol.split("-")[1];
  return candidate && KNOWN_ASSETS.has(candidate) ? candidate : null;
}

type BuildPositionsArgs = {
  v2Held: {
    vaultMint: VaultMintAccount;
    vault: VaultAccount;
    balance: number;
    market: any | null;
  }[];
  spotPrices: Record<string, number>;
  metadataSymbolByMint?: Map<string, string>;
  /**
   * Active V2 secondary listings owned by the connected wallet.
   * Caller (PortfolioPage) must filter to `seller === connected wallet`
   * before passing in — buildPositions assumes at most one entry per mint.
   * Optional with a default of [] so the existing call site keeps compiling
   * during Stage Secondary 7.2 wiring; Slice B threads the real fetch in.
   */
  listings?: ResaleListingAccount[];
  /**
   * Writer-ask collateral pots, keyed by CANONICAL series mint (base58).
   *
   * Load-bearing for the early-exercise gate, not cosmetic. On a series whose
   * collateral came from writer asks the vault's own USDC account is $0 and all
   * the money sits in the pot, so a row judged on vault fields alone looks
   * unfunded and renders the "cannot exercise yet" copy over a fully funded
   * position. earlyExerciseAvailability distinguishes "pot is empty" from "pot
   * was never looked up" and stays conservative on the latter — so omitting this
   * map is indistinguishable from a genuinely unfunded series. Pass it.
   *
   * Optional only so a caller mid-wiring still compiles; every real call site
   * supplies it.
   */
  potByMint?: Map<string, PotFundingView>;
};

/**
 * Build the V2 buyer-side Position[] array for the positions table.
 *
 * Centralises the cost-basis (proportional premium), current-value
 * (B-S for active, intrinsic for settled-ITM, $0 for settled-OTM),
 * and state-machine derivation in one place.
 */
export function buildPositions(args: BuildPositionsArgs): Position[] {
  const { v2Held, spotPrices, metadataSymbolByMint, listings = [], potByMint } = args;
  const now = Math.floor(Date.now() / 1000);
  const result: Position[] = [];

  // Map option_mint base58 → listing PDA + payload, used to flip each V2
  // position's isListedForResale flag and to thread cancel-resale dispatch
  // off the same row. Caller pre-filters listings to seller === wallet, so
  // at most one entry per mint exists in this map (the on-chain PDA seed
  // [VAULT_RESALE_LISTING_SEED, mint, seller] guarantees uniqueness too).
  const listingByMint = new Map<string, ResaleListingAccount>();
  for (const l of listings) {
    listingByMint.set((l.account.optionMint as PublicKey).toBase58(), l);
  }

  // ---- V2 (shared vault) ----
  for (const { vaultMint, vault, balance, market } of v2Held) {
    if (balance <= 0) continue;
    const v = vault.account;
    const isCall = "call" in v.optionType;
    // ExerciseStyle is an Anchor enum decoded as { european: {} } | { american: {} }.
    // Same shape-check pattern as optionType above. Guard for undefined so a
    // legacy/unmigrated vault that slips through decode defaults to european.
    const exerciseStyle: "european" | "american" =
      v.exerciseStyle && "american" in v.exerciseStyle ? "american" : "european";
    const strike = usdcToNumber(v.strikePrice);
    const expiry = typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber();
    const isSettled = !!v.isSettled;
    const isPastExpiry = expiry <= now;

    // HIGH-2 (audit Run-7): source canonical IDL fields. Pre-fix this read
    // non-existent .totalSupply / .premium on VaultMint, silently zeroing
    // costBasis on every row. premiumPerContract × balance is the buyer's
    // dollar cost basis — premiumPerContract is fixed for a VaultMint's
    // lifetime per purchase_from_vault.rs:60-62.
    const premiumPerContract = usdcToNumber(vaultMint.account.premiumPerContract ?? 0);
    const costBasis = premiumPerContract * balance;

    let assetName: string = market?.assetName ?? "";
    if (!assetName && metadataSymbolByMint) {
      const symbol = metadataSymbolByMint.get(
        (vaultMint.account.optionMint as PublicKey).toBase58(),
      );
      assetName = tickerFromMetadataSymbol(symbol) ?? "";
    }

    const { state, currentValue } = computeStateAndValue({
      isSettled,
      isPastExpiry,
      strike,
      isCall,
      balance,
      settlementPrice: isSettled ? usdcToNumber(v.settlementPrice) : null,
      spot: assetName ? spotPrices[assetName] : 0,
      expirySeconds: expiry,
      now,
      assetName,
    });

    const pnl = currentValue - costBasis;
    const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

    const mintKey = (vaultMint.account.optionMint as PublicKey).toBase58();
    const isListedForResale = listingByMint.has(mintKey);

    // Current-spot intrinsic check, for American early-exercise gating.
    // Buyer ITM: CALL spot > strike, PUT strike > spot.
    const spotNow = assetName ? spotPrices[assetName] ?? 0 : 0;
    const isItm = spotNow > 0 && (isCall ? spotNow > strike : strike > spotNow);

    const derivedAction = deriveAction(
      state, isListedForResale, exerciseStyle === "american", isItm,
    );
    // Offered-but-impossible actions get a reason rather than a wallet popup.
    // Only early exercise can be in that state today.
    // The pot is the SECOND funding source and must be passed explicitly — an
    // omitted pot means "not looked up", not "no pot", and the gate then blocks
    // a funded position. `?? null` is deliberate: a loader that supplied the map
    // but found no pot for this mint is a real negative, not an unknown.
    const availability =
      derivedAction === "exercise-american"
        ? earlyExerciseAvailability(
            vault.account as any,
            potByMint ? potByMint.get(mintKey) ?? null : undefined,
          )
        : { available: true as const };

    result.push({
      id: mintKey,
      source: { kind: "v2", vault, vaultMint, market },
      blockedReason: availability.available ? null : availability.reason,
      hasWriterAskPot: potByMint?.has(mintKey) ?? false,
      vaultPda: vault.publicKey,
      asset: assetName || "?",
      side: isCall ? "call" : "put",
      exerciseStyle,
      strike,
      expiry,
      contracts: balance,
      costBasis,
      currentValue,
      pnl,
      pnlPercent,
      state,
      isListedForResale,
      action: derivedAction,
    });
  }

  return result;
}

function computeStateAndValue(args: {
  isSettled: boolean;
  isPastExpiry: boolean;
  strike: number;
  isCall: boolean;
  balance: number;
  settlementPrice: number | null;
  spot: number | undefined;
  expirySeconds: number;
  now: number;
  assetName: string;
}): { state: PositionState; currentValue: number } {
  const {
    isSettled,
    isPastExpiry,
    strike,
    isCall,
    balance,
    settlementPrice,
    spot,
    expirySeconds,
    now,
    assetName,
  } = args;

  if (isSettled) {
    const sp = settlementPrice ?? 0;
    const intrinsic = isCall ? Math.max(0, sp - strike) : Math.max(0, strike - sp);
    const value = intrinsic * balance;
    return {
      state: intrinsic > 0 ? "settled-itm" : "settled-otm",
      currentValue: value,
    };
  }

  if (isPastExpiry) {
    return { state: "expired-unsettled", currentValue: 0 };
  }

  // active — current value via Black-Scholes; skip if Pyth feed is missing
  // (better undercount than mislead).
  if (!spot || spot <= 0 || !assetName) {
    return { state: "active", currentValue: 0 };
  }
  const days = Math.max(0, (expirySeconds - now) / 86400);
  const vol = getDefaultVolatility(assetName);
  const fair = isCall
    ? calculateCallPremium(spot, strike, days, vol)
    : calculatePutPremium(spot, strike, days, vol);
  return { state: "active", currentValue: fair * balance };
}

function deriveAction(
  state: PositionState,
  isListedForResale: boolean,
  isAmerican: boolean,
  isItm: boolean,
): PositionAction {
  // American early-exercise: holder can exercise an ITM American option BEFORE
  // expiry (state still "active"). Gated behind AMERICAN_ENABLED_UI so the
  // affordance is dark until the Stage I pair-flip — until then American
  // active positions fall through to the resale path like European ones.
  if (AMERICAN_ENABLED_UI && isAmerican && state === "active" && isItm) {
    return "exercise-american";
  }
  if (state === "settled-itm") return "exercise";
  if (state === "settled-otm") return "burn";
  if (state === "expired-unsettled") return "none";
  return isListedForResale ? "cancel-resale" : "list-resale";
}
