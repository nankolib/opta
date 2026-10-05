// =============================================================================
// build-release.mjs — the ONE way to produce a store artifact.
// =============================================================================
//
// `npm run build:apk` runs assembleReview: a DEBUG-signed APK for sideload
// review, never a store artifact. This script runs assembleRelease and refuses
// to call the result good unless every gate below holds:
//
//   1. the required EXPO_PUBLIC_* build vars are present (process env or
//      mobile/.env) and the RPC is not the public devnet endpoint;
//   2. static handoff gate, type-check, and the unit suites pass;
//   3. the bundle task outputs are deleted first. Gradle does not track
//      EXPO_PUBLIC_* as task inputs, so without this a stale bundle ships under
//      BUILD SUCCESSFUL;
//   4. assembleRelease (never assembleReview);
//   5. the APK's own bundle carries the proxy RPC and the indexer base exactly
//      once each and no provider host or key;
//   6. the APK is signed by the upload key (never the Android debug cert), and
//      its versionCode / versionName match app.json;
//   7. the artifact's sha256 and the signing cert sha256 are printed last.
//
// Usage:  node scripts/build-release.mjs            (from mobile/)
//         OPTA_SKIP_ASSEMBLE=1 node scripts/build-release.mjs   (re-run gates 5-7)
// =============================================================================
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const androidDir = resolve(mobileRoot, "android");
const isWindows = process.platform === "win32";
const fail = (msg) => { console.error(`RELEASE GATE FAILED: ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`gate ok: ${msg}`);

// ---- 1. required build vars ------------------------------------------------
const REQUIRED = ["EXPO_PUBLIC_RPC_URL", "EXPO_PUBLIC_INDEXER_BASE", "EXPO_PUBLIC_INDEXER_ENABLED", "EXPO_PUBLIC_HERMES_BASE"];
const fileEnv = {};
const envPath = resolve(mobileRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) fileEnv[m[1]] = m[2];
  }
}
const buildEnv = {};
for (const k of REQUIRED) {
  const v = process.env[k] ?? fileEnv[k];
  if (!v) fail(`${k} is unset (process env and mobile/.env). An unset RPC var silently bakes the public devnet endpoint.`);
  buildEnv[k] = v;
}
if (/api\.devnet\.solana\.com/.test(buildEnv.EXPO_PUBLIC_RPC_URL)) fail("EXPO_PUBLIC_RPC_URL is the public devnet endpoint; a release build goes through the proxy.");
if (/api-key|helius/i.test(Object.values(buildEnv).join(" "))) fail("a build var carries a provider host or key; it would be baked into the bundle.");
ok(`build vars present: ${REQUIRED.join(", ")}`);
const expect = {
  rpc: buildEnv.EXPO_PUBLIC_RPC_URL.replace(/^https?:\/\//, ""),
  indexer: buildEnv.EXPO_PUBLIC_INDEXER_BASE.replace(/^https?:\/\//, ""),
};

function run(command, args, options = {}) {
  const r = spawnSync(command, args, { stdio: "inherit", ...options });
  if (r.error) fail(`${command}: ${r.error.message}`);
  if (r.status !== 0) fail(`${command} ${args.join(" ")} exited ${r.status}`);
}
function capture(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const sdkCandidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, isWindows && process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, "Android", "Sdk") : null].filter(Boolean);
const androidSdk = sdkCandidates.find((c) => existsSync(c));
if (!androidSdk) fail("Android SDK not found. Set ANDROID_HOME.");
const buildToolsRoot = resolve(androidSdk, "build-tools");
const buildTools = readdirSync(buildToolsRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const tool = (name) => resolve(buildToolsRoot, buildTools, isWindows ? `${name}${name === "apksigner" ? ".bat" : ".exe"}` : name);

const apk = resolve(androidDir, "app", "build", "outputs", "apk", "release", "app-release.apk");

if (process.env.OPTA_SKIP_ASSEMBLE !== "1") {
  // ---- 2. static gate, type-check, suites -----------------------------------
  const tsc = resolve(mobileRoot, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [resolve(scriptDir, "verify-seeker-build.mjs")], { cwd: mobileRoot });
  run(process.execPath, [tsc, "--noEmit"], { cwd: mobileRoot });
  // The test build tolerates one long-standing type error in transactions.ts
  // (noEmitOnError false); the suites themselves must pass.
  spawnSync(process.execPath, [tsc, "-p", "tsconfig.test.json"], { cwd: mobileRoot, stdio: "ignore" });
  for (const t of readdirSync(resolve(mobileRoot, "test")).filter((f) => f.endsWith(".test.js")).sort()) {
    run(process.execPath, ["--test", "--test-force-exit", join("test", t)], { cwd: mobileRoot, stdio: ["ignore", "ignore", "inherit"] });
    ok(`suite ${t}`);
  }

  // ---- 3. delete the bundle task outputs ------------------------------------
  let removed = 0;
  const walk = (dir, depth) => {
    if (depth > 5 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      if (/^createBundleReleaseJsAndAssets$/.test(name)) { rmSync(p, { recursive: true, force: true }); removed += 1; }
      else walk(p, depth + 1);
    }
  };
  walk(resolve(androidDir, "app", "build", "generated"), 0);
  walk(resolve(androidDir, "app", "build", "intermediates"), 0);
  if (existsSync(apk)) rmSync(apk);
  ok(`bundle task outputs deleted (${removed} directories); previous release APK removed`);

  // ---- 4. assembleRelease ---------------------------------------------------
  // Absolute, quoted: cmd.exe does not always search the working directory, and the
  // checkout path may contain spaces.
  run(isWindows ? `"${resolve(androidDir, "gradlew.bat")}"` : "./gradlew", ["assembleRelease"], {
    cwd: androidDir,
    shell: isWindows,
    env: { ...process.env, ...buildEnv, ANDROID_HOME: androidSdk, ANDROID_SDK_ROOT: androidSdk, NODE_ENV: "production" },
  });
}
if (!existsSync(apk)) fail(`no artifact at ${apk}`);

// ---- 5. the artifact's own bundle --------------------------------------------
const bundle = capture("unzip", ["-p", apk, "assets/index.android.bundle"]) ?? capture("tar", ["-xOf", apk, "assets/index.android.bundle"]);
if (!bundle || bundle.length < 100000) fail("could not read assets/index.android.bundle out of the APK");
const count = (needle) => { let n = 0, i = 0; const b = Buffer.from(needle, "latin1"); while ((i = bundle.indexOf(b, i)) !== -1) { n += 1; i += b.length; } return n; };
const checks = [[expect.rpc, 1], [expect.indexer, 1], ["helius", 0], ["api-key", 0]];
for (const [needle, want] of checks) {
  const got = count(needle);
  if (got !== want) fail(`bundle carries "${needle}" ${got}x, expected ${want}`);
}
ok(`bundle: "${expect.rpc}" x1, "${expect.indexer}" x1, no provider host, no key (${bundle.length} bytes, magic ${bundle.subarray(0, 4).toString("hex")})`);

// ---- 6. signature and version -------------------------------------------------
// apksigner is a .bat on Windows: it needs a shell, and with a shell every path
// that may contain a space has to be quoted by hand.
const certs = isWindows
  ? capture(`"${tool("apksigner")}" verify --print-certs "${apk}"`, [], { shell: true })
  : capture(tool("apksigner"), ["verify", "--print-certs", apk]);
if (!certs) fail("apksigner verify failed: the APK is unsigned or the signature is invalid");
const certText = certs.toString("utf8");
if (/Android Debug/i.test(certText)) fail("the APK is signed with the Android DEBUG certificate");
const certSha = (/certificate SHA-256 digest:\s*([0-9a-f]{64})/i.exec(certText) || [])[1];
const certDn = (/certificate DN:\s*(.+)/i.exec(certText) || [])[1];
if (!certSha) fail("could not read the signing certificate digest");
const wantPrefix = (process.env.OPTA_RELEASE_CERT_SHA256_PREFIX || "087ff9cbbb039a5f").toLowerCase();
if (!certSha.toLowerCase().startsWith(wantPrefix)) fail(`signing cert ${certSha} is not the upload key (expected prefix ${wantPrefix})`);
ok(`signed by the upload key: ${certDn?.trim()}`);

const app = JSON.parse(readFileSync(resolve(mobileRoot, "app.json"), "utf8")).expo;
const badging = capture(tool("aapt2"), ["dump", "badging", apk]);
if (!badging) fail("aapt2 dump badging failed");
const pkg = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(badging.toString("utf8"));
if (!pkg) fail("could not read the package line");
if (pkg[1] !== app.android.package || Number(pkg[2]) !== app.android.versionCode || pkg[3] !== app.version) {
  fail(`artifact is ${pkg[1]} ${pkg[3]} (${pkg[2]}), app.json says ${app.android.package} ${app.version} (${app.android.versionCode})`);
}
ok(`${pkg[1]} ${pkg[3]} versionCode ${pkg[2]}`);

// ---- 7. identity, printed last ------------------------------------------------
const apkSha = createHash("sha256").update(readFileSync(apk)).digest("hex");
console.log("");
console.log(`ARTIFACT      ${apk}`);
console.log(`SIZE          ${statSync(apk).size} bytes`);
console.log(`APK SHA-256   ${apkSha}`);
console.log(`CERT SHA-256  ${certSha}`);
console.log(`VERSION       ${pkg[3]} (versionCode ${pkg[2]})`);
