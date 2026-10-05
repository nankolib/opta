import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  PROGRAM_ID,
  MARKET_SEED,
  PROTOCOL_SEED,
  TREASURY_SEED,
  EPOCH_CONFIG_SEED,
  SHARED_VAULT_SEED,
  SHARED_VAULT_AMERICAN_SEED,
  VAULT_USDC_SEED,
  WRITER_POSITION_SEED,
  VAULT_MINT_RECORD_SEED,
  VAULT_OPTION_MINT_SEED,
  VAULT_PURCHASE_ESCROW_SEED,
  VAULT_RESALE_LISTING_SEED,
  VAULT_RESALE_ESCROW_SEED,
  VOL_ORACLE_SEED,
  OPTA_PRICE_FEED_SEED
} from "../constants";
import type { ExerciseStyle } from "../types";

export function deriveMarket(assetName: string, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
    programId
  )[0];
}

export function protocolStatePda(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(PROTOCOL_SEED)], programId)[0];
}

export function treasuryPda(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(TREASURY_SEED)], programId)[0];
}

export function epochConfigPda(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(EPOCH_CONFIG_SEED)], programId)[0];
}

export function deriveSharedVault(
  market: PublicKey,
  strikePrice: BN,
  expiry: BN,
  optionType: number,
  exerciseStyle: ExerciseStyle,
  programId = PROGRAM_ID
): PublicKey {
  const seed = exerciseStyle === "american" ? SHARED_VAULT_AMERICAN_SEED : SHARED_VAULT_SEED;
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(seed),
      market.toBuffer(),
      strikePrice.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([optionType])
    ],
    programId
  )[0];
}

export function deriveVaultUsdc(sharedVault: PublicKey, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_USDC_SEED), sharedVault.toBuffer()],
    programId
  )[0];
}

export function deriveWriterPosition(
  sharedVault: PublicKey,
  writer: PublicKey,
  programId = PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(WRITER_POSITION_SEED), sharedVault.toBuffer(), writer.toBuffer()],
    programId
  )[0];
}

export function deriveVaultOptionMint(
  sharedVault: PublicKey,
  writer: PublicKey,
  createdAt: BN,
  programId = PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_OPTION_MINT_SEED),
      sharedVault.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8)
    ],
    programId
  )[0];
}

export function deriveCanonicalSeriesMint(
  market: PublicKey,
  strikePrice: BN,
  expiry: BN,
  optionType: number,
  programId = PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_OPTION_MINT_SEED),
      market.toBuffer(),
      strikePrice.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([optionType]),
      Buffer.from([1])
    ],
    programId
  )[0];
}

export function deriveVaultPurchaseEscrow(
  sharedVault: PublicKey,
  writer: PublicKey,
  createdAt: BN,
  programId = PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VAULT_PURCHASE_ESCROW_SEED),
      sharedVault.toBuffer(),
      writer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8)
    ],
    programId
  )[0];
}

export function deriveVaultMintRecord(optionMint: PublicKey, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_MINT_RECORD_SEED), optionMint.toBuffer()],
    programId
  )[0];
}

export function deriveVaultResaleListing(
  optionMint: PublicKey,
  seller: PublicKey,
  programId = PROGRAM_ID
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_RESALE_LISTING_SEED), optionMint.toBuffer(), seller.toBuffer()],
    programId
  )[0];
}

export function deriveVaultResaleEscrow(listing: PublicKey, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_RESALE_ESCROW_SEED), listing.toBuffer()],
    programId
  )[0];
}

export function deriveVolOracle(feedId: number[], programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedId)],
    programId
  )[0];
}

/** First-party price feed for a source-2 market: [opta_price_feed, feed_id]. */
export function deriveOptaPriceFeed(feedId: number[], programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(OPTA_PRICE_FEED_SEED), Buffer.from(feedId)],
    programId
  )[0];
}

export function deriveExtraAccountMetaListPda(
  mint: PublicKey,
  transferHookProgram: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    transferHookProgram
  )[0];
}

export function deriveHookStatePda(mint: PublicKey, transferHookProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), mint.toBuffer()],
    transferHookProgram
  )[0];
}
