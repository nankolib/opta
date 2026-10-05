import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const repoRoot = resolve(mobileRoot, "..");
const failures = [];

const read = (...parts) => readFileSync(resolve(...parts), "utf8");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const requireText = (condition, message) => {
  if (!condition) failures.push(message);
};

function namedBlock(source, name) {
  const start = source.indexOf(`${name} {`);
  if (start < 0) return null;
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, index);
    }
  }
  return null;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [path];
  });
}

const idlPaths = [
  resolve(repoRoot, "target", "idl", "opta.json"),
  resolve(repoRoot, "app", "src", "idl", "opta.json"),
  resolve(mobileRoot, "src", "idl", "opta.json"),
];
const idlHashes = idlPaths.map(sha256);
// The web and mobile copies are tracked and must always be byte-identical.
requireText(idlHashes[1] === idlHashes[2], "Web and mobile IDLs must be byte-identical.");
// The generated copy (target/idl) is an untracked local build output, and a
// test-feature build leaves a test-only instruction in it. When it differs, the
// only acceptable substitute is the IDL published on chain for the deployed
// program: pass OPTA_IDL_REFERENCE=<json fetched from the chain> and the tracked
// copy must be structurally identical to it. Without that, a mismatch fails.
if (idlHashes[0] !== idlHashes[1]) {
  const reference = process.env.OPTA_IDL_REFERENCE;
  if (!reference) {
    requireText(false, "Generated, web, and mobile IDLs must be byte-identical (or set OPTA_IDL_REFERENCE to the on-chain IDL).");
  } else {
    const canon = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
    const tracked = canon(JSON.parse(readFileSync(idlPaths[1], "utf8")));
    const onChain = canon(JSON.parse(readFileSync(reference, "utf8")));
    requireText(tracked === onChain, "The tracked IDL must be structurally identical to the on-chain IDL reference.");
    console.log("PASS IDL parity against the on-chain reference (target/idl differs: local build output)");
  }
}

const source = sourceFiles(resolve(mobileRoot, "src"))
  .filter((path) => [".ts", ".tsx"].includes(extname(path)))
  .map((path) => ({ path, text: read(path) }));

for (const file of source) {
  const name = relative(mobileRoot, file.path).replaceAll("\\", "/");
  if (name !== "src/theme.ts" && /#[0-9a-f]{3,8}\b|rgba?\s*\(/i.test(file.text)) {
    failures.push(`${name} contains a hardcoded color outside the theme.`);
  }
  if (/Alert\.alert|ActivityIndicator|NativeModules|buildWriteDepositTx|buildWriteMintTx/.test(file.text)) {
    failures.push(`${name} contains a blocked legacy or blocking UI path.`);
  }
  if (/(?:Ã|Â|â€¦|â€”|â€“|ï¿½|ðŸ)/.test(file.text)) {
    failures.push(`${name} contains mojibake.`);
  }
  if (/\.slice\(\s*0\s*,\s*8\s*\)/.test(file.text)) {
    failures.push(`${name} truncates the Trade offer list.`);
  }
}

const renderedDirectories = ["screens", "state", "ui"];
const rendered = source.filter(({ path }) => {
  const name = relative(resolve(mobileRoot, "src"), path).replaceAll("\\", "/");
  return name === "App.tsx" || renderedDirectories.some((directory) => name.startsWith(`${directory}/`));
});
for (const file of rendered) {
  const name = relative(mobileRoot, file.path).replaceAll("\\", "/");
  if (/(?:Pyth|Switchboard|Hermes|EWMA)/i.test(file.text)) {
    failures.push(`${name} exposes internal price-source provenance in rendered source.`);
  }
}

const app = read(mobileRoot, "src", "App.tsx");
requireText(app.includes("buildAtomicWriteTx"), "App must use the atomic write builder.");
requireText(app.includes("SafeAreaProvider"), "App must install the safe-area provider.");
requireText(app.includes("useOptaFonts"), "App must load the five required font faces.");
requireText(app.includes("Clipboard.setStringAsync"), "Signature copy must use a functional clipboard callback.");
requireText(app.includes("NavigationBar.setStyle(mode)"), "Manual theme changes must update Android navigation controls.");
requireText(app.includes("SystemUI.setBackgroundColorAsync"), "Manual theme changes must update Android system UI.");
requireText(app.includes("const americanWriteSupported = false"), "Unwired American writes must remain hidden.");
requireText(app.includes("wallet.signTransaction(transaction)"), "Wallet signing must be separated from RPC broadcast.");
requireText(!app.includes("signAndSendTransaction"), "Ambiguous wallet sign-and-send must not ship.");
requireText(app.includes("!transaction.hydrated"), "Transactional controls must stay gated until receipt restoration finishes.");
requireText(!app.includes('market.phase === "empty" ? "loaded"'), "A true no-market state must not expose Write one.");

const flow = read(mobileRoot, "src", "state", "useTransactionFlow.ts");
const durableReceiptIndex = flow.indexOf('JSON.stringify(receiptFor("sending"');
const broadcastIndex = flow.indexOf("connection.sendRawTransaction");
requireText(flow.includes("if (!hydrated) return"), "Review must be blocked until stored receipts hydrate.");
requireText(flow.includes("Saved transaction status could not be verified. New transactions remain disabled."), "Receipt hydration must fail closed.");
requireText(flow.includes("retryHydration"), "Receipt hydration failure must expose a functional retry.");
requireText(flow.includes("hasUnresolved"), "Unresolved signatures must block and relabel new transaction controls.");
requireText(durableReceiptIndex >= 0 && broadcastIndex > durableReceiptIndex, "The signature receipt must be persisted before broadcast.");
requireText(flow.includes("rpcSignature !== signature"), "RPC and precomputed transaction signatures must be compared.");

const transactionStatus = read(mobileRoot, "src", "solana", "transactionStatus.ts");
requireText(transactionStatus.includes("blockHeight > submitted.lastValidBlockHeight"), "Missing signatures must resolve only after blockhash expiry.");

const transactionSource = read(mobileRoot, "src", "solana", "transactions.ts");
requireText(transactionSource.includes("buildAtomicWriteTx"), "Atomic write transaction builder is missing.");
requireText(!transactionSource.includes("buildWriteDepositTx"), "Legacy deposit-only write builder must not ship.");
requireText(!transactionSource.includes("buildWriteMintTx"), "Legacy mint-only write builder must not ship.");
requireText(transactionSource.includes("ensureDevnetConnection(connection)"), "Every transaction connection must pass the devnet genesis gate.");

const marketData = read(mobileRoot, "src", "solana", "marketData.ts");
requireText(marketData.includes("getMetadataPointerState"), "Token-2022 metadata pointers must be validated.");
requireText(marketData.includes("deriveVaultResaleListing"), "Resale listing PDAs must be validated.");
requireText(marketData.includes("MAX_CONFIDENCE_BPS"), "Live prices must enforce the protocol confidence bound.");
requireText(marketData.includes("PRICE_FETCH_TIMEOUT_MS"), "Price requests must have a bounded timeout.");
const optaFeedSource = read(mobileRoot, "src", "solana", "optaFeed.ts");
requireText(
  marketData.includes("if (!isSupportedOracleSource(market.account.oracleSource)) return [];") &&
    optaFeedSource.includes("return source === 0 || source === 1 || source === 2;") &&
    marketData.includes('route === "http"') && marketData.includes('route === "optaFeed"'),
  "Only sources with a quote route (0 pull-oracle, 1 on-chain sample, 2 first-party feed) may reach transactional screens, through the one predicate; any other source stays hidden, and only route http may use the HTTP price path."
);

const marketState = read(mobileRoot, "src", "state", "useMarketState.ts");
requireText(marketState.includes("AUTO_REFRESH_MS"), "Live prices must refresh before the write gate becomes permanently stale.");
requireText(marketState.includes("portfolioPhase"), "Portfolio failures must not poison Trade and Write market state.");

// ---- Permission surface: source declaration + merged/APK reality ----------
// The shippable runtime set is exactly these three: INTERNET, ACCESS_NETWORK_STATE
// (both transitive/kept) and the app-scoped RN dynamic-receiver permission.
const ALLOWED_RUNTIME_PERMISSIONS = new Set([
  "android.permission.INTERNET",
  "android.permission.ACCESS_NETWORK_STATE",
  "com.opta.seeker.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
]);
const STRIPPED_PERMISSIONS = [
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
];

function parsePermissions(xml) {
  const granted = [];
  const removed = [];
  for (const match of xml.matchAll(/<uses-permission\s+([^>]*?)\/?>/g)) {
    const attrs = match[1];
    const name = /android:name="([^"]+)"/.exec(attrs)?.[1];
    if (!name) continue;
    if (/tools:node="remove"/.test(attrs)) removed.push(name);
    else granted.push(name);
  }
  return { granted, removed };
}

const manifest = read(mobileRoot, "android", "app", "src", "main", "AndroidManifest.xml");
const src = parsePermissions(manifest);
requireText(/xmlns:tools="/.test(manifest), "Source manifest must declare xmlns:tools for permission removal.");
requireText(
  src.granted.length === 1 && src.granted[0] === "android.permission.INTERNET",
  `Source manifest may grant only INTERNET (found: ${src.granted.join(", ") || "none"}).`
);
for (const perm of STRIPPED_PERMISSIONS) {
  requireText(src.removed.includes(perm), `Source manifest must strip ${perm} via tools:node="remove".`);
}
requireText(/android:allowBackup="false"/.test(manifest), "Android backups must remain disabled.");
requireText(/android:screenOrientation="portrait"/.test(manifest), "Native Android orientation must match app.json.");
requireText(/<data android:scheme="opta-seeker"\/>/.test(manifest), "Native Android scheme must match app.json.");

// Merged manifests (post-build intermediates) must reflect the strip exactly.
const mergedRoot = resolve(mobileRoot, "android", "app", "build", "intermediates");
let checkedMerged = 0;
if (existsSync(mergedRoot)) {
  const mergedManifests = sourceFiles(mergedRoot).filter(
    (path) => /merged_manifest/.test(path) && path.endsWith("AndroidManifest.xml")
  );
  for (const path of mergedManifests) {
    const { granted } = parsePermissions(read(path));
    const rel = relative(mobileRoot, path);
    for (const perm of STRIPPED_PERMISSIONS) {
      requireText(!granted.includes(perm), `Merged manifest still grants ${perm}: ${rel}`);
    }
    for (const perm of granted) {
      requireText(ALLOWED_RUNTIME_PERMISSIONS.has(perm), `Merged manifest grants unexpected permission ${perm}: ${rel}`);
    }
    checkedMerged += 1;
  }
}
if (checkedMerged > 0) console.log(`PASS merged-manifest permission set (${checkedMerged} checked)`);

// ---- Release signing: self-custody, never debug, no bundled secrets ---------
const gradle = read(mobileRoot, "android", "app", "build.gradle");
const buildTypesBlock = namedBlock(gradle, "buildTypes");
const releaseBuildType = buildTypesBlock ? namedBlock(buildTypesBlock, "release") : null;
requireText(releaseBuildType != null, "Release build block is missing.");
requireText(
  releaseBuildType != null && /signingConfig\s+signingConfigs\.release/.test(releaseBuildType),
  "Release build must use signingConfigs.release."
);
requireText(
  releaseBuildType != null && !/signingConfig\s+signingConfigs\.debug/.test(releaseBuildType),
  "Release must never fall back to debug signing."
);
const signingConfigsBlock = namedBlock(gradle, "signingConfigs");
const signingRelease = signingConfigsBlock ? namedBlock(signingConfigsBlock, "release") : null;
requireText(signingRelease != null, "signingConfigs.release block is missing.");
requireText(
  gradle.includes("rootProject.file(\"keystore.properties\")"),
  "Release signing must load credentials from the gitignored keystore.properties."
);
// No plaintext store/key passwords committed in gradle.
requireText(
  !/(store|key)Password\s+["'][^"']+["']/.test(gradle),
  "Release keystore passwords must never be hardcoded in build.gradle."
);
// Keystore artifacts must be gitignored.
const rootGitignore = read(repoRoot, ".gitignore");
requireText(/(^|\n)\*\.keystore(\s|$)/.test(rootGitignore) || /\*\.keystore/.test(rootGitignore), "Keystores (*.keystore) must be gitignored.");
requireText(/keystore\.properties/.test(rootGitignore), "keystore.properties must be gitignored.");
requireText(/review\s*\{[\s\S]*?debuggable\s+false[\s\S]*?signingConfig\s+signingConfigs\.debug/.test(gradle), "Review APK must bundle JS and use only the local review certificate.");
requireText(/review\s*\{[\s\S]*?initWith\s+release[\s\S]*?matchingFallbacks\s*=\s*\['release'\]/.test(gradle), "Review APK must use release native dependencies, never dev-client debug fallbacks.");

const appConfig = JSON.parse(read(mobileRoot, "app.json"));
requireText(!appConfig.expo?.extra?.eas?.projectId, "Placeholder EAS ownership must not ship.");
requireText(appConfig.expo?.userInterfaceStyle === "automatic", "Android must follow the selected dark/light theme.");
requireText(appConfig.expo?.android?.allowBackup === false, "app.json must preserve disabled Android backups.");
requireText(gradle.includes(`applicationId '${appConfig.expo?.android?.package}'`), "Native Android package must match app.json.");
requireText(gradle.includes(`versionCode ${appConfig.expo?.android?.versionCode}`), "Native Android version code must match app.json.");

const packageJson = JSON.parse(read(mobileRoot, "package.json"));
requireText(!packageJson.scripts?.prebuild, "Unreviewed Expo prebuild must not rewrite the checked-in Android project.");
requireText(!packageJson.dependencies?.["expo-dev-client"], "The standalone APK must not ship Expo's development launcher.");
requireText(Boolean(packageJson.devDependencies?.["babel-preset-expo"]), "Metro's Expo Babel preset must be pinned as a development dependency.");
requireText(
  packageJson.expo?.doctor?.appConfigFieldsNotSyncedCheck?.enabled === false,
  "Checked-in native configuration must explicitly own app.json synchronization."
);
for (const dependency of [
  "expo-font",
  "expo-clipboard",
  "expo-system-ui",
  "expo-navigation-bar",
  "react-native-safe-area-context",
  "@expo-google-fonts/inter",
  "@expo-google-fonts/ibm-plex-mono",
  "@expo-google-fonts/fraunces",
]) {
  requireText(Boolean(packageJson.dependencies?.[dependency]), `Required dependency ${dependency} is missing.`);
}

if (failures.length) {
  console.error("Seeker handoff gate failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("PASS Seeker handoff gate");
console.log(`PASS IDL parity ${idlHashes[0]}`);
console.log("PASS atomic write only, density A, theme/font, manifest, and release-signing guards");
