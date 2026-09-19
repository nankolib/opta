// fp-oracle-quote-probe.js — READ-ONLY hourly quote probe for every source-2
// market on canonical (post-plug check-in tooling, ruled 2026-09-19).
//
// For each OptionsMarket with oracle_source == 2: simulate get_option_price
// (signature-free) for an ATM call and put, 7 days out, American, and record
// the return data: premium, the VOL FIELD (must equal seed_vol while
// sample_count < 168, then the realised ring), spot, ts. Also records the
// VolOracle's sample_count / last_sample_ts / seed_vol and the feed's
// price / publish_time. One JSON line per market, appended to the JSONL in
// argv[2] (or stdout only). Exit 0 = every probe returned; 1 = a probe errored.
//
//   cd crank && NODE_PATH=$PWD/node_modules node ../scripts/fp-oracle-quote-probe.js [out.jsonl]
//   RPC_URL overrides the public devnet endpoint (reads + simulate only).
"use strict";
const fs = require("fs");
const path = require("path");
const { Connection, PublicKey, Transaction, ComputeBudgetProgram } = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor"); const { BN } = anchor;
// OPTA_IDL_PATH lets the probe run standalone on the box (outside the repo
// checkout), pointing at the crank's own IDL; default = the repo layout.
const idl = require(process.env.OPTA_IDL_PATH || path.resolve(__dirname, "..", "crank", "idl", "opta.json"));
const PID = new PublicKey(idl.address);
const PAYER = new PublicKey("5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk"); // any funded account; nothing is signed
const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
const coder = new anchor.BorshAccountsCoder(idl);
const bs58 = anchor.utils.bytes.bs58;
const disc = (n) => Buffer.from(idl.accounts.find((a) => a.name === n).discriminator);
const pda = (s) => PublicKey.findProgramAddressSync(s, PID)[0];
const g = (o, a, b) => (o[a] !== undefined ? o[a] : o[b]);

(async () => {
  const outFile = process.argv[2] || null;
  const ts = new Date().toISOString();
  const p = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(anchor.web3.Keypair.generate()), {}));
  const raw = await conn.getProgramAccounts(PID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc("OptionsMarket")) } }] });
  const markets = [];
  for (const { pubkey, account } of raw) { try { const m = coder.decode("OptionsMarket", account.data); if (Number(g(m, "oracle_source", "oracleSource")) === 2) markets.push({ pubkey, m }); } catch (_) {} }
  let errored = 0;
  for (const { pubkey, m } of markets) {
    const name = String(g(m, "asset_name", "assetName")).replace(/\0+$/, "");
    const feedBuf = Buffer.from(g(m, "pyth_feed_id", "pythFeedId"));
    const VOL = pda([Buffer.from("vol_oracle"), feedBuf]); const FEED = pda([Buffer.from("opta_price_feed"), feedBuf]);
    const [vi, fi] = await conn.getMultipleAccountsInfo([VOL, FEED], "confirmed");
    const v = vi ? coder.decode("VolOracle", vi.data) : null; const f = fi ? coder.decode("OptaPriceFeed", fi.data) : null;
    const rec = { ts, asset: name, market: pubkey.toBase58(), vol_oracle: VOL.toBase58(), sample_count: v ? Number(g(v, "sample_count", "sampleCount")) : null,
      last_sample_ts: v ? Number(g(v, "last_sample_ts", "lastSampleTs")) : null, seed_vol: v ? String(g(v, "seed_vol", "seedVol")) : null,
      feed_price_6dec: f ? String(g(f, "price_6dec", "price6dec")) : null, feed_publish_time: f ? Number(g(f, "publish_time", "publishTime")) : null, feed_frozen: f ? !!f.frozen : null,
      spot: v ? Number(g(v, "last_spot_price", "lastSpotPrice")) / 1e12 : null, quotes: {} };
    const strike = rec.spot ? Math.round(rec.spot / 100) * 100 : null; const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
    rec.strike = strike; rec.expiry = expiry;
    for (const side of ["call", "put"]) {
      try {
        const ix = await p.methods.getOptionPrice(new BN(Math.round(strike * 1e6)), new BN(expiry), { [side]: {} }, { american: {} }, 0).accountsStrict({ market: pubkey, volOracle: VOL }).instruction();
        const bh = await conn.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: PAYER, recentBlockhash: bh.blockhash }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
        const r = await conn.simulateTransaction(tx);
        const rd = r.value.returnData ? Buffer.from(r.value.returnData.data[0], "base64") : null;
        const u = rd ? Array.from({ length: Math.floor(rd.length / 8) }, (_, i) => rd.readBigUInt64LE(i * 8).toString()) : null;
        rec.quotes[side] = { err: r.value.err ? JSON.stringify(r.value.err) : null, units: r.value.unitsConsumed, premium_6dec: u ? u[0] : null, vol_field: u ? u[1] : null, spot_field: u ? u[2] : null };
        if (r.value.err) errored++;
      } catch (e) { rec.quotes[side] = { err: String(e).slice(0, 200) }; errored++; }
    }
    rec.vol_field_is_seed = rec.quotes.call && rec.quotes.call.vol_field === rec.seed_vol;
    rec.write_gate_holding = rec.sample_count !== null && rec.sample_count < 168;
    const line = JSON.stringify(rec);
    console.log(line);
    if (outFile) fs.appendFileSync(outFile, line + "\n");
  }
  if (markets.length === 0) console.log(JSON.stringify({ ts, note: "no source-2 markets" }));
  process.exitCode = errored ? 1 : 0;
})().catch((e) => { console.error("probe failed:", e.message); process.exitCode = 2; });
