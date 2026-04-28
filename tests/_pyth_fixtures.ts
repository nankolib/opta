// =============================================================================
// tests/_pyth_fixtures.ts — Fake PriceUpdateV2 fixture helper
// =============================================================================
//
// Stage P2 test infrastructure. Serializes Pyth Pull PriceUpdateV2 accounts
// in their exact on-chain Borsh layout so solana-test-validator's
// --account flag can pre-load them with Pyth Receiver as the owner. The
// settle_expiry instruction's `Account<'info, PriceUpdateV2>` constraint
// then accepts them as if they came from a real post_update_atomic call.
//
// Layout reference: pythnet-sdk-2.3.1::messages::PriceFeedMessage and
// pyth-solana-receiver-sdk-1.1.0::price_update::PriceUpdateV2.
//
// Total bytes per fixture: 8 (discriminator) + 32 (write_authority) +
//   1 (verification_level=Full) + 84 (price_message) + 8 (posted_slot) = 133.
// =============================================================================

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

// Pyth Solana Receiver program ID (devnet + mainnet are the same).
export const PYTH_RECEIVER_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

// Anchor account discriminator: SHA-256("account:PriceUpdateV2")[..8].
function priceUpdateV2Discriminator(): Buffer {
  return crypto
    .createHash("sha256")
    .update("account:PriceUpdateV2")
    .digest()
    .subarray(0, 8);
}

export type PriceUpdateFixture = {
  feedIdHex: string;     // 64 hex chars (no 0x prefix)
  price: bigint;         // i64
  conf: bigint;          // u64
  exponent: number;      // i32
  publishTime: bigint;   // i64 (unix seconds)
  prevPublishTime: bigint; // i64
  emaPrice: bigint;      // i64
  emaConf: bigint;       // u64
};

/// Serialize a PriceUpdateV2 account body (133 bytes including discriminator).
export function serializePriceUpdateV2(f: PriceUpdateFixture): Buffer {
  const buf = Buffer.alloc(8 + 32 + 1 + 84 + 8);
  let o = 0;

  // Discriminator
  priceUpdateV2Discriminator().copy(buf, o);
  o += 8;

  // write_authority: Pubkey (any value — settle_expiry doesn't read it)
  buf.fill(0, o, o + 32);
  o += 32;

  // verification_level: Full = enum tag 1 (Borsh: 1-byte tag, no payload).
  buf.writeUInt8(1, o);
  o += 1;

  // PriceFeedMessage — declaration order in pythnet-sdk-2.3.1::messages.rs:
  //   feed_id, price, conf, exponent, publish_time, prev_publish_time,
  //   ema_price, ema_conf
  const feedId = Buffer.from(f.feedIdHex, "hex");
  if (feedId.length !== 32) {
    throw new Error(`feedIdHex must decode to 32 bytes, got ${feedId.length}`);
  }
  feedId.copy(buf, o); o += 32;
  buf.writeBigInt64LE(f.price, o); o += 8;
  buf.writeBigUInt64LE(f.conf, o); o += 8;
  buf.writeInt32LE(f.exponent, o); o += 4;
  buf.writeBigInt64LE(f.publishTime, o); o += 8;
  buf.writeBigInt64LE(f.prevPublishTime, o); o += 8;
  buf.writeBigInt64LE(f.emaPrice, o); o += 8;
  buf.writeBigUInt64LE(f.emaConf, o); o += 8;

  // posted_slot: u64 (any value — not read by settle_expiry)
  buf.writeBigUInt64LE(BigInt(0), o); o += 8;

  return buf;
}

/// Round-trip deserializer matching `serializePriceUpdateV2` byte layout.
/// Self-consistency check — catches off-by-N / endianness / int-size bugs
/// in our own serializer. Cross-side drift (the Pyth SDK changing the
/// PriceFeedMessage struct) is caught by the downstream end-to-end
/// settle_expiry tests when the program rejects the fixture.
export function deserializePriceUpdateV2(body: Buffer): {
  discriminator: Buffer;
  writeAuthority: Buffer;
  verificationLevelTag: number; // 0 = Partial, 1 = Full
  feedId: Buffer;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  prevPublishTime: bigint;
  emaPrice: bigint;
  emaConf: bigint;
  postedSlot: bigint;
} {
  if (body.length !== 133) {
    throw new Error(`expected 133 bytes, got ${body.length}`);
  }
  let o = 0;
  const discriminator = body.subarray(o, o + 8); o += 8;
  const writeAuthority = body.subarray(o, o + 32); o += 32;
  const verificationLevelTag = body.readUInt8(o); o += 1;
  const feedId = body.subarray(o, o + 32); o += 32;
  const price = body.readBigInt64LE(o); o += 8;
  const conf = body.readBigUInt64LE(o); o += 8;
  const exponent = body.readInt32LE(o); o += 4;
  const publishTime = body.readBigInt64LE(o); o += 8;
  const prevPublishTime = body.readBigInt64LE(o); o += 8;
  const emaPrice = body.readBigInt64LE(o); o += 8;
  const emaConf = body.readBigUInt64LE(o); o += 8;
  const postedSlot = body.readBigUInt64LE(o); o += 8;
  return {
    discriminator, writeAuthority, verificationLevelTag,
    feedId, price, conf, exponent, publishTime, prevPublishTime,
    emaPrice, emaConf, postedSlot,
  };
}

/// Deterministic pubkey for a fixture name. SHA-256("opta:fixture:" + name)
/// truncated to 32 bytes. Doesn't need to be a valid ed25519 point — accounts
/// can have any 32-byte address.
export function fixturePubkey(name: string): PublicKey {
  const bytes = crypto
    .createHash("sha256")
    .update("opta:fixture:" + name)
    .digest()
    .subarray(0, 32);
  return new PublicKey(bytes);
}

/// Write the JSON fixture in solana-test-validator's --account format.
/// rentEpoch=0 is safe for test fixtures: accounts are rent-exempt (5M
/// lamports for 133 bytes is well above the rent-exempt minimum), and
/// the validator never tries to collect rent on a 0-epoch account.
/// Using u64::MAX would lose precision through JSON.stringify since
/// 1.8e19 > Number.MAX_SAFE_INTEGER, breaking the validator's parser.
export function writeFixtureJson(filePath: string, pubkey: PublicKey, body: Buffer): void {
  const accountJson = {
    pubkey: pubkey.toBase58(),
    account: {
      lamports: 5_000_000,
      data: [body.toString("base64"), "base64"],
      owner: PYTH_RECEIVER_ID,
      executable: false,
      rentEpoch: 0,
      space: body.length,
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(accountJson, null, 2));
}

/// Hex feed IDs for the assets we use in tests. Mainnet IDs from
/// scripts/pyth-feed-ids.csv — Stage P2 stores these verbatim, no
/// validation against Hermes (we use Option B = fake fixtures).
export const FEED_ID_HEX = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
};

/// The 5 fixtures the P2 test suite needs. Names map to scenarios and
/// must stay stable — test code looks them up by name via fixturePubkey().
export type FixtureSpec = {
  name: string;
  feedIdHex: string;
  /// Price as a u128-ish number (TS bigint). Pyth uses (price × 10^expo).
  price: bigint;
  exponent: number;
  /// Offset from now (negative = in the past). 0 = "right now".
  publishTimeOffsetSec: number;
};

export const ALL_FIXTURES: FixtureSpec[] = [
  // SOL @ $180, fresh — used by opta happy/pre-expiry/unregistered/double-settle
  { name: "sol-180-fresh", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: -30 },
  // SOL @ $180 but stale — used by opta stale-rejection test
  { name: "sol-180-stale", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: -400 },
  // BTC fresh — used by opta wrong-feed test (asset is SOL but fixture is BTC feed)
  { name: "btc-fresh", feedIdHex: FEED_ID_HEX.BTC, price: BigInt("90000000000000"), exponent: -8, publishTimeOffsetSec: -30 },
  // SOL @ $250 fresh — zzz CRITICAL-ITM
  { name: "sol-250-fresh", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("25000000000"), exponent: -8, publishTimeOffsetSec: -30 },
  // SOL @ $50 fresh — zzz CRITICAL-OTM, HIGH-01, DUST
  { name: "sol-50-fresh", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("5000000000"), exponent: -8, publishTimeOffsetSec: -30 },
];

/// Write all fixtures to /tmp and return the (name → pubkey) map plus the
/// list of `--account <PUBKEY> <FILE>` argument pairs the launcher needs.
export function writeAllFixtures(outDir: string = "/tmp"): {
  pubkeys: Record<string, PublicKey>;
  launcherArgs: string[];
} {
  const now = Math.floor(Date.now() / 1000);
  const pubkeys: Record<string, PublicKey> = {};
  const launcherArgs: string[] = [];

  for (const spec of ALL_FIXTURES) {
    const fixture: PriceUpdateFixture = {
      feedIdHex: spec.feedIdHex,
      price: spec.price,
      conf: BigInt(1_000_000),
      exponent: spec.exponent,
      publishTime: BigInt(now + spec.publishTimeOffsetSec),
      prevPublishTime: BigInt(now + spec.publishTimeOffsetSec - 1),
      emaPrice: spec.price,
      emaConf: BigInt(1_000_000),
    };
    const body = serializePriceUpdateV2(fixture);
    const pk = fixturePubkey(spec.name);
    const filePath = path.join(outDir, `pyth_${spec.name}.json`);
    writeFixtureJson(filePath, pk, body);

    pubkeys[spec.name] = pk;
    launcherArgs.push("--account", pk.toBase58(), filePath);
  }

  return { pubkeys, launcherArgs };
}
