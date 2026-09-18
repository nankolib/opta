// ============================================================================
// crank/triggerCrank.ts — Phase 4 Pass 2: the trigger keeper loop (off-chain)
// ============================================================================
//
// A SCHEDULER, not an authority. The on-chain execute_trigger (P1) re-reads a
// fresh Pyth EMA and re-checks the stored condition itself — the keeper only
// watches prices, decides which triggers are worth sending, and (in production)
// sends the atomic post_update_atomic + execute_trigger tx. Every fire goes
// through the on-chain re-check; the keeper's decision is never final.
//
// Mirrors volOracleCrank.ts structure (loop shell + discovery + shutdown +
// TICK_ONCE) but with a SHORT FIXED cadence (stops can't fire 5 min late), NOT
// the hour-boundary alignment the vol loop uses.
//
// IDL: the keeper reads a CRANK-LOCAL IDL (crank/idl/opta.json, synced from
// target/idl) — NOT app/src/idl, which lags behind the deployed program (it
// rides the FE arc and at P2 still lacks execute_trigger/TriggerOrder).
// Discovery uses this fresh IDL's coder (the app-side safeFetchAll hardcodes a
// stale DISCRIMINATORS map and has no "triggerOrder").
//
// Refinements baked in:
//   - BATCHED Hermes read: ONE /v2/updates/price/latest?ids[]=…&ids[]=… per
//     tick for ALL unique feeds (not one-per-trigger → 429s).
//   - AIMD backoff on Hermes 429/5xx via the shared crank/hermesBackoff helper.
//   - FIRE MARGIN: the keeper reads SPOT but the chain re-checks the EMA; only
//     fire when spot is past the threshold by TRIGGER_FIRE_MARGIN_BPS so
//     spot-vs-EMA divergence doesn't churn 6059 reverts.
//   - BUY budget pre-check: simulate get_option_price (+ vault spread) and skip
//     (trigger STAYS LIVE) if the would-be premium exceeds the escrowed ceiling
//     — never send a doomed SlippageExceeded tx (fee-burn).
//   - SELL OTM pre-skip: skip an obviously-OTM sell (spot vs strike) rather than
//     send a doomed OptionNotInTheMoney tx.
//
// DRY RUN (default ON via OPTA_TRIGGER_DRY_RUN): logs exactly what it WOULD send
// per eligible order and does NOT call the sender. P3 flips it off for the first
// real send against a seeded trigger.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  Connection, PublicKey, ComputeBudgetProgram, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { hexFromBytes } from "@app/utils/format";
import { fetchOptionPriceQuote } from "@app/utils/optionPriceQuote";
import { fetchHermesUpdate, submitWithFallback, type SignerWallet } from "@app/utils/pythPullPost";
import {
  PROTOCOL_SEED, TREASURY_SEED, VOL_ORACLE_SEED, VAULT_MINT_RECORD_SEED, VAULT_USDC_SEED,
} from "@app/utils/constants";
import {
  mkBackoff, backoffOn429, backoffOnOk, classifyHermesError, type BackoffState,
  DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CEILING_MS,
} from "./hermesBackoff";
import { SPL_SYSVAR_SLOT_HASHES_ID, SPL_SYSVAR_INSTRUCTIONS_ID } from "@switchboard-xyz/on-demand";
import { assertPotSlots, POT_SLOTS } from "./potSlotGuard";
import { AccountCache, ACCOUNT_CACHE_TTL_MS } from "./accountCache";

// ---- Trigger PDA seeds (constants.ts is FE-stale — define crank-local; these
//      MUST match programs/opta/src/state/trigger_order.rs) -------------------
const TRIGGER_ORDER_SEED = "trigger_order";
const TRIGGER_ESCROW_SEED = "trigger_escrow";

// ---- Phase B1: book-fire seeds (MUST match programs/opta/src/state + the
//      execute_trigger.rs runtime PDA checks). The keeper assembles the [21]-[30]
//      trailing optionals ONLY when book fires are enabled at the flip (dormant
//      until then — the on-chain BOOK_TRIGGERS_ENABLED gate is dark in prod). --
const RESTING_ORDER_ESCROW_SEED = "resting_order_escrow";
const WRITER_ASK_POT_SEED = "writer_ask_pot";
const WRITER_ASK_POT_USDC_SEED = "writer_ask_pot_usdc";
const WRITER_ASK_POSITION_SEED = "writer_ask_position";
// opta-transfer-hook PDA seeds (programs/opta-transfer-hook/src/lib.rs:32-35).
const EXTRA_ACCOUNT_METAS_SEED = "extra-account-metas";
const HOOK_STATE_SEED = "hook-state";
/** Switchboard On-Demand DEVNET queue — the cluster fingerprint the ALT boot
 *  assertion checks. Mainnet has a different queue and therefore its own table. */
export const SB_ON_DEMAND_QUEUE = new PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7");
/** opta-transfer-hook program id. Same value as writer/src/ids.ts:22 and
 *  tests/bankrun/bootstrap.ts:42; execute_trigger ID-pins [29] against it. */
export const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

// ---- Tunables --------------------------------------------------------------
// TEMPORARILY WIDENED 2026-08-07 (15s -> 5min) after the Helius credit
// exhaustion. Measured burn: this crank issued 5,720 getProgramAccounts/day,
// 98.6% of ALL gPA traffic on the key, and every single tick logged
// triggersFound: 0. gPA is the most credit-expensive method, so one subsystem
// finding nothing accounted for essentially the whole expensive-call load.
//
// The original 15s existed so "stops can't fire 5 min late". That reasoning is
// sound and will apply again — but there is NO trigger-placement UI today
// (OrderTicket.tsx gates the Stop/TP-SL tabs "coming soon", which is why O5/O5b
// read as coming soon on the rules page), so no user can arm a trigger and the
// latency cost is currently zero. TRIGGER-UI-REVERT: REVERT THIS TO 15_000 IN THE SAME
// CHANGE THAT SHIPS THE TRIGGER-PLACEMENT UI — a 5-minute stop latency against
// real user triggers is a product defect, not a saving.
//
// Override without a deploy: OPTA_TRIGGER_TICK_MS.
export const DEFAULT_TRIGGER_TICK_MS = 300_000; // 5min — see TRIGGER-UI-REVERT above
export const DEFAULT_FIRE_MARGIN_BPS = 50; // 0.50% — headroom over measured SOL spot↔EMA gap (calm p90 ~16bps, move-peak ~33bps; P3.4 characterization)
export const DEFAULT_FEED_STALE_SECS = 120; // a Hermes price older than this = stale
// Raised 400_000 -> 700_000 at 2A. A contract-tape fire adds one American pricing
// kernel on legs that do not already pay for one; measured 2026-08-18 at 24.5-41K
// CU, so ~441K worst case. 700K also covers the pessimistic reading of the older
// (and now corrected) ~280K kernel note, at ~680K. Still 50% under the 1.4M
// ceiling, and a devnet CU reservation is free.
export const EXECUTE_CU_LIMIT = 700_000; // BUY+BS-2002+contract-tape; keeper IS the caller

// ---- Phase A: Switchboard arm ---------------------------------------------
// The on-chain execute_trigger ALREADY routes by market.oracle_source (a Pyth
// arm and an SB arm). This keeper was the half that opted out: it built a
// Pyth/Hermes read + a Pyth-only ctx and skipped every oracle_source==1 market.
// Post-migration that is the ENTIRE tradeable board (recon 2026-07-22: 24 SB
// markets vs 7 Pyth, all 7 non-board FX/commodity), so the keeper was firing for
// nobody. This flag turns the SB arm on; OFF reproduces the prior behaviour
// byte-for-byte (SB markets skipped) so the Pyth arm can never regress.
export const TRIGGER_SB_ENABLED =
  (process.env.OPTA_TRIGGER_SB_ENABLED ?? "").trim() === "1";
/** Crossbar is the SB WATCH tape (batched, mirrors the batched-Hermes design).
 *  The on-chain re-validation still re-reads a verified quote at fire time — the
 *  watch tape only decides WHEN to try, never what price is used. */
export const DEFAULT_CROSSBAR_URL =
  process.env.OPTA_CROSSBAR_URL ?? "https://crossbar.switchboard.xyz";

/** Within-tick fire retries against the flaky SB gateway (~3/15 clean, see
 *  sbOracleCrank.ts). Single-shot-per-tick catches the clean window far too
 *  slowly for a stop; the crank's proven answer is bounded retry-with-fresh-
 *  quote. Matches SB_PUSH_MAX_ATTEMPTS's intent at a fire-appropriate bound. */
export const DEFAULT_FIRE_MAX_ATTEMPTS = 3;

/**
 * Classify a fire-attempt failure. Load-bearing distinction the crank's push
 * loop doesn't need but a fire does: a stop that keeps re-firing a tx the CHAIN
 * already rejected (wrong comparator, stale oracle, insufficient funds) is
 * wrong — that verdict won't change within a tick, and re-sending wastes the
 * gateway window. So:
 *   - "retryable": the quote never reached the chain — gateway/crossbar/quote-
 *     fetch failures ("No gateways available", network, no-ed25519), or a
 *     transient sim error (blockhash). Re-fetch a FRESH quote and try again.
 *   - "terminal": the chain SIMULATED and REJECTED it — any InstructionError
 *     carrying a Custom program error (6059 TriggerConditionNotMet, freshness,
 *     funds). Stop this tick; the next tick re-reads state and re-decides.
 */
export function classifyFireError(err: unknown): "retryable" | "terminal" {
  // On-chain program rejection: a simulate result shaped {InstructionError:[i,{Custom:n}]}
  // (or {Custom:n}) is a deliberate revalidation failure → terminal.
  const asObj = (v: unknown): any => (v && typeof v === "object" ? (v as any) : undefined);
  const o = asObj(err);
  const ie = o?.InstructionError ?? o?.err?.InstructionError;
  if (Array.isArray(ie) && asObj(ie[1])?.Custom !== undefined) return "terminal";
  if (o?.Custom !== undefined) return "terminal";
  // Everything else — gateway/quote-fetch throws, network, blockhash — is a
  // "never landed" condition → retry with a fresh quote.
  return "retryable";
}

/** Resolve a feedHash → its SB On-Demand queue via the registry. Undefined for a
 *  Pyth feed or an unregistered hash (the fire path then throws explicitly). */
export function sbQueueFor(feedHex: string): PublicKey | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { lookupSbFeed } = require("./sbFeedRegistry") as typeof import("./sbFeedRegistry");
    return lookupSbFeed(feedHex)?.queue;
  } catch { return undefined; }
}
const SHUTDOWN_CHECK_MS = 5000; // interruptible-sleep granularity

const CRANK_IDL_PATH = path.resolve(__dirname, "idl/opta.json");

// Account order in execute_trigger's context (for readable dry-run logs).
const EXECUTE_ACCOUNT_ROLES = [
  "caller", "trigger_order", "market", "shared_vault", "vault_mint_record",
  "option_mint", "price_update", "vol_oracle", "protocol_state", "treasury",
  "trigger_escrow", "holder_option_ata", "owner_usdc_account", "owner_wallet",
  "vault_usdc_account", "token_program", "token_2022_program", "system_program",
  // Phase A: the SB arm's three optional accounts (null on the Pyth path).
  "sb_queue", "sb_slothashes", "sb_instructions",
];

// The ELEVEN trailing book-fire optionals [21]-[31], in the EXACT order
// execute_trigger.rs declares them (see its positional-layout table). Three fire
// shapes share these slots:
//   WriterAsk buy (B1) → [21]-[27]           ([28]-[31] null)
//   ResaleAsk buy (B1) → [21]-[24],[28]-[30] ([25]-[27],[31] null)
//   Bid sell      (B2) → [21]-[23],[28]-[31] ([24]-[27] null)
// [28]-[30] are the SHARED per-series transfer-hook triad — required by ANY leg
// that moves option tokens, so they are book_hook_* and not resale-specific.
// This array is the single source of truth both assemblers + their unit tests
// pin to, so a struct reorder on either side breaks the test.
export const BOOK_ACCOUNT_ROLES = [
  "book_order", "book_maker", "book_escrow", "book_maker_usdc",
  "writer_ask_pot", "writer_ask_pot_usdc", "writer_ask_position",
  "book_hook_metas", "book_hook_program", "book_hook_state",
  "book_maker_option",
] as const;

// ---- Types -----------------------------------------------------------------

export type TriggerCrankLogLevel = "info" | "warn" | "error" | "fatal";
export type TriggerCrankLogger = (
  level: TriggerCrankLogLevel, msg: string, fields?: Record<string, unknown>,
) => void;

export interface TriggerCrankContext {
  connection: Connection;
  wallet: SignerWallet;
  hermesBase: string;
  log: TriggerCrankLogger;
  shouldShutdown: () => boolean;
}

export interface TriggerCrankOptions {
  tickOnce?: boolean;
  dryRun?: boolean;
  tickMs?: number;
  fireMarginBps?: number;
  feedStaleSecs?: number;
}

export type TriggerKindStr = "buy" | "sell";
export type ComparatorStr = "le" | "ge";

/** Plain view of a TriggerOrder — pure-decidable, no anchor types. */
export interface TriggerView {
  pubkey: string;
  owner: string;
  market: string;
  vault: string;
  optionMint: string;
  holderOptionAta: string;
  kind: TriggerKindStr;
  comparator: ComparatorStr;
  thresholdUsdc: bigint; // 6-dec
  quantity: bigint;
  maxPremiumPerContract: bigint; // 6-dec (BUY); 0 for sells
  /** B3: the paired TriggerOrder PDA when this order is half of an OCO couple,
   *  else null. Carried on the view because execute_trigger's [32] slot needs it
   *  at assembly time — accountsStrict rejects the build without the account, and
   *  the program refuses the fire (6087) if a linked order arrives without it.
   *  OPTIONAL so existing fixtures need no edit — absent is read as "unpaired",
   *  which is what every pre-B3 order is. */
  ocoLink?: PublicKey | null;
}

export interface SpotEntry {
  priceFloat: number; // USD
  publishTime: number; // unix seconds
}

export interface VaultInfo {
  strikeUsdc: bigint; // 6-dec
  isCall: boolean;
  spreadBps: number;
  carryRateBps: number;
  expiry: number;
}

export type SkipReason =
  | "stale_feed" | "condition_not_met" | "within_margin"
  | "otm" | "over_budget" | "quote_unavailable";
export type Decision = { eligible: true } | { eligible: false; reason: SkipReason };

export interface EvalOpts {
  spot?: SpotEntry;
  nowSec: number;
  maxStaleSecs: number;
  fireMarginBps: number;
  pegPremiumTotalUsdc?: bigint; // BUY: spread-applied total (6-dec)
  strikeUsdc?: bigint; // SELL OTM pre-skip
  isCall?: boolean; // SELL OTM pre-skip
}

export interface TickReport {
  triggersFound: number;
  fired: number;
  skippedStaleFeed: number;
  skippedConditionNotMet: number;
  skippedWithinMargin: number;
  skippedOtm: number;
  skippedOverBudget: number;
  skippedQuoteUnavailable: number;
  /** Stage 3: triggers whose parent market is Switchboard-sourced
   *  (oracle_source==1) — out of keeper scope until an SB execute arm exists.
   *  Counted, not fired: a wrong-spot fill would be worse than a no-op. */
  skippedSbMarket: number;
  orderErrors: number;
  durationMs: number;
}

// ============================================================================
// PURE decision logic (unit-tested without RPC)
// ============================================================================

/** Float USD spot → USDC 6-dec integer (matches threshold_usdc units). */
export function spotToUsdc6(priceFloat: number): bigint {
  return BigInt(Math.round(priceFloat * 1_000_000));
}

/** Apply a vault spread to a per-contract premium, floored — mirrors
 *  fill_vault_peg::apply_spread (base × (10_000 + spread_bps) / 10_000). */
export function applySpreadFloor(perContractUsdc: bigint, spreadBps: number): bigint {
  return (perContractUsdc * (10_000n + BigInt(spreadBps))) / 10_000n;
}

/**
 * Decide whether the keeper should SEND an execute_trigger for this order THIS
 * tick. Pure — the impure reads (batched Hermes spot, get_option_price sim) are
 * done by the tick and passed in. The on-chain core remains the authority; this
 * only governs WHEN the keeper bothers to send (and avoids fee-burn reverts).
 */
export function evaluateTrigger(order: TriggerView, o: EvalOpts): Decision {
  // 1. Missing / stale feed — never fire on no price.
  if (!o.spot) return { eligible: false, reason: "stale_feed" };
  if (o.nowSec - o.spot.publishTime > o.maxStaleSecs) return { eligible: false, reason: "stale_feed" };

  const spotUsdc = spotToUsdc6(o.spot.priceFloat);

  // 2. Condition + fire-margin buffer (spot↔EMA divergence guard).
  const margin = (order.thresholdUsdc * BigInt(o.fireMarginBps)) / 10_000n;
  if (order.comparator === "ge") {
    if (spotUsdc < order.thresholdUsdc) return { eligible: false, reason: "condition_not_met" };
    if (spotUsdc < order.thresholdUsdc + margin) return { eligible: false, reason: "within_margin" };
  } else {
    if (spotUsdc > order.thresholdUsdc) return { eligible: false, reason: "condition_not_met" };
    if (spotUsdc > order.thresholdUsdc - margin) return { eligible: false, reason: "within_margin" };
  }

  // 3. SELL OTM pre-skip (avoid a doomed OptionNotInTheMoney tx). Only when the
  //    vault's strike + side are known; otherwise leave it to the on-chain core.
  if (order.kind === "sell" && o.strikeUsdc !== undefined && o.isCall !== undefined) {
    const itm = o.isCall ? spotUsdc > o.strikeUsdc : spotUsdc < o.strikeUsdc;
    if (!itm) return { eligible: false, reason: "otm" };
  }

  // 4. BUY budget pre-check (avoid a doomed SlippageExceeded tx; trigger STAYS
  //    LIVE — just doesn't fire this tick, fires when the peg gets cheaper).
  if (order.kind === "buy") {
    if (o.pegPremiumTotalUsdc === undefined) return { eligible: false, reason: "quote_unavailable" };
    const budget = order.maxPremiumPerContract * order.quantity;
    if (o.pegPremiumTotalUsdc > budget) return { eligible: false, reason: "over_budget" };
  }

  return { eligible: true };
}

// ---- Discovery / batched-read helpers (exported for unit tests) ------------

const normHex = (h: string) => h.replace(/^0x/, "").toLowerCase();

/**
 * Stage 3 guard (exported for unit tests): build the per-market lookup maps for
 * a tick, EXCLUDING Switchboard-sourced markets (oracle_source==1) from the
 * Hermes feed set so their feedHash never enters the batched price request.
 * Returns `sbMarkets` (their pubkeys) so the tick loop can skip their orders.
 * execute_trigger HAS an SB arm, but this keeper builds a Pyth/Hermes read + a
 * Pyth-only execute ctx — firing on an SB market would 404 the feed and assemble
 * a wrong-spot / reverting tx. A skipped trigger is honest; a wrong fill is not.
 */
export function buildTriggerMarketMaps(
  markets: { publicKey: PublicKey; account: any }[],
  sbEnabled: boolean = TRIGGER_SB_ENABLED,
): {
  marketRec: Map<string, { publicKey: PublicKey; account: any }>;
  marketFeed: Map<string, string>;
  sbMarkets: Set<string>;
} {
  const marketRec = new Map<string, { publicKey: PublicKey; account: any }>();
  const marketFeed = new Map<string, string>();
  const sbMarkets = new Set<string>();
  for (const m of markets) {
    const pk = m.publicKey.toBase58();
    marketRec.set(pk, m);
    const isSb = (m.account.oracleSource as number) === 1;
    if (isSb) {
      sbMarkets.add(pk);
      // Flag OFF → prior behaviour verbatim: never enters the feed set, tick
      // skips it. Flag ON → routed like any other feed; `sbMarkets` becomes a
      // ROUTING tag (which tape to read / which ctx to assemble), not a denylist.
      if (!sbEnabled) continue;
    }
    // For an SB market `pyth_feed_id` holds the SB feedHash (verified on-chain:
    // market.pyth_feed_id === registry feedHash for all 24 SB markets).
    marketFeed.set(pk, normHex(hexFromBytes(m.account.pythFeedId as number[])));
  }
  return { marketRec, marketFeed, sbMarkets };
}

/** Split a tick's feed set by tape, so each is read from its own source:
 *  Pyth → batched Hermes; Switchboard → batched Crossbar simulate. */
export function splitFeedsByTape(
  orders: { market: string }[],
  marketFeed: Map<string, string>,
  sbMarkets: Set<string>,
): { pythFeeds: string[]; sbFeeds: string[] } {
  const pyth = new Set<string>();
  const sb = new Set<string>();
  for (const o of orders) {
    const f = marketFeed.get(o.market);
    if (!f) continue;
    (sbMarkets.has(o.market) ? sb : pyth).add(normHex(f));
  }
  return { pythFeeds: [...pyth], sbFeeds: [...sb] };
}

/** Unique feed-hex set across live orders (the dedupeFeedIds idea, hex-keyed). */
export function uniqueFeedHexes(
  orders: { market: string }[], marketFeed: Map<string, string>,
): string[] {
  const set = new Set<string>();
  for (const o of orders) {
    const f = marketFeed.get(o.market);
    if (f) set.add(normHex(f));
  }
  return [...set];
}

/** The batched Hermes latest-price URL: one request, N ids[]. */
export function buildHermesMultiUrl(base: string, feedHexes: string[]): string {
  const qs = feedHexes.map((h) => `ids[]=0x${normHex(h)}`).join("&");
  return `${base}/v2/updates/price/latest?${qs}&encoding=base64`;
}

// ============================================================================
// IMPURE deps (real impls; the dry-run harness + tests inject mocks)
// ============================================================================

export interface TickDeps {
  fetchTriggerOrders: () => Promise<{ publicKey: PublicKey; account: any }[]>;
  /** `required` is the set of keys this tick KNOWS it needs (every live order's
   *  market / vault). The cached implementation refreshes on a miss, so a new
   *  market is picked up on the first tick an order references it regardless of
   *  TTL. Optional so uncached test doubles need no change. */
  fetchMarkets: (required?: Iterable<string>) => Promise<{ publicKey: PublicKey; account: any }[]>;
  fetchVaults: (required?: Iterable<string>) => Promise<{ publicKey: PublicKey; account: any }[]>;
  readPrices: (feedHexes: string[]) => Promise<Map<string, SpotEntry>>;
  /** Diagnostics for the tick heartbeat. Optional: test doubles omit it. */
  cacheSnapshots?: () => Array<{ label: string; refreshes: number; ageRefreshes: number; missRefreshes: number; hits: number; size: number; ageMs: number }>;
  /** Switchboard WATCH tape (Crossbar simulate). Optional so existing callers
   *  and the Pyth-only tests need no change; absent ⇒ no SB spots. */
  readSbPrices?: (feedHexes: string[]) => Promise<Map<string, SpotEntry>>;
  quotePegTotalUsdc: (
    marketRec: { publicKey: PublicKey; account: any }, vi: VaultInfo, quantity: bigint,
  ) => Promise<bigint>;
  /** Production sender. NEVER called when dryRun — kept injectable so tests can
   *  assert it stays untouched in dry-run. */
  /** B1.5: resting asks on one series. Optional so existing callers/tests need
   *  no change; absent ⇒ no book discovery ⇒ peg fallback (unchanged). */
  fetchAsksForMint?: (optionMint: PublicKey) => Promise<BookAskView[]>;
  send: (
    view: TriggerView, feedHex: string, isSb?: boolean,
    book?: Record<string, PublicKey | null> | null,
  ) => Promise<string>;
  nowSec: () => number;
}

export interface TickConfig {
  dryRun: boolean;
  fireMarginBps: number;
  feedStaleSecs: number;
  usdcMint: PublicKey;
  programId: PublicKey;
  callerPubkey: PublicKey;
  /** B1.6 Address Lookup Table. A BOOK fire does not fit in a legacy tx: real
   *  book keys add 7 unique pubkeys and the SB tape also carries an ed25519
   *  quote ix (measured 1305 B > the 1232 limit). Resolving the static set
   *  through an ALT brings it to ~1031 B. null ⇒ legacy encoding: the PEG path
   *  still fires, a BOOK fire refuses LOUDLY rather than silently downgrading. */
  alt?: AddressLookupTableAccount | null;
}

const FETCHABLE = { triggerOrder: "triggerOrder", optionsMarket: "optionsMarket", sharedVault: "sharedVault" } as const;

/**
 * COST NOTE (measured 2026-08-07, crank/_rpc_burn_report.mjs). This helper is the
 * single largest RPC consumer in the whole system: at the old 15s tick it issued
 * 5,720 getProgramAccounts/day, 98.6% of ALL gPA traffic on the Helius key, while
 * every tick logged triggersFound: 0. That is what exhausted the key on 2026-08-06.
 *
 * The tick is now 5min (see TRIGGER-UI-REVERT below). If you add a caller here,
 * or restore the 15s tick with the trigger UI, re-run the burn report first.
 */
/** Crank-local getProgramAccounts + fresh-IDL coder decode (orphan-tolerant).
 *  `extraFilters` are ANDed with the discriminator memcmp — e.g. a memcmp on a
 *  field offset to scope the scan (WriterPosition.vault @ offset 40). */
export async function fetchAllDecoded(
  program: anchor.Program<any>, name: string,
  extraFilters: { memcmp: { offset: number; bytes: string } }[] = [],
): Promise<{ publicKey: PublicKey; account: any }[]> {
  const { bytes } = program.coder.accounts.memcmp(name);
  const raw = await program.provider.connection.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: bytes as string } }, ...extraFilters],
  });
  const out: { publicKey: PublicKey; account: any }[] = [];
  for (const r of raw) {
    try {
      out.push({ publicKey: r.pubkey, account: program.coder.accounts.decode(name, r.account.data) });
    } catch {
      /* stale-schema orphan — skip */
    }
  }
  return out;
}

export function toView(d: { publicKey: PublicKey; account: any }): TriggerView {
  const a = d.account;
  return {
    pubkey: d.publicKey.toBase58(),
    owner: (a.owner as PublicKey).toBase58(),
    market: (a.market as PublicKey).toBase58(),
    vault: (a.vault as PublicKey).toBase58(),
    optionMint: (a.optionMint as PublicKey).toBase58(),
    holderOptionAta: (a.holderOptionAta as PublicKey).toBase58(),
    kind: "stopEntryBuy" in a.kind ? "buy" : "sell",
    comparator: "lessOrEqual" in a.comparator ? "le" : "ge",
    thresholdUsdc: BigInt(a.thresholdUsdc.toString()),
    quantity: BigInt(a.quantity.toString()),
    maxPremiumPerContract: BigInt(a.maxPremium.toString()),
    // Anchor decodes Option<Pubkey> to the value or null.
    ocoLink: (a.ocoLink ?? a.oco_link ?? null) as PublicKey | null,
  };
}

export function toVaultInfo(d: { publicKey: PublicKey; account: any }): VaultInfo {
  const a = d.account;
  return {
    strikeUsdc: BigInt(a.strikePrice.toString()),
    isCall: "call" in a.optionType,
    spreadBps: Number(a.spreadBps ?? 0),
    carryRateBps: Number(a.carryRateBps ?? 0),
    expiry: Number(a.expiry.toString()),
  };
}

/** Assemble the 18-account execute_trigger context. `priceUpdate` is the
 *  ephemeral PriceUpdateV2 (real PDA in production; a placeholder for dry-run
 *  logging — it's posted in-tx). */
export function assembleExecuteAccounts(
  view: TriggerView, feedIdBytes: Buffer, usdcMint: PublicKey,
  caller: PublicKey, priceUpdate: PublicKey, programId: PublicKey,
  sb?: { queue: PublicKey } | null,
  /** B1.5: snake_case book accounts from assembleBookAccounts/assembleBidAccounts.
   *  Absent ⇒ all eleven stay null ⇒ on-chain `book_order.is_some()` is false ⇒
   *  the byte-identical vault-peg fallback. This is the ONLY way real book keys
   *  reach the wire. */
  book?: Record<string, PublicKey | null> | null,
): Record<string, PublicKey | null> {
  const triggerOrder = new PublicKey(view.pubkey);
  const optionMint = new PublicKey(view.optionMint);
  const vault = new PublicKey(view.vault);
  const owner = new PublicKey(view.owner);
  const seed = (s: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([Buffer.from(s), ...extra], programId)[0];
  // Anchor 0.32 optional accounts are passed as `null`, never omitted. Exactly
  // ONE tape is populated: Pyth → priceUpdate set / sb* null; Switchboard →
  // priceUpdate null / the three sb* set. This mirrors the single match site in
  // execute_trigger.rs (routed by market.oracle_source).
  const isSb = !!sb;
  return {
    caller,
    triggerOrder,
    market: new PublicKey(view.market),
    sharedVault: vault,
    vaultMintRecord: seed(VAULT_MINT_RECORD_SEED, [optionMint.toBuffer()]),
    optionMint,
    priceUpdate: isSb ? null : priceUpdate,
    volOracle: seed(VOL_ORACLE_SEED, [feedIdBytes]),
    protocolState: seed(PROTOCOL_SEED),
    treasury: seed(TREASURY_SEED),
    triggerEscrow: seed(TRIGGER_ESCROW_SEED, [triggerOrder.toBuffer()]),
    holderOptionAta: new PublicKey(view.holderOptionAta),
    ownerUsdcAccount: getAssociatedTokenAddressSync(usdcMint, owner, false, TOKEN_PROGRAM_ID),
    ownerWallet: owner,
    vaultUsdcAccount: seed(VAULT_USDC_SEED, [vault.toBuffer()]),
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    sbQueue: isSb ? sb!.queue : null,
    sbSlothashes: isSb ? SPL_SYSVAR_SLOT_HASHES_ID : null,
    sbInstructions: isSb ? SPL_SYSVAR_INSTRUCTIONS_ID : null, optaPriceFeed: null,
    // Phase B1: the ten book-fire optionals [21]-[30] — ALWAYS null on this
    // peg-path assembler (book fires are dark until the Jul-31 flip). accountsStrict
    // requires every IDL account to be specified, so these must be present-as-null;
    // Anchor substitutes the program-id sentinel → the on-chain arm reads them as
    // None → the byte-identical vault-peg path. When the flip wires book fires,
    // assembleBookAccounts (above) supplies real keys here instead of the nulls.
    bookOrder: book?.book_order ?? null,
    bookMaker: book?.book_maker ?? null,
    bookEscrow: book?.book_escrow ?? null,
    bookMakerUsdc: book?.book_maker_usdc ?? null,
    writerAskPot: book?.writer_ask_pot ?? null,
    writerAskPotUsdc: book?.writer_ask_pot_usdc ?? null,
    writerAskPosition: book?.writer_ask_position ?? null,
    bookHookMetas: book?.book_hook_metas ?? null,
    bookHookProgram: book?.book_hook_program ?? null,
    bookHookState: book?.book_hook_state ?? null,
    bookMakerOption: book?.book_maker_option ?? null,
    // [32] B3 OCO peer. accountsStrict requires EVERY account the IDL declares, so
    // omitting this fails the BUILD with "Account `ocoPeer` not provided" — the
    // keeper could not fire at all. The view carries the paired PDA when the order
    // is half of an OCO couple; null otherwise. When it IS set, execute_trigger
    // decrements the sibling in the same transaction, which is the whole point of
    // pairing on chain rather than in the keeper.
    ocoPeer: view.ocoLink ?? null,
  };
}

// ============================================================================
// Phase B1: book-fire selection + positional account assembly (PURE)
// ============================================================================
//
// DORMANT until the Jul-31 canary flip: the on-chain BOOK_TRIGGERS_ENABLED gate
// is dark in the feature-free prod build, so a StopEntryBuy that passes book
// accounts STILL routes to the vault peg. These helpers are unit-tested now so
// the flip session only has to wire discovery (fetch resting orders per
// option_mint) into the tick — the selection rule and the exact [21]-[30] layout
// are already proven against the on-chain struct.

export type BookAskKind = "writerAsk" | "resaleAsk";

/** Plain view of a resting ask eligible for a StopEntryBuy book fire. */
export interface BookAskView {
  pubkey: string;
  owner: string;
  optionMint: string;
  vault: string;
  kind: BookAskKind;
  pricePerContract: bigint; // 6-dec
  quantityRemaining: bigint;
}

/**
 * Choose the ask a StopEntryBuy should lift THIS fire — the cheapest resting ask
 * whose price ≤ the trigger's per-contract max_premium and that still has depth.
 * The on-chain arm re-validates price ≤ max_premium (AskPriceExceedsMax / 6080),
 * so this only governs WHICH ask the keeper hands over.
 *
 * Tie-break: a WriterAsk wins an exact price tie (primary board liquidity, and it
 * avoids the heavier Token-2022 hook transfer). A ResaleAsk is therefore only
 * selected when it is STRICTLY better-priced — "resale secondary: only if
 * better-priced within max_premium" from the branch spec.
 */
export function selectBestAsk(
  asks: BookAskView[], maxPremiumPerContract: bigint,
): BookAskView | undefined {
  let best: BookAskView | undefined;
  for (const a of asks) {
    if (a.quantityRemaining <= 0n) continue;
    if (a.pricePerContract > maxPremiumPerContract) continue;
    if (a.kind !== "writerAsk" && a.kind !== "resaleAsk") continue;
    if (!best) { best = a; continue; }
    if (a.pricePerContract < best.pricePerContract) { best = a; continue; }
    // Exact price tie → prefer WriterAsk (primary).
    if (a.pricePerContract === best.pricePerContract
        && a.kind === "writerAsk" && best.kind === "resaleAsk") {
      best = a;
    }
  }
  return best;
}

/**
 * Assemble the ten trailing book optionals in BOOK_ACCOUNT_ROLES order for the
 * chosen ask. WriterAsk → pot/position set, hook accounts null; ResaleAsk → hook
 * accounts set, pot/position null. Every PDA is derived from the same seeds the
 * on-chain runtime re-checks (execute_trigger.rs), so the keeper never sends a tx
 * the program would reject on a PDA mismatch. Key ORDER is pinned to
 * BOOK_ACCOUNT_ROLES (the assembler's unit test asserts both).
 */
export function assembleBookAccounts(
  ask: BookAskView, usdcMint: PublicKey, programId: PublicKey, hookProgramId: PublicKey,
): Record<string, PublicKey | null> {
  const order = new PublicKey(ask.pubkey);
  const maker = new PublicKey(ask.owner);
  const optionMint = new PublicKey(ask.optionMint);
  const seed = (s: string, extra: Buffer[] = [], pid = programId) =>
    PublicKey.findProgramAddressSync([Buffer.from(s), ...extra], pid)[0];
  const isWriter = ask.kind === "writerAsk";

  // Insertion order MUST equal BOOK_ACCOUNT_ROLES → the on-chain struct order.
  return {
    book_order: order,
    book_maker: maker,
    book_escrow: seed(RESTING_ORDER_ESCROW_SEED, [order.toBuffer()]),
    book_maker_usdc: getAssociatedTokenAddressSync(usdcMint, maker, false, TOKEN_PROGRAM_ID),
    writer_ask_pot: isWriter ? seed(WRITER_ASK_POT_SEED, [optionMint.toBuffer()]) : null,
    writer_ask_pot_usdc: isWriter ? seed(WRITER_ASK_POT_USDC_SEED, [optionMint.toBuffer()]) : null,
    writer_ask_position: isWriter
      ? seed(WRITER_ASK_POSITION_SEED, [optionMint.toBuffer(), maker.toBuffer()]) : null,
    book_hook_metas: isWriter ? null : seed(EXTRA_ACCOUNT_METAS_SEED, [optionMint.toBuffer()], hookProgramId),
    book_hook_program: isWriter ? null : hookProgramId,
    book_hook_state: isWriter ? null : seed(HOOK_STATE_SEED, [optionMint.toBuffer()], hookProgramId),
    // [31] is the SELL leg's delivery destination — never populated by a buy.
    book_maker_option: null,
  };
}

// ============================================================================
// Phase B2: sell-leg bid selection + positional account assembly (PURE)
// ============================================================================
//
// DORMANT until the flip, exactly as the B1 buy-side helpers are. Additionally
// dormant in PRACTICE: the live bid side is empty by design today, so
// selectBestBid returns undefined on every real board and the tick emits the
// quiet skip class below rather than a fire. These are unit-tested now so the
// flip session only has to wire bid discovery into the tick.

/** Plain view of a resting bid eligible for a sell-leg fire. */
export interface BookBidView {
  pubkey: string;
  owner: string;
  optionMint: string;
  vault: string;
  pricePerContract: bigint; // 6-dec
  quantityRemaining: bigint;
}

/**
 * Choose the bid a sell trigger should hit THIS fire — the HIGHEST-priced resting
 * bid that still has depth and that meets the owner's stored per-contract
 * minimum-proceeds floor. Mirror image of `selectBestAsk` (cheapest within a
 * ceiling ↔ dearest above a floor).
 *
 * `floorPerContract` is the trigger's `max_premium` read with its sell-side
 * meaning. A floor of 0n means the trigger is BOOK INELIGIBLE — it was placed
 * before B2 (or deliberately without a floor), and the on-chain arm would revert
 * it with SellFloorRequired (6082), so never select a bid for it at all.
 *
 * The on-chain arm re-validates price >= floor (BidPriceBelowMin / 6083); this
 * only governs WHICH bid the keeper hands over. Returning `undefined` is the
 * normal, expected outcome and must be treated as skip-until-bid, not an error.
 */
export function selectBestBid(
  bids: BookBidView[], floorPerContract: bigint,
): BookBidView | undefined {
  if (floorPerContract <= 0n) return undefined; // book ineligible — 6082 on-chain
  let best: BookBidView | undefined;
  for (const b of bids) {
    if (b.quantityRemaining <= 0n) continue;
    if (b.pricePerContract < floorPerContract) continue;
    if (!best || b.pricePerContract > best.pricePerContract) best = b;
  }
  return best;
}

/**
 * Assemble the eleven [21]-[31] optionals in BOOK_ACCOUNT_ROLES order for a
 * sell-leg fire against `bid`. Populates [21]-[23] + [28]-[31]; [24]-[27] are
 * ask-only and stay null:
 *   [24] book_maker_usdc — a sell pays the TRIGGER OWNER out of the bid escrow,
 *        and owner_usdc_account (base slot 12) is that destination. The maker has
 *        no USDC leg on this side at all.
 *   [25]-[27] writer-ask pot/position — writer-ask bookkeeping, irrelevant to a
 *        bid fill (nothing is minted; the contract merely changes hands).
 *
 * `book_maker_option` is the bidder's option ATA. The on-chain arm pins it to
 * (bid.owner, option_mint) before the transfer, so deriving it here from exactly
 * those two values is what keeps the keeper from ever sending a rejectable tx.
 * It must EXIST at fire time — the caller prepends an idempotent ATA create.
 */
export function assembleBidAccounts(
  bid: BookBidView, programId: PublicKey, hookProgramId: PublicKey,
): Record<string, PublicKey | null> {
  const order = new PublicKey(bid.pubkey);
  const maker = new PublicKey(bid.owner);
  const optionMint = new PublicKey(bid.optionMint);
  const seed = (s: string, extra: Buffer[] = [], pid = programId) =>
    PublicKey.findProgramAddressSync([Buffer.from(s), ...extra], pid)[0];

  // Insertion order MUST equal BOOK_ACCOUNT_ROLES → the on-chain struct order.
  return {
    book_order: order,
    book_maker: maker,
    book_escrow: seed(RESTING_ORDER_ESCROW_SEED, [order.toBuffer()]),
    book_maker_usdc: null,
    writer_ask_pot: null,
    writer_ask_pot_usdc: null,
    writer_ask_position: null,
    book_hook_metas: seed(EXTRA_ACCOUNT_METAS_SEED, [optionMint.toBuffer()], hookProgramId),
    book_hook_program: hookProgramId,
    book_hook_state: seed(HOOK_STATE_SEED, [optionMint.toBuffer()], hookProgramId),
    book_maker_option: getAssociatedTokenAddressSync(optionMint, maker, false, TOKEN_2022_PROGRAM_ID),
  };
}

/** Why a sell trigger produced no book fire this tick. Both are QUIET, expected
 *  states — never errors, never `report.orderErrors`. */
export type SellSkipReason = "no_crossing_bid" | "book_ineligible";

export type SellRoute =
  | { route: "book"; bid: BookBidView }
  | { route: "vault" }
  | { route: "skip"; reason: SellSkipReason };

/**
 * Decide how a sell trigger is routed THIS tick. Pure — mirrors the on-chain
 * dispatch in execute_trigger's sell arm exactly, so the keeper never sends a tx
 * the program would refuse:
 *
 *   floor 0, TakeProfitSell   → vault  (unchanged fallback; 6082 on the book arm)
 *   floor 0, StopLossSell     → skip:book_ineligible  (no vault path exists)
 *   floor > 0, bid found      → book   (assembleBidAccounts supplies [21]-[31])
 *   floor > 0, no bid,  TP    → vault  (fall back rather than stall)
 *   floor > 0, no bid,  SL    → skip:no_crossing_bid
 *
 * SKIP-UNTIL-BID IS THE STEADY STATE. The bid side is empty by design today, so
 * `no_crossing_bid` is what every live StopLossSell returns on every tick until
 * writer bids ship. It is logged at the quiet `skip` class alongside
 * condition_not_met — a stop-loss with nothing to cross is a market fact, not a
 * keeper failure, and must never page anyone.
 */
export function classifySellRoute(
  kind: "takeProfitSell" | "stopLossSell",
  floorPerContract: bigint,
  bids: BookBidView[],
): SellRoute {
  const bid = selectBestBid(bids, floorPerContract);
  if (bid) return { route: "book", bid };
  if (kind === "takeProfitSell") return { route: "vault" };
  return { route: "skip", reason: floorPerContract <= 0n ? "book_ineligible" : "no_crossing_bid" };
}

/**
 * B1.5 — DISCOVERY. Enumerate every resting ask on ONE series, decoded to the
 * plain view `selectBestAsk` consumes. gPA filtered by account discriminator +
 * `option_mint` (offset 8 owner, 40 option_mint: disc8 + owner32), so the scan
 * is one series, not the whole book.
 *
 * Decode is per-account in try/catch (safeFetchAll semantics) — Anchor's .all()
 * dies on a single stale-discriminator orphan and would empty the whole scan.
 * Zero-depth orders are dropped here so the selector never sees them; Bids are
 * dropped because this is the BUY side (a StopEntryBuy lifts asks only).
 */
export async function enumerateAsksForMint(
  program: anchor.Program<any>, optionMint: PublicKey,
): Promise<BookAskView[]> {
  const connection: Connection = program.provider.connection;
  const { offset, bytes } = (program.coder.accounts as any).memcmp("restingOrder");
  const raw = await connection.getProgramAccounts(program.programId, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset, bytes } },
      // RestingOrder layout: disc(8) owner(32) option_mint(32) ...
      { memcmp: { offset: 8 + 32, bytes: optionMint.toBase58() } },
    ],
  });
  const out: BookAskView[] = [];
  for (const { pubkey, account } of raw) {
    let r: any;
    try {
      r = program.coder.accounts.decode("restingOrder", account.data);
    } catch {
      continue;
    }
    const kind: BookAskKind | null = r.kind && "writerAsk" in r.kind
      ? "writerAsk"
      : r.kind && "resaleAsk" in r.kind
        ? "resaleAsk"
        : null;
    if (!kind) continue; // Bid / VaultPeg are not liftable by a StopEntryBuy
    const quantityRemaining = BigInt(String(r.quantityRemaining ?? r.quantity_remaining ?? 0));
    if (quantityRemaining <= 0n) continue; // zero depth ⇒ never offer it
    out.push({
      pubkey: pubkey.toBase58(),
      owner: new PublicKey(r.owner).toBase58(),
      optionMint: new PublicKey(r.optionMint ?? r.option_mint).toBase58(),
      vault: new PublicKey(r.vault).toBase58(),
      kind,
      pricePerContract: BigInt(String(r.pricePerContract ?? r.price_per_contract ?? 0)),
      quantityRemaining,
    });
  }
  return out;
}

/**
 * B1.5 — the whole buy-side book decision for one trigger, pure given `asks`.
 * Returns the eleven snake_case book accounts, or null to leave them null (the
 * vault-peg fallback). Kept separate from the tick so the fallback path is
 * unit-testable without RPC.
 */
export function bookAccountsForBuy(
  asks: BookAskView[], maxPremiumPerContract: bigint,
  usdcMint: PublicKey, programId: PublicKey, hookProgramId: PublicKey = HOOK_PROGRAM_ID,
): Record<string, PublicKey | null> | null {
  const best = selectBestAsk(asks, maxPremiumPerContract);
  if (!best) return null;
  return assembleBookAccounts(best, usdcMint, programId, hookProgramId);
}

/**
 * B1.6 — load the trigger ALT and assert it is the RIGHT table for this cluster.
 *
 * The boot assertion is not ceremony: the SB queue is cluster-specific, so a
 * mainnet keeper pointed at the devnet table would resolve a WRONG queue and
 * every SB fire would verify a quote from the wrong oracle set. Fail at boot,
 * loudly, rather than at fire time.
 */
export async function loadTriggerAlt(
  connection: Connection, address: string, expectedSbQueue: PublicKey,
): Promise<AddressLookupTableAccount> {
  const res = await connection.getAddressLookupTable(new PublicKey(address));
  if (!res.value) throw new Error(`OPTA_TRIGGER_ALT ${address} not found on this cluster`);
  const addrs = res.value.state.addresses;
  if (!addrs.some((a) => a.equals(expectedSbQueue))) {
    throw new Error(
      `OPTA_TRIGGER_ALT ${address} does not contain the expected SB queue ${expectedSbQueue.toBase58()} — wrong cluster's table?`,
    );
  }
  return res.value;
}

/** Build the execute_trigger instruction (offline — no RPC). */
export async function buildExecuteTriggerIx(
  program: anchor.Program<any>, accounts: Record<string, PublicKey | null>,
): Promise<TransactionInstruction> {
  const ix = await program.methods.executeTrigger().accountsStrict(accounts).instruction();

  // Slot-content guard, added 2026-08-17. Only meaningful on a book fire that
  // actually resolved a pot — on the vault-peg route and on sells these are null
  // by design, and Anchor writes the program id into the slot for an absent
  // optional account, which is correct and must not be flagged.
  //
  // Why slots and not a count: measured 2026-08-17, `accountsStrict` silently
  // drops accounts an outdated IDL does not declare, and the count guard this
  // replaces elsewhere missed a partial IDL regression that left the length in
  // an acceptable range. execute_trigger is 32 accounts with the pot at
  // [25]/[26]; if either has shifted, the positional layout no longer matches
  // execute_trigger.rs and the fire must not be sent.
  const pot = accounts.writerAskPot ?? null;
  const potUsdc = accounts.writerAskPotUsdc ?? null;
  if (pot && potUsdc) {
    assertPotSlots(
      ix,
      [
        { slot: POT_SLOTS.execute_trigger.pot, expected: pot, name: "writer_ask_pot" },
        {
          slot: POT_SLOTS.execute_trigger.potUsdc,
          expected: potUsdc,
          name: "writer_ask_pot_usdc",
        },
      ],
      { instruction: "execute_trigger" },
    );
  }

  return ix;
}

/**
 * Batched Switchboard WATCH read via Crossbar simulate — the SB twin of
 * `readPricesBatched` (one request, N feedHashes). Crossbar returns the same
 * aggregated value the signed quote will carry, so it is the right tape for
 * deciding WHEN to fire; the authoritative price is still re-read on-chain from
 * a verified quote inside execute_trigger. Failures are non-fatal: an empty map
 * just means "no SB spot this tick" → those triggers skip as stale_feed.
 */
export async function readSbPricesBatched(
  feedHexes: string[],
  crossbar: { simulateFeeds: (h: string[]) => Promise<any[]> },
  nowSec: number,
): Promise<Map<string, SpotEntry>> {
  const out = new Map<string, SpotEntry>();
  if (feedHexes.length === 0) return out;
  const res = await crossbar.simulateFeeds(feedHexes.map((h) => `0x${normHex(h)}`));
  for (const r of res ?? []) {
    // Crossbar's response key is `feedId` (hex, no 0x) and `results` are STRINGS
    // — verified against the live endpoint 2026-07-22:
    //   {feedId:"5f42a2a7…", feedName:"JUP/USD", results:["0.19320000","0.19283"]}
    const hex = normHex(String(r?.feedId ?? r?.feedHash ?? r?.feed ?? ""));
    // Per-job results → median (the same aggregation the signed quote carries).
    const vals = (r?.results ?? []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
    if (!hex || vals.length === 0) continue;
    vals.sort((a: number, b: number) => a - b);
    const median = vals[Math.floor(vals.length / 2)];
    // Crossbar has no publish timestamp per feed; it is a live pull, so stamp it
    // `now` — staleness for SB is enforced on-chain (150-slot quote max_age).
    out.set(hex, { priceFloat: median, publishTime: nowSec });
  }
  return out;
}

// ============================================================================
// Sleep / program-load
// ============================================================================

async function sleepInterruptibly(totalMs: number, shouldStop: () => boolean): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0 && !shouldStop()) {
    const chunk = Math.min(remaining, SHUTDOWN_CHECK_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}

/** Build an anchor Program from the CRANK-LOCAL fresh IDL (has execute_trigger
 *  + triggerOrder). Loosely typed (Program<any>) — runtime IDL drives methods. */
export function loadTriggerProgram(connection: Connection, wallet: SignerWallet): anchor.Program<any> {
  const idl = JSON.parse(fs.readFileSync(CRANK_IDL_PATH, "utf-8"));
  const provider = new anchor.AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
  return new anchor.Program(idl as anchor.Idl, provider) as anchor.Program<any>;
}

// ============================================================================
// Fire (dry-run plan vs production send)
// ============================================================================

async function fireTrigger(
  ctx: TriggerCrankContext, program: anchor.Program<any>, view: TriggerView,
  feedHex: string, cfg: TickConfig, extra: Record<string, unknown>, deps: TickDeps,
  isSb: boolean = false, sbQueue?: PublicKey,
  book?: Record<string, PublicKey | null> | null,
): Promise<void> {
  if (cfg.dryRun) {
    const feedIdBytes = Buffer.from(normHex(feedHex), "hex");
    const accounts = assembleExecuteAccounts(
      view, feedIdBytes, cfg.usdcMint, cfg.callerPubkey, PublicKey.default, cfg.programId,
      isSb && sbQueue ? { queue: sbQueue } : null, book,
    );
    const ix = await buildExecuteTriggerIx(program, accounts);
    ctx.log("info", "DRY-RUN would send execute_trigger", {
      event: "would-send",
      trigger: view.pubkey,
      kind: view.kind,
      owner: view.owner,
      computeUnitLimit: EXECUTE_CU_LIMIT,
      tape: isSb ? "switchboard" : "pyth",
      txPlan: isSb
        ? [
            `ComputeBudget.setComputeUnitLimit(${EXECUTE_CU_LIMIT})`,
            "ed25519 verify(signed SB quote, ix idx 1)",
            "execute_trigger(price_update:null, sb_queue/slothashes/instructions)",
          ]
        : [
            `ComputeBudget.setComputeUnitLimit(${EXECUTE_CU_LIMIT})`,
            "pyth post_update_atomic(fresh VAA)",
            "execute_trigger",
          ],
      accounts: ix.keys.map((k, i) => ({
        i, role: EXECUTE_ACCOUNT_ROLES[i] ?? "?", pubkey: k.pubkey.toBase58(),
        signer: k.isSigner, writable: k.isWritable,
      })),
      route: book ? "book" : "vault-peg",
      ...extra,
      note: "DRY RUN — NOT sent; price_update shown as placeholder (ephemeral, posted in-tx); on-chain execute_trigger re-checks EMA + condition",
    });
    return;
  }
  const sig = await deps.send(view, feedHex, isSb, book);
  ctx.log("info", "execute_trigger sent", {
    event: "fired", trigger: view.pubkey, kind: view.kind,
    tape: isSb ? "switchboard" : "pyth", route: book ? "book" : "vault-peg", sig,
  });
}

// ============================================================================
// One tick (injectable deps)
// ============================================================================

export async function tickOnce(
  ctx: TriggerCrankContext, program: anchor.Program<any>, cfg: TickConfig,
  state: { backoff: BackoffState }, deps: TickDeps,
): Promise<TickReport> {
  const startMs = Date.now();
  const report: TickReport = {
    triggersFound: 0, fired: 0, skippedStaleFeed: 0, skippedConditionNotMet: 0,
    skippedWithinMargin: 0, skippedOtm: 0, skippedOverBudget: 0,
    skippedQuoteUnavailable: 0, skippedSbMarket: 0, orderErrors: 0, durationMs: 0,
  };

  const orders = await deps.fetchTriggerOrders();
  report.triggersFound = orders.length;
  if (orders.length === 0) {
    report.durationMs = Date.now() - startMs;
    ctx.log("info", "trigger tick: no live triggers", { ...report, cache: deps.cacheSnapshots?.() });
    return report;
  }

  // Tell the cache what this tick actually needs. Any market or vault an order
  // references but the cache has not seen forces one refresh, so a brand-new
  // market enters evaluation on the FIRST tick an order points at it — the TTL
  // only bounds staleness of already-known accounts, it never hides a new one.
  const needMarkets = new Set(orders.map((o) => o.account.market.toBase58()));
  const needVaults = new Set(orders.map((o) => o.account.vault.toBase58()));
  const [markets, vaults] = await Promise.all([
    deps.fetchMarkets(needMarkets),
    deps.fetchVaults(needVaults),
  ]);
  // Stage 3 guard: exclude Switchboard-sourced markets from the Hermes feed set
  // and collect their pubkeys so the loop skips their orders (see helper).
  const { marketRec, marketFeed, sbMarkets } = buildTriggerMarketMaps(markets);
  const vaultInfo = new Map<string, VaultInfo>();
  for (const v of vaults) vaultInfo.set(v.publicKey.toBase58(), toVaultInfo(v));

  const views = orders.map(toView);
  // Pyth feeds go to Hermes; SB feeds go to Crossbar. When the SB flag is OFF
  // `marketFeed` has no SB entries at all, so `sbFeeds` is empty and this is the
  // prior single-tape behaviour verbatim.
  const { pythFeeds, sbFeeds } = splitFeedsByTape(views, marketFeed, sbMarkets);
  const feedHexes = pythFeeds;

  // ---- BATCHED Hermes read (one request) with AIMD backoff ----------------
  await sleepInterruptibly(state.backoff.currentMs, ctx.shouldShutdown); // pace
  if (ctx.shouldShutdown()) { report.durationMs = Date.now() - startMs; return report; }
  let prices: Map<string, SpotEntry>;
  try {
    prices = await deps.readPrices(feedHexes);
    // SB tape (additive, own source): a Crossbar failure must not poison the
    // Pyth arm, so it is caught separately and degrades to "no SB spot".
    if (sbFeeds.length > 0 && deps.readSbPrices) {
      try {
        for (const [k, v] of await deps.readSbPrices(sbFeeds)) prices.set(k, v);
      } catch (sbErr) {
        ctx.log("warn", "sb crossbar read failed (SB triggers skip this tick)", {
          feeds: sbFeeds.length, err: String(sbErr).slice(0, 140),
        });
      }
    }
    backoffOnOk(state.backoff, DEFAULT_BACKOFF_BASE_MS);
  } catch (err) {
    const cls = classifyHermesError(err);
    if (cls === "rate-limit") backoffOn429(state.backoff, DEFAULT_BACKOFF_CEILING_MS);
    ctx.log(cls === "rate-limit" ? "warn" : "error", "trigger tick: batched price read failed", {
      class: cls, feeds: feedHexes.length, err: String(err),
      hermesBackoffMs: state.backoff.currentMs,
    });
    report.durationMs = Date.now() - startMs;
    return report; // skip the whole tick; retry next interval
  }

  const nowSec = deps.nowSec();

  for (let idx = 0; idx < views.length; idx++) {
    if (ctx.shouldShutdown()) break;
    const view = views[idx];
    // Stage 3: skip triggers whose parent market is Switchboard-sourced (see the
    // marketFeed build above). Counted so the skipped volume stays visible.
    // Flag OFF → SB markets are still counted-and-skipped (prior behaviour).
    // Flag ON → they fall through and are routed by tape below.
    if (sbMarkets.has(view.market) && !TRIGGER_SB_ENABLED) {
      report.skippedSbMarket++; continue;
    }
    try {
      const feedHex = marketFeed.get(view.market);
      const spot = feedHex ? prices.get(feedHex) : undefined;
      const vi = vaultInfo.get(view.vault);

      // First pass WITHOUT a quote (cheap): resolves stale/condition/margin/OTM.
      // A BUY that clears those returns quote_unavailable → we then simulate the
      // peg premium and re-evaluate. This avoids a get_option_price sim on every
      // condition-not-met BUY.
      let decision = evaluateTrigger(view, {
        spot, nowSec, maxStaleSecs: cfg.feedStaleSecs, fireMarginBps: cfg.fireMarginBps,
        pegPremiumTotalUsdc: undefined, strikeUsdc: vi?.strikeUsdc, isCall: vi?.isCall,
      });
      let extra: Record<string, unknown> = {};
      if (!decision.eligible && decision.reason === "quote_unavailable" && view.kind === "buy" && vi) {
        const mrec = marketRec.get(view.market);
        if (mrec) {
          const pegTotal = await deps.quotePegTotalUsdc(mrec, vi, view.quantity);
          const budget = view.maxPremiumPerContract * view.quantity;
          extra = { premiumTotalUsdc: pegTotal.toString(), budgetUsdc: budget.toString() };
          decision = evaluateTrigger(view, {
            spot, nowSec, maxStaleSecs: cfg.feedStaleSecs, fireMarginBps: cfg.fireMarginBps,
            pegPremiumTotalUsdc: pegTotal, strikeUsdc: vi.strikeUsdc, isCall: vi.isCall,
          });
        }
      }
      if (view.kind === "sell") extra = { intrinsic: "enforced on-chain (OptionNotInTheMoney if OTM)" };

      if (decision.eligible) {
        // B1.5 BOOK DISCOVERY. A StopEntryBuy lifts the live ask board when one
        // is crossable within its per-contract ceiling; anything else (no asks,
        // all over budget, discovery error) leaves the eleven optionals null and
        // takes the byte-identical vault-peg fallback. Discovery failure must
        // NEVER block a fire — the peg path is always still available.
        let book: Record<string, PublicKey | null> | null = null;
        if (view.kind === "buy" && deps.fetchAsksForMint) {
          try {
            const asks = await deps.fetchAsksForMint(new PublicKey(view.optionMint));
            book = bookAccountsForBuy(
              asks, view.maxPremiumPerContract, cfg.usdcMint, cfg.programId,
            );
            ctx.log("info", "book discovery", {
              event: "book-discovery", trigger: view.pubkey, asksFound: asks.length,
              maxPremium: view.maxPremiumPerContract.toString(),
              route: book ? "book" : "vault-peg",
              ask: book?.book_order?.toBase58() ?? null,
            });
          } catch (err) {
            book = null;
            ctx.log("warn", "book discovery failed (falling back to vault peg)", {
              trigger: view.pubkey, err: String(err).slice(0, 160),
            });
          }
        }
        await fireTrigger(
          ctx, program, view, feedHex!, cfg, extra, deps,
          sbMarkets.has(view.market), sbQueueFor(feedHex!), book,
        );
        report.fired++;
      } else {
        switch (decision.reason) {
          case "stale_feed": report.skippedStaleFeed++; break;
          case "condition_not_met": report.skippedConditionNotMet++; break;
          case "within_margin": report.skippedWithinMargin++; break;
          case "otm": report.skippedOtm++; break;
          case "over_budget": report.skippedOverBudget++; break;
          case "quote_unavailable": report.skippedQuoteUnavailable++; break;
        }
        ctx.log("info", "trigger skipped", {
          event: "skip", trigger: view.pubkey, kind: view.kind, reason: decision.reason, ...extra,
        });
      }
    } catch (err) {
      report.orderErrors++;
      ctx.log("error", "trigger order errored (skipped, tick continues)", {
        trigger: view.pubkey, err: String(err),
      });
    }
  }

  if (report.skippedSbMarket > 0) {
    ctx.log("info", "trigger tick: skipped Switchboard-sourced markets (out of keeper scope)", {
      skippedSbMarket: report.skippedSbMarket,
    });
  }
  report.durationMs = Date.now() - startMs;
  ctx.log("info", "trigger tick complete", { ...report, cache: deps.cacheSnapshots?.() });
  return report;
}

// ============================================================================
// Real deps (wired from the live program + Hermes)
// ============================================================================

/** Batched Hermes latest-price read → map(feedHex → {priceFloat, publishTime}). */
export async function readPricesBatched(
  feedHexes: string[], hermesBase: string,
): Promise<Map<string, SpotEntry>> {
  const out = new Map<string, SpotEntry>();
  if (feedHexes.length === 0) return out;
  const url = buildHermesMultiUrl(hermesBase, feedHexes);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Hermes price HTTP ${resp.status}`);
  const json: any = await resp.json();
  for (const p of json?.parsed ?? []) {
    const id = normHex(String(p.id ?? ""));
    const px = p.price;
    if (!px || typeof px.price !== "string" || typeof px.expo !== "number") continue;
    const value = parseFloat(px.price) * Math.pow(10, px.expo);
    if (!Number.isFinite(value)) continue;
    out.set(id, { priceFloat: value, publishTime: typeof px.publish_time === "number" ? px.publish_time : 0 });
  }
  return out;
}

function realDeps(
  ctx: TriggerCrankContext, program: anchor.Program<any>, cfg: TickConfig,
): TickDeps {
  // Held ACROSS ticks: this is the whole point. Constructed once per keeper
  // process, so a quiet board costs 1 gPA/tick (the orders scan) instead of 3.
  const marketCache = new AccountCache(
    () => fetchAllDecoded(program, FETCHABLE.optionsMarket), ACCOUNT_CACHE_TTL_MS, "markets");
  const vaultCache = new AccountCache(
    () => fetchAllDecoded(program, FETCHABLE.sharedVault), ACCOUNT_CACHE_TTL_MS, "vaults");
  return {
    fetchTriggerOrders: () => fetchAllDecoded(program, FETCHABLE.triggerOrder),
    fetchMarkets: (req) => marketCache.get(req),
    fetchVaults: (req) => vaultCache.get(req),
    // Exposed so the tick heartbeat can REPORT the cache rather than leave its
    // effect to be inferred from a unit test. 2B shipped the cache with no
    // on-box evidence that the gPA reduction actually happened; this closes that.
    cacheSnapshots: () => [marketCache.snapshot(), vaultCache.snapshot()],
    readPrices: (feeds) => readPricesBatched(feeds, ctx.hermesBase),
    readSbPrices: TRIGGER_SB_ENABLED
      ? async (feeds) => {
          const { CrossbarClient } = await import("@switchboard-xyz/common");
          const crossbar = new CrossbarClient(DEFAULT_CROSSBAR_URL);
          return readSbPricesBatched(feeds, crossbar as any, Math.floor(Date.now() / 1000));
        }
      : undefined,
    quotePegTotalUsdc: async (mrec, vi, quantity) => {
      const q = await fetchOptionPriceQuote(program as any, mrec as any, {
        strike: Number(vi.strikeUsdc) / 1_000_000,
        expiryTs: vi.expiry,
        side: vi.isCall ? "call" : "put",
        exerciseStyle: "american",
        carryRateBps: vi.carryRateBps,
      });
      const perContract6 = BigInt(Math.round(q.premiumPerContract * 1_000_000));
      return applySpreadFloor(perContract6, vi.spreadBps) * quantity;
    },
    send: async (view, feedHex, isSb, book) => (isSb
      ? fireProductionSb(ctx, program, view, feedHex, cfg, book)
      : fireProduction(ctx, program, view, feedHex, cfg, book)),
    fetchAsksForMint: async (optionMint) => enumerateAsksForMint(program, optionMint),
    nowSec: () => Math.floor(Date.now() / 1000),
  };
}

/** PRODUCTION send (P3): atomic post_update_atomic(fresh VAA) + CU + execute_trigger.
 *  Gated behind !dryRun — NOT exercised this pass. */
/**
 * SB fire path — the twin of the Pyth builder above. Tx shape is exactly the
 * sbOracleCrank push shape: [CU, ed25519(idx 1), execute_trigger(SB accounts,
 * price_update:null)]. `instructionIdx: 1` is load-bearing — execute_trigger
 * locates the signature via find_ed25519_ix_index over the Instructions sysvar.
 */
async function fireProductionSb(
  ctx: TriggerCrankContext, program: anchor.Program<any>, view: TriggerView,
  feedHex: string, cfg: TickConfig,
  /** B1.5 book optionals, or null/absent for the vault-peg fallback. */
  book?: Record<string, PublicKey | null> | null,
): Promise<string> {
  // Lazy imports keep the SB SDK off the dry-run/test path.
  const [{ buildManagedQuoteUpdateIxs }, reg, sbSdk, web3] = await Promise.all([
    import("./switchboardQuotePost"),
    import("./sbFeedRegistry"),
    import("@switchboard-xyz/on-demand"),
    import("@solana/web3.js"),
  ]);
  const { CrossbarClient } = await import("@switchboard-xyz/common");

  const entry = reg.lookupSbFeed(feedHex);
  if (!entry) throw new Error(`feed ${normHex(feedHex).slice(0, 10)} not in SB registry`);

  const sbProgram = await (sbSdk as any).AnchorUtils.loadProgramFromConnection(
    ctx.connection, ctx.wallet as any, (sbSdk as any).ON_DEMAND_DEVNET_PID,
  );
  const qObj = new (sbSdk as any).Queue(sbProgram, (sbSdk as any).ON_DEMAND_DEVNET_QUEUE);
  const crossbar = new CrossbarClient(DEFAULT_CROSSBAR_URL);
  const edPid = (web3 as any).Ed25519Program.programId.toBase58();
  const oracleFeed = reg.buildOracleFeed(entry);

  // The execute_trigger ix is fixed; only the ed25519(quote) ix is re-fetched.
  const accounts = assembleExecuteAccounts(
    view, Buffer.from(normHex(feedHex), "hex"), cfg.usdcMint,
    ctx.wallet.publicKey, PublicKey.default, cfg.programId,
    { queue: entry.queue }, book,
  );
  const executeIx = await buildExecuteTriggerIx(program, accounts);
  const feedShort = normHex(feedHex).slice(0, 10);

  // Bounded retry-with-FRESH-quote (mirrors sbOracleCrank's warming push).
  // gateway/quote-fetch/transient-sim = retryable → re-fetch; a Custom program
  // error = the chain rejected the revalidation → terminal, stop this tick.
  let lastErr: unknown = new Error("no fire attempt ran");
  for (let attempt = 1; attempt <= DEFAULT_FIRE_MAX_ATTEMPTS; attempt++) {
    if (ctx.shouldShutdown()) throw new Error("shutdown during fire");

    // (a) FRESH signed quote → ed25519 ix. Never reuse a prior attempt's quote.
    let edIx: TransactionInstruction;
    try {
      const { ixs } = await buildManagedQuoteUpdateIxs(
        qObj, crossbar as any, oracleFeed, ctx.wallet.publicKey,
        { numSignatures: 2, instructionIdx: 1 },
      );
      const found = ixs.find((i: TransactionInstruction) => i.programId.toBase58() === edPid);
      if (!found) throw new Error("no ed25519 ix in managed-update output");
      edIx = found;
    } catch (err) {
      lastErr = err; // quote never reached the chain → always retryable
      ctx.log("info", "sb fire quote fetch failed (re-fetch fresh)", {
        trigger: view.pubkey, feed: feedShort, attempt, err: String(err).slice(0, 140),
      });
      continue;
    }

    // (b) [CU, ed25519(idx 1), execute_trigger(SB ctx, price_update:null)].
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: EXECUTE_CU_LIMIT }),
      edIx,
      executeIx,
    ];
    const { blockhash } = await ctx.connection.getLatestBlockhash("confirmed");
    // B1.6: resolve the static set through the ALT. A book fire WITHOUT a table
    // does not fit — refuse loudly instead of emitting a tx that cannot encode.
    if (book && !cfg.alt) {
      throw new Error(
        "book fire requires OPTA_TRIGGER_ALT (legacy encoding measured 1305 B > 1232 limit) — refusing to build",
      );
    }
    const msg = new (web3 as any).TransactionMessage({
      payerKey: ctx.wallet.publicKey, recentBlockhash: blockhash, instructions,
    }).compileToV0Message(cfg.alt ? [cfg.alt] : []);
    const tx = new (web3 as any).VersionedTransaction(msg);

    // (c) simulate-gate → classify. Terminal = the chain rejected it; do NOT
    //     retry (re-reading next tick is the correct path).
    const sim = await ctx.connection.simulateTransaction(tx, { commitment: "confirmed" });
    if (sim.value.err) {
      if (classifyFireError(sim.value.err) === "terminal") {
        ctx.log("info", "sb fire rejected on-chain (terminal, no retry)", {
          trigger: view.pubkey, feed: feedShort, attempt, err: JSON.stringify(sim.value.err),
        });
        throw new Error(`execute_trigger rejected: ${JSON.stringify(sim.value.err)}`);
      }
      lastErr = sim.value.err;
      ctx.log("info", "sb fire sim transient (re-fetch fresh)", {
        trigger: view.pubkey, feed: feedShort, attempt, err: JSON.stringify(sim.value.err),
      });
      continue;
    }

    // (d) sim clean → send. A send failure re-fetches a fresh quote next attempt.
    try {
      return await submitWithFallback(ctx.connection, ctx.wallet, [{ tx, signers: [] }] as any);
    } catch (err) {
      lastErr = err;
      ctx.log("info", "sb fire send failed (re-fetch fresh)", {
        trigger: view.pubkey, feed: feedShort, attempt, err: String(err).slice(0, 140),
      });
      continue;
    }
  }
  throw new Error(`sb fire exhausted ${DEFAULT_FIRE_MAX_ATTEMPTS} attempts: ${String(lastErr).slice(0, 160)}`);
}

async function fireProduction(
  ctx: TriggerCrankContext, program: anchor.Program<any>, view: TriggerView,
  feedHex: string, cfg: TickConfig,
  /** B1.5 book optionals, or null/absent for the vault-peg fallback. */
  book?: Record<string, PublicKey | null> | null,
): Promise<string> {
  // Lazy import keeps the receiver SDK off the dry-run/test path.
  const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
  const vaa = await fetchHermesUpdate(feedHex, ctx.hermesBase);
  const receiver = new PythSolanaReceiver({ connection: ctx.connection, wallet: ctx.wallet as any });
  if (book && !cfg.alt) {
    throw new Error(
      "book fire requires OPTA_TRIGGER_ALT (legacy encoding exceeds the 1232 B limit) — refusing to build",
    );
  }
  // PythSolanaReceiver takes the lookup table natively and already emits
  // versioned txs, so the peg and book paths stay ONE code path.
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true }, cfg.alt ?? undefined);
  await builder.addPostPriceUpdates([vaa.toString("base64")]);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: (k: string) => PublicKey | undefined) => {
    const priceUpdatePda = getPriceUpdateAccount(`0x${normHex(feedHex)}`);
    if (!priceUpdatePda) throw new Error(`no PriceUpdate PDA for feed ${feedHex}`);
    const accounts = assembleExecuteAccounts(
      view, Buffer.from(normHex(feedHex), "hex"), cfg.usdcMint, ctx.wallet.publicKey, priceUpdatePda, cfg.programId,
      null, book,
    );
    const ix = await buildExecuteTriggerIx(program, accounts);
    return [
      { instruction: ComputeBudgetProgram.setComputeUnitLimit({ units: EXECUTE_CU_LIMIT }), signers: [] },
      { instruction: ix, signers: [] },
    ];
  });
  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 0 });
  return submitWithFallback(ctx.connection, ctx.wallet, txs as any);
}

// ============================================================================
// Loop
// ============================================================================

function readOptions(options: TriggerCrankOptions): {
  tickMs: number; fireMarginBps: number; feedStaleSecs: number; dryRun: boolean; tickOnce: boolean;
} {
  const env = (k: string) => process.env[k];
  const intOr = (v: string | undefined, d: number) => {
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const dryRunRaw = (env("OPTA_TRIGGER_DRY_RUN") ?? "1").toLowerCase();
  return {
    tickMs: options.tickMs ?? intOr(env("OPTA_TRIGGER_TICK_MS"), DEFAULT_TRIGGER_TICK_MS),
    fireMarginBps: options.fireMarginBps ?? intOr(env("OPTA_TRIGGER_FIRE_MARGIN_BPS"), DEFAULT_FIRE_MARGIN_BPS),
    feedStaleSecs: options.feedStaleSecs ?? intOr(env("OPTA_TRIGGER_FEED_STALE_SECS"), DEFAULT_FEED_STALE_SECS),
    // Dry-run is ON unless explicitly "0"/"false" (never accidentally sends).
    dryRun: options.dryRun ?? !(dryRunRaw === "0" || dryRunRaw === "false"),
    tickOnce: !!options.tickOnce,
  };
}

export async function runTriggerCrank(
  ctx: TriggerCrankContext, options: TriggerCrankOptions = {},
): Promise<void> {
  const opt = readOptions(options);
  const program = loadTriggerProgram(ctx.connection, ctx.wallet);

  // Protocol state → canonical USDC mint (for owner USDC ATA derivation).
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PROTOCOL_SEED)], program.programId,
  );
  const protocolState: any = await (program.account as any).protocolState.fetch(protocolStatePda);
  const cfg: TickConfig = {
    dryRun: opt.dryRun,
    fireMarginBps: opt.fireMarginBps,
    feedStaleSecs: opt.feedStaleSecs,
    usdcMint: protocolState.usdcMint as PublicKey,
    programId: program.programId,
    callerPubkey: ctx.wallet.publicKey,
    alt: null,
  };
  // B1.6: optional, but REQUIRED for book fires. Unset ⇒ legacy encoding ⇒ the
  // peg path still fires and a book fire refuses loudly (never a silent downgrade).
  const altAddr = (process.env.OPTA_TRIGGER_ALT ?? "").trim();
  if (altAddr) {
    try {
      const { lookupSbFeed } = require("./sbFeedRegistry") as typeof import("./sbFeedRegistry");
      void lookupSbFeed;
    } catch { /* registry optional */ }
    cfg.alt = await loadTriggerAlt(ctx.connection, altAddr, SB_ON_DEMAND_QUEUE);
    ctx.log("info", "trigger ALT loaded", { alt: altAddr, entries: cfg.alt.state.addresses.length });
  } else {
    ctx.log("warn", "OPTA_TRIGGER_ALT unset — legacy encoding; BOOK fires will refuse", {});
  }
  const deps = realDeps(ctx, program, cfg);
  const state = { backoff: mkBackoff() };

  ctx.log("info", "trigger crank started", {
    hermesBase: ctx.hermesBase, tickMs: opt.tickMs, fireMarginBps: opt.fireMarginBps,
    feedStaleSecs: opt.feedStaleSecs, dryRun: opt.dryRun, tickOnce: opt.tickOnce,
    usdcMint: cfg.usdcMint.toBase58(),
  });

  if (opt.tickOnce) {
    try {
      const r = await tickOnce(ctx, program, cfg, state, deps);
      ctx.log("info", "trigger crank exiting (TICK_ONCE)", { ...r });
    } catch (err) {
      ctx.log("error", "trigger TICK_ONCE crashed", { err: String(err) });
      throw err; // non-zero exit
    }
    return;
  }

  // Continuous: tick on boot, then every fixed interval.
  await runTickWithGuard(ctx, program, cfg, state, deps);
  while (!ctx.shouldShutdown()) {
    await sleepInterruptibly(opt.tickMs, ctx.shouldShutdown);
    if (ctx.shouldShutdown()) break;
    await runTickWithGuard(ctx, program, cfg, state, deps);
  }
  ctx.log("info", "trigger crank stopped cleanly");
}

async function runTickWithGuard(
  ctx: TriggerCrankContext, program: anchor.Program<any>, cfg: TickConfig,
  state: { backoff: BackoffState }, deps: TickDeps,
): Promise<void> {
  try {
    await tickOnce(ctx, program, cfg, state, deps);
  } catch (err) {
    ctx.log("error", "trigger tick crashed (will retry next interval)", {
      err: String(err), stack: (err as any)?.stack,
    });
  }
}
