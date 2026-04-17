import { useEffect, useState, useCallback, useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "./useProgram";
import { safeFetchAll } from "./useFetchAccounts";
import { USE_V2_VAULTS } from "../utils/constants";

// Precision multiplier matching Rust's 1e12 for premium_per_share_cumulative
const PRECISION = new BN("1000000000000");

/**
 * Detect if a vault is an Epoch vault. Handles all possible Anchor enum serialization formats:
 *   - object with lowercase key: { epoch: {} }
 *   - object with PascalCase key: { Epoch: {} }
 *   - numeric discriminator: 0 (Epoch is first variant)
 *   - string: "epoch" / "Epoch"
 * Exported so other modules can use the same check.
 */
export function isEpochVault(vault: any): boolean {
  const vt = vault?.account?.vaultType ?? vault?.vaultType;
  if (!vt) return false;
  if (typeof vt === "object") {
    return "epoch" in vt || "Epoch" in vt;
  }
  if (typeof vt === "number") return vt === 0;
  if (typeof vt === "string") return vt.toLowerCase() === "epoch";
  return false;
}

export function isCustomVault(vault: any): boolean {
  const vt = vault?.account?.vaultType ?? vault?.vaultType;
  if (!vt) return false;
  return !isEpochVault(vault);
}

interface VaultAccount {
  publicKey: PublicKey;
  account: any;
}

/**
 * Hook providing convenient access to v2 shared vault data.
 *
 * Fetches SharedVault, WriterPosition, VaultMint, and EpochConfig accounts
 * and provides helpers for common lookups and calculations.
 */
export function useVaults() {
  const { program } = useProgram();
  const { publicKey } = useWallet();

  const [vaults, setVaults] = useState<VaultAccount[]>([]);
  const [writerPositions, setWriterPositions] = useState<VaultAccount[]>([]);
  const [vaultMints, setVaultMints] = useState<VaultAccount[]>([]);
  const [epochConfig, setEpochConfig] = useState<VaultAccount | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!program || !USE_V2_VAULTS) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const [sv, wp, vm, ec] = await Promise.all([
        safeFetchAll(program, "sharedVault"),
        safeFetchAll(program, "writerPosition"),
        safeFetchAll(program, "vaultMint"),
        safeFetchAll(program, "epochConfig"),
      ]);
      setVaults(sv);
      setWriterPositions(wp);
      setVaultMints(vm);
      setEpochConfig(ec.length > 0 ? ec[0] : null);
    } catch (err) {
      console.error("Failed to fetch vault accounts:", err);
    } finally {
      setIsLoading(false);
    }
  }, [program]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Current wallet's writer positions
  const myPositions = useMemo(() => {
    if (!publicKey) return [];
    return writerPositions.filter(
      (wp) => (wp.account.owner as PublicKey).equals(publicKey),
    );
  }, [writerPositions, publicKey]);

  // Helper: get all vaults for a specific market
  const getVaultsForMarket = useCallback(
    (marketKey: PublicKey) =>
      vaults.filter((v) => (v.account.market as PublicKey).equals(marketKey)),
    [vaults],
  );

  // Helper: get current wallet's position in a specific vault
  const getMyPosition = useCallback(
    (vaultKey: PublicKey) =>
      myPositions.find((wp) =>
        (wp.account.vault as PublicKey).equals(vaultKey),
      ) ?? null,
    [myPositions],
  );

  // Helper: get all mints for a specific vault
  const getMintsForVault = useCallback(
    (vaultKey: PublicKey) =>
      vaultMints.filter((vm) =>
        (vm.account.vault as PublicKey).equals(vaultKey),
      ),
    [vaultMints],
  );

  // Helper: is this vault an epoch vault? Wraps the robust exported helper.
  const isEpochVaultHelper = useCallback(
    (vault: any) => isEpochVault(vault.account ? vault : { account: vault }),
    [],
  );

  // Helper: calculate unclaimed premium for a writer position.
  // Matches Rust claim_premium.rs exactly:
  //   total_earned = (shares * cumulative) / 1e12
  //   earned_since_deposit = total_earned - debt  (clamped to 0)
  //   claimable = earned_since_deposit - claimed  (clamped to 0)
  const getUnclaimedPremium = useCallback(
    (vault: any, position: any): BN => {
      const cumulative = new BN(vault.premiumPerShareCumulative.toString());
      const shares = new BN(position.shares.toString());
      const debt = new BN(position.premiumDebt.toString());
      const claimed = new BN(position.premiumClaimed.toString());
      const totalEarned = shares.mul(cumulative).div(PRECISION);
      const earnedSinceDeposit = BN.max(totalEarned.sub(debt), new BN(0));
      return BN.max(earnedSinceDeposit.sub(claimed), new BN(0));
    },
    [],
  );

  return {
    vaults,
    myPositions,
    vaultMints,
    epochConfig,
    isLoading,
    refetch,
    getVaultsForMarket,
    getMyPosition,
    getMintsForVault,
    isEpochVault: isEpochVaultHelper,
    getUnclaimedPremium,
  };
}
