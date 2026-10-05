// =============================================================================
// discovery.ts — source-agnostic chain enumeration (safeFetchAll pattern).
// =============================================================================
// Markets and orders are read via raw getProgramAccounts + discriminator memcmp
// + per-account coder.decode wrapped in try/catch — NEVER Anchor's .all(), which
// throws "offset out of range" on legacy orphans and empties the whole scan.
// Discovery is pure enumeration: any market on-chain (incl. Monday's equities)
// auto-appears with zero code change. Per-asset pricing tier is a display
// classification (asset_class + a meme override), not a discovery gate.
// =============================================================================

import type { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PROGRAM_ID, volOraclePda } from "./ids";
import type { AssetClass } from "./marketHours";
import { log } from "./log";

const VOL_WARMUP_SAMPLES = 168;
const VOL_STALE_SECS = 6 * 3600;

export interface MarketInfo {
  publicKey: PublicKey;
  assetName: string;
  assetClass: AssetClass;
  pythFeedId: Uint8Array;
  oracleSource: number; // 0 Pyth, 1 Switchboard
}

export interface OracleState {
  ready: boolean;   // fresh AND (warm OR seeded) — and for source 2, WARM only (see oracleStateOf)
  reason: string;   // when !ready
  spot: number;     // coarse spot (human USD), for strike selection
  samples: number;
  seedVol: number;
  ageSecs: number;
  oracleSource: number; // VolOracle.oracle_source as the coder emits it (0 Pyth, 1 Switchboard, 2 Opta)
}

/** ORACLE_SOURCE_OPTA — the first-party lane (app/src/utils/oracleArm.ts). */
export const ORACLE_SOURCE_OPTA = 2;

export interface MyOrder {
  pubkey: PublicKey;
  optionMint: PublicKey;
  vault: PublicKey;
  priceMicro: bigint;
  quantityRemaining: bigint;
  nonce: bigint;
  createdAtMs: number; // best-effort from on-chain created_at (secs -> ms)
  /** Collateral this ask locks PER CONTRACT, micro-USDC. The leash measures
   *  committed collateral from these on-chain values at tick start — it never
   *  trusts an internal counter. See leash.ts. */
  collateralPerContract: bigint;
}

/** A resting Bid owned by the bot. Same shape as MyOrder — kept as a distinct
 *  type so no call site can accidentally feed a bid into an ask code path. */
export interface MyBid {
  pubkey: PublicKey;
  optionMint: PublicKey;
  vault: PublicKey;
  priceMicro: bigint;
  quantityRemaining: bigint;
  nonce: bigint;
  createdAtMs: number;
}

function memcmpFilter(program: Program<any>, accountName: string) {
  const { offset, bytes } = (program.coder.accounts as any).memcmp(accountName);
  return { memcmp: { offset, bytes } };
}

/** Enumerate live markets, applying the strict validator (drops corrupt/legacy). */
export async function enumerateMarkets(program: Program<any>): Promise<MarketInfo[]> {
  const connection = program.provider.connection;
  const raw = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [memcmpFilter(program, "optionsMarket")],
  });
  const out: MarketInfo[] = [];
  const seen = new Set<string>();
  for (const { pubkey, account } of raw) {
    let m: any;
    try {
      m = program.coder.accounts.decode("optionsMarket", account.data);
    } catch {
      continue; // corrupt / legacy orphan — skip (safeFetchAll semantics)
    }
    if (typeof m.assetName !== "string" || !m.assetName) continue;
    if (typeof m.assetClass !== "number" || m.assetClass < 0 || m.assetClass > 4) continue;
    const key = pubkey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    const feed = m.pythFeedId instanceof Uint8Array ? m.pythFeedId : Uint8Array.from(m.pythFeedId as number[]);
    out.push({
      publicKey: pubkey,
      assetName: m.assetName,
      assetClass: m.assetClass as AssetClass,
      pythFeedId: feed,
      oracleSource: typeof m.oracleSource === "number" ? m.oracleSource : 0,
    });
  }
  return out;
}

const bnNum = (v: any): number => {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  if (typeof v.toNumber === "function") { try { return v.toNumber(); } catch { return Number(v.toString()); } }
  return Number(v.toString?.() ?? v);
};

/** Read the per-feed VolOracle: quote-ready iff fresh (<6h) AND (warm OR seeded). */
export async function readOracle(
  program: Program<any>, feedId: Uint8Array, nowSec: number, debug = false,
): Promise<OracleState> {
  const pda = volOraclePda(feedId);
  let o: any;
  try {
    o = await (program.account as any).volOracle.fetch(pda);
  } catch {
    return { ready: false, reason: "oracle-not-initialized", spot: 0, samples: 0, seedVol: 0, ageSecs: Infinity, oracleSource: -1 };
  }
  if (debug) log.info("oracle-debug", { keys: Object.keys(o) });
  return oracleStateOf(o, nowSec);
}

/**
 * Pure readiness decision over a DECODED VolOracle (the object the real Anchor
 * coder emits: camelCase keys). Exported so the contract test can feed it a
 * coder-decoded account and catch a key-name drift (P4).
 *
 * WARMING SOURCE-2 GATE (2026-09-23, ops ledger 62): a market on the
 * first-party lane (oracle_source 2) is CLOSED to this writer until its ring
 * holds 168 samples, seeded or not. The FE write-gate (writeWarmupGate) binds
 * users the same way; the bot is a writer too. Before this, a freshly reset
 * ring (sample_count 0, seed_vol set) read as "seeded → ready" and the bot
 * posted asks on SOL and XRP inside their first pricing week. Writer lanes
 * treat a warming source-2 market as closed regardless of ceremony state.
 * Not-ready → the engine also PULLS any resting asks there (stale-pull path).
 */
export function oracleStateOf(o: any, nowSec: number): OracleState {
  // NOT `o.samples` — that is the 720-entry ring under snake_case keys (NaN when read as a count).
  const samples = bnNum(o.sampleCount ?? o.sample_count ?? 0);
  const seedVol = bnNum(o.seedVol ?? o.seed_vol ?? 0);
  const lastTs = bnNum(o.lastSampleTs ?? o.lastTs ?? o.last_sample_ts ?? 0);
  const spotScaled = o.lastSpotPrice ?? o.lastSpot ?? o.spot ?? o.last_spot_price;
  const spot = spotScaled != null ? bnNum(spotScaled) / 1e12 : 0;
  const oracleSource = bnNum(o.oracleSource ?? o.oracle_source ?? 0);
  const ageSecs = lastTs > 0 ? nowSec - lastTs : Infinity;
  const fresh = ageSecs < VOL_STALE_SECS;
  const warm = samples >= VOL_WARMUP_SAMPLES;
  const seeded = seedVol !== 0;
  const source2Warming = oracleSource === ORACLE_SOURCE_OPTA && !warm;
  const ready = fresh && (warm || seeded) && !source2Warming && spot > 0;
  const reason = !fresh ? "oracle-stale"
    : source2Warming ? `source2-warmup:${samples}/${VOL_WARMUP_SAMPLES}`
    : !(warm || seeded) ? "oracle-warmup"
    : spot <= 0 ? "no-spot" : "ok";
  return { ready, reason, spot, samples, seedVol, ageSecs, oracleSource };
}

/** Enumerate the bot's own resting orders (memcmp on discriminator + owner@8). */
export async function enumerateMyOrders(
  program: Program<any>, owner: PublicKey,
): Promise<MyOrder[]> {
  const connection: Connection = program.provider.connection;
  const disc = memcmpFilter(program, "restingOrder");
  const raw = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [disc, { memcmp: { offset: 8, bytes: owner.toBase58() } }], // owner is first field after discriminator
  });
  const out: MyOrder[] = [];
  for (const { pubkey, account } of raw) {
    let r: any;
    try {
      r = program.coder.accounts.decode("restingOrder", account.data);
    } catch {
      continue;
    }
    // Only WriterAsks belong to this bot's flow; ignore anything else defensively.
    if (!r.kind || !("writerAsk" in r.kind)) continue;
    const createdAtSec = bnNum(r.createdAt ?? r.created_at ?? 0);
    out.push({
      pubkey,
      optionMint: new PublicKey(r.optionMint ?? r.option_mint),
      vault: new PublicKey(r.vault),
      priceMicro: BigInt(String(r.pricePerContract ?? r.price_per_contract ?? 0)),
      quantityRemaining: BigInt(String(r.quantityRemaining ?? r.quantity_remaining ?? 0)),
      nonce: BigInt(String(r.nonce ?? 0)),
      createdAtMs: createdAtSec > 0 ? createdAtSec * 1000 : 0,
      collateralPerContract: BigInt(String(r.collateralPerContract ?? r.collateral_per_contract ?? 0)),
    });
  }
  return out;
}

/**
 * Enumerate the bot's own resting BIDS. Deliberately a SEPARATE function from
 * `enumerateMyOrders`, whose `writerAsk` filter is a NAMED INVARIANT: it is the
 * reason the ask engine (ordersBySeries, the reprice loop, the orphan sweep)
 * cannot see bids and therefore cannot mistake one for an ask or cancel it out
 * from under this pass. Do not merge these two functions or generalise that
 * filter — the duplication below is the safety property.
 */
export async function enumerateMyBids(
  program: Program<any>, owner: PublicKey,
): Promise<MyBid[]> {
  const connection: Connection = program.provider.connection;
  const disc = memcmpFilter(program, "restingOrder");
  const raw = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [disc, { memcmp: { offset: 8, bytes: owner.toBase58() } }],
  });
  const out: MyBid[] = [];
  for (const { pubkey, account } of raw) {
    let r: any;
    try {
      r = program.coder.accounts.decode("restingOrder", account.data);
    } catch {
      continue;
    }
    // Mirror image of the ask filter: ONLY Bids belong to this flow.
    if (!r.kind || !("bid" in r.kind)) continue;
    const createdAtSec = bnNum(r.createdAt ?? r.created_at ?? 0);
    out.push({
      pubkey,
      optionMint: new PublicKey(r.optionMint ?? r.option_mint),
      vault: new PublicKey(r.vault),
      priceMicro: BigInt(String(r.pricePerContract ?? r.price_per_contract ?? 0)),
      quantityRemaining: BigInt(String(r.quantityRemaining ?? r.quantity_remaining ?? 0)),
      nonce: BigInt(String(r.nonce ?? 0)),
      createdAtMs: createdAtSec > 0 ? createdAtSec * 1000 : 0,
    });
  }
  return out;
}

/**
 * Batch-read the bot's LONG inventory across `mints` — the option-token balance
 * of its own ATA per series. Feeds the inventory cap (a filled bid makes the bot
 * a long holder and there is no on-chain net-off, so the cap is the only thing
 * bounding accumulation). Token-2022 base layout: amount at bytes 64..72. A
 * missing ATA reads as 0. Chunked to stay inside getMultipleAccounts' 100-key limit.
 */
export async function enumerateMyLongs(
  program: Program<any>, owner: PublicKey, mints: PublicKey[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;
  const connection: Connection = program.provider.connection;
  const atas = mints.map((m) => ({
    mint58: m.toBase58(),
    ata: getAssociatedTokenAddressSync(m, owner, false, TOKEN_2022_PROGRAM_ID),
  }));
  for (let i = 0; i < atas.length; i += 100) {
    const chunk = atas.slice(i, i + 100);
    let infos: (AccountInfo<Buffer> | null)[];
    try {
      infos = await connection.getMultipleAccountsInfo(chunk.map((c) => c.ata), "confirmed");
    } catch (e: any) {
      log.warn("enumerate-longs-fail", { err: String(e?.message ?? e).slice(0, 160) });
      continue;
    }
    chunk.forEach((c, j) => {
      const info = infos[j];
      if (!info || info.data.length < 72) { out.set(c.mint58, 0); return; }
      out.set(c.mint58, Number(Buffer.from(info.data).readBigUInt64LE(64)));
    });
  }
  return out;
}
