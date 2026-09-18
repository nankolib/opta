// =============================================================================
// exerciseArm.ts — route an early exercise to the oracle arm its market uses
// =============================================================================
//
// THE BUG THIS CLOSES (P1, reproduced 2026-08-12). exerciseAmericanV2 read
// `market.pyth_feed_id` and handed it to the Hermes poster unconditionally, with
// no oracle_source branch. For a Switchboard market that field holds the SB
// FEEDHASH (the two sources share the field by design), and Hermes has never
// heard of it:
//
//   GET hermes/v2/updates/price/latest?ids[]=0xe01fe3bb…b463  -> 404
//        "Price ids not found: 0xe01fe3bb…"                     (SOL, SB feedHash)
//   GET hermes/v2/updates/price/latest?ids[]=0xef0d8b6f…b56d  -> 200
//                                                               (SOL, Pyth id)
//
// Same endpoint, same encoding; the only variable is which id we send. Early
// exercise was therefore broken on EVERY Switchboard market — which is the whole
// traded board (BTC, SOL, ETH, XRP, the memes) — and worked only on the seven
// Pyth-sourced assets nobody trades. That inversion is why it survived so long.
//
// The PROGRAM was never the problem: exercise_american.rs:118-175 has dispatched
// on `market.oracle_source` since it shipped, and its account struct already
// carries the trailing sb_queue / sb_slothashes / sb_instructions optionals. Only
// the client never learned to pick an arm.
//
// ── WHY THE SB ARM IS NOT BUILT IN THE BROWSER ─────────────────────────────
// Building an SB quote needs @switchboard-xyz/on-demand. app/ has ZERO
// @switchboard-xyz dependencies and that is deliberate and load-bearing — three
// modules document it (newMarketCreate.ts, NewMarketModal.tsx, liveness.ts): the
// SB SDK never enters the FE bundle. So the SB arm mirrors sb-create-market: the
// crank builds an UNSIGNED tx, the FE signs it with the holder's wallet and
// submits. The user pays; the crank key never signs a user's exercise.
//
// ── THE GUARD (assertExerciseTxShape) ───────────────────────────────────────
// We operate that endpoint, which is exactly why the FE must not trust it. A
// wallet that signs whatever bytes a server returns IS a blind-signing oracle,
// and the fact that we run the server today is a fact about today. So before the
// wallet ever sees it, the returned tx is checked against values the FE derived
// LOCALLY: our program, our discriminator, our vault, our quantity, our accounts,
// one signer (the holder), no lookup tables. A compromised or swapped endpoint
// can return a tx — it cannot return one that signs anything else.
//
// This module is dependency-injected (endpoint + fetch) and imports no `./env`,
// so it compiles to CommonJS and is tested against real VersionedTransactions.
// =============================================================================

import { PublicKey, VersionedTransaction } from "@solana/web3.js";

// ---- oracle sources ---------------------------------------------------------

export const ORACLE_SOURCE_PYTH = 0;
export const ORACLE_SOURCE_SWITCHBOARD = 1;
/** Plug wave 1 (2026-09-18): the first-party feed. Routed to a LOCAL build —
 *  no off-chain post, no endpoint — carrying the feed PDA in the trailing
 *  optional. See utils/oracleArm.ts. */
export const ORACLE_SOURCE_OPTA = 2;

export type ExerciseArm = "pyth" | "switchboard" | "opta";

/** Raised when a market's oracle_source is absent or not one of {0,1}. */
export class UnknownOracleSourceError extends Error {
  readonly received: unknown;
  constructor(received: unknown) {
    super("This market's price source could not be determined.");
    this.name = "UnknownOracleSourceError";
    this.received = received;
  }
}

/**
 * Pick the arm from a market's `oracle_source`.
 *
 * THROWS rather than defaulting, on purpose. Defaulting to Pyth is precisely the
 * bug above; defaulting to Switchboard would break the seven markets that work.
 * There is no safe guess, so an unreadable source is surfaced as an error and
 * the caller re-fetches the market account before giving up (accounts predating
 * a size bump can be short — see the account size-drift note).
 */
export function chooseExerciseArm(oracleSource: unknown): ExerciseArm {
  if (oracleSource === ORACLE_SOURCE_PYTH) return "pyth";
  if (oracleSource === ORACLE_SOURCE_SWITCHBOARD) return "switchboard";
  if (oracleSource === ORACLE_SOURCE_OPTA) return "opta";
  throw new UnknownOracleSourceError(oracleSource);
}

// ---- endpoint client --------------------------------------------------------

export class SbExerciseNetworkError extends Error {
  constructor() {
    super("Could not reach the pricing service. Check your connection and try again.");
    this.name = "SbExerciseNetworkError";
  }
}

/** Names that must never reach a user-facing string. The endpoint is ours and
 *  already writes neutral copy, but "the server promised to be careful" is not
 *  a mechanism — this is the mechanism. */
const VENDOR_RE = /pyth|switchboard|hermes|crossbar|ed25519/i;

export class SbExerciseEndpointError extends Error {
  readonly status: number;
  /** The endpoint's raw detail, kept for logs. NEVER rendered. */
  readonly detail: string;
  constructor(status: number, detail?: string) {
    const raw = detail ?? "";
    // Echo the endpoint's wording only when it is already neutral; otherwise
    // fall back. A pass-through would have shipped "Switchboard" into a toast,
    // which is the same class of bug as the "Hermes" one this session removes.
    const safe = raw.length > 0 && !VENDOR_RE.test(raw) ? raw : "Price unavailable — try again.";
    super(safe);
    this.name = "SbExerciseEndpointError";
    this.status = status;
    this.detail = raw;
  }
}

export interface SbExerciseResponse {
  transactionBase64: string;
  lastValidBlockHeight: number;
  /**
   * Slot after which the embedded price quote is too old for the chain to
   * accept. Absent on older endpoint builds, in which case the caller falls
   * back to blockhash validity alone (the pre-2026-08-13 behaviour).
   *
   * This exists because the two deadlines INVERTED: the quote budget is 150
   * slots, worth ~35 s at the measured devnet rate of 4.22 slots/s, while a
   * blockhash survives 60-90 s. The quote now dies first, so blockhash validity
   * no longer implies quote validity and the tighter bound must be checked.
   */
  quoteExpiresAtSlot?: number;
}

export interface SbExerciseRequest {
  holder: string;
  sharedVault: string;
  market: string;
  vaultMintRecord: string;
  optionMint: string;
  holderOptionAccount: string;
  vaultUsdcAccount: string;
  holderUsdcAccount: string;
  quantity: number;
}

type FetchLike = (input: string, init?: any) => Promise<any>;

/** POST for a fresh unsigned exercise tx. Stateless: every call builds anew. */
export async function postSbExercise(
  endpoint: string,
  body: SbExerciseRequest,
  fetchImpl?: FetchLike,
): Promise<SbExerciseResponse> {
  const f: FetchLike = fetchImpl ?? ((globalThis as any).fetch as FetchLike);
  let resp: any;
  try {
    resp = await f(`${endpoint}/sb-exercise-american`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SbExerciseNetworkError();
  }
  if (!resp.ok) {
    let msg = "";
    try {
      const j = await resp.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      /* non-JSON body — fall back to the neutral default */
    }
    throw new SbExerciseEndpointError(resp.status, msg);
  }
  let json: any;
  try {
    json = await resp.json();
  } catch {
    throw new SbExerciseEndpointError(resp.status, "Price unavailable — try again.");
  }
  if (
    typeof json?.transactionBase64 !== "string" ||
    typeof json?.lastValidBlockHeight !== "number"
  ) {
    throw new SbExerciseEndpointError(resp.status, "Price unavailable — try again.");
  }
  return {
    transactionBase64: json.transactionBase64,
    lastValidBlockHeight: json.lastValidBlockHeight,
    quoteExpiresAtSlot:
      typeof json.quoteExpiresAtSlot === "number" ? json.quoteExpiresAtSlot : undefined,
  };
}

// ---- the pre-signature guard ------------------------------------------------

/** exercise_american, from app/src/idl/opta.json. */
export const EXERCISE_AMERICAN_DISCRIMINATOR = Object.freeze([
  241, 75, 206, 124, 107, 254, 131, 81,
]);

/** The only non-Opta programs an SB exercise tx may invoke: the CU bump and the
 *  oracle's own signature-verify ix. Anything else is not this transaction. */
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";

/**
 * Account order of exercise_american (IDL order — the on-chain struct's order).
 * Index 3 (price_update) and 11-13 (sb_*) are Anchor optionals.
 */
export const EXERCISE_ACCOUNT_INDEX = Object.freeze({
  holder: 0,
  sharedVault: 1,
  market: 2,
  priceUpdate: 3,
  vaultMintRecord: 4,
  optionMint: 5,
  holderOptionAccount: 6,
  vaultUsdcAccount: 7,
  holderUsdcAccount: 8,
  token2022Program: 9,
  tokenProgram: 10,
  sbQueue: 11,
  sbSlothashes: 12,
  sbInstructions: 13,
  // Writer-ask pot payout arm (2026-08-15). Appended AFTER sb_*, so indices 0-13
  // are unchanged and the 14-account shape keeps validating exactly as before.
  writerAskPot: 14,
  writerAskPotUsdc: 15,
  protocolState: 16,
  // FP-ORACLE arm (plug wave 1, 2026-09-18). Appended LAST, so 0-16 and both
  // legal counts below are unchanged. An Opta-sourced exercise (18 accounts, or
  // 15 without the pot arm) is NOT accepted by this validator yet: the FE arm
  // for oracleSource 2 is a separate item and lands with its own shape check.
  optaPriceFeed: 17,
});

/** The two legal account counts. 14 = vault-funded (trailing optionals omitted,
 *  byte-identical to every exercise built before 2026-08-15); 17 = the pot arm
 *  is carried. Anything else is not this instruction. */
export const EXERCISE_ACCOUNTS_VAULT_ONLY = 14;
export const EXERCISE_ACCOUNTS_WITH_POT = 17;
/** Plug wave 1: an endpoint built against the current IDL carries the trailing
 *  `opta_price_feed` slot too. On the Switchboard arm that slot MUST hold the
 *  program-id sentinel (index 17 is checked below); a real key there is not an
 *  SB exercise. 14 and 17 stay legal for older endpoint builds. */
export const EXERCISE_ACCOUNTS_WITH_FEED_SLOT = 18;

export interface ExpectedExercise extends SbExerciseRequest {
  /** Our Opta program id — not the endpoint's claim about it. */
  programId: string;
  /** Locally-derived pot arm. Supply these whenever the series is (or may be)
   *  writer-ask funded; without them a 17-account response cannot be checked and
   *  is therefore refused rather than trusted. */
  writerAskPot?: string;
  writerAskPotUsdc?: string;
  protocolState?: string;
}

/** Raised when a server-built tx is not the transaction we asked for. */
export class ExerciseTxShapeError extends Error {
  constructor(detail: string) {
    super(`Refused to sign: ${detail}`);
    this.name = "ExerciseTxShapeError";
  }
}

function u64le(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
  return v;
}

/**
 * Verify a server-built exercise tx against locally-derived expectations, and
 * throw before the wallet is asked to sign anything that fails.
 *
 * What each check buys, since a guard nobody can reason about is decoration:
 *
 *  - NO LOOKUP TABLES. A v0 tx can hide accounts behind an address table that
 *    the FE cannot resolve without another RPC round-trip. If we can't see every
 *    account synchronously we cannot check them, so we require them all static.
 *  - ONE SIGNER, THE HOLDER, AS PAYER. The holder must be the only required
 *    signature. This alone stops the tx from moving anyone else's assets.
 *  - PROGRAM ALLOWLIST + EXACTLY ONE OPTA IX. No extra Opta calls smuggled in
 *    beside the exercise (a second ix could be a transfer, a listing, anything).
 *  - DISCRIMINATOR. It is exercise_american, not some other Opta instruction
 *    that happens to take the same accounts.
 *  - EVERY ACCOUNT + THE QUANTITY. Compared against values THIS CLIENT derived,
 *    so a swapped vault, a substituted USDC destination, or an inflated
 *    quantity are all rejected. `price_update` must be the omitted-optional
 *    sentinel (Anchor encodes an absent optional as the program id) — an SB
 *    exercise carrying a Pyth account is not the tx we asked for.
 */
/** u16::MAX in an ed25519 offset's instruction-index field means "this
 *  instruction" — position-independent, and what a correct packer emits. */
const ED25519_SELF_INDEX = 0xffff;

/**
 * Walk the ed25519 precompile payload and confirm every reference it makes
 * lands inside the instruction it names. Mirrors the runtime's own bounds check.
 *
 * Layout (solana ed25519_instruction.rs): u8 num_signatures, u8 padding, then
 * num_signatures x 14-byte offset structs of u16 LE:
 *   signature_offset, signature_instruction_index,
 *   public_key_offset, public_key_instruction_index,
 *   message_data_offset, message_data_size, message_instruction_index
 */
export function assertPriceProofResolves(
  ixs: { programIdIndex: number; data: Uint8Array }[],
  edIdx: number,
): void {
  const self = Buffer.from(ixs[edIdx].data);
  if (self.length < 2) throw new ExerciseTxShapeError("price proof is malformed");
  const n = self.readUInt8(0);
  if (n === 0) throw new ExerciseTxShapeError("price proof carries no signatures");
  if (self.length < 2 + n * 14) throw new ExerciseTxShapeError("price proof is truncated");

  for (let i = 0; i < n; i++) {
    const b = 2 + i * 14;
    const refs: Array<[string, number, number, number]> = [
      ["signature", self.readUInt16LE(b + 2), self.readUInt16LE(b + 0), 64],
      ["public key", self.readUInt16LE(b + 6), self.readUInt16LE(b + 4), 32],
      ["message", self.readUInt16LE(b + 12), self.readUInt16LE(b + 8), self.readUInt16LE(b + 10)],
    ];
    for (const [label, ixIndex, off, size] of refs) {
      const target =
        ixIndex === ED25519_SELF_INDEX ? self : (ixs[ixIndex] ? Buffer.from(ixs[ixIndex].data) : null);
      if (!target || off + size > target.length) {
        throw new ExerciseTxShapeError(
          `price proof ${label} reference is out of bounds (instruction ${ixIndex}, offset ${off}, size ${size})`,
        );
      }
    }
  }
}

export function assertExerciseTxShape(
  tx: VersionedTransaction,
  expected: ExpectedExercise,
): void {
  const msg = tx.message;

  if (msg.addressTableLookups && msg.addressTableLookups.length > 0) {
    throw new ExerciseTxShapeError("transaction uses address lookup tables");
  }

  const keys = msg.staticAccountKeys.map((k: PublicKey) => k.toBase58());

  if (msg.header.numRequiredSignatures !== 1) {
    throw new ExerciseTxShapeError(
      `expected exactly 1 signer, found ${msg.header.numRequiredSignatures}`,
    );
  }
  if (keys[0] !== expected.holder) {
    throw new ExerciseTxShapeError("fee payer is not your wallet");
  }

  const allowed = new Set([
    expected.programId,
    COMPUTE_BUDGET_PROGRAM_ID,
    ED25519_PROGRAM_ID,
  ]);
  const ixs = msg.compiledInstructions;
  for (const ix of ixs) {
    const pid = keys[ix.programIdIndex];
    if (!allowed.has(pid)) {
      throw new ExerciseTxShapeError(`transaction invokes an unexpected program (${pid})`);
    }
  }

  const optaIxs = ixs.filter((ix) => keys[ix.programIdIndex] === expected.programId);
  if (optaIxs.length !== 1) {
    throw new ExerciseTxShapeError(
      `expected exactly 1 Opta instruction, found ${optaIxs.length}`,
    );
  }
  const ix = optaIxs[0];
  const data = ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data as any);

  if (data.length !== 16) {
    throw new ExerciseTxShapeError(`instruction data is ${data.length} bytes, expected 16`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== EXERCISE_AMERICAN_DISCRIMINATOR[i]) {
      throw new ExerciseTxShapeError("instruction is not exercise_american");
    }
  }
  const qty = u64le(data, 8);
  if (qty !== BigInt(expected.quantity)) {
    throw new ExerciseTxShapeError(
      `quantity is ${qty.toString()}, expected ${expected.quantity}`,
    );
  }

  const acc = ix.accountKeyIndexes;
  if (
    acc.length !== EXERCISE_ACCOUNTS_VAULT_ONLY &&
    acc.length !== EXERCISE_ACCOUNTS_WITH_POT &&
    acc.length !== EXERCISE_ACCOUNTS_WITH_FEED_SLOT
  ) {
    throw new ExerciseTxShapeError(
      `instruction has ${acc.length} accounts, expected ` +
        `${EXERCISE_ACCOUNTS_VAULT_ONLY}, ${EXERCISE_ACCOUNTS_WITH_POT} or ${EXERCISE_ACCOUNTS_WITH_FEED_SLOT}`,
    );
  }
  const at = (i: number) => keys[acc[i]];
  const I = EXERCISE_ACCOUNT_INDEX;

  // A 17-account instruction does NOT imply a pot is carried (2026-08-16).
  // Anchor encodes a null optional as the PROGRAM ID sentinel and still occupies
  // the slot, so once the IDL declares the pot arm, EVERY exercise is 17
  // accounts — pool-funded ones carry three sentinels. Keying `carriesPot` on
  // the count alone made the guard demand pot expectations for a pool-funded
  // transaction and refuse it with "collateral pot does not match this series",
  // which would have blocked every pool-funded early exercise. Read the SLOT,
  // not the length. (14 remains legal: an endpoint built against an IDL that
  // predates the arm omits the trailing optionals entirely.)
  const carriesPot =
    acc.length >= EXERCISE_ACCOUNTS_WITH_POT && at(I.writerAskPot) !== expected.programId;
  // Plug wave 1: on the Switchboard arm the trailing feed slot, when present,
  // must be the omitted-optional sentinel. A real account there means the
  // endpoint built something other than a Switchboard exercise.
  if (acc.length === EXERCISE_ACCOUNTS_WITH_FEED_SLOT && at(I.optaPriceFeed) !== expected.programId) {
    throw new ExerciseTxShapeError("transaction carries an unexpected price account");
  }

  const mustMatch: Array<[number, string, string]> = [
    [I.holder, expected.holder, "holder"],
    [I.sharedVault, expected.sharedVault, "vault"],
    [I.market, expected.market, "market"],
    [I.vaultMintRecord, expected.vaultMintRecord, "mint record"],
    [I.optionMint, expected.optionMint, "option mint"],
    [I.holderOptionAccount, expected.holderOptionAccount, "your option account"],
    [I.vaultUsdcAccount, expected.vaultUsdcAccount, "vault USDC account"],
    [I.holderUsdcAccount, expected.holderUsdcAccount, "your USDC account"],
  ];
  for (const [idx, want, label] of mustMatch) {
    if (at(idx) !== want) {
      throw new ExerciseTxShapeError(`${label} does not match the position you selected`);
    }
  }

  // Anchor encodes an omitted optional account as the program id itself.
  if (at(I.priceUpdate) !== expected.programId) {
    throw new ExerciseTxShapeError("transaction carries an unexpected price account");
  }
  for (const [idx, label] of [
    [I.sbQueue, "queue"],
    [I.sbSlothashes, "slot hashes"],
    [I.sbInstructions, "instructions sysvar"],
  ] as Array<[number, string]>) {
    if (at(idx) === expected.programId) {
      throw new ExerciseTxShapeError(`price proof is missing its ${label} account`);
    }
  }

  // The oracle's signature-verify ix must be present; without it the on-chain
  // proof cannot be read at all.
  const edIdx = ixs.findIndex((i2) => keys[i2.programIdIndex] === ED25519_PROGRAM_ID);
  if (edIdx < 0) {
    throw new ExerciseTxShapeError("transaction carries no price proof");
  }

  // The price proof must RESOLVE — its internal offsets are references, and a
  // reference that lands outside the instruction it names is rejected by the
  // ed25519 precompile (InvalidDataOffsets) at preflight, after the user has
  // already signed. Validating it here turns that into a refusal before the
  // wallet opens.
  //
  // HONEST LIMIT: this sees the PRE-WALLET transaction. A wallet that inserts an
  // instruction after this point shifts every index and invalidates a payload
  // that passed here — the 2026-08-16 incident, where Phantom's priority-fee ix
  // moved the proof from index 1 to 2 while its offsets still named 1.
  //
  // NOTHING IN THIS FILE CAN COVER THAT, and neither can the packer. The obvious
  // remedy — pack u16::MAX ("this instruction"), which the ed25519 precompile
  // accepts — was tried and is REJECTED on chain: the Switchboard crate our
  // program calls re-reads the ix through the instructions sysvar and asserts
  // the field equals that ix's own concrete index, panicking otherwise
  // ("Signature instruction index 65535 does not match current instruction
  // index 1"). The payload is position-DEPENDENT by construction.
  //
  // The live mitigation is to remove the wallet's REASON to insert (the endpoint
  // now supplies both compute-budget instructions itself). The structural fix —
  // endpoint returns instructions, the FE assembles and computes the ed25519
  // index last, after anything it will add — is tracked on 86eymw9m1.
  //
  // What this check DOES catch is a builder-side regression that ships an index
  // which is wrong for the transaction as built.
  assertPriceProofResolves(ixs, edIdx);

  // Pot arm. Checked ONLY when carried, so the vault-funded shape is validated
  // exactly as it was before this arm existed. When it IS carried, every one of
  // the three must match an address this client derived — a server that can
  // choose the pot could drain another series', and `protocol_state` is the
  // authority that signs that transfer.
  if (carriesPot) {
    const potChecks: Array<[number, string | undefined, string]> = [
      [I.writerAskPot, expected.writerAskPot, "collateral pot"],
      [I.writerAskPotUsdc, expected.writerAskPotUsdc, "collateral pot account"],
      [I.protocolState, expected.protocolState, "protocol state"],
    ];
    for (const [idx, want, label] of potChecks) {
      if (!want) {
        // We were handed a pot arm we have no local expectation for, so we
        // cannot check it. Refusing is the only honest response — "looks
        // plausible" is not verification.
        throw new ExerciseTxShapeError(
          `transaction carries a ${label} this client did not derive`,
        );
      }
      if (at(idx) !== want) {
        throw new ExerciseTxShapeError(`${label} does not match this series`);
      }
    }
  }
}

/**
 * Is the quote already dead (or about to be) at this slot?
 *
 * `margin` covers the send + land gap: a transaction accepted here still has to
 * reach a leader, so checking against the bare deadline would approve quotes
 * that expire in flight. 20 slots is ~5 s at the measured rate.
 *
 * Returns false when the endpoint published no deadline — an older build, where
 * the caller keeps the previous blockhash-only behaviour rather than inventing
 * a bound it cannot know.
 */
export function isQuoteExpired(
  resp: Pick<SbExerciseResponse, "quoteExpiresAtSlot">,
  currentSlot: number,
  margin = 20,
): boolean {
  if (typeof resp.quoteExpiresAtSlot !== "number") return false;
  return currentSlot + margin >= resp.quoteExpiresAtSlot;
}

/** Deserialize a base64 tx from the endpoint. Malformed bytes are a shape
 *  failure, not a crash. */
export function deserializeExerciseTx(transactionBase64: string): VersionedTransaction {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(Buffer.from(transactionBase64, "base64"));
  } catch {
    throw new ExerciseTxShapeError("response was not a readable transaction");
  }
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    throw new ExerciseTxShapeError("response was not a readable transaction");
  }
}
