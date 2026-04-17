// Shared filter utilities so all pages (Markets, Trade, Write, Portfolio) stay in sync.
import { PublicKey } from "@solana/web3.js";
import { isEpochVault } from "../hooks/useVaults";

type VaultAcct = { publicKey: PublicKey; account: any };
type MarketAcct = { publicKey: PublicKey; account: any };

const assetOf = (m: MarketAcct): string => m.account.assetName ?? m.account.asset ?? "";

/** Set of market pubkeys that have at least one active (non-settled) vault. */
export function getActiveVaultMarketKeys(vaults: VaultAcct[]): Set<string> {
  const s = new Set<string>();
  for (const v of vaults) {
    if (v.account.isSettled) continue;
    s.add((v.account.market as PublicKey).toBase58());
  }
  return s;
}

/** Unique asset names (sorted) from markets that have active vaults. */
export function getVaultAssets(vaults: VaultAcct[], markets: MarketAcct[]): string[] {
  const vaultMarketKeys = getActiveVaultMarketKeys(vaults);
  const assets = new Set<string>();
  for (const m of markets) {
    if (vaultMarketKeys.has(m.publicKey.toBase58())) {
      const name = assetOf(m);
      if (name) assets.add(name);
    }
  }
  return Array.from(assets).sort();
}

/** Unique expiry timestamps (sorted) from active vaults for a specific asset. */
export function getVaultExpiries(vaults: VaultAcct[], markets: MarketAcct[], asset: string): number[] {
  const marketKeysForAsset = new Set(
    markets.filter((m) => assetOf(m) === asset).map((m) => m.publicKey.toBase58()),
  );
  const expiries = new Set<number>();
  for (const v of vaults) {
    if (v.account.isSettled) continue;
    if (!marketKeysForAsset.has((v.account.market as PublicKey).toBase58())) continue;
    const t = typeof v.account.expiry === "number" ? v.account.expiry : v.account.expiry.toNumber();
    expiries.add(t);
  }
  return Array.from(expiries).sort((a, b) => a - b);
}

interface FilterOptions {
  asset?: string;
  epochOnly?: boolean;
  customOnly?: boolean;
  activeOnly?: boolean;
}

/** Filter vaults by asset and/or type. */
export function filterVaults(
  vaults: VaultAcct[],
  markets: MarketAcct[],
  options: FilterOptions = {},
): VaultAcct[] {
  let filtered = vaults;

  if (options.activeOnly) {
    filtered = filtered.filter((v) => !v.account.isSettled);
  }
  if (options.epochOnly) {
    filtered = filtered.filter((v) => isEpochVault(v));
  }
  if (options.customOnly) {
    filtered = filtered.filter((v) => !isEpochVault(v));
  }
  if (options.asset) {
    const marketKeysForAsset = new Set(
      markets.filter((m) => assetOf(m) === options.asset).map((m) => m.publicKey.toBase58()),
    );
    filtered = filtered.filter((v) => marketKeysForAsset.has((v.account.market as PublicKey).toBase58()));
  }

  return filtered;
}
