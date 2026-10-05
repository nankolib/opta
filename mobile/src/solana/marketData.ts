import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import {
  getMetadataPointerState,
  getMint,
  getTokenMetadata,
  TOKEN_2022_PROGRAM_ID
} from "@solana/spl-token";
import { createOptaProgram, fetchDecodedAccount, normalizeAccountBytes, safeFetchAll } from "./program";
import { indexerLineageOk, loadIndexerRecords } from "./indexerReadPath";
import { ensureDevnetConnection } from "./cluster";
import {
  deriveMarket,
  deriveCanonicalSeriesMint,
  deriveSharedVault,
  deriveVaultOptionMint,
  deriveVaultMintRecord,
  deriveVaultResaleListing,
  deriveWriterPosition,
  deriveVolOracle,
  deriveOptaPriceFeed
} from "./pdas";
import { asFallbackSpot, feedFieldsToSpot, isSupportedOracleSource, spotRouteFor } from "./optaFeed";
import { HERMES_BASE, PHASE2_CUTOFF_TIMESTAMP } from "../constants";
import { hexFromBytes, usdcToNumber } from "../format";
import { sanitizeAssetDisplayName } from "../runtime/assetDisplay";
import type {
  AccountRecord,
  ExerciseStyle,
  MarketSnapshot,
  Offering,
  OptionSide,
  PositionState,
  WalletPortfolio,
  WalletPosition,
  WalletWriterPosition
} from "../types";

function bnToNumber(value: any): number {
  if (typeof value === "number") return value;
  if (value?.toNumber) return value.toNumber();
  return Number(value ?? 0);
}

function isCall(optionType: any): boolean {
  return !!optionType && (("call" in optionType) || ("Call" in optionType) || optionType === 0);
}

function exerciseStyleName(value: any): ExerciseStyle {
  return value && (("american" in value) || ("American" in value) || value === 1)
    ? "american"
    : "european";
}

function isPostPhase2Vault(vault: AccountRecord): boolean {
  return bnToNumber(vault.account.createdAt) >= PHASE2_CUTOFF_TIMESTAMP;
}

function isCanonicalVault(vault: AccountRecord): boolean {
  try {
    const expected = deriveSharedVault(
      vault.account.market as PublicKey,
      vault.account.strikePrice,
      vault.account.expiry,
      isCall(vault.account.optionType) ? 0 : 1,
      exerciseStyleName(vault.account.exerciseStyle)
    );
    return vault.publicKey.equals(expected);
  } catch {
    return false;
  }
}

function isCanonicalVaultMint(record: AccountRecord, vault: AccountRecord): boolean {
  try {
    const optionMint = record.account.optionMint as PublicKey;
    const writer = record.account.writer as PublicKey;
    const createdAt = record.account.createdAt;
    if (!record.publicKey.equals(deriveVaultMintRecord(optionMint))) return false;
    if (!(record.account.vault as PublicKey).equals(vault.publicKey)) return false;
    const canonicalMint = writer.equals(PublicKey.default) && createdAt.isZero()
      ? deriveCanonicalSeriesMint(
          vault.account.market as PublicKey,
          vault.account.strikePrice,
          vault.account.expiry,
          isCall(vault.account.optionType) ? 0 : 1
        )
      : deriveVaultOptionMint(vault.publicKey, writer, createdAt);
    if (writer.equals(PublicKey.default) && exerciseStyleName(vault.account.exerciseStyle) !== "american") {
      return false;
    }
    return optionMint.equals(canonicalMint);
  } catch {
    return false;
  }
}

const LIVE_PRICE_MAX_AGE_SECONDS = 120;
const PRICE_FUTURE_TOLERANCE_SECONDS = 30;
const PRICE_FETCH_TIMEOUT_MS = 4_000;
const MAX_CONFIDENCE_BPS = 200;
const ONCHAIN_SPOT_MAX_AGE_SECONDS = 7_200; // ~2h; mirrors the vol-oracle sample-gap tolerance
const SOLMATH_SCALE = 1e12;

type SpotQuote = { value: number; state: "live" | "stale" };

/** Source 2: the first-party feed account for this market's feed id. */
async function fetchOptaFeedSpot(
  program: ReturnType<typeof createOptaProgram>,
  feedId: number[]
): Promise<SpotQuote | null> {
  const record = await fetchDecodedAccount(program, "optaPriceFeed", deriveOptaPriceFeed(feedId, program.programId));
  if (!record) return null;
  const spot = feedFieldsToSpot(record.account, Math.floor(Date.now() / 1000));
  return spot ? { value: spot.value, state: spot.state } : null;
}

async function fetchOnchainSpot(
  program: ReturnType<typeof createOptaProgram>,
  feedId: number[]
): Promise<SpotQuote | null> {
  const pda = deriveVolOracle(feedId, program.programId);
  const record = await fetchDecodedAccount(program, "volOracle", pda);
  if (!record) return null;
  const value = record.account.lastSpotPriceScaled / SOLMATH_SCALE;
  const lastTs = record.account.lastSampleTs;
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(lastTs) || lastTs <= 0) return null;
  const age = Math.floor(Date.now() / 1000) - lastTs;
  const state: "live" | "stale" =
    age >= -PRICE_FUTURE_TOLERANCE_SECONDS && age <= ONCHAIN_SPOT_MAX_AGE_SECONDS ? "live" : "stale";
  return { value, state };
}

async function fetchSpot(feedIdHex: string): Promise<SpotQuote | null> {
  const hex = feedIdHex.replace(/^0x/, "").toLowerCase();
  const url = `${HERMES_BASE}/v2/updates/price/latest?ids[]=0x${hex}&encoding=base64`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);
  let json: any;
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    json = await resp.json();
  } finally {
    clearTimeout(timeout);
  }
  const parsed = json?.parsed?.[0];
  const returnedId = typeof parsed?.id === "string"
    ? parsed.id.replace(/^0x/, "").toLowerCase()
    : "";
  if (returnedId !== hex) return null;
  const price = parsed?.price;
  if (!price
    || typeof price.price !== "string"
    || typeof price.conf !== "string"
    || typeof price.expo !== "number") return null;
  const value = Number(price.price) * Math.pow(10, price.expo);
  const confidence = Number(price.conf) * Math.pow(10, price.expo);
  const publishTime = Number(price.publish_time);
  if (!Number.isFinite(value)
    || value <= 0
    || !Number.isFinite(confidence)
    || confidence < 0
    || !Number.isSafeInteger(publishTime)) return null;
  const age = Math.floor(Date.now() / 1000) - publishTime;
  const confidenceIsNarrow = confidence * 10_000 <= Math.abs(value) * MAX_CONFIDENCE_BPS;
  const state = confidenceIsNarrow
    && age >= -PRICE_FUTURE_TOLERANCE_SECONDS
    && age <= LIVE_PRICE_MAX_AGE_SECONDS
    ? "live"
    : "stale";
  return { value, state };
}

export type SnapshotOptions = {
  /**
   * Board to load. Rev C fetches vaults/series for ONE market at a time — the
   * unfiltered form is 5.93 MB of JSON, worse than the base64 it replaces.
   * null means "first paint": markets only, so the asset chips can render
   * before any board is chosen. The board loads on selection.
   */
  marketKey?: string | null;
};

export async function loadMarketSnapshot(
  connection: Connection,
  options?: SnapshotOptions
): Promise<MarketSnapshot> {
  await ensureDevnetConnection(connection);
  const program = createOptaProgram(connection);
  const marketKey = options?.marketKey ?? null;

  // One lineage/health probe per load. Any failure here (unhealthy, wrong
  // deploy, unreachable) demotes the whole load to the chain scan, which is
  // exactly today's behaviour — the floor, never worse.
  const indexerOk = await indexerLineageOk().catch(() => false);

  async function viaIndexer(
    kind: "sharedVault" | "vaultMint" | "optionsMarket" | "epochConfig",
    mk: string | null,
    fallback: () => Promise<AccountRecord[]>
  ): Promise<AccountRecord[]> {
    if (indexerOk) {
      const rows = await loadIndexerRecords(kind, mk).catch(() => null);
      if (rows) return rows;
    }
    return fallback();
  }

  // Board-scoped kinds are skipped entirely on first paint. Without a board
  // there is nothing to show in the grid anyway, and fetching every vault to
  // discover that is the whole disease.
  const boardScoped = (
    fallback: () => Promise<AccountRecord[]>,
    kind: "sharedVault" | "vaultMint"
  ): Promise<AccountRecord[]> =>
    indexerOk && !marketKey
      ? Promise.resolve([] as AccountRecord[])
      : viaIndexer(kind, marketKey, fallback);

  const [rawMarkets, vaults, vaultMints, listings]: AccountRecord[][] = await Promise.all([
    viaIndexer("optionsMarket", null, () => safeFetchAll(program, "optionsMarket")),
    boardScoped(() => safeFetchAll(program, "sharedVault"), "sharedVault"),
    boardScoped(() => safeFetchAll(program, "vaultMint"), "vaultMint"),
    // No indexer endpoint, and trivially small (1 account / 492 B). Stays chain-direct.
    safeFetchAll(program, "vaultResaleListing")
  ]);

  const markets = rawMarkets.flatMap((market) => {
    // Source 0 = pull-oracle HTTP quote; source 1 = hourly on-chain sample;
    // source 2 = first-party feed account. Each has a spot route below
    // (spotRouteFor). Any other source stays hidden from Trade/Write until it
    // has one; token metadata still works.
    if (!isSupportedOracleSource(market.account.oracleSource)) return [];
    const rawName = market.account.assetName;
    if (typeof rawName !== "string" || !market.publicKey.equals(deriveMarket(rawName))) return [];
    const displayName = sanitizeAssetDisplayName(rawName);
    if (!displayName) return [];
    return [{
      ...market,
      account: { ...market.account, assetName: displayName }
    }];
  });
  const activeVaults = vaults.filter((vault) => isPostPhase2Vault(vault) && isCanonicalVault(vault));
  const vaultByKey = new Map(activeVaults.map((vault) => [vault.publicKey.toBase58(), vault]));
  const activeVaultMints = vaultMints.filter((mint) => {
    const vault = vaultByKey.get((mint.account.vault as PublicKey).toBase58());
    return !!vault && isCanonicalVaultMint(mint, vault);
  });
  const marketByKey = new Map(markets.map((market) => [market.publicKey.toBase58(), market]));
  const vaultMintByOptionMint = new Map(activeVaultMints.map((record) => [
    (record.account.optionMint as PublicKey).toBase58(),
    record
  ]));
  const listingsByMint = new Map<string, AccountRecord[]>();
  const activeListings: AccountRecord[] = [];

  for (const listing of listings) {
    const optionMint = listing.account.optionMint as PublicKey;
    const seller = listing.account.seller as PublicKey;
    const vault = listing.account.vault as PublicKey;
    const mintRecord = vaultMintByOptionMint.get(optionMint.toBase58());
    if (!mintRecord
      || !listing.publicKey.equals(deriveVaultResaleListing(optionMint, seller))
      || !(mintRecord.account.vault as PublicKey).equals(vault)
      || bnToNumber(listing.account.listedQuantity) <= 0
      || bnToNumber(listing.account.pricePerContract) <= 0) continue;
    const mint = optionMint.toBase58();
    const records = listingsByMint.get(mint) ?? [];
    records.push(listing);
    listingsByMint.set(mint, records);
    activeListings.push(listing);
  }

  // FIX C: the spot stage USED to run here, inline, before offerings were built.
  // Measured on-device 2026-08-25: scan responses landed at 19:04:35 but the spot
  // reads did not start until 19:07:20 — a 165s tail in front of the first paint,
  // for data no offering row depends on. It is now deferred: offerings commit
  // immediately after decode, prices arrive afterwards via loadSpotPrices().
  const spotByAsset: Record<string, number> = {};
  const spotStatusByAsset: Record<string, "live" | "stale"> = {};

  const offerings: Offering[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const vaultMint of activeVaultMints) {
    const vault = vaultByKey.get((vaultMint.account.vault as PublicKey).toBase58());
    if (!vault || vault.account.isSettled || vault.account.voided) continue;
    const market = marketByKey.get((vault.account.market as PublicKey).toBase58());
    if (!market) continue;

    const asset = market.account.assetName as string;
    const side: OptionSide = isCall(vault.account.optionType) ? "call" : "put";
    const strike = usdcToNumber(vault.account.strikePrice);
    const expiry = bnToNumber(vault.account.expiry);
    if (expiry <= now) continue;
    const exerciseStyle = exerciseStyleName(vault.account.exerciseStyle);
    const optionMint = vaultMint.account.optionMint as PublicKey;
    const unsold = bnToNumber(vaultMint.account.quantityMinted) - bnToNumber(vaultMint.account.quantitySold);

    if (unsold > 0) {
      offerings.push({
        id: `vault:${vaultMint.publicKey.toBase58()}`,
        kind: "vault",
        side,
        asset,
        strike,
        expiry,
        premium: usdcToNumber(vaultMint.account.premiumPerContract),
        quantityAvailable: unsold,
        exerciseStyle,
        market,
        vault,
        vaultMint
      });
    }

    for (const listing of listingsByMint.get(optionMint.toBase58()) ?? []) {
      const seller = listing.account.seller as PublicKey;
      offerings.push({
        id: `resale:${listing.publicKey.toBase58()}`,
        kind: "resale",
        side,
        asset,
        strike,
        expiry,
        premium: usdcToNumber(listing.account.pricePerContract),
        quantityAvailable: bnToNumber(listing.account.listedQuantity),
        exerciseStyle,
        market,
        vault,
        vaultMint,
        listing,
        seller
      });
    }
  }

  offerings.sort((a, b) => a.premium - b.premium);
  const assets = Array.from(new Set(offerings.map((offering) => offering.asset))).sort();
  const expiriesByAsset: Record<string, number[]> = {};
  for (const asset of assets) {
    expiriesByAsset[asset] = Array.from(new Set(
      offerings.filter((offering) => offering.asset === asset).map((offering) => offering.expiry)
    )).sort((a, b) => a - b);
  }

  return {
    markets,
    vaults: activeVaults,
    vaultMints: activeVaultMints,
    listings: activeListings,
    spotByAsset,
    spotStatusByAsset,
    spotResolved: false,
    offerings,
    assets,
    expiriesByAsset,
    fetchedAt: Date.now()
  };
}

export async function loadWalletPositions(
  connection: Connection,
  owner: PublicKey,
  snapshot: MarketSnapshot
): Promise<WalletPosition[]> {
  await ensureDevnetConnection(connection);
  const tokenAccounts = await connection.getTokenAccountsByOwner(owner, {
    programId: TOKEN_2022_PROGRAM_ID
  });
  const balances = new Map<string, { mint: PublicKey; balance: number }>();
  for (const item of tokenAccounts.value) {
    if (!item.account.owner.equals(TOKEN_2022_PROGRAM_ID)) continue;
    const data = normalizeAccountBytes(item.account.data);
    if (data.length < 165) continue;
    const accountOwner = new PublicKey(data.subarray(32, 64));
    if (!accountOwner.equals(owner)) continue;
    const mint = new PublicKey(data.subarray(0, 32));
    const balance = readU64Number(data, 64);
    if (balance <= 0) continue;
    const key = mint.toBase58();
    const existing = balances.get(key);
    balances.set(key, { mint, balance: (existing?.balance ?? 0) + balance });
  }

  const now = Math.floor(Date.now() / 1000);
  const positions = await Promise.all(Array.from(balances.values()).map(async ({ mint, balance }) => {
    const known = positionFromSnapshot(mint, balance, snapshot, now);
    if (known) return known;
    try {
      return await positionFromTokenMetadata(connection, mint, balance, now);
    } catch (err) {
      return unavailablePosition(mint, balance, errorText(err));
    }
  }));
  return positions
    .filter((position): position is WalletPosition => position != null)
    .sort((a, b) => b.expiry - a.expiry || a.asset.localeCompare(b.asset));
}

export async function loadWrittenPositions(
  connection: Connection,
  owner: PublicKey,
  snapshot: MarketSnapshot
): Promise<WalletWriterPosition[]> {
  await ensureDevnetConnection(connection);
  const program = createOptaProgram(connection);
  const records = await safeFetchAll(program, "writerPosition");
  const vaultByKey = new Map(snapshot.vaults.map((vault) => [vault.publicKey.toBase58(), vault]));
  const marketByKey = new Map(snapshot.markets.map((market) => [market.publicKey.toBase58(), market]));
  const now = Math.floor(Date.now() / 1000);
  const rows: WalletWriterPosition[] = [];

  for (const record of records) {
    if (!(record.account.owner as PublicKey).equals(owner)) continue;
    const vaultKey = record.account.vault as PublicKey;
    if (!record.publicKey.equals(deriveWriterPosition(vaultKey, owner))) continue;
    const vault = vaultByKey.get(vaultKey.toBase58());
    if (vault && !isCanonicalVault(vault)) {
      rows.push(unavailableWriterPosition(record.publicKey, vaultKey, record.account, "The written option vault is invalid."));
      continue;
    }
    if (!vault) {
      rows.push(unavailableWriterPosition(record.publicKey, vaultKey, record.account, "The written option vault is unavailable."));
      continue;
    }
    const market = marketByKey.get((vault.account.market as PublicKey).toBase58());
    const asset = sanitizeAssetDisplayName(market?.account.assetName);
    if (!market || !asset) {
      rows.push(unavailableWriterPosition(record.publicKey, vaultKey, record.account, "Written option metadata is unavailable."));
      continue;
    }

    const side: OptionSide = isCall(vault.account.optionType) ? "call" : "put";
    const strike = usdcToNumber(vault.account.strikePrice);
    const expiry = bnToNumber(vault.account.expiry);
    const settlementPrice = vault.account.isSettled
      ? usdcToNumber(vault.account.settlementPrice)
      : null;
    rows.push({
      id: record.publicKey.toBase58(),
      position: record.publicKey,
      vault: vaultKey,
      asset,
      side,
      exerciseStyle: exerciseStyleName(vault.account.exerciseStyle),
      strike,
      expiry,
      shares: bnToNumber(record.account.shares),
      collateralDeposited: usdcToNumber(record.account.depositedCollateral),
      optionsMinted: bnToNumber(record.account.optionsMinted),
      optionsSold: bnToNumber(record.account.optionsSold),
      premiumClaimed: usdcToNumber(record.account.premiumClaimed),
      claimablePremium: null,
      currentMark: null,
      settlementPrice,
      state: positionState(vault.account, side, strike, expiry, settlementPrice, now)
    });
  }
  return rows.sort((a, b) => b.expiry - a.expiry || a.asset.localeCompare(b.asset));
}

export async function loadWalletPortfolio(
  connection: Connection,
  owner: PublicKey,
  snapshot: MarketSnapshot
): Promise<WalletPortfolio> {
  const [holdings, written] = await Promise.all([
    loadWalletPositions(connection, owner, snapshot),
    loadWrittenPositions(connection, owner, snapshot)
  ]);
  return { holdings, written, fetchedAt: Date.now() };
}

/** Functional read-only retry for a metadata-unavailable position row. */
export async function refetchPositionMetadata(
  connection: Connection,
  position: WalletPosition,
  snapshot?: MarketSnapshot
): Promise<WalletPosition> {
  await ensureDevnetConnection(connection);
  const now = Math.floor(Date.now() / 1000);
  const known = snapshot && positionFromSnapshot(position.mint, position.balance, snapshot, now);
  if (known) return known;
  const refreshed = await positionFromTokenMetadata(connection, position.mint, position.balance, now);
  if (!refreshed) throw new Error("This token is not an Opta option position.");
  if (refreshed.state === "metaUnavailable") {
    throw new Error(refreshed.metadataError || "Option metadata is still unavailable.");
  }
  return refreshed;
}

function positionFromSnapshot(
  mint: PublicKey,
  balance: number,
  snapshot: MarketSnapshot,
  now: number
): WalletPosition | null {
  const mintRecord = snapshot.vaultMints.find((record) =>
    (record.account.optionMint as PublicKey).equals(mint)
  );
  if (!mintRecord) return null;
  const vaultKey = mintRecord.account.vault as PublicKey;
  const vault = snapshot.vaults.find((record) => record.publicKey.equals(vaultKey));
  if (!vault || !isCanonicalVault(vault) || !isCanonicalVaultMint(mintRecord, vault)) return null;
  const marketKey = vault.account.market as PublicKey;
  const market = snapshot.markets.find((record) => record.publicKey.equals(marketKey));
  const asset = sanitizeAssetDisplayName(market?.account.assetName);
  if (!market || !asset) return null;
  return positionFromVault(mint, balance, asset, vault, null, now);
}

async function positionFromTokenMetadata(
  connection: Connection,
  mint: PublicKey,
  balance: number,
  now: number
): Promise<WalletPosition | null> {
  const program = createOptaProgram(connection);
  const recordPda = deriveVaultMintRecord(mint, program.programId);
  const mintRecord = await fetchDecodedAccount(program, "vaultMint", recordPda);
  // A wallet can hold arbitrary Token-2022 assets. No canonical Opta mint
  // record means this balance is unrelated and must not become an UNKNOWN row.
  if (!mintRecord) return null;
  const recordedMint = mintRecord.account.optionMint as PublicKey;
  const recordedVault = mintRecord.account.vault as PublicKey;
  if (!recordedMint?.equals?.(mint) || !recordedVault?.toBase58) {
    return unavailablePosition(mint, balance, "The option mint record is invalid.");
  }

  const mintAccount = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const metadataPointer = getMetadataPointerState(mintAccount);
  if (!metadataPointer
    || metadataPointer.authority !== null
    || !metadataPointer.metadataAddress?.equals(mint)) {
    return unavailablePosition(mint, balance, "The option mint metadata pointer is invalid.");
  }
  const metadata = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (!metadata || !metadata.mint.equals(mint)) {
    return unavailablePosition(mint, balance, "Token metadata is unavailable.");
  }
  const fields = new Map(metadata.additionalMetadata.map(([key, value]) => [key.toLowerCase(), value]));
  const metadataAsset = sanitizeAssetDisplayName(fields.get("asset_name"));
  const metadataVault = publicKeyField(fields.get("vault_pda"));
  if (!metadataAsset || !metadataVault || !metadataVault.equals(recordedVault)) {
    return unavailablePosition(mint, balance, "Token metadata is incomplete.");
  }

  const vaultRecord = await fetchDecodedAccount(program, "sharedVault", recordedVault);
  if (!vaultRecord || !isCanonicalVault(vaultRecord) || !isCanonicalVaultMint(mintRecord, vaultRecord)) {
    return unavailablePosition(mint, balance, "The option vault is unavailable.");
  }
  const marketKey = vaultRecord.account.market as PublicKey;
  const marketRecord = await fetchDecodedAccount(program, "optionsMarket", marketKey);
  const rawMarketName = marketRecord?.account.assetName;
  const canonicalAsset = sanitizeAssetDisplayName(rawMarketName);
  if (!marketRecord
    || typeof rawMarketName !== "string"
    || !marketRecord.publicKey.equals(deriveMarket(rawMarketName))
    || !canonicalAsset
    || canonicalAsset !== metadataAsset) {
    return unavailablePosition(mint, balance, "Option market metadata does not match the mint.");
  }
  return positionFromVault(mint, balance, canonicalAsset, vaultRecord, null, now);
}

function positionFromVault(
  mint: PublicKey,
  balance: number,
  asset: string,
  vault: AccountRecord,
  premiumPaid: number | null,
  now: number
): WalletPosition {
  const side: OptionSide = isCall(vault.account.optionType) ? "call" : "put";
  const strike = usdcToNumber(vault.account.strikePrice);
  const expiry = bnToNumber(vault.account.expiry);
  const settlementPrice = vault.account.isSettled
    ? usdcToNumber(vault.account.settlementPrice)
    : null;
  return {
    id: mint.toBase58(),
    mint,
    vault: vault.publicKey,
    asset,
    side,
    exerciseStyle: exerciseStyleName(vault.account.exerciseStyle),
    strike,
    expiry,
    balance,
    premiumPaid,
    currentMark: null,
    settlementPrice,
    state: positionState(vault.account, side, strike, expiry, settlementPrice, now)
  };
}

function positionState(
  vault: any,
  side: OptionSide,
  strike: number,
  expiry: number,
  settlementPrice: number | null,
  now: number
): PositionState {
  // A dead-feed reclaim is explicitly not settlement. Keep it out of both
  // settled states even if a corrupt/legacy account has both flags set.
  if (vault.voided) return "expired";
  if (vault.isSettled) {
    if (settlementPrice == null) return "settledOTM";
    const isItm = side === "call" ? settlementPrice > strike : settlementPrice < strike;
    return isItm ? "settledITM" : "settledOTM";
  }
  return expiry <= now ? "expired" : "live";
}

function unavailablePosition(mint: PublicKey, balance: number, metadataError: string): WalletPosition {
  return {
    id: mint.toBase58(),
    mint,
    asset: "UNKNOWN",
    side: "call",
    exerciseStyle: "european",
    strike: 0,
    expiry: 0,
    balance,
    premiumPaid: null,
    currentMark: null,
    settlementPrice: null,
    state: "metaUnavailable",
    metadataError
  };
}

function unavailableWriterPosition(
  position: PublicKey,
  vault: PublicKey,
  account: any,
  metadataError: string
): WalletWriterPosition {
  return {
    id: position.toBase58(),
    position,
    vault,
    asset: "UNKNOWN",
    side: "call",
    exerciseStyle: "european",
    strike: 0,
    expiry: 0,
    shares: bnToNumber(account.shares),
    collateralDeposited: usdcToNumber(account.depositedCollateral),
    optionsMinted: bnToNumber(account.optionsMinted),
    optionsSold: bnToNumber(account.optionsSold),
    premiumClaimed: usdcToNumber(account.premiumClaimed),
    claimablePremium: null,
    currentMark: null,
    settlementPrice: null,
    state: "metaUnavailable",
    metadataError
  };
}

function publicKeyField(value: string | undefined): PublicKey | null {
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function readU64Number(data: ArrayLike<number>, offset: number): number {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(data[offset + index]);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Token balance exceeds the safe display range.");
  }
  return Number(value);
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * FIX C — deferred spot stage.
 *
 * Split out of loadMarketSnapshot so offerings render as soon as they are
 * decoded. No offering field depends on spot: the offerings loop reads only
 * vault / vaultMint data. Prices are a decoration on top.
 *
 * Never throws. A dead Hermes or an unreachable VolOracle yields empty maps,
 * which renders prices as placeholders and leaves offerings untouched — the
 * spot stage must not be able to unrender the board.
 */
export async function loadSpotPrices(
  connection: Connection,
  markets: AccountRecord[]
): Promise<{ spotByAsset: Record<string, number>; spotStatusByAsset: Record<string, "live" | "stale"> }> {
  const spotByAsset: Record<string, number> = {};
  const spotStatusByAsset: Record<string, "live" | "stale"> = {};
  try {
    const program = createOptaProgram(connection);
    const feeds = new Map<string, { source: number; feedHex: string; feedId: number[] }>();
    for (const market of markets) {
      const asset = market.account.assetName as string;
      if (!feeds.has(asset)) {
        const feedId = market.account.pythFeedId as number[];
        feeds.set(asset, {
          source: market.account.oracleSource as number,
          feedHex: hexFromBytes(feedId),
          feedId
        });
      }
    }
    await Promise.all(Array.from(feeds.entries()).map(async ([asset, feed]) => {
      const route = spotRouteFor(feed.source);
      let quote: SpotQuote | null = null;
      if (route === "optaFeed") {
        // First-party feed, seconds fresh. If the read fails, the hourly sample
        // may fill the number in, but it is never shown as live.
        quote = await fetchOptaFeedSpot(program, feed.feedId).catch(() => null);
        if (quote == null) quote = asFallbackSpot(await fetchOnchainSpot(program, feed.feedId).catch(() => null));
      } else if (route === "volOracle") {
        quote = await fetchOnchainSpot(program, feed.feedId).catch(() => null);
      } else if (route === "http") {
        quote = await fetchSpot(feed.feedHex).catch(() => null);
      }
      if (quote == null) {
        spotStatusByAsset[asset] = "stale";
      } else {
        spotByAsset[asset] = quote.value;
        spotStatusByAsset[asset] = quote.state;
      }
    }));
  } catch {
    // Deliberately swallowed — see the contract above.
  }
  return { spotByAsset, spotStatusByAsset };
}
