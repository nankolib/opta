#!/usr/bin/env bash
# ============================================================================
# fp-oracle-guard-mutation.sh — proves the set_oracle_source D1 guard is
# load-bearing. Three-state: exit 0 PASS · 1 FAIL · 2 INCONCLUSIVE.
#
# The guard (BEGIN D1-GUARD .. END D1-GUARD in set_oracle_source.rs) refuses a
# flip to ORACLE_SOURCE_OPTA unless the OptaPriceFeed is present, identity-
# matched, unfrozen, pushed, and fresh. This script DELETES that block, rebuilds
# the test program, runs the arms suite, and requires the guard tests to FAIL —
# i.e. a flip to source 2 with no serviceable feed must LAND on the mutant. If
# the mutant still refuses, the guard was not what refused it and the green
# tests proved nothing.
#
# The original source is restored from an in-memory copy, never from git — a
# `git checkout --` here once silently reverted an uncommitted fix (ledger §21).
#
# Run from WSL with the 0.32.1 toolchain on PATH (the 1.x binary shadows avm):
#   PATH="$HOME/.local/anchor032:$PATH" bash scripts/fp-oracle-guard-mutation.sh
# Logs are written under .context/fp/ — WSL /tmp does not survive between
# invocations, and a proof whose evidence evaporates is not a proof.
# ============================================================================
set -u
cd "$(dirname "$0")/.."
SRC="programs/opta/src/instructions/set_oracle_source.rs"
TEST="tests/bankrun/fp-oracle-arms.test.ts"
FEATURES="testing test-fast-vol american-enabled test-synth-vol"
LOGDIR=".context/fp"; mkdir -p "$LOGDIR"
MUT_TEST_LOG="$LOGDIR/mutation-mocha.log"

say() { printf '%s\n' "$*"; }
inconclusive() { say ""; say "RESULT: INCONCLUSIVE — $*"; say "(not a pass)"; restore; exit 2; }

ORIG="$(cat "$SRC")"
restore() {
  printf '%s\n' "$ORIG" > "$SRC"
  if ! grep -q "BEGIN D1-GUARD" "$SRC"; then say "RESTORE FAILED — fix $SRC by hand"; exit 3; fi
}
trap restore EXIT

command -v anchor >/dev/null || inconclusive "anchor not on PATH"
anchor --version 2>/dev/null | grep -q "0.32.1" || inconclusive "anchor is $(anchor --version) — need 0.32.1 (the 1.x binary shadows avm)"
[ -f "$TEST" ] || inconclusive "$TEST missing"
grep -q "BEGIN D1-GUARD" "$SRC" || inconclusive "guard markers not found in $SRC"

say "=========================================================================="
say "FP-ORACLE D1 GUARD MUTATION"
say "=========================================================================="

# ---- mutate: drop everything between the markers (inclusive) ---------------
python3 - "$SRC" <<'PY'
import sys, io, re
p = sys.argv[1]; s = io.open(p, encoding="utf-8").read()
m = re.search(r"    // ---- D1 GUARD.*?// END D1-GUARD\n", s, re.S)
if not m: sys.exit(9)
s2 = s[:m.start()] + "    // [MUTANT] D1 guard deleted by scripts/fp-oracle-guard-mutation.sh\n" + s[m.end():]
io.open(p, "w", encoding="utf-8", newline="\n").write(s2)
PY
[ $? -eq 0 ] || inconclusive "could not strip the guard block"
grep -q "BEGIN D1-GUARD" "$SRC" && inconclusive "mutation did not apply"
say "mutant written (guard block removed): $(grep -c MUTANT "$SRC") marker"

# ---- build the mutant -------------------------------------------------------
say "building mutant (anchor build --features \"$FEATURES\") ..."
if ! anchor build -- --features "$FEATURES" >"$LOGDIR/mutation-build.log" 2>&1; then
  tail -20 "$LOGDIR/mutation-build.log"
  inconclusive "mutant failed to BUILD — the behaviour under test never ran"
fi

# ---- run the arms suite; the guard tests must FAIL --------------------------
say "running $TEST against the mutant ..."
npx ts-mocha -p ./tsconfig.json -t 180000 "$TEST" >"$MUT_TEST_LOG" 2>&1
rc=$?
GUARD_IN_FILE=$(grep -cE '^\s*it\("D1 guard' "$TEST" || true)
FAIL_NAMES=$(grep -E '^\s+[0-9]+\) ' "$MUT_TEST_LOG" | grep -vE '^\s+[0-9]+\) FP-ORACLE wave' | sed -E 's/^\s+[0-9]+\) //' | sort -u)
GUARD_FAILS=$(printf '%s\n' "$FAIL_NAMES" | grep -c "D1 guard" || true)
OTHER_FAILS=$(printf '%s\n' "$FAIL_NAMES" | grep -v "D1 guard" | grep -c . || true)
say "  mocha exit=$rc   D1-guard tests in file: $GUARD_IN_FILE   failing on mutant: guard=$GUARD_FAILS other=$OTHER_FAILS"
grep -E "passing|failing" "$MUT_TEST_LOG" | sed 's/^/  /'
say "  failing on the mutant — the names ARE the proof:"
printf '%s\n' "$FAIL_NAMES" | sed 's/^/    /'

# ---- restore + rebuild the real program -------------------------------------
restore; trap - EXIT
say "restored $SRC (guard markers present: $(grep -c 'D1-GUARD' "$SRC"))"
say "rebuilding the real program ..."
anchor build -- --features "$FEATURES" >"$LOGDIR/mutation-rebuild.log" 2>&1 || { tail -5 "$LOGDIR/mutation-rebuild.log"; say "RESULT: INCONCLUSIVE — real program failed to rebuild after restore"; exit 2; }

say "=========================================================================="
if [ "$GUARD_IN_FILE" -eq 0 ]; then say "RESULT: INCONCLUSIVE — no it(\"D1 guard…\") tests in $TEST"; exit 2; fi
if [ "$rc" -ne 0 ] && [ "$GUARD_FAILS" -eq "$GUARD_IN_FILE" ] && [ "$OTHER_FAILS" -eq 0 ]; then
  say "RESULT: PASS — guard deleted → exactly the $GUARD_IN_FILE D1-guard tests fail and nothing else does: the guard is what refuses the flip."
  exit 0
fi
say "RESULT: FAIL — mutant outcome does not isolate the guard (guard fails=$GUARD_FAILS of $GUARD_IN_FILE, other fails=$OTHER_FAILS)."
exit 1
