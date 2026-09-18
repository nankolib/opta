// L3 pre-state + the proven-nonzero vault check (plug proposal 6.0), READ-ONLY.
// Run from crank/ (for its node_modules): NODE_PATH=$PWD/node_modules node ../scripts/fp-oracle-l3-prestate.js [ASSET]
// Exit 0 = report printed. Exit 2 = a query that must not be empty was empty (STOP).
const { Connection, PublicKey } = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");
const idl = require(require("path").resolve(__dirname, "..", "crank", "idl", "opta.json"));
const PID = new PublicKey(idl.address);
const coder = new anchor.BorshAccountsCoder(idl);
const bs58 = anchor.utils.bytes.bs58;
const disc = (n) => Buffer.from(idl.accounts.find((a) => a.name === n).discriminator);
const FEEDS = {
  BTC: "baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2",
  ETH: "1d8f55a03da760d0f322bc1d066427e95573f651d506e0e31a5499659349caa3",
  SOL: "e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463",
  XRP: "a1c4ce28a9a4abd471fb2eb11236c299a3b02cad72f3f93437aa01578405f736",
  XAU: "6c3c5cc720d1ffd8108aca22bf7834d659612b7e1a4e5f623b76846d1167355e",
};
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PID)[0];
const g = (o, a, b) => (o[a] !== undefined ? o[a] : o[b]);
(async () => {
  const conn = new Connection(process.env.RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const only = process.argv[2];
  console.log("program", PID.toBase58(), "rpc", (process.env.RPC_URL || "public devnet").replace(/api-key=.*/, "api-key=<redacted>"), "at", new Date().toISOString());
  // 6.0 step 1 — control query: program-wide SharedVault count MUST be > 0
  const control = await conn.getProgramAccounts(PID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc("SharedVault")) } }] });
  if (control.length === 0) { console.log("CONTROL ZERO — the query is broken, not the protocol empty. STOP."); process.exit(2); }
  const decoded = []; let undec = 0;
  for (const c of control) { try { decoded.push({ pk: c.pubkey, v: coder.decode("SharedVault", c.account.data) }); } catch (e) { undec++; } }
  console.log(`control: SharedVault program-wide = ${control.length} (decoded ${decoded.length}, undecodable ${undec})`);
  // Writer-ask collateral lives in WriterAskPot (keyed by vault), NOT in
  // SharedVault.total_collateral, and the on-chain R1 guard reads only the
  // vault. A vault can read clean while its pot holds live collateral, so the
  // off-chain proof joins pots onto vaults. Control: program-wide pot count.
  const potsRaw = await conn.getProgramAccounts(PID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc("WriterAskPot")) } }] });
  const pots = []; let potUndec = 0;
  for (const c of potsRaw) { try { pots.push({ pk: c.pubkey, v: coder.decode("WriterAskPot", c.account.data) }); } catch (e) { potUndec++; } }
  const potsByVault = new Map(); for (const p of pots) { const k = p.v.vault.toBase58(); if (!potsByVault.has(k)) potsByVault.set(k, []); potsByVault.get(k).push(p); }
  console.log(`control: WriterAskPot program-wide = ${potsRaw.length} (decoded ${pots.length}, undecodable ${potUndec}, with collateral>0: ${pots.filter((p) => String(g(p.v, "total_collateral", "totalCollateral")) !== "0").length})`);
  for (const [name, feedHex] of Object.entries(FEEDS)) {
    if (only && only !== name) continue;
    const feed = Buffer.from(feedHex, "hex");
    const market = pda([Buffer.from("market"), Buffer.from(name)]);
    const vol = pda([Buffer.from("vol_oracle"), feed]);
    const opta = pda([Buffer.from("opta_price_feed"), feed]);
    const [mi, vi, oi] = await conn.getMultipleAccountsInfo([market, vol, opta]);
    const m = mi ? coder.decode("OptionsMarket", mi.data) : null;
    const v = vi ? coder.decode("VolOracle", vi.data) : null;
    // 6.0 step 2 — target query by memcmp on SharedVault.market (offset 8)
    const target = await conn.getProgramAccounts(PID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc("SharedVault")) } }, { memcmp: { offset: 8, bytes: market.toBase58() } }] });
    // 6.0 step 3 — cross-check by a second path (filter the decoded control set)
    const mem = decoded.filter((d) => d.v.market.equals(market));
    const agree = target.length === mem.length;
    // 6.0 steps 4-5 — decode every row, assert clean locally
    let unclean = 0, potOpen = 0, potCount = 0; const rows = [];
    for (const d of mem) {
      const settled = g(d.v, "is_settled", "isSettled"), voided = g(d.v, "voided", "voided"), coll = String(g(d.v, "total_collateral", "totalCollateral"));
      const clean = !!settled || !!voided || coll === "0";
      if (!clean) unclean++;
      const vp = potsByVault.get(d.pk.toBase58()) || []; potCount += vp.length;
      const potColl = vp.map((p) => String(g(p.v, "total_collateral", "totalCollateral")));
      const potLive = !settled && !voided && potColl.some((c) => c !== "0");
      if (potLive) potOpen++;
      if (!clean || potLive || (!settled && !voided)) rows.push(`${d.pk.toBase58()} settled=${settled} voided=${voided} total_collateral=${coll} pots=${vp.length} pot_collateral=[${potColl.join(",")}]${clean ? "" : "  <-- OPEN"}${potLive ? "  <-- POT LIVE (invisible to the on-chain guard)" : ""}`);
    }
    console.log(`\n== ${name} ==`);
    console.log(`  market          ${market.toBase58()} exists=${!!mi} len=${mi ? mi.data.length : "-"} oracle_source=${m ? g(m, "oracle_source", "oracleSource") : "-"} feed_id_matches=${m ? Buffer.from(g(m, "pyth_feed_id", "pythFeedId")).equals(feed) : "-"}`);
    console.log(`  vol_oracle      ${vol.toBase58()} exists=${!!vi} oracle_source=${v ? g(v, "oracle_source", "oracleSource") : "-"} sample_count=${v ? g(v, "sample_count", "sampleCount") : "-"} last_sample_ts=${v ? g(v, "last_sample_ts", "lastSampleTs") : "-"} seed_vol=${v ? g(v, "seed_vol", "seedVol") : "-"}`);
    console.log(`  opta_price_feed ${opta.toBase58()} exists=${!!oi}${oi ? "  (NOT a genesis — STOP)" : "  (absent: genesis pending)"}`);
    console.log(`  vaults: memcmp=${target.length} in-memory=${mem.length} agree=${agree} unclean=${unclean}${agree ? "" : "  <-- OFFSET WRONG, STOP"}`);
    console.log(`  pots on this market: ${potCount}; unsettled vaults with live pot collateral: ${potOpen}`);
    for (const r of rows) console.log("    " + r);
  }
})().catch((e) => { console.error("failed:", e.message); process.exit(2); });
