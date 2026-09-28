// =============================================================================
// chain/layouts.ts — full-struct decoders for the FE read path
// =============================================================================
//
// WHY FULL-STRUCT, NOT DISPLAY-FIELDS
//
//   The obvious design is "store the handful of fields the chain view shows".
//   It is wrong, and the measurement says so: the trade path reads
//   `exercised_options` (ends at byte 249) and `writer_ask_collateral_swept`
//   (ends at byte 268) of a 276-byte SharedVault. A display-field schema fails
//   the moment the ticket or the early-exercise gate reads one that was left
//   out — and it fails as a MISSING FIELD that renders as a plausible wrong
//   number, not as an error. So every field is decoded and stored.
//
//   This is the same measurement that killed dataSlice on the client: a prefix
//   slice covering what the FE reads saves 8 bytes of 276 (2.9%).
//
// LAYOUT DRIFT IS REAL
//
//   SharedVault has been 260 -> 268 -> 276 bytes. Accounts of the older sizes
//   still exist on devnet and share the discriminator, so a decoder that trusts
//   the discriminator alone reads garbage that looks like data. Every decoder
//   here is EXACT-LENGTH GATED: an account whose length is not a size this
//   decoder understands is REJECTED, never partially parsed.
//
//   Rejection is reported, never swallowed — see the NEVER SILENT policy in
//   tape/marketsRefresh.ts, which this carries over verbatim.
// =============================================================================

import { createHash } from "node:crypto";
import bs58 from "bs58";

export function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

export function discriminatorBase58(name: string): string {
  return bs58.encode(accountDiscriminator(name));
}

/** Pubkeys are stored base58 — the form every consumer actually uses. */
const pk = (b: Buffer, o: number): string => bs58.encode(b.subarray(o, o + 32));

/** u64/i64/u128 exceed Number.MAX_SAFE_INTEGER. They are carried as STRINGS all
 *  the way to the client: a collateral figure silently losing precision at 2^53
 *  is the kind of wrong that looks right. */
const u64 = (b: Buffer, o: number): string => b.readBigUInt64LE(o).toString();
const i64 = (b: Buffer, o: number): string => b.readBigInt64LE(o).toString();
const u128 = (b: Buffer, o: number): string =>
  (b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n)).toString();

// ---------------------------------------------------------------------------
// SharedVault
// ---------------------------------------------------------------------------

/**
 * Byte offsets after the 8-byte discriminator, from
 * programs/opta/src/state/shared_vault.rs. Named constants rather than magic
 * numbers so a future field insertion is a visible diff on THIS table instead
 * of a silent shift of everything below it.
 */
export const SHARED_VAULT_OFFSETS = {
  market: 8,
  optionType: 40,
  strikePrice: 41,
  expiry: 49,
  vaultType: 57,
  totalCollateral: 58,
  totalShares: 66,
  vaultUsdcAccount: 74,
  collateralMint: 106,
  totalOptionsMinted: 138,
  totalOptionsSold: 146,
  netPremiumCollected: 154,
  premiumPerShareCumulative: 162,
  isSettled: 178,
  settlementPrice: 179,
  collateralRemaining: 187,
  creator: 195,
  createdAt: 227,
  bump: 235,
  carryRateBps: 236,
  exerciseStyle: 240,
  exercisedOptions: 241,
  earlyExercisePayout: 249,
  spreadBps: 257,
  voided: 259,
  writerAskCollateralSwept: 260,
  writerAskEquivShares: 268,
} as const;

/** The ONLY length this decoder accepts. 268 bytes of body + 8 discriminator. */
export const SHARED_VAULT_LEN = 276;

export interface SharedVaultRow {
  market: string;
  optionType: number;
  strikePrice: string;
  expiry: string;
  vaultType: number;
  totalCollateral: string;
  totalShares: string;
  vaultUsdcAccount: string;
  collateralMint: string;
  totalOptionsMinted: string;
  totalOptionsSold: string;
  netPremiumCollected: string;
  premiumPerShareCumulative: string;
  isSettled: boolean;
  settlementPrice: string;
  collateralRemaining: string;
  creator: string;
  createdAt: string;
  bump: number;
  carryRateBps: number;
  exerciseStyle: number;
  exercisedOptions: string;
  earlyExercisePayout: string;
  spreadBps: number;
  voided: boolean;
  writerAskCollateralSwept: string;
  writerAskEquivShares: string;
}

export function decodeSharedVault(b: Buffer): SharedVaultRow | null {
  // Exact-length gate. A 260- or 268-byte account is a PREVIOUS layout; its
  // fields sit at different offsets, so decoding it here would produce numbers
  // that are structurally valid and semantically nonsense.
  if (b.length !== SHARED_VAULT_LEN) return null;
  const o = SHARED_VAULT_OFFSETS;
  return {
    market: pk(b, o.market),
    optionType: b.readUInt8(o.optionType),
    strikePrice: u64(b, o.strikePrice),
    expiry: i64(b, o.expiry),
    vaultType: b.readUInt8(o.vaultType),
    totalCollateral: u64(b, o.totalCollateral),
    totalShares: u64(b, o.totalShares),
    vaultUsdcAccount: pk(b, o.vaultUsdcAccount),
    collateralMint: pk(b, o.collateralMint),
    totalOptionsMinted: u64(b, o.totalOptionsMinted),
    totalOptionsSold: u64(b, o.totalOptionsSold),
    netPremiumCollected: u64(b, o.netPremiumCollected),
    premiumPerShareCumulative: u128(b, o.premiumPerShareCumulative),
    isSettled: b.readUInt8(o.isSettled) !== 0,
    settlementPrice: u64(b, o.settlementPrice),
    collateralRemaining: u64(b, o.collateralRemaining),
    creator: pk(b, o.creator),
    createdAt: i64(b, o.createdAt),
    bump: b.readUInt8(o.bump),
    carryRateBps: b.readInt32LE(o.carryRateBps),
    exerciseStyle: b.readUInt8(o.exerciseStyle),
    exercisedOptions: u64(b, o.exercisedOptions),
    earlyExercisePayout: u64(b, o.earlyExercisePayout),
    spreadBps: b.readUInt16LE(o.spreadBps),
    voided: b.readUInt8(o.voided) !== 0,
    writerAskCollateralSwept: u64(b, o.writerAskCollateralSwept),
    writerAskEquivShares: u64(b, o.writerAskEquivShares),
  };
}

// ---------------------------------------------------------------------------
// VaultMint
// ---------------------------------------------------------------------------

export const VAULT_MINT_LEN = 137;

export interface VaultMintRow {
  vault: string;
  writer: string;
  optionMint: string;
  premiumPerContract: string;
  quantityMinted: string;
  quantitySold: string;
  createdAt: string;
  bump: number;
}

export function decodeVaultMint(b: Buffer): VaultMintRow | null {
  if (b.length !== VAULT_MINT_LEN) return null;
  return {
    vault: pk(b, 8),
    writer: pk(b, 40),
    optionMint: pk(b, 72),
    premiumPerContract: u64(b, 104),
    quantityMinted: u64(b, 112),
    quantitySold: u64(b, 120),
    createdAt: i64(b, 128),
    bump: b.readUInt8(136),
  };
}

// ---------------------------------------------------------------------------
// EpochConfig
// ---------------------------------------------------------------------------

export const EPOCH_CONFIG_LEN = 45;

export interface EpochConfigRow {
  authority: string;
  weeklyExpiryDay: number;
  weeklyExpiryHour: number;
  monthlyEnabled: boolean;
  minEpochDurationDays: number;
  bump: number;
}

export function decodeEpochConfig(b: Buffer): EpochConfigRow | null {
  if (b.length !== EPOCH_CONFIG_LEN) return null;
  return {
    authority: pk(b, 8),
    weeklyExpiryDay: b.readUInt8(40),
    weeklyExpiryHour: b.readUInt8(41),
    monthlyEnabled: b.readUInt8(42) !== 0,
    minEpochDurationDays: b.readUInt8(43),
    bump: b.readUInt8(44),
  };
}

// ---------------------------------------------------------------------------
// OptionsMarket
// ---------------------------------------------------------------------------
//
// asset_name is a Borsh String (4-byte LE length + utf8), so everything after it
// is at a VARIABLE offset and must be parsed positionally. This mirrors the
// existing tape/marketsRefresh.ts parser; the difference is that this one keeps
// the whole struct rather than just (asset_name, asset_class).

/** The highest oracle_source the program defines (ORACLE_SOURCE_OPTA). */
export const MAX_ORACLE_SOURCE = 2;

export interface OptionsMarketRow {
  assetName: string;
  pythFeedId: string; // hex
  assetClass: number;
  bump: number;
  oracleSource: number;
}

export function decodeOptionsMarket(b: Buffer): OptionsMarketRow | null {
  try {
    let p = 8;
    if (b.length < p + 4) return null;
    const nameLen = b.readUInt32LE(p);
    p += 4;
    // A legacy layout puts a different field here, so the length reads as
    // nonsense. Bound it hard rather than trusting it into a slice.
    if (nameLen === 0 || nameLen > 32 || b.length < p + nameLen + 32 + 3) return null;
    const assetName = b.subarray(p, p + nameLen).toString("utf8");
    // Asset names are tickers. Anything else means we are reading a field that
    // is not asset_name, which means this is not the layout we think it is.
    if (!/^[A-Za-z0-9._/-]+$/.test(assetName)) return null;
    p += nameLen;
    const pythFeedId = b.subarray(p, p + 32).toString("hex");
    p += 32;
    const assetClass = b.readUInt8(p);
    p += 1;
    const bump = b.readUInt8(p);
    p += 1;
    const oracleSource = b.readUInt8(p);
    // Known ranges. Out-of-range means a legacy layout decoded as garbage — the
    // exact failure the repo's account size-drift history warns about.
    if (assetClass > 4) return null;
    // The program's own set of sources: 0 Pyth, 1 Switchboard, 2 first-party.
    // The bound was 1 until 2026-09-28, which dropped every market flipped to
    // the first-party lane from the index, and with it from the site.
    if (oracleSource > MAX_ORACLE_SOURCE) return null;
    return { assetName, pythFeedId, assetClass, bump, oracleSource };
  } catch {
    return null;
  }
}
