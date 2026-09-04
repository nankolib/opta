#!/usr/bin/env bash
# ============================================================================
# fp-oracle-crash-handler-gate.sh
#
# Proves the 2026-09-04T10:35:51Z crash class is handled, and proves the proof
# can fail. Three-state, per this project's gate convention:
#
#   exit 0  PASS          exit 1  FAIL          exit 2  INCONCLUSIVE
#
# INCONCLUSIVE is never green. A missing runner is not a pass.
#
# The handler under test is EXTRACTED VERBATIM from crank/fpOracleMain.ts at
# run time, never retyped here. If the shipped handler changes or disappears,
# this gate changes with it -- a paraphrased copy would keep passing after the
# real thing regressed.
#
#   CASE A  real handler + synthetic late rejection -> exit 1 AND a JSON fatal
#           line naming UNHANDLED REJECTION.
#   CASE B  MUTATION: handler deleted, same synthetic -> must reproduce the
#           ORIGINAL failure signature: exit 1, raw Node stack, NO fatal JSON.
#           If B still emits the fatal line, case A proved nothing.
#   CASE C  the leak plug itself: a rejecting getSignatureStatus must be
#           absorbed to null (web3.js graceful-degrade path) and must NOT
#           reach the unhandledRejection handler at all.
# ============================================================================
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/crank/fpOracleMain.ts"
# Work INSIDE crank/ so the lane's real tsconfig.json governs the run: same
# target, same lib, same transpileOnly setting the service uses. A temp dir
# outside the repo resolves no tsconfig, and ts-node then type-checks against
# defaults with no @types/node -- every case dies on a compile error instead of
# on the behaviour under test, and "exits 1" passes for the wrong reason.
WORK="$REPO/crank/.fpgate-tmp"
rm -rf "$WORK"; mkdir -p "$WORK"
export TS_NODE_PROJECT="$REPO/crank/tsconfig.json"
trap 'rm -rf "$WORK"' EXIT

say() { printf '%s\n' "$*"; }
inconclusive() { say ""; say "RESULT: INCONCLUSIVE — $*"; say "(not a pass)"; exit 2; }

[ -f "$SRC" ] || inconclusive "cannot find $SRC"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || inconclusive "node not on PATH"
TSNODE="$REPO/crank/node_modules/ts-node"
[ -d "$TSNODE" ] || TSNODE="$REPO/node_modules/ts-node"
[ -d "$TSNODE" ] || inconclusive "ts-node not installed (crank/node_modules or root)"
[ -f "$REPO/crank/tsconfig.json" ] || inconclusive "crank/tsconfig.json missing"

say "=========================================================================="
say "FP-ORACLE CRASH-HANDLER GATE"
say "  source : crank/fpOracleMain.ts"
say "  node   : $(node --version)"
say "=========================================================================="

# ---- extract the two handlers verbatim -------------------------------------
node -e '
const fs=require("fs");
const s=fs.readFileSync(process.argv[1],"utf8");
function grab(name){
  const key=`process.on("${name}"`;
  const i=s.indexOf(key);
  if(i<0) return null;
  let d=0,j=s.indexOf("(",i);
  const st=j;
  for(;j<s.length;j++){ const c=s[j]; if(c==="(")d++; else if(c===")"){d--; if(d===0){j++;break;}} }
  return s.slice(i,j)+";";
}
const a=grab("unhandledRejection"), b=grab("uncaughtException");
if(!a){ console.error("NOTFOUND"); process.exit(9); }
fs.writeFileSync(process.argv[2], a+"\n"+(b||"")+"\n");
' "$SRC" "$WORK/handlers.ts"
if [ $? -ne 0 ]; then
  say ""
  say "RESULT: FAIL — no process.on(\"unhandledRejection\") found in fpOracleMain.ts"
  exit 1
fi
HLINES=$(wc -l < "$WORK/handlers.ts" | tr -d ' ')
say "extracted handler block: $HLINES lines"
grep -q "UNHANDLED REJECTION" "$WORK/handlers.ts" || inconclusive "extracted block lacks expected fatal text; extractor may be misaligned"
grep -q "process.exit(1)" "$WORK/handlers.ts" || { say ""; say "RESULT: FAIL — handler does not exit(1); systemd would not restart"; exit 1; }
grep -qE "process\.exit\(0\)|return;\s*}\s*\);" "$WORK/handlers.ts" && say "note: verify no swallow-path in handler" || true

# ---- shared preamble: the log() shim the handler closes over ---------------
cat > "$WORK/preamble.ts" <<'PRE'
const log = (level: string, msg: string, extra?: any) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra || {}) }));
PRE

# ---- the synthetic leak: web3.js's floating IIFE, same shape ---------------
# Mirrors lib/index.cjs.js:6587 -- an un-awaited async IIFE whose HTTP call
# rejects AFTER the confirmation race has already been won and `done` set.
cat > "$WORK/leak.ts" <<'LEAK'
let done = false;
const rejectingStatusCall = async (): Promise<any> => {
  await new Promise((r) => setTimeout(r, 30));
  const e: any = new TypeError("fetch failed");
  e.cause = Object.assign(new Error("read ECONNRESET"), {
    errno: -104, code: "ECONNRESET", syscall: "read",
  });
  throw e;
};
// the race is won by the websocket; sendAndConfirm returns; done = true
setTimeout(() => { done = true; log("info", "fp-oracle: push sent (synthetic)"); }, 5);
// ...but this was already in flight, and nothing holds it:
(async () => {
  const response = await rejectingStatusCall();
  if (done) return;              // never reached: a rejection skips the guard
  if (response == null) return;
})();
setTimeout(() => { log("error", "SURVIVED — process did not die"); process.exit(7); }, 3000);
LEAK

run_case() {  # $1=file  -> sets RC, OUT
  OUT="$(cd "$REPO/crank" && "$NODE_BIN" --require "$TSNODE/register" "$1" 2>&1)"; RC=$?
  # A TS compile failure also exits 1 and would let "exits 1" pass for the
  # wrong reason. Treat it as inconclusive, never as a result.
  case "$OUT" in *"Unable to compile TypeScript"*|*"TSError"*)
    say "$OUT" | sed 's/^/    /' | head -6
    inconclusive "harness failed to compile — behaviour under test never ran" ;;
  esac
}

# ================= CASE A : real handler present ============================
say ""
say "-- CASE A: real handler + synthetic late rejection ----------------------"
cat "$WORK/preamble.ts" "$WORK/leak.ts" "$WORK/handlers.ts" > "$WORK/caseA.ts"
run_case "$WORK/caseA.ts"
A_RC=$RC
echo "$OUT" | sed 's/^/    /' | head -12
A_FATAL=0; echo "$OUT" | grep -q '"level":"fatal"' && A_FATAL=1
A_NAMED=0; echo "$OUT" | grep -q 'UNHANDLED REJECTION' && A_NAMED=1
A_CODE=0;  echo "$OUT" | grep -q 'ECONNRESET' && A_CODE=1
say "    exit=$A_RC fatal_json=$A_FATAL named=$A_NAMED econnreset_captured=$A_CODE"

# ================= CASE B : MUTATION, handler deleted =======================
say ""
say "-- CASE B: MUTATION — handler removed (must reproduce the mute death) ---"
cat "$WORK/preamble.ts" "$WORK/leak.ts" > "$WORK/caseB.ts"
run_case "$WORK/caseB.ts"
B_RC=$RC
echo "$OUT" | sed 's/^/    /' | head -8
B_FATAL=0; echo "$OUT" | grep -q '"level":"fatal"' && B_FATAL=1
B_STACK=0; echo "$OUT" | grep -qE 'TypeError: fetch failed' && B_STACK=1
say "    exit=$B_RC fatal_json=$B_FATAL raw_stack=$B_STACK"

# ================= CASE C : the leak plug ===================================
say ""
say "-- CASE C: leak plug — rejecting getSignatureStatus absorbed to null ----"
cat "$WORK/preamble.ts" > "$WORK/caseC.ts"
cat >> "$WORK/caseC.ts" <<'CC'
const connection: any = {
  getSignatureStatus: async () => {
    const e: any = new TypeError("fetch failed");
    e.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    throw e;
  },
};
CC
# splice in the real wrapper from fpOracleMain.ts, verbatim
node -e '
const fs=require("fs");
const s=fs.readFileSync(process.argv[1],"utf8");
const i=s.indexOf("const inner = connection.getSignatureStatus.bind(connection);");
if(i<0){ console.error("NOTFOUND"); process.exit(9); }
let j=s.indexOf("const wallet = new anchor.Wallet", i);
if(j<0) j=s.length;
fs.appendFileSync(process.argv[2], s.slice(i,j).replace(/\}\s*$/,""));
' "$SRC" "$WORK/caseC.ts" || inconclusive "could not extract the getSignatureStatus wrapper"
cat >> "$WORK/caseC.ts" <<'CC'
(async () => {
  const r = await connection.getSignatureStatus("sig");
  if (r !== null) { log("error", "PLUG FAILED — did not absorb to null", { got: String(r) }); process.exit(8); }
  log("info", "PLUG OK — absorbed to null, confirmation left to subscription");
  process.exit(0);
})();
CC
cat "$WORK/handlers.ts" >> "$WORK/caseC.ts"
run_case "$WORK/caseC.ts"
C_RC=$RC
echo "$OUT" | sed 's/^/    /' | head -8
C_OK=0; echo "$OUT" | grep -q 'PLUG OK' && C_OK=1
C_FATAL=0; echo "$OUT" | grep -q '"level":"fatal"' && C_FATAL=1
say "    exit=$C_RC plug_ok=$C_OK reached_fatal_handler=$C_FATAL"

# ================= verdict ==================================================
say ""
say "=========================================================================="
FAIL=0
chk() { if [ "$2" = "$3" ]; then say "  PASS  $1"; else say "  FAIL  $1 (want $3, got $2)"; FAIL=1; fi; }
chk "A exits 1 (systemd restarts)"                "$A_RC"    1
chk "A emits JSON fatal line"                     "$A_FATAL" 1
chk "A names UNHANDLED REJECTION"                 "$A_NAMED" 1
chk "A captures ECONNRESET cause"                 "$A_CODE"  1
chk "B (mutant) still dies"                       "$B_RC"    1
chk "B (mutant) emits NO fatal JSON"              "$B_FATAL" 0
chk "B (mutant) shows raw Node stack"             "$B_STACK" 1
chk "C plug absorbs to null"                      "$C_OK"    1
chk "C never reaches the fatal handler"           "$C_FATAL" 0
say "=========================================================================="
if [ "$FAIL" -eq 0 ]; then
  say "RESULT: PASS — handler is load-bearing (B proves A can fail); leak plugged at source."
  exit 0
fi
say "RESULT: FAIL"
exit 1
