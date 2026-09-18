// =============================================================================
// pythPullPost.ts — Pyth Pull settle helpers
// =============================================================================
//
// Builds + submits the atomic transaction that posts a fresh PriceUpdateV2
// to the Pyth Receiver program and consumes it in our settle_expiry IX, all
// in one tx. The Pyth SDK's `closeUpdateAccounts: true` mode arranges
// post + consume + close into a single tx and reclaims rent for the
// ephemeral price account when the tx ends.
//
// Tx-size analysis (P4d): single-feed VAA ≈ 519 bytes, settle_expiry IX
// ≈ 150 bytes; comfortably under Solana's 1232-byte limit. The SDK will
// auto-split into multiple sequential txs if a future change ever pushes
// the budget — submitWithFallback handles that case.
//
// On-chain seed constants (verified against programs/opta/src/instructions/
//   - market PDA       : [b"market", asset_name.as_bytes()]            (variable)
//   - settlement PDA   : [b"settlement", asset_name.as_bytes(), &expiry.to_le_bytes()]
// =============================================================================

import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { withResolvedOutcome } from "./txOutcome";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  Signer,
  TransactionMessage,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { Program } from "@coral-xyz/anchor";
import type { Opta } from "../idl/opta";

/**
 * Minimal wallet shape both pythPullPost callers satisfy:
 *   browser → AnchorWallet from @solana/wallet-adapter-react
 *   Node    → Wallet from @coral-xyz/anchor (when used by crank/bot.ts)
 *
 * Defined structurally so the helper is portable across both runtimes
 * without runtime-specific imports.
 */
export type SignerWallet = {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
};

/**
 * Default Hermes endpoint. Mainnet (production-signed Wormhole VAAs that
 * devnet's Wormhole Core Bridge tracks). Override per-call via the
 * `hermesBase` arg to point at the Beta cluster
 * (`https://hermes-beta.pyth.network`) for staging.
 */
export const DEFAULT_HERMES_BASE = "https://hermes.pyth.network";

const HERMES_PRICE_PATH = "/v2/updates/price/latest";
const HERMES_HISTORICAL_PATH_PREFIX = "/v2/updates/price/";
const FETCH_TIMEOUT_MS = 15000;
const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 50_000;

// ---------------------------------------------------------------------------
// Window-walk tunables (see fetchHistoricalHermesUpdateInWindow)
// ---------------------------------------------------------------------------
const WALK_PROBE_OFFSETS_S = [0, 1, 3, 7, 15, 30, 60] as const;
/** When the first 200 lands at one of these offsets and the preceding offset
 *  was 404, do a backward linear refine over the small bracket between them
 *  to recover an earlier publish_time. Larger brackets ([15..30], [30..60])
 *  intentionally skip refine to bound the request budget. */
const WALK_REFINE_PREV_OFFSET: Record<number, number> = { 3: 1, 7: 3 };
const WALK_THROTTLE_MS = 500;
const WALK_RATE_LIMIT_RETRY_MS = 2000;
const WALK_MAX_CONSECUTIVE_429 = 2;

const MARKET_SEED = "market";
const SETTLEMENT_SEED = "settlement";
const VOL_ORACLE_SEED = "vol_oracle";
// Phase 3 retro-harden — settle_vault now derives the writer-ask pot from the
// canonical series-mint identity (see settle_vault.rs / create_series.rs).
const VAULT_OPTION_MINT_SEED = "vault_option_mint";
const WRITER_ASK_POT_SEED = "writer_ask_pot";
const WRITER_ASK_POT_USDC_SEED = "writer_ask_pot_usdc";

// ---------------------------------------------------------------------------
// Hermes off-chain endpoint helpers
// ---------------------------------------------------------------------------

async function hermesGet(feedIdHex: string, hermesBase: string): Promise<any> {
  const hex = feedIdHex.replace(/^0x/, "").toLowerCase();
  const url = `${hermesBase}${HERMES_PRICE_PATH}?ids[]=0x${hex}&encoding=base64`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) {
      // PROVENANCE RULE: surfaced verbatim in the exercise/settle toasts. The
      // 404 this used to print — "Hermes price HTTP 404" — was BOTH a vendor
      // leak and a lie: the feed was fine, we were asking the wrong service.
      console.warn("[pythPullPost] price fetch HTTP", resp.status, url);
      throw new Error("Price unavailable — try again.");
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the binary Wormhole VAA for a single feed_id. Pyth Receiver's
 *  post_update_atomic IX consumes this Buffer directly. */
export async function fetchHermesUpdate(
  feedIdHex: string,
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<Buffer> {
  const json = await hermesGet(feedIdHex, hermesBase);
  const b64 = json?.binary?.data?.[0];
  if (typeof b64 !== "string") {
    // Same toast path as the HTTP failure above — same rule.
    throw new Error("Price unavailable — try again.");
  }
  return Buffer.from(b64, "base64");
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Low-level Hermes historical probe. Returns an explicit result rather
 *  than throwing on HTTP errors, so the window-walker can distinguish
 *  404 / 429 / 5xx and decide whether to retry, throttle, or abort.
 *  Network and parse errors still propagate as thrown exceptions. */
type HermesProbeResult =
  | { ok: true; body: Buffer }
  | { ok: false; status: number; bodyText: string };

async function probeHistoricalHermes(
  feedIdHex: string,
  ts: number,
  hermesBase: string,
): Promise<HermesProbeResult> {
  const hex = feedIdHex.replace(/^0x/, "").toLowerCase();
  const url = `${hermesBase}${HERMES_HISTORICAL_PATH_PREFIX}${ts}?ids[]=0x${hex}&encoding=base64`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "<no body>");
      return { ok: false, status: resp.status, bodyText };
    }
    const json = await resp.json();
    const b64 = json?.binary?.data?.[0];
    if (typeof b64 !== "string") {
      // Synthetic non-2xx so the walker treats malformed responses as a
      // "miss" at this offset rather than throwing mid-walk.
      return { ok: false, status: 502, bodyText: "<missing binary.data[0]>" };
    }
    return { ok: true, body: Buffer.from(b64, "base64") };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the binary Wormhole VAA for a single feed_id at a SPECIFIC
 *  historical unix timestamp. Single-shot — throws on the first non-2xx.
 *  Used directly only by tests / future single-shot callers; the
 *  settlement path goes through fetchHistoricalHermesUpdateInWindow
 *  instead so small Hermes archive holes near the exact expiry second
 *  don't fail the settle.
 *
 *  NOTE: historical lookups go to /v2/updates/price/{publish_time}.
 *  /v1 was decommissioned in the 2026-05-20 Pyth cutover.
 */
export async function fetchHistoricalHermesUpdate(
  feedIdHex: string,
  publishTimeUnixSeconds: number,
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<Buffer> {
  if (!Number.isFinite(publishTimeUnixSeconds) || publishTimeUnixSeconds <= 0) {
    throw new Error(
      `fetchHistoricalHermesUpdate: invalid timestamp ${publishTimeUnixSeconds}`,
    );
  }
  const ts = Math.floor(publishTimeUnixSeconds);
  const result = await probeHistoricalHermes(feedIdHex, ts, hermesBase);
  if (!result.ok) {
    throw new Error(
      `Hermes historical price HTTP ${result.status} for ts=${ts}: ${result.bodyText}`,
    );
  }
  return result.body;
}

/** Settlement-aware historical fetch. Walks the on-chain settlement
 *  window forward looking for a Hermes update Hermes can serve, so a
 *  small archive gap near the exact expiry second doesn't fail the
 *  settle. settle_expiry.rs requires publish_time ∈ [expiry, expiry+60],
 *  and Hermes /v2/updates/price/{ts} returns the update AT (within a
 *  tiny tolerance) the requested second or 404 — it does NOT walk
 *  forward arbitrarily — so we walk client-side.
 *
 *  Strategy (worst case 10 requests):
 *    1. Exponential probe at offsets [0, 1, 3, 7, 15, 30, 60] s past
 *       expiry. First 200 wins.
 *    2. If the first 200 was at offset 3 or 7 AND the immediately-prior
 *       exp offset was a confirmed 404, linear-refine BACKWARD over the
 *       small bracket between them to find an earlier publish_time
 *       (better price-pinning). Wider brackets (15..30, 30..60) skip
 *       refine — sub-30s pinning sacrificed for request budget.
 *    3. 429 handling: each probe gets one 2 s rate-limit retry. If TWO
 *       probes in a row come back 429-after-retry, abort the walk early
 *       with an HTTP-429-classified error (different recovery path on
 *       the crank than 404).
 *    4. 500 ms throttle between consecutive probes.
 *
 *  On full-walk failure, throws with substring "HTTP 404" so the crank's
 *  classifySettleError routes to the hermes-no-update backoff path.
 *  On 429 abort, throws with substring "HTTP 429" for the rate-limit
 *  backoff path. */
export async function fetchHistoricalHermesUpdateInWindow(
  feedIdHex: string,
  expiry: number,
  windowSecs: number,
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<Buffer> {
  if (!Number.isFinite(expiry) || expiry <= 0) {
    throw new Error(
      `fetchHistoricalHermesUpdateInWindow: invalid expiry ${expiry}`,
    );
  }
  if (!Number.isFinite(windowSecs) || windowSecs < 0) {
    throw new Error(
      `fetchHistoricalHermesUpdateInWindow: invalid windowSecs ${windowSecs}`,
    );
  }

  const offsets = WALK_PROBE_OFFSETS_S.filter((o) => o <= windowSecs);
  const probedStatus = new Map<number, number>();
  const probedData = new Map<number, Buffer>();
  let consecutive429 = 0;

  // Probe a single offset within the walker. Handles the 2s/one-shot
  // 429 retry inline and tracks consecutive 429s. Return values:
  //   "ok"          – 200, body stashed in probedData[offset]
  //   "miss"        – any non-2xx (404, 5xx, or single 429-after-retry)
  //   "abort-429"   – two probes in a row hit 429-after-retry → caller throws
  async function walkProbe(
    offset: number,
  ): Promise<"ok" | "miss" | "abort-429"> {
    const ts = expiry + offset;
    let result = await probeHistoricalHermes(feedIdHex, ts, hermesBase);
    if (!result.ok && result.status === 429) {
      await sleepMs(WALK_RATE_LIMIT_RETRY_MS);
      result = await probeHistoricalHermes(feedIdHex, ts, hermesBase);
    }
    if (!result.ok && result.status === 429) {
      // Post-retry still 429 — counts against the consecutive-429 budget.
      consecutive429 += 1;
      probedStatus.set(offset, 429);
      if (consecutive429 >= WALK_MAX_CONSECUTIVE_429) return "abort-429";
      return "miss";
    }
    // Any non-429 outcome (including 200 / 404 / 5xx) resets the counter.
    consecutive429 = 0;
    if (result.ok) {
      probedData.set(offset, result.body);
      probedStatus.set(offset, 200);
      return "ok";
    }
    probedStatus.set(offset, result.status);
    return "miss";
  }

  // ---- Phase 1: exponential probe across the offsets ----
  let firstOkOffset: number | null = null;
  for (let i = 0; i < offsets.length; i++) {
    if (i > 0) await sleepMs(WALK_THROTTLE_MS);
    const r = await walkProbe(offsets[i]);
    if (r === "abort-429") {
      // MUST keep "HTTP 429" substring — bot.ts:466 classifySettleError uses
      // it to route to the rate-limit backoff path. Removing it routes to
      // "other" → wrong backoff (the data-gap recovery, which is wrong here).
      throw new Error(
        // PROVENANCE RULE: reaches a settle toast. The rate limit is real and
        // the remedy ("wait a moment") is actionable; which vendor imposed it
        // is not the user's business.
        `Price service is rate-limited — try again in a moment. [429, expiry=${expiry}]`,
      );
    }
    if (r === "ok") {
      firstOkOffset = offsets[i];
      break;
    }
  }

  if (firstOkOffset === null) {
    // MUST keep "HTTP 404" substring — bot.ts:466 classifySettleError uses
    // it to route to the hermes-no-update backoff path. Removing it routes
    // to "other" → wrong backoff (the rate-limit recovery, which is wrong here).
    throw new Error(
      `No price available in the 60-second window after expiry. Try again in a few minutes — likely a temporary gap. [404, expiry=${expiry}, probes=${probedStatus.size}]`,
    );
  }

  // ---- Phase 2: refine within small brackets (3→1, 7→3) only ----
  const refinePrev = WALK_REFINE_PREV_OFFSET[firstOkOffset];
  if (refinePrev !== undefined && probedStatus.get(refinePrev) === 404) {
    for (let off = refinePrev + 1; off < firstOkOffset; off++) {
      await sleepMs(WALK_THROTTLE_MS);
      const r = await walkProbe(off);
      if (r === "abort-429") {
        // MUST keep "HTTP 429" substring — see note above.
        throw new Error(
          // PROVENANCE RULE: reaches a settle toast. The rate limit is real and
        // the remedy ("wait a moment") is actionable; which vendor imposed it
        // is not the user's business.
        `Price service is rate-limited — try again in a moment. [429, expiry=${expiry}]`,
        );
      }
      if (r === "ok") {
        return probedData.get(off)!;
      }
    }
  }
  return probedData.get(firstOkOffset)!;
}

/** Fetch the parsed display price (USD float + publish_time). Used by the
 *  post-click confirmation modal so we can show "Settled at $X" without
 *  re-decoding the on-chain account. */
export async function fetchHermesParsedPrice(
  feedIdHex: string,
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<{ price: number; publishTime: number } | null> {
  try {
    const json = await hermesGet(feedIdHex, hermesBase);
    const p = json?.parsed?.[0]?.price;
    if (!p || typeof p.price !== "string" || typeof p.expo !== "number") {
      return null;
    }
    const value = parseFloat(p.price) * Math.pow(10, p.expo);
    return Number.isFinite(value)
      ? {
          price: value,
          publishTime: typeof p.publish_time === "number" ? p.publish_time : 0,
        }
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tx builder
// ---------------------------------------------------------------------------

export type BuiltTx = { tx: VersionedTransaction; signers: Signer[] };

/**
 * Compose the atomic post_update_atomic + settle_expiry transaction(s).
 * Returns an array because the SDK may split if we ever exceed tx size;
 * for our single-feed case this is virtually always length 1.
 */
export async function buildPostUpdateAndSettleTx(
  program: Program<Opta>,
  wallet: SignerWallet,
  assetName: string,
  expiry: number,
  feedIdHex: string,
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<BuiltTx[]> {
  // Historical fetch — VAA whose publish_time is at-or-after vault expiry,
  // walked forward within the on-chain settlement window so small Hermes
  // archive holes near the exact expiry second don't fail the settle.
  // settle_expiry then enforces the 60s window on-chain.
  const priceUpdateData = await fetchHistoricalHermesUpdateInWindow(
    feedIdHex,
    expiry,
    60, // must match settle_expiry.rs:67 EXPIRY_WINDOW_SECS
    hermesBase,
  );

  const receiver = new PythSolanaReceiver({
    connection: program.provider.connection,
    // SDK types expect NodeWallet (which has a `payer` Keypair); the
    // runtime only uses publicKey + signTransaction + signAllTransactions,
    // all present on AnchorWallet. Cast through `any` to bypass the
    // stricter-than-runtime type.
    wallet: wallet as any,
  });

  const builder = receiver.newTransactionBuilder({
    closeUpdateAccounts: true, // reclaim rent for the ephemeral PriceUpdateV2 at tx end
  });

  // SDK 0.14.0: a single addPostPriceUpdates call works for both atomic
  // (closeUpdateAccounts: true) and persistent (false) flows. There is no
  // separate "Atomic" method — that was a pre-investigation misread.
  // The SDK expects base64 strings, not raw Buffers — re-encode here.
  await builder.addPostPriceUpdates([priceUpdateData.toString("base64")]);

  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    // The receiver's helper indexes by 0x-prefixed lowercase hex.
    const hexKey = `0x${feedIdHex.replace(/^0x/, "").toLowerCase()}`;
    const priceUpdatePda = getPriceUpdateAccount(hexKey);
    if (!priceUpdatePda) {
      throw new Error(`No ephemeral PriceUpdate PDA for feed ${feedIdHex}`);
    }

    const expiryBN = new BN(expiry);
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
      program.programId,
    );
    const [settlementPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(SETTLEMENT_SEED),
        Buffer.from(assetName),
        expiryBN.toArrayLike(Buffer, "le", 8),
      ],
      program.programId,
    );

    const ix = await program.methods
      .settleExpiry(assetName, expiryBN)
      // Pyth path: pass the 3 SB optional accounts as null. anchor 0.32.1 does NOT
      // auto-null unprovided optional accounts at .instruction() — it throws
      // "Account `sbQueue` not provided". .accountsPartial (not .accounts) is kept
      // because plain .accounts() rejects the explicitly-passed derivable PDAs
      // (market/settlement). Explicit null = no Switchboard accounts on a Pyth feed.
      .accountsPartial({
        caller: wallet.publicKey,
        market: marketPda,
        priceUpdate: priceUpdatePda,
        settlementRecord: settlementPda,
        systemProgram: SystemProgram.programId,
        sbQueue: null,
        sbSlothashes: null,
        sbInstructions: null, optaPriceFeed: null,
      })
      .instruction();

    return [{ instruction: ix, signers: [] }];
  });

  return (await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  })) as BuiltTx[];
}

/**
 * Sign + send the built tx(s) sequentially. Each tx must confirm before
 * the next is sent (the second tx in a split scenario references state
 * created by the first). Returns the FINAL tx signature — i.e. the one
 * containing our settle_expiry IX, which the modal links out to Solscan.
 *
 * Single-tx atomic path is the norm. Multi-tx fallback only triggers if
 * the SDK can't fit post+consume+close in 1232 bytes; on retry, if the
 * second tx fails with PriceTooOld or MismatchedFeedId (rare race where
 * the ephemeral account expired between submissions), we surface the
 * error to the caller — the modal offers "Try again" which rebuilds
 * with a fresh Hermes update.
 */
export async function submitWithFallback(
  connection: Connection,
  wallet: SignerWallet,
  txs: BuiltTx[],
): Promise<string> {
  // Pre-sign with any ephemeral signers the SDK needs.
  for (const { tx, signers } of txs) {
    if (signers.length > 0) tx.sign(signers);
  }
  const userSigned = await wallet.signAllTransactions(txs.map((t) => t.tx));

  let lastSig = "";
  for (const signedTx of userSigned) {
    // D2: the signature-only confirm form is the deprecated 30s wait. This path
    // has no lastValidBlockHeight in scope to switch strategies with, so the
    // wait stays as-is — but the TIMEOUT is now resolved against the chain
    // instead of surfacing as "unknown if it succeeded or failed".
    const sig = await withResolvedOutcome(connection as never, async () => {
      const s = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await connection.confirmTransaction(s, "confirmed");
      return s;
    });
    lastSig = sig;
  }
  return lastSig;
}

// ---------------------------------------------------------------------------
// HIGH-5 helpers — proof-bound create_market + migrate_pyth_feed
// ---------------------------------------------------------------------------
//
// Both instructions now require a fresh PriceUpdateV2 account whose
// `verification_level == Full` and `price_message.feed_id == arg`. The
// frontend therefore must post a Hermes /latest update + consume it in the
// same atomic tx — same shape as `buildPostUpdateAndSettleTx`, but
// targeting create_market / migrate_pyth_feed instead of settle_expiry.
//
// We use the /latest endpoint (NOT historical) because the proof gate only
// requires the feed_id be real — staleness against vault expiry isn't a
// concern here. Hermes /latest comfortably satisfies the receiver's
// `MAX_AGE` check at on-chain post time.

const PROTOCOL_SEED = "protocol_v2";

/**
 * Build atomic post_update + create_market tx. Mirrors
 * buildPostUpdateAndSettleTx but for the registry-create flow. Used by
 * NewMarketModal (browser) — permissionless post-HIGH-5.
 */
export async function buildPostUpdateAndCreateMarketTx(
  program: Program<Opta>,
  wallet: SignerWallet,
  assetName: string,
  pythFeedIdHex: string,
  assetClass: number,
  hermesBase: string = DEFAULT_HERMES_BASE,
  oracleSource: number = 0,
): Promise<BuiltTx[]> {
  const priceUpdateData = await fetchHermesUpdate(pythFeedIdHex, hermesBase);

  const receiver = new PythSolanaReceiver({
    connection: program.provider.connection,
    wallet: wallet as any,
  });

  const builder = receiver.newTransactionBuilder({
    closeUpdateAccounts: true,
  });

  await builder.addPostPriceUpdates([priceUpdateData.toString("base64")]);

  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const hexKey = `0x${pythFeedIdHex.replace(/^0x/, "").toLowerCase()}`;
    const priceUpdatePda = getPriceUpdateAccount(hexKey);
    if (!priceUpdatePda) {
      throw new Error(`No ephemeral PriceUpdate PDA for feed ${pythFeedIdHex}`);
    }

    const [protocolStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PROTOCOL_SEED)],
      program.programId,
    );
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
      program.programId,
    );

    // Convert 32-byte hex (with or without 0x) to number[].
    const hex = pythFeedIdHex.replace(/^0x/, "").toLowerCase();
    if (hex.length !== 64) {
      throw new Error(
        `buildPostUpdateAndCreateMarketTx: invalid feed_id hex (expected 64 chars, got ${hex.length})`,
      );
    }
    const feedIdBytes = Array.from({ length: 32 }, (_, i) =>
      parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    );

    const ix = await program.methods
      // Phase B: 4-arg create_market. oracle_source is forwarded from the caller
      // (single source of truth) rather than hardcoded — this Pyth builder is only
      // reached for oracle_source=0 (the modal's SB early-return guards the SB
      // path), so this is runtime-identical to the prior literal 0 while removing
      // the latent hardcode trap. SB-create is the switchboardCreateMarket.ts path.
      .createMarket(assetName, feedIdBytes, assetClass, oracleSource)
      // Pyth path: pass the 3 SB optional accounts as null. anchor 0.32.1 does NOT
      // auto-null unprovided optionals at .instruction() — it throws "Account
      // `sbQueue` not provided". Explicit null = no Switchboard accounts on a Pyth
      // create (oracle_source=0). SB-create is the switchboardCreateMarket.ts path.
      .accountsPartial({
        creator: wallet.publicKey,
        protocolState: protocolStatePda,
        priceUpdate: priceUpdatePda,
        market: marketPda,
        systemProgram: SystemProgram.programId,
        sbQueue: null,
        sbSlothashes: null,
        sbInstructions: null, optaPriceFeed: null,
      })
      .instruction();

    return [{ instruction: ix, signers: [] }];
  });

  return (await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  })) as BuiltTx[];
}

/**
 * Build atomic post_update + migrate_pyth_feed tx. Same proof shape as
 * create_market — admin gate is enforced server-side; this helper only
 * composes the proof tx. Used by MigrateFeedTools (admin UI) and
 * crank/migrate-sol-feed.ts.
 */
export async function buildPostUpdateAndMigrateFeedTx(
  program: Program<Opta>,
  wallet: SignerWallet,
  assetName: string,
  newPythFeedIdHex: string,
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<BuiltTx[]> {
  const priceUpdateData = await fetchHermesUpdate(newPythFeedIdHex, hermesBase);

  const receiver = new PythSolanaReceiver({
    connection: program.provider.connection,
    wallet: wallet as any,
  });

  const builder = receiver.newTransactionBuilder({
    closeUpdateAccounts: true,
  });

  await builder.addPostPriceUpdates([priceUpdateData.toString("base64")]);

  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const hexKey = `0x${newPythFeedIdHex.replace(/^0x/, "").toLowerCase()}`;
    const priceUpdatePda = getPriceUpdateAccount(hexKey);
    if (!priceUpdatePda) {
      throw new Error(
        `No ephemeral PriceUpdate PDA for feed ${newPythFeedIdHex}`,
      );
    }

    const [protocolStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PROTOCOL_SEED)],
      program.programId,
    );
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
      program.programId,
    );

    const hex = newPythFeedIdHex.replace(/^0x/, "").toLowerCase();
    if (hex.length !== 64) {
      throw new Error(
        `buildPostUpdateAndMigrateFeedTx: invalid feed_id hex (expected 64 chars, got ${hex.length})`,
      );
    }
    const feedIdBytes = Array.from({ length: 32 }, (_, i) =>
      parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    );

    const ix = await program.methods
      .migratePythFeed(assetName, feedIdBytes)
      .accountsStrict({
        admin: wallet.publicKey,
        protocolState: protocolStatePda,
        priceUpdate: priceUpdatePda,
        market: marketPda,
      })
      .instruction();

    return [{ instruction: ix, signers: [] }];
  });

  return (await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  })) as BuiltTx[];
}

// ---------------------------------------------------------------------------
// Phase 2 Stage B Step 7 — VolOracle init + push helpers
// ---------------------------------------------------------------------------
//
// Both follow the same atomic-post pattern as `buildPostUpdateAndCreateMarketTx`:
// post_update_atomic the fresh Hermes /latest VAA + consume it in the
// target IX + close. The Pyth Receiver SDK's `closeUpdateAccounts: true`
// arranges the post + consume + close into one tx and reclaims rent for
// the ephemeral PriceUpdateV2 account.
//
// Init helper is called by the vol-oracle crank on the first sighting of
// a new feed_id; push helper is called every hour after the oracle exists.

/**
 * Build atomic post_update + initialize_vol_oracle tx. Permissionless --
 * the on-chain handler's proof-of-feed gate accepts any signer whose
 * supplied PriceUpdateV2 has verification_level == Full and matching
 * feed_id (mirrors create_market post-HIGH-5).
 */
export async function buildPostUpdateAndInitializeVolOracleTx(
  program: Program<Opta>,
  wallet: SignerWallet,
  pythFeedIdHex: string,
  seedVol: number,
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<BuiltTx[]> {
  const priceUpdateData = await fetchHermesUpdate(pythFeedIdHex, hermesBase);

  const receiver = new PythSolanaReceiver({
    connection: program.provider.connection,
    wallet: wallet as any,
  });

  const builder = receiver.newTransactionBuilder({
    closeUpdateAccounts: true,
  });

  await builder.addPostPriceUpdates([priceUpdateData.toString("base64")]);

  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const hexKey = `0x${pythFeedIdHex.replace(/^0x/, "").toLowerCase()}`;
    const priceUpdatePda = getPriceUpdateAccount(hexKey);
    if (!priceUpdatePda) {
      throw new Error(`No ephemeral PriceUpdate PDA for feed ${pythFeedIdHex}`);
    }

    const hex = pythFeedIdHex.replace(/^0x/, "").toLowerCase();
    if (hex.length !== 64) {
      throw new Error(
        `buildPostUpdateAndInitializeVolOracleTx: invalid feed_id hex (expected 64 chars, got ${hex.length})`,
      );
    }
    const feedIdBytes = Array.from({ length: 32 }, (_, i) =>
      parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    );

    const [volOraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedIdBytes)],
      program.programId,
    );

    const ix = await program.methods
      // Seed-at-birth: initialize_vol_oracle takes (feed_id, oracle_source,
      // seed_vol). The FE/crank vol-oracle path is always Pyth-sourced →
      // oracle_source 0 (ORACLE_SOURCE_PYTH); seed_vol is the per-asset-class
      // day-0 vol (caller-supplied via seedVolForAssetClass), wrapped in BN at
      // the i64 boundary. Switchboard oracles are born via the SB crank path
      // (sbOracleCrank.birthSbOracle), not this builder. Typed call: the synced
      // app IDL (deploy step 2) carries the 3-arg signature + SB optional accounts.
      .initializeVolOracle(feedIdBytes, 0, new BN(seedVol))
      .accountsStrict({
        initializer: wallet.publicKey,
        priceUpdate: priceUpdatePda,
        volOracle: volOraclePda,
        systemProgram: SystemProgram.programId,
        // Pyth path: trailing SB optionals are null (no Switchboard accounts).
        sbQueue: null,
        sbSlothashes: null,
        sbInstructions: null, optaPriceFeed: null,
      })
      .instruction();

    return [{ instruction: ix, signers: [] }];
  });

  return (await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  })) as BuiltTx[];
}

/**
 * Build atomic post_update + push_vol_sample tx. Permissionless. The
 * on-chain handler validates feed_id match + EMA conf + 60s freshness +
 * positive spot, then either seeds the oracle (first push) or applies
 * the log-return + ring + accumulator update. The crank calls this
 * hourly per discovered feed_id.
 */
export async function buildPostUpdateAndPushVolSampleTx(
  program: Program<Opta>,
  wallet: SignerWallet,
  pythFeedIdHex: string,
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<BuiltTx[]> {
  const priceUpdateData = await fetchHermesUpdate(pythFeedIdHex, hermesBase);

  const receiver = new PythSolanaReceiver({
    connection: program.provider.connection,
    wallet: wallet as any,
  });

  const builder = receiver.newTransactionBuilder({
    closeUpdateAccounts: true,
  });

  await builder.addPostPriceUpdates([priceUpdateData.toString("base64")]);

  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const hexKey = `0x${pythFeedIdHex.replace(/^0x/, "").toLowerCase()}`;
    const priceUpdatePda = getPriceUpdateAccount(hexKey);
    if (!priceUpdatePda) {
      throw new Error(`No ephemeral PriceUpdate PDA for feed ${pythFeedIdHex}`);
    }

    const hex = pythFeedIdHex.replace(/^0x/, "").toLowerCase();
    if (hex.length !== 64) {
      throw new Error(
        `buildPostUpdateAndPushVolSampleTx: invalid feed_id hex (expected 64 chars, got ${hex.length})`,
      );
    }
    const feedIdBytes = Array.from({ length: 32 }, (_, i) =>
      parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    );

    const [volOraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedIdBytes)],
      program.programId,
    );

    const ix = await program.methods
      .pushVolSample()
      // Pyth path: pass the 3 SB optional accounts as null. anchor 0.32.1 does
      // NOT auto-null unprovided optional accounts at .instruction() build time —
      // it throws "Account `sbQueue` not provided" before any tx is sent. Explicit
      // null = no Switchboard accounts on a Pyth (oracle_source=0) feed.
      .accountsPartial({
        signer: wallet.publicKey,
        priceUpdate: priceUpdatePda,
        volOracle: volOraclePda,
        systemProgram: SystemProgram.programId,
        sbQueue: null,
        sbSlothashes: null,
        sbInstructions: null, optaPriceFeed: null,
      })
      .instruction();

    return [{ instruction: ix, signers: [] }];
  });

  return (await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  })) as BuiltTx[];
}

// ---------------------------------------------------------------------------
// Phase 2 Stage H — atomic post_update + exercise_american (early exercise)
// ---------------------------------------------------------------------------

/**
 * Build atomic post_update + exercise_american tx. Mirrors the vol-sample
 * sibling shape: post a FRESH Hermes /latest VAA + consume it in
 * exercise_american + close. We use /latest (NOT the settlement window-walk):
 * American early-exercise wants a CURRENT spot, and the handler enforces a
 * tight 60s freshness gate (Stage G Pass 2), which /latest comfortably meets.
 *
 * The handler burns `quantity` option tokens and pays capped intrinsic USDC
 * from the vault. 1.4M CU covers the Token-2022 burn + Pyth post/consume +
 * payout. 11-account context vs exercise_from_vault: ADDS price_update, DROPS
 * protocol_state. The holder's USDC ATA is assumed to exist (the holder bought
 * the option with USDC) — same precondition as exercise_from_vault. Reuse
 * submitWithFallback to sign + send. Dark until Stage I (AMERICAN_ENABLED gates
 * the handler on-chain).
 */
export async function buildPostUpdateAndExerciseAmericanTx(
  program: Program<Opta>,
  wallet: SignerWallet,
  params: {
    feedIdHex: string;
    quantity: number;
    sharedVault: PublicKey;
    market: PublicKey;
    vaultMintRecord: PublicKey;
    optionMint: PublicKey;
    holderOptionAccount: PublicKey;
    vaultUsdcAccount: PublicKey;
    holderUsdcAccount: PublicKey;
  },
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<BuiltTx[]> {
  const priceUpdateData = await fetchHermesUpdate(params.feedIdHex, hermesBase);

  const receiver = new PythSolanaReceiver({
    connection: program.provider.connection,
    wallet: wallet as any,
  });

  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates([priceUpdateData.toString("base64")]);

  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => {
    const hexKey = `0x${params.feedIdHex.replace(/^0x/, "").toLowerCase()}`;
    const priceUpdatePda = getPriceUpdateAccount(hexKey);
    if (!priceUpdatePda) {
      throw new Error(`No ephemeral PriceUpdate PDA for feed ${params.feedIdHex}`);
    }

    const ix = await program.methods
      .exerciseAmerican(new BN(params.quantity))
      // Pyth path: pass the 3 SB optional accounts as null. anchor 0.32.1 does NOT
      // auto-null unprovided optional accounts at .instruction() — it throws
      // "Account `sbQueue` not provided". Explicit null = no Switchboard accounts
      // on a Pyth (oracle_source=0) feed.
      .accountsPartial({
        holder: wallet.publicKey,
        sharedVault: params.sharedVault,
        market: params.market,
        priceUpdate: priceUpdatePda,
        vaultMintRecord: params.vaultMintRecord,
        optionMint: params.optionMint,
        holderOptionAccount: params.holderOptionAccount,
        vaultUsdcAccount: params.vaultUsdcAccount,
        holderUsdcAccount: params.holderUsdcAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        sbQueue: null,
        sbSlothashes: null,
        sbInstructions: null, optaPriceFeed: null,
      })
      .instruction();

    return [
      // 1.4M CU — Token-2022 burn + Pyth consume + USDC payout. Same bump the
      // American mint + auto-finalize paths use.
      {
        instruction: ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        signers: [],
      },
      { instruction: ix, signers: [] },
    ];
  });

  return (await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  })) as BuiltTx[];
}

// ---------------------------------------------------------------------------
// One-stop settle helper — atomic Pyth tx + batched settle_vault calls
// ---------------------------------------------------------------------------

export type SettleAllResult = {
  /** Atomic tx signature (post + settle_expiry). Null if the SettlementRecord
   *  already existed and we resumed straight to Phase 2. */
  atomicSig: string | null;
  /** One signature per follow-up vault batch tx. */
  vaultSigs: string[];
  /** Total vault count finalized in this call. */
  vaultsFinalized: number;
};

const SETTLE_VAULT_CHUNK_SIZE = 5;

/**
 * One-stop "settle everything for this (asset, expiry) tuple" helper.
 *
 * Sequence:
 *   Phase 1 — Atomic Pyth tx: post_update + settle_expiry + close. Skipped
 *             if a SettlementRecord PDA already exists (partial-failure
 *             resume path).
 *   Phase 2 — settle_vault batches: one IX per vault, chunked into
 *             VersionedTransactions of SETTLE_VAULT_CHUNK_SIZE IXs each.
 *             Each chunk gets a fresh blockhash and is submitted
 *             sequentially with confirmation between chunks.
 *
 * This is the **client-side replacement for the not-yet-built crank bot**.
 * Once a crank exists, Phase 2 becomes redundant — the crank watches for
 * SettlementRecord events and calls settle_vault per vault in the
 * background. Phase 1 stays user-triggered either way.
 */
export async function settleAllForExpiry(
  program: Program<Opta>,
  wallet: SignerWallet,
  assetName: string,
  expiry: number,
  feedIdHex: string,
  vaultPdas: PublicKey[],
  hermesBase: string = DEFAULT_HERMES_BASE,
): Promise<SettleAllResult> {
  const connection = program.provider.connection;
  const expiryBN = new BN(expiry);

  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(MARKET_SEED), Buffer.from(assetName)],
    program.programId,
  );
  const [settlementPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(SETTLEMENT_SEED),
      Buffer.from(assetName),
      expiryBN.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );

  // ---- Phase 1: atomic Pyth tx (skipped if SettlementRecord exists) ----
  let atomicSig: string | null = null;
  const existing = await connection.getAccountInfo(settlementPda);
  if (!existing) {
    const atomicTxs = await buildPostUpdateAndSettleTx(
      program,
      wallet,
      assetName,
      expiry,
      feedIdHex,
      hermesBase,
    );
    atomicSig = await submitWithFallback(connection, wallet, atomicTxs);
  }

  // ---- Phase 2: settle_vault batches (10-account writer-ask retro-harden) ----
  if (vaultPdas.length === 0) {
    return { atomicSig, vaultSigs: [], vaultsFinalized: 0 };
  }

  // protocol_state PDA — signs the pot→vault USDC sweep (constant per call).
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PROTOCOL_SEED)],
    program.programId,
  );

  // Fetch each vault ONCE — serves two purposes:
  //   1. the option_mint / writer-ask-pot derivations need strike/expiry/type/style;
  //   2. the already-settled SKIP GUARD. settle_vault reverts VaultAlreadySettled
  //      (6019) on a settled vault, and AccountNotInitialized (3012) on the
  //      settled-and-drained vaults whose vault_usdc_account has been closed. We
  //      filter both out HERE, before building any ix, so we never fire at them.
  const vaultAccts = await program.account.sharedVault.fetchMultiple(vaultPdas);

  const ixs: TransactionInstruction[] = [];
  for (let i = 0; i < vaultPdas.length; i++) {
    const vaultPda = vaultPdas[i];
    const v = vaultAccts[i];
    // SKIP GUARD: missing account or already settled → never build the ix.
    if (!v || v.isSettled) continue;

    // enum → discriminant byte (OptionType Call=0/Put=1; ExerciseStyle
    // European=0/American=1 — from the Rust enum declaration order).
    const otByte = "call" in v.optionType ? 0 : 1;
    const esByte = "european" in v.exerciseStyle ? 0 : 1;

    // Canonical series mint — matches settle_vault.rs / create_series.rs seeds.
    // For legacy vaults this address may hold no mint; settle_vault uses it only
    // as a pinned key + pot-seed source (UncheckedAccount, never deserialized).
    const [optionMint] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(VAULT_OPTION_MINT_SEED),
        marketPda.toBuffer(),
        v.strikePrice.toArrayLike(Buffer, "le", 8),
        v.expiry.toArrayLike(Buffer, "le", 8),
        Buffer.from([otByte]),
        Buffer.from([esByte]),
      ],
      program.programId,
    );
    const [writerAskPot] = PublicKey.findProgramAddressSync(
      [Buffer.from(WRITER_ASK_POT_SEED), optionMint.toBuffer()],
      program.programId,
    );
    const [writerAskPotUsdc] = PublicKey.findProgramAddressSync(
      [Buffer.from(WRITER_ASK_POT_USDC_SEED), optionMint.toBuffer()],
      program.programId,
    );

    const ix = await program.methods
      .settleVault()
      .accountsStrict({
        authority: wallet.publicKey,
        sharedVault: vaultPda,
        market: marketPda,
        settlementRecord: settlementPda,
        vaultUsdcAccount: v.vaultUsdcAccount, // field read off the vault
        optionMint,
        writerAskPot,
        writerAskPotUsdc,
        protocolState: protocolStatePda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    ixs.push(ix);
  }

  // All vaults already settled (or missing) → nothing to fire.
  if (ixs.length === 0) {
    return { atomicSig, vaultSigs: [], vaultsFinalized: 0 };
  }

  const vaultSigs: string[] = [];
  for (let i = 0; i < ixs.length; i += SETTLE_VAULT_CHUNK_SIZE) {
    const chunk = ixs.slice(i, i + SETTLE_VAULT_CHUNK_SIZE);
    const { blockhash } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: chunk,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const signed = (await wallet.signAllTransactions([tx]))[0];
    // D2: the signature-only confirm form is the deprecated 30s wait. This path
    // has no lastValidBlockHeight in scope to switch strategies with, so the
    // wait stays as-is — but the TIMEOUT is now resolved against the chain
    // instead of surfacing as "unknown if it succeeded or failed".
    const sig = await withResolvedOutcome(connection as never, async () => {
      const s = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await connection.confirmTransaction(s, "confirmed");
      return s;
    });
    vaultSigs.push(sig);
  }

  // ixs.length (not vaultPdas.length) — already-settled/missing vaults were skipped.
  return { atomicSig, vaultSigs, vaultsFinalized: ixs.length };
}
