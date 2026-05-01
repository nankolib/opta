import type { PublicKey } from "@solana/web3.js";
import {
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { usdcToNumber } from "../../utils/format";

export type PositionState =
  | "active"
  | "settled-itm"
  | "settled-otm"
  | "expired-unsettled";

export type PositionAction =
  | "exercise"
  | "list-resale"
  | "cancel-resale"
  | "burn"
  | "none";

interface PositionAccount {
  publicKey: PublicKey;
  account: any;
}
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

export type PositionSource =
  | { kind: "v1"; position: PositionAccount; market: any }
  | {
      kind: "v2";
      vault: VaultAccount;
      vaultMint: VaultMintAccount;
      market: any | null;
    };

export type Position = {
  /** Stable id — option-mint base58. Unique across both v1 and v2 because each holds its own SPL mint. */
  id: string;
  source: PositionSource;
  asset: string;
  side: "call" | "put";
  strike: number;
  expiry: number;
  contracts: number;
  totalSupply: number;
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
  v1Held: PositionAccount[];
  v2Held: {
    vaultMint: VaultMintAccount;
    vault: VaultAccount;
    balance: number;
    market: any | null;
  }[];
  heldBalances: Map<string, number>;
  marketMap: Map<string, any>;
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
};

/**
 * Collapse v1 (P2P) and v2 (vault) buyer-side holdings into a single
 * Position[] array shaped for the new positions table.
 *
 * Centralises the cost-basis (proportional premium), current-value
 * (B-S for active, intrinsic for settled-ITM, $0 for settled-OTM),
 * and state-machine derivation that previously lived inline in the
 * Stage 1 PortfolioPage summary memo and the legacy V2TokenHoldings
 * component.
 */
export function buildPositions(args: BuildPositionsArgs): Position[] {
  // v1Held / heldBalances / marketMap params retained for cascade
  // prevention — PortfolioPage still computes and passes them. v1 path
  // retired in P4a; v2 path reads balances and market straight off each
  // v2Held entry. Full type cleanup deferred to P4e.
  const { v2Held, spotPrices, metadataSymbolByMint, listings = [] } = args;
  void args.v1Held;
  void args.heldBalances;
  void args.marketMap;
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
    const strike = usdcToNumber(v.strikePrice);
    const expiry = typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber();
    const isSettled = !!v.isSettled;
    const isPastExpiry = expiry <= now;

    const totalSupply = vaultMint.account.totalSupply?.toNumber?.() || 1;
    const premium = usdcToNumber(vaultMint.account.premium ?? 0);
    const costBasis = premium * (balance / totalSupply);

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

    result.push({
      id: mintKey,
      source: { kind: "v2", vault, vaultMint, market },
      asset: assetName || "?",
      side: isCall ? "call" : "put",
      strike,
      expiry,
      contracts: balance,
      totalSupply,
      costBasis,
      currentValue,
      pnl,
      pnlPercent,
      state,
      isListedForResale,
      action: deriveAction(state, isListedForResale, "v2"),
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
  kind: "v1" | "v2",
): PositionAction {
  if (state === "settled-itm") return "exercise";
  if (state === "settled-otm") return "burn";
  if (state === "expired-unsettled") return "none";
  // active
  if (kind === "v2") return isListedForResale ? "cancel-resale" : "list-resale";
  return isListedForResale ? "cancel-resale" : "list-resale";
}
