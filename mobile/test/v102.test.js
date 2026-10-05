// Seeker 1.0.2 red-first suite: first-party markets (oracle_source 2).
//
// Gates:
//   the two guards admit source 2 through ONE predicate, and nothing above it
//   a source-2 spot is read from the first-party feed account, never over HTTP
//   the feed decoder is exact against REAL devnet bytes, and honest about age
//   the fallback to the hourly on-chain sample can never read "live"
//   version 1.0.2 / versionCode 4 in both app.json and the native project
//
// Build + run:
//   npx tsc -p tsconfig.test.json && node --test --test-force-exit test/v102.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const OUT = process.env.OPTA_TEST_OUT || path.join(__dirname, "out");
const SRC = process.env.OPTA_TEST_SRC || path.join(__dirname, "..", "src");
const load = (rel) => require(path.join(OUT, rel));
const src = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// Real devnet accounts, read 2026-10-05 at slot 507756712 (SOL market
// 7ke68gTG... and its first-party feed 7bxvxKGT...). Price 121.13.
const FEED_B64 = "kBI+daZkNv3gH+O7HWWeWVcpayY3ZY3v0fi0L8h92fFuj/8W/K60YxBMOAcAAAAAIE4AAAAAAABKr8NqAAAAAFXAQx4AAAAAnIbAD/WcVQXFQVu1w2GnL3uKW1UkPDzU/VwnBViDJWjQPjUHAAAAAAevw2oAAAAAAP8=";
const MARKET_B64 = "Qx5aJILbpggDAAAAU09M4B/jux1lnllXKWsmN2WN79H4tC/Ifdnxbo//FvyutGMA/QIAAAAAAAAAAAAAAAAA";
const FEED_PDA = "7bxvxKGTheW7K7ntpX6kKfMbja3D6DTqBsDGsbY3A8kb";
const PUBLISH_TIME = 1791209290;
const feedBytes = () => Buffer.from(FEED_B64, "base64");

test("the supported-source predicate admits 0, 1 and 2 and nothing else", () => {
  const { isSupportedOracleSource } = load("solana/optaFeed.js");
  for (const ok of [0, 1, 2]) assert.equal(isSupportedOracleSource(ok), true, `source ${ok}`);
  for (const bad of [3, 4, 255, -1, 1.5, "2", null, undefined, NaN]) assert.equal(isSupportedOracleSource(bad), false, `source ${String(bad)}`);
});

test("spot routing: 0 over HTTP, 1 from the hourly sample, 2 from the first-party feed, anything else nowhere", () => {
  const { spotRouteFor } = load("solana/optaFeed.js");
  assert.equal(spotRouteFor(0), "http");
  assert.equal(spotRouteFor(1), "volOracle");
  assert.equal(spotRouteFor(2), "optaFeed");
  assert.equal(spotRouteFor(3), null);
});

test("decoder, real devnet bytes: price, publish time, live inside the age bound", () => {
  const { decodeOptaFeedSpot, OPTA_FEED_LIVE_MAX_AGE_SECONDS } = load("solana/optaFeed.js");
  assert.equal(OPTA_FEED_LIVE_MAX_AGE_SECONDS, 180);
  const q = decodeOptaFeedSpot(feedBytes(), PUBLISH_TIME + 10);
  assert.deepEqual(q, { value: 121.13, state: "live", publishTime: PUBLISH_TIME });
});

test("decoder is honest about age: stale past the bound, and past the future tolerance", () => {
  const { decodeOptaFeedSpot } = load("solana/optaFeed.js");
  assert.equal(decodeOptaFeedSpot(feedBytes(), PUBLISH_TIME + 180).state, "live");
  assert.equal(decodeOptaFeedSpot(feedBytes(), PUBLISH_TIME + 181).state, "stale");
  assert.equal(decodeOptaFeedSpot(feedBytes(), PUBLISH_TIME - 30).state, "live");
  assert.equal(decodeOptaFeedSpot(feedBytes(), PUBLISH_TIME - 31).state, "stale");
});

test("decoder refuses a frozen feed, a never-pushed feed and a short account", () => {
  const { decodeOptaFeedSpot } = load("solana/optaFeed.js");
  const frozen = feedBytes(); frozen[120] = 1;
  assert.equal(decodeOptaFeedSpot(frozen, PUBLISH_TIME), null);
  const zero = feedBytes(); zero.fill(0, 40, 48);
  assert.equal(decodeOptaFeedSpot(zero, PUBLISH_TIME), null);
  assert.equal(decodeOptaFeedSpot(feedBytes().subarray(0, 121), PUBLISH_TIME), null);
});

test("the feed address derives from the market's own feed id (real market bytes)", () => {
  const { deriveOptaPriceFeed } = load("solana/pdas.js");
  const m = Buffer.from(MARKET_B64, "base64");
  const nameLen = m.readUInt32LE(8);
  assert.equal(m.subarray(12, 12 + nameLen).toString("ascii"), "SOL");
  assert.equal(m[12 + nameLen + 34], 2, "the real SOL market is source 2");
  const feedId = Array.from(m.subarray(12 + nameLen, 12 + nameLen + 32));
  assert.equal(deriveOptaPriceFeed(feedId).toBase58(), FEED_PDA);
});

test("the fallback to the hourly sample never reads live", () => {
  const { asFallbackSpot } = load("solana/optaFeed.js");
  assert.deepEqual(asFallbackSpot({ value: 120.5, state: "live" }), { value: 120.5, state: "stale" });
  assert.deepEqual(asFallbackSpot({ value: 120.5, state: "stale" }), { value: 120.5, state: "stale" });
  assert.equal(asFallbackSpot(null), null);
});

test("guard 1 (program.ts): the market validator uses the predicate, the 0|1 literal is gone", () => {
  const s = src("solana/program.ts");
  assert.match(s, /isSupportedOracleSource\(account\.oracleSource\)/);
  assert.doesNotMatch(s, /oracleSource === 0 \|\| account\.oracleSource === 1/);
});

test("guard 2 (marketData.ts): the board filter uses the predicate, the 0|1 literal is gone", () => {
  const s = src("solana/marketData.ts");
  assert.match(s, /if \(!isSupportedOracleSource\(market\.account\.oracleSource\)\) return \[\];/);
  assert.doesNotMatch(s, /oracleSource !== 0 && market\.account\.oracleSource !== 1/);
});

test("the spot stage routes by source: HTTP only for route http, the feed read for source 2", () => {
  const s = src("solana/marketData.ts");
  assert.match(s, /spotRouteFor\(feed\.source\)/);
  assert.match(s, /route === "optaFeed"/);
  assert.match(s, /route === "http"/);
  assert.match(s, /fetchOptaFeedSpot\(/);
  assert.match(s, /asFallbackSpot\(/);
  assert.doesNotMatch(s, /feed\.source === 1\s*\?/, "the two-way source ternary sent source 2 over HTTP");
});

test("the real market account decodes as a valid source-2 market", () => {
  const { __test_decodeAccount } = load("solana/program.js");
  const a = __test_decodeAccount("optionsMarket", Buffer.from(MARKET_B64, "base64"));
  assert.ok(a, "source 2 must not be rejected by the validator");
  assert.equal(a.assetName, "SOL");
  assert.equal(a.oracleSource, 2);
});

test("the real feed account decodes through the account path", () => {
  const { __test_decodeAccount } = load("solana/program.js");
  const a = __test_decodeAccount("optaPriceFeed", feedBytes());
  assert.equal(a.price6Dec, 121130000);
  assert.equal(a.publishTime, PUBLISH_TIME);
  assert.equal(a.frozen, false);
});

test("version: 1.0.2 / versionCode 4 in app.json and in the native project", () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app.json"), "utf8"));
  assert.equal(app.expo.version, "1.0.2");
  assert.equal(app.expo.android.versionCode, 4);
  const gradle = fs.readFileSync(path.join(__dirname, "..", "android", "app", "build.gradle"), "utf8");
  assert.match(gradle, /versionCode 4\b/);
  assert.match(gradle, /versionName "1\.0\.2"/);
});
