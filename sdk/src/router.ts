// =============================================================================
// sdk/src/router.ts — Matching router for aggregated vault fills
// =============================================================================
//
// The router is a FRONTEND/SDK function, not an on-chain instruction. It:
//   1. Fetches all SharedVaults for a given asset + option type
//   2. Filters by strike range, expiry, and settlement status
//   3. Sorts by best price (lowest premium per contract)
//   4. Greedily fills from the cheapest vault first
//   5. Returns a FillPlan the caller uses to build purchase transactions
//
// The caller then builds a transaction with one `purchase_from_vault` instruction
// per vault in the fill plan. Multiple fills can be batched in a single tx
// (up to Solana's account limit of ~64).
// =============================================================================

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";

// =============================================================================
// Types
// =============================================================================

/** A single fill from one vault — how many contracts and at what price. */
export interface VaultFill {
  /** The SharedVault pubkey to purchase from. */
  vault: PublicKey;
  /** The VaultMint record pubkey (for the specific mint within this vault). */
  vaultMintRecord: PublicKey;
  /** The Token-2022 option mint pubkey. */
  optionMint: PublicKey;
  /** How many contracts to fill from this vault. */
  quantity: number;
  /** Premium per contract in USDC (6 decimals). */
  premiumPerContract: number;
  /** This vault's strike price in USDC (6 decimals). */
  strike: number;
  /** Total premium for this fill (quantity * premiumPerContract). */
  totalPremium: number;
}

/** The router's output — a complete fill plan for a buyer's order. */
export interface FillPlan {
  /** Ordered list of fills, cheapest first. */
  fills: VaultFill[];
  /** Total premium across all fills (sum of each fill's totalPremium). */
  totalPremium: number;
  /** Total contracts the buyer will receive. */
  totalQuantity: number;
  /** Whether the full desired quantity was filled. */
  fullyFilled: boolean;
}

/** Input parameters for the route_fill function. */
export interface RouteFillParams {
  /** The asset name (e.g., "SOL", "BTC"). */
  asset: string;
  /** "call" or "put". */
  optionType: "call" | "put";
  /** Minimum acceptable strike price in USDC (6 decimals). */
  minStrike: number;
  /** Maximum acceptable strike price in USDC (6 decimals). */
  maxStrike: number;
  /** Desired number of contracts. */
  desiredQuantity: number;
  /** Maximum total premium the buyer is willing to pay (USDC, 6 decimals). */
  maxTotalPremium: number;
}

/** Fetched vault data from on-chain accounts. */
interface VaultData {
  pubkey: PublicKey;
  strikePrice: number;
  expiry: number;
  isSettled: boolean;
  optionType: { call: {} } | { put: {} };
  market: PublicKey;
  totalOptionsMinted: number;
  totalOptionsSold: number;
}

/** Fetched mint record data from on-chain accounts. */
interface MintData {
  pubkey: PublicKey;
  vault: PublicKey;
  optionMint: PublicKey;
  premiumPerContract: number;
  quantityMinted: number;
  quantitySold: number;
}

// =============================================================================
// Router
// =============================================================================

/**
 * Build an optimal fill plan across multiple shared vaults.
 *
 * This function:
 *   1. Fetches all SharedVaults matching the asset + option type
 *   2. Fetches all VaultMint records for those vaults
 *   3. Filters: in strike range, not expired, not settled, has available supply
 *   4. Sorts by premium (cheapest first)
 *   5. Greedily fills from cheapest to most expensive
 *
 * Returns a FillPlan that the caller can use to build purchase_from_vault
 * instructions for a single transaction.
 *
 * @param connection - Solana RPC connection
 * @param program - Anchor program instance for butter_options
 * @param params - Fill parameters (asset, type, strike range, quantity, max premium)
 * @returns FillPlan with optimal fills sorted by price
 */
export async function routeFill(
  connection: Connection,
  program: Program,
  params: RouteFillParams,
): Promise<FillPlan> {
  const {
    asset,
    optionType,
    minStrike,
    maxStrike,
    desiredQuantity,
    maxTotalPremium,
  } = params;

  // =========================================================================
  // Step 1: Fetch all SharedVaults
  // =========================================================================
  const allVaults = await program.account.sharedVault.all();
  const now = Math.floor(Date.now() / 1000);

  // =========================================================================
  // Step 2: Filter vaults by criteria
  // =========================================================================
  const optionTypeKey = optionType === "call" ? "call" : "put";
  const eligibleVaults: VaultData[] = allVaults
    .filter((v) => {
      const data = v.account as any;
      return (
        // Not settled
        !data.isSettled &&
        // Not expired
        data.expiry.toNumber() > now &&
        // Correct option type
        data.optionType[optionTypeKey] !== undefined &&
        // Within strike range
        data.strikePrice.toNumber() >= minStrike &&
        data.strikePrice.toNumber() <= maxStrike
      );
    })
    .map((v) => ({
      pubkey: v.publicKey,
      strikePrice: (v.account as any).strikePrice.toNumber(),
      expiry: (v.account as any).expiry.toNumber(),
      isSettled: (v.account as any).isSettled,
      optionType: (v.account as any).optionType,
      market: (v.account as any).market,
      totalOptionsMinted: (v.account as any).totalOptionsMinted.toNumber(),
      totalOptionsSold: (v.account as any).totalOptionsSold.toNumber(),
    }));

  if (eligibleVaults.length === 0) {
    return { fills: [], totalPremium: 0, totalQuantity: 0, fullyFilled: false };
  }

  // =========================================================================
  // Step 3: Fetch all VaultMint records for eligible vaults
  // =========================================================================
  const vaultPubkeys = new Set(eligibleVaults.map((v) => v.pubkey.toBase58()));
  const allMintRecords = await program.account.vaultMint.all();

  const eligibleMints: MintData[] = allMintRecords
    .filter((m) => {
      const data = m.account as any;
      const available = data.quantityMinted.toNumber() - data.quantitySold.toNumber();
      return vaultPubkeys.has(data.vault.toBase58()) && available > 0;
    })
    .map((m) => ({
      pubkey: m.publicKey,
      vault: (m.account as any).vault,
      optionMint: (m.account as any).optionMint,
      premiumPerContract: (m.account as any).premiumPerContract.toNumber(),
      quantityMinted: (m.account as any).quantityMinted.toNumber(),
      quantitySold: (m.account as any).quantitySold.toNumber(),
    }));

  // =========================================================================
  // Step 4: Sort by premium (cheapest first)
  // =========================================================================
  eligibleMints.sort((a, b) => a.premiumPerContract - b.premiumPerContract);

  // =========================================================================
  // Step 5: Greedy fill from cheapest to most expensive
  // =========================================================================
  const fills: VaultFill[] = [];
  let remainingQuantity = desiredQuantity;
  let runningPremium = 0;

  for (const mint of eligibleMints) {
    if (remainingQuantity <= 0) break;

    const available = mint.quantityMinted - mint.quantitySold;
    const fillQuantity = Math.min(available, remainingQuantity);
    const fillPremium = fillQuantity * mint.premiumPerContract;

    // Check if adding this fill would exceed the buyer's max premium
    if (runningPremium + fillPremium > maxTotalPremium) {
      // See if we can partially fill within the budget
      const budgetRemaining = maxTotalPremium - runningPremium;
      const affordableQuantity = Math.floor(budgetRemaining / mint.premiumPerContract);
      if (affordableQuantity > 0) {
        const partialPremium = affordableQuantity * mint.premiumPerContract;
        fills.push({
          vault: mint.vault,
          vaultMintRecord: mint.pubkey,
          optionMint: mint.optionMint,
          quantity: affordableQuantity,
          premiumPerContract: mint.premiumPerContract,
          strike: eligibleVaults.find(
            (v) => v.pubkey.toBase58() === mint.vault.toBase58(),
          )!.strikePrice,
          totalPremium: partialPremium,
        });
        remainingQuantity -= affordableQuantity;
        runningPremium += partialPremium;
      }
      break; // Budget exhausted
    }

    fills.push({
      vault: mint.vault,
      vaultMintRecord: mint.pubkey,
      optionMint: mint.optionMint,
      quantity: fillQuantity,
      premiumPerContract: mint.premiumPerContract,
      strike: eligibleVaults.find(
        (v) => v.pubkey.toBase58() === mint.vault.toBase58(),
      )!.strikePrice,
      totalPremium: fillPremium,
    });

    remainingQuantity -= fillQuantity;
    runningPremium += fillPremium;
  }

  return {
    fills,
    totalPremium: runningPremium,
    totalQuantity: desiredQuantity - remainingQuantity,
    fullyFilled: remainingQuantity === 0,
  };
}
