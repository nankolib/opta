// =============================================================================
// exerciseArm.test.ts — arm routing + the pre-signature guard
// =============================================================================
//   run: node app/scripts/run-exercise-arm-tests.mjs
//
// TWO JOBS.
//
// 1. ROUTING. The P1 was a missing branch: every market went down the Pyth arm,
//    so every Switchboard market — i.e. the entire traded board — 404'd. The RED
//    test here is that a Switchboard market does NOT route to Pyth.
//
// 2. THE GUARD. The SB arm signs a transaction a SERVER built. These tests are
//    the reason that is acceptable: they build REAL VersionedTransactions and
//    then tamper with them one field at a time — swapped vault, swapped USDC
//    destination, inflated quantity, extra instruction, second signer, wrong
//    program, hidden lookup table — and assert the guard refuses each. A guard
//    only tested on the happy path is not a guard.
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  assertExerciseTxShape,
  chooseExerciseArm,
  isQuoteExpired,
  deserializeExerciseTx,
  ExerciseTxShapeError,
  EXERCISE_AMERICAN_DISCRIMINATOR,
  EXERCISE_ACCOUNT_INDEX,
  ORACLE_SOURCE_PYTH,
  ORACLE_SOURCE_SWITCHBOARD,
  postSbExercise,
  SbExerciseEndpointError,
  SbExerciseNetworkError,
  UnknownOracleSourceError,
  type ExpectedExercise,
} from "./exerciseArm";

// ===========================================================================
// 1. ARM ROUTING — the missing branch
// ===========================================================================

test("RED: a Switchboard market does NOT route to the Pyth arm", () => {
  // THE BUG. exerciseAmericanV2 had no branch at all, so oracle_source=1 was
  // treated exactly like oracle_source=0 and its SB feedHash went to Hermes.
  assert.equal(chooseExerciseArm(ORACLE_SOURCE_SWITCHBOARD), "switchboard");
  assert.notEqual(chooseExerciseArm(ORACLE_SOURCE_SWITCHBOARD), "pyth");
});

test("a Pyth market still routes to the Pyth arm — the working arm is untouched", () => {
  assert.equal(chooseExerciseArm(ORACLE_SOURCE_PYTH), "pyth");
});

test("an unreadable oracle_source throws rather than guessing", () => {
  // Defaulting either way is a bug: Pyth is the P1 we are fixing, and Switchboard
  // would break the seven markets that work today.
  // 2 became the Opta arm at plug wave 1 (2026-09-18); it is asserted below.
  for (const bad of [undefined, null, 3, 255, -1, "0", NaN, {}]) {
    assert.throws(
      () => chooseExerciseArm(bad),
      UnknownOracleSourceError,
      `${String(bad)} should not resolve to an arm`,
    );
  }
});

test("the thrown error carries no vendor name", () => {
  // Provenance rule: users never see "Pyth" / "Switchboard" / "Hermes".
  const err = new UnknownOracleSourceError(undefined);
  assert.doesNotMatch(err.message, /pyth|switchboard|hermes|oracle/i);
});

// ===========================================================================
// 2. THE GUARD — real transactions, tampered one field at a time
// ===========================================================================

const PROGRAM = new PublicKey("oPtaMHmBgQ2CxJPDNCJmxMuLbrCg9dbBPcstJfP1Zzo");
const TOKEN22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SLOTHASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const IX_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

const holder = Keypair.generate().publicKey;
const sharedVault = Keypair.generate().publicKey;
const market = Keypair.generate().publicKey;
const vaultMintRecord = Keypair.generate().publicKey;
const optionMint = Keypair.generate().publicKey;
const holderOptionAccount = Keypair.generate().publicKey;
const vaultUsdcAccount = Keypair.generate().publicKey;
const holderUsdcAccount = Keypair.generate().publicKey;
const sbQueue = Keypair.generate().publicKey;
// Writer-ask pot arm (2026-08-15). Seed-derived in prod; opaque keys here — the
// guard compares against what the CLIENT derived, never against a shape rule.
const writerAskPot = Keypair.generate().publicKey;
const writerAskPotUsdc = Keypair.generate().publicKey;
const protocolState = Keypair.generate().publicKey;

const EXPECTED: ExpectedExercise = {
  programId: PROGRAM.toBase58(),
  holder: holder.toBase58(),
  sharedVault: sharedVault.toBase58(),
  market: market.toBase58(),
  vaultMintRecord: vaultMintRecord.toBase58(),
  optionMint: optionMint.toBase58(),
  holderOptionAccount: holderOptionAccount.toBase58(),
  vaultUsdcAccount: vaultUsdcAccount.toBase58(),
  holderUsdcAccount: holderUsdcAccount.toBase58(),
  quantity: 3,
};

function exerciseData(quantity: number | bigint): Buffer {
  const b = Buffer.alloc(16);
  Buffer.from(EXERCISE_AMERICAN_DISCRIMINATOR).copy(b, 0);
  b.writeBigUInt64LE(BigInt(quantity), 8);
  return b;
}

/** A fake ed25519 quote ix — the guard only cares that the program is invoked. */
/**
 * A price proof with REAL geometry: 1 signature, SELF-referential instruction
 * indices (u16::MAX), sig@16, pubkey@80, message@112 len 81 — the same layout
 * crank/ed25519SelfPack.ts emits for n=1.
 *
 * It used to be `Buffer.alloc(16)`, which decodes as num_signatures=0. That was
 * fine while the guard only checked the ix was PRESENT, but the guard now walks
 * the payload's offsets (2026-08-16), and a stub that isn't a payload fails it
 * before any account assertion runs. A fixture that cannot survive the real
 * check is a fixture that stops testing what it claims to.
 */
function fakeEd25519Ix(opts: { instructionIndex?: number } = {}): TransactionInstruction {
  const SELF = 0xffff;
  const idx = opts.instructionIndex ?? SELF;
  const MSG_LEN = 81;
  const data = Buffer.alloc(112 + MSG_LEN);
  data.writeUInt8(1, 0);              // num_signatures
  data.writeUInt8(0, 1);              // padding
  data.writeUInt16LE(16, 2);          // signature_offset
  data.writeUInt16LE(idx, 4);         // signature_instruction_index
  data.writeUInt16LE(80, 6);          // public_key_offset
  data.writeUInt16LE(idx, 8);         // public_key_instruction_index
  data.writeUInt16LE(112, 10);        // message_data_offset
  data.writeUInt16LE(MSG_LEN, 12);    // message_data_size
  data.writeUInt16LE(idx, 14);        // message_instruction_index
  return new TransactionInstruction({
    programId: Ed25519Program.programId,
    keys: [],
    data,
  });
}

interface Opts {
  quantity?: number | bigint;
  accounts?: Partial<Record<string, PublicKey>>;
  omitEd25519?: boolean;
  extraIx?: TransactionInstruction;
  payer?: PublicKey;
  discriminator?: Buffer;
  accountCount?: number;
  /** Force an absolute instruction index into the price proof's offsets, to
   *  reproduce the pre-2026-08-16 packing the guard must now reject. */
  ed25519InstructionIndex?: number;
}

/** Build the tx shape the endpoint returns, with surgical overrides. */
function buildTx(opts: Opts = {}): VersionedTransaction {
  const a = {
    holder,
    sharedVault,
    market,
    priceUpdate: PROGRAM, // Anchor's omitted-optional sentinel
    vaultMintRecord,
    optionMint,
    holderOptionAccount,
    vaultUsdcAccount,
    holderUsdcAccount,
    token2022Program: TOKEN22,
    tokenProgram: TOKEN,
    sbQueue,
    sbSlothashes: SLOTHASHES,
    sbInstructions: IX_SYSVAR,
    writerAskPot,
    writerAskPotUsdc,
    protocolState,
    // Plug wave 1: the trailing feed slot; the sentinel on the SB arm.
    optaPriceFeed: PROGRAM,
    ...(opts.accounts ?? {}),
  } as Record<string, PublicKey>;

  const order = [
    "holder", "sharedVault", "market", "priceUpdate", "vaultMintRecord",
    "optionMint", "holderOptionAccount", "vaultUsdcAccount", "holderUsdcAccount",
    "token2022Program", "tokenProgram", "sbQueue", "sbSlothashes", "sbInstructions",
    "writerAskPot", "writerAskPotUsdc", "protocolState", "optaPriceFeed",
  ].slice(0, opts.accountCount ?? 14);

  const data = opts.discriminator
    ? Buffer.concat([opts.discriminator, exerciseData(opts.quantity ?? 3).subarray(8)])
    : exerciseData(opts.quantity ?? 3);

  const exerciseIx = new TransactionInstruction({
    programId: PROGRAM,
    keys: order.map((k) => ({
      pubkey: a[k],
      isSigner: k === "holder",
      isWritable: k !== "market" && k !== "token2022Program" && k !== "tokenProgram",
    })),
    data,
  });

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  ];
  if (!opts.omitEd25519) ixs.push(fakeEd25519Ix({ instructionIndex: opts.ed25519InstructionIndex }));
  ixs.push(exerciseIx);
  if (opts.extraIx) ixs.push(opts.extraIx);

  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: opts.payer ?? holder,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: ixs,
    }).compileToV0Message(),
  );
}

test("GREEN: the transaction the endpoint is supposed to return passes", () => {
  assertExerciseTxShape(buildTx(), EXPECTED);
});

test("GREEN: it survives a base64 round-trip, which is how it actually arrives", () => {
  const b64 = Buffer.from(buildTx().serialize()).toString("base64");
  assertExerciseTxShape(deserializeExerciseTx(b64), EXPECTED);
});

test("REFUSES: a swapped vault", () => {
  const tx = buildTx({ accounts: { sharedVault: Keypair.generate().publicKey } });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), ExerciseTxShapeError);
});

test("REFUSES: the payout redirected to someone else's USDC account", () => {
  // The single most valuable thing a hostile endpoint could try.
  const tx = buildTx({ accounts: { holderUsdcAccount: Keypair.generate().publicKey } });
  assert.throws(
    () => assertExerciseTxShape(tx, EXPECTED),
    /your USDC account does not match/,
  );
});

test("REFUSES: an inflated quantity", () => {
  const tx = buildTx({ quantity: 4 });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), /quantity is 4, expected 3/);
});

test("REFUSES: a u64 quantity that would overflow a JS number", () => {
  const tx = buildTx({ quantity: 2n ** 63n });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), ExerciseTxShapeError);
});

test("REFUSES: a different Opta instruction wearing the same accounts", () => {
  const tx = buildTx({ discriminator: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) });
  assert.throws(
    () => assertExerciseTxShape(tx, EXPECTED),
    /not exercise_american/,
  );
});

test("REFUSES: a second Opta instruction smuggled in beside the exercise", () => {
  const extra = new TransactionInstruction({
    programId: PROGRAM,
    keys: [{ pubkey: holder, isSigner: true, isWritable: true }],
    data: Buffer.alloc(8),
  });
  const tx = buildTx({ extraIx: extra });
  assert.throws(
    () => assertExerciseTxShape(tx, EXPECTED),
    /expected exactly 1 Opta instruction, found 2/,
  );
});

test("REFUSES: an instruction from a program that has no business here", () => {
  const tx = buildTx({
    extraIx: new TransactionInstruction({
      programId: new PublicKey("11111111111111111111111111111111"), // SystemProgram
      keys: [{ pubkey: holder, isSigner: true, isWritable: true }],
      data: Buffer.alloc(4),
    }),
  });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), /unexpected program/);
});

test("REFUSES: a second required signer", () => {
  // compileToV0Message promotes any isSigner key into the signature set.
  const other = Keypair.generate().publicKey;
  const tx = buildTx({
    extraIx: new TransactionInstruction({
      programId: ComputeBudgetProgram.programId,
      keys: [{ pubkey: other, isSigner: true, isWritable: false }],
      data: Buffer.alloc(1),
    }),
  });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), ExerciseTxShapeError);
});

test("REFUSES: a fee payer that is not the holder", () => {
  const tx = buildTx({ payer: Keypair.generate().publicKey });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), ExerciseTxShapeError);
});

test("REFUSES: a Pyth price account on the Switchboard arm", () => {
  // price_update must be the omitted-optional sentinel (= the program id).
  const tx = buildTx({ accounts: { priceUpdate: Keypair.generate().publicKey } });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), /unexpected price account/);
});

test("REFUSES: a stripped Switchboard account", () => {
  const tx = buildTx({ accounts: { sbQueue: PROGRAM } });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), /missing its queue account/);
});

test("REFUSES: a truncated account list", () => {
  const tx = buildTx({ accountCount: 11 });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), /11 accounts, expected 14/);
});

test("REFUSES: no price proof at all", () => {
  const tx = buildTx({ omitEd25519: true });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), /no price proof/);
});

test("REFUSES: accounts hidden behind an address lookup table", () => {
  // We cannot check what we cannot see synchronously, so we refuse to try.
  const tx = buildTx();
  (tx.message as any).addressTableLookups = [
    { accountKey: Keypair.generate().publicKey, writableIndexes: [0], readonlyIndexes: [] },
  ];
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), /lookup tables/);
});

test("REFUSES: bytes that are not a transaction", () => {
  assert.throws(() => deserializeExerciseTx("bm90LWEtdHg="), ExerciseTxShapeError);
});

test("every refusal message names no vendor", () => {
  const cases: Array<() => void> = [
    () => assertExerciseTxShape(buildTx({ quantity: 9 }), EXPECTED),
    () => assertExerciseTxShape(buildTx({ omitEd25519: true }), EXPECTED),
    () => assertExerciseTxShape(buildTx({ accounts: { sbQueue: PROGRAM } }), EXPECTED),
    () => assertExerciseTxShape(
      buildTx({ accounts: { priceUpdate: Keypair.generate().publicKey } }), EXPECTED),
    () => deserializeExerciseTx("bm90LWEtdHg="),
  ];
  for (const c of cases) {
    try {
      c();
      assert.fail("expected a refusal");
    } catch (e: any) {
      assert.doesNotMatch(e.message, /pyth|switchboard|hermes|ed25519/i, e.message);
    }
  }
});

// ===========================================================================
// 3. ENDPOINT CLIENT — failures are neutral copy, never a vendor name
// ===========================================================================

const REQ = {
  holder: EXPECTED.holder,
  sharedVault: EXPECTED.sharedVault,
  market: EXPECTED.market,
  vaultMintRecord: EXPECTED.vaultMintRecord,
  optionMint: EXPECTED.optionMint,
  holderOptionAccount: EXPECTED.holderOptionAccount,
  vaultUsdcAccount: EXPECTED.vaultUsdcAccount,
  holderUsdcAccount: EXPECTED.holderUsdcAccount,
  quantity: 3,
};

test("a good response is parsed", async () => {
  const fake = async () => ({
    ok: true,
    json: async () => ({ transactionBase64: "AAA=", lastValidBlockHeight: 42 }),
  });
  const r = await postSbExercise("https://x", REQ, fake as any);
  assert.equal(r.transactionBase64, "AAA=");
  assert.equal(r.lastValidBlockHeight, 42);
});

test("it POSTs to /sb-exercise-american", async () => {
  let seen = "";
  const fake = async (url: string) => {
    seen = url;
    return { ok: true, json: async () => ({ transactionBase64: "A", lastValidBlockHeight: 1 }) };
  };
  await postSbExercise("https://x", REQ, fake as any);
  assert.equal(seen, "https://x/sb-exercise-american");
});

test("an unreachable endpoint is a network error, not a silent success", async () => {
  const fake = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(() => postSbExercise("https://x", REQ, fake as any), SbExerciseNetworkError);
});

test("a malformed 200 is rejected rather than handed to the wallet", async () => {
  const fake = async () => ({ ok: true, json: async () => ({ transactionBase64: 5 }) });
  await assert.rejects(
    () => postSbExercise("https://x", REQ, fake as any),
    SbExerciseEndpointError,
  );
});

test("a non-2xx surfaces neutral copy — no vendor name reaches the user", async () => {
  const fake = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ error: "could not fetch a fresh Switchboard quote" }),
  });
  // The endpoint's own detail is echoed ONLY if neutral; this one is not, so the
  // client must not pass it through verbatim.
  try {
    await postSbExercise("https://x", REQ, fake as any);
    assert.fail("expected a rejection");
  } catch (e: any) {
    assert.doesNotMatch(e.message, /switchboard|pyth|hermes/i, e.message);
  }
});

// ===========================================================================
// 4. THE QUOTE DEADLINE (GATE 4) — the two bounds inverted
// ===========================================================================

test("RED: a quote past its deadline is refused BEFORE the wallet opens", () => {
  // Measured 2026-08-13: the quote budget is 150 slots but devnet runs at
  // ~4.22 slots/s, so it is worth ~35s — SHORTER than a blockhash (60-90s).
  // Blockhash validity therefore no longer implies quote validity, and a slow
  // approve hands the user a transaction that is already dead.
  assert.equal(isQuoteExpired({ quoteExpiresAtSlot: 1000 }, 1200), true);
});

test("a fresh quote is not refused", () => {
  assert.equal(isQuoteExpired({ quoteExpiresAtSlot: 1000 }, 800), false);
});

test("the margin rejects a quote that would expire in flight", () => {
  // At the boundary the tx still has to reach a leader. 20 slots ~ 5s.
  assert.equal(isQuoteExpired({ quoteExpiresAtSlot: 1000 }, 985), true);
  assert.equal(isQuoteExpired({ quoteExpiresAtSlot: 1000 }, 979), false);
  assert.equal(isQuoteExpired({ quoteExpiresAtSlot: 1000 }, 995, 0), false);
});

test("an endpoint that publishes no deadline keeps the old behaviour", () => {
  // Older builds return no quoteExpiresAtSlot. Inventing a bound we cannot know
  // would block every exercise against them.
  assert.equal(isQuoteExpired({}, 999_999_999), false);
  assert.equal(isQuoteExpired({ quoteExpiresAtSlot: undefined }, 1), false);
});

test("the endpoint client passes the deadline through when present", async () => {
  const withDeadline = async () => ({
    ok: true,
    json: async () => ({ transactionBase64: "A", lastValidBlockHeight: 1, quoteExpiresAtSlot: 7 }),
  });
  const r = await postSbExercise("https://x", REQ, withDeadline as any);
  assert.equal(r.quoteExpiresAtSlot, 7);

  const without = async () => ({
    ok: true,
    json: async () => ({ transactionBase64: "A", lastValidBlockHeight: 1 }),
  });
  assert.equal((await postSbExercise("https://x", REQ, without as any)).quoteExpiresAtSlot, undefined);
});

test("a non-numeric deadline is dropped rather than trusted", async () => {
  const bad = async () => ({
    ok: true,
    json: async () => ({ transactionBase64: "A", lastValidBlockHeight: 1, quoteExpiresAtSlot: "soon" }),
  });
  assert.equal((await postSbExercise("https://x", REQ, bad as any)).quoteExpiresAtSlot, undefined);
});

// ---- Writer-ask pot arm (2026-08-15): the dual shape ------------------------
// 14 accounts = vault-funded, trailing optionals omitted. 17 = the pot arm is
// carried. Both are legal; indices 0-13 are identical in each.

const EXPECTED_POT: ExpectedExercise = {
  ...EXPECTED,
  writerAskPot: writerAskPot.toBase58(),
  writerAskPotUsdc: writerAskPotUsdc.toBase58(),
  protocolState: protocolState.toBase58(),
};

test("GREEN: the 14-account vault-funded shape still passes untouched", () => {
  // The regression that matters: adding an arm must not invalidate every
  // exercise built before it existed.
  assertExerciseTxShape(buildTx(), EXPECTED);
  assertExerciseTxShape(buildTx(), EXPECTED_POT);
});

test("GREEN: the 17-account pot shape passes when every address matches", () => {
  assertExerciseTxShape(buildTx({ accountCount: 17 }), EXPECTED_POT);
});

test("REFUSES: a pot arm this client never derived", () => {
  // No local expectation means no way to check it. "Looks plausible" is not
  // verification, and the pot leg is signed by protocol_state.
  assert.throws(
    () => assertExerciseTxShape(buildTx({ accountCount: 17 }), EXPECTED),
    /did not derive/,
  );
});

test("REFUSES: another series' collateral pot", () => {
  const tx = buildTx({ accountCount: 17, accounts: { writerAskPot: Keypair.generate().publicKey } });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED_POT), /collateral pot does not match/);
});

test("REFUSES: the pot payout account swapped", () => {
  const tx = buildTx({ accountCount: 17, accounts: { writerAskPotUsdc: Keypair.generate().publicKey } });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED_POT), /collateral pot account does not match/);
});

test("REFUSES: a substituted protocol_state — the account that SIGNS the pot leg", () => {
  const tx = buildTx({ accountCount: 17, accounts: { protocolState: Keypair.generate().publicKey } });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED_POT), /protocol state does not match/);
});

test("REFUSES: a half-supplied pot arm (15 or 16 accounts)", () => {
  for (const n of [15, 16]) {
    assert.throws(
      () => assertExerciseTxShape(buildTx({ accountCount: n }), EXPECTED_POT),
      new RegExp(`${n} accounts, expected 14, 17 or 18`),
    );
  }
});

test("plug wave 1: source 2 resolves to the opta arm", () => {
  assert.equal(chooseExerciseArm(2), "opta");
});

test("GREEN: an 18-account SB build carrying the trailing sentinel passes (current endpoint shape)", () => {
  assertExerciseTxShape(buildTx({ accountCount: 18 }), EXPECTED_POT);
});

test("REFUSES: an 18-account build with a REAL key in the feed slot — not a Switchboard exercise", () => {
  const tx = buildTx({ accountCount: 18, accounts: { optaPriceFeed: Keypair.generate().publicKey } });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED_POT), /unexpected price account/);
});

test("indices 0-13 are unchanged by the arm — the legacy map still reads true", () => {
  const I = EXERCISE_ACCOUNT_INDEX;
  assert.equal(I.holder, 0);
  assert.equal(I.sbInstructions, 13);
  assert.equal(I.writerAskPot, 14);
  assert.equal(I.writerAskPotUsdc, 15);
  assert.equal(I.protocolState, 16);
});

test("REFUSES: a price proof whose offsets point outside the instruction they name", () => {
  // instruction_index 0 is the ComputeBudget ix (a few bytes) — it cannot hold a
  // 64-byte signature at offset 16. This is the builder-side regression the guard
  // exists to catch: absolute indices shipping again instead of SELF.
  const tx = buildTx({ accountCount: 17, ed25519InstructionIndex: 0 });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED_POT), /out of bounds/);
});

test("GREEN: a SELF-referential price proof passes regardless of its position", () => {
  const tx = buildTx({ accountCount: 17 });
  assert.doesNotThrow(() => assertExerciseTxShape(tx, EXPECTED_POT));
});

test("GREEN: 17 accounts with NULL pot sentinels is a pool-funded exercise, not a pot arm", () => {
  // Anchor writes the program id into an unused optional's slot. Before
  // 2026-08-16 the guard read length alone, so this shape demanded pot
  // expectations and refused a legitimate pool-funded exercise.
  const tx = buildTx({
    accountCount: 17,
    accounts: { writerAskPot: PROGRAM, writerAskPotUsdc: PROGRAM, protocolState: PROGRAM },
  });
  assert.doesNotThrow(() => assertExerciseTxShape(tx, EXPECTED));
});

test("REFUSES: a REAL pot at the slot still requires a matching local derivation", () => {
  const tx = buildTx({ accountCount: 17 });
  assert.throws(() => assertExerciseTxShape(tx, EXPECTED), /did not derive/);
});
