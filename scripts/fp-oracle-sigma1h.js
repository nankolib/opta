// D2 seed derivation, READ-ONLY. node l3-sigma1h.js <jsonl>
// Full series -> status=="sent" pushes -> first sample of each UTC hour ->
// log returns across CONSECUTIVE hours only (a gap is not a return) -> sample
// stdev -> annualise by sqrt(8766) -> clamp [0.05, 2.00] -> round(sigma*1e12).
const fs = require("fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n");
const by = {};
for (const l of lines) {
  if (!l) continue;
  let r; try { r = JSON.parse(l); } catch (e) { continue; }
  if (r.status !== "sent" || !(r.pushed_price > 0)) continue;
  const h = Math.floor(Date.parse(r.ts) / 3600000);
  if (!by[r.symbol]) by[r.symbol] = new Map();
  if (!by[r.symbol].has(h)) by[r.symbol].set(h, r.pushed_price);
}
for (const sym of Object.keys(by).sort()) {
  const m = by[sym];
  const hours = Array.from(m.keys()).sort((a, b) => a - b);
  const p = hours.map((h) => m.get(h));
  const rets = []; let gaps = 0;
  for (let i = 1; i < p.length; i++) { if (hours[i] - hours[i - 1] !== 1) { gaps++; continue; } rets.push(Math.log(p[i] / p[i - 1])); }
  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  const sigma = Math.sqrt(variance) * Math.sqrt(8766);
  const clamped = Math.min(2.0, Math.max(0.05, sigma));
  console.log(`${sym.padEnd(8)} hourly_points=${p.length} returns=${n} gaps=${gaps} first=${new Date(hours[0] * 3600000).toISOString().slice(0, 13)}Z last=${new Date(hours[hours.length - 1] * 3600000).toISOString().slice(0, 13)}Z sigma_1h_ann=${sigma.toFixed(4)} clamped=${clamped.toFixed(4)} seed_x1e12=${Math.round(clamped * 1e12)} floor_330=${p.length >= 330 ? "MET" : "NOT MET"}`);
}
