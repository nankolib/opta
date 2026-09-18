#!/usr/bin/env bash
# =============================================================================
# fp-oracle-isolation-gate.sh -- enforce the FP-ORACLE module boundary
# =============================================================================
#
# Spec FP_ORACLE_MODULE_SPEC_V2 section 7: zero commits touch canonical program
# code paths until the plug ceremony. Run before every push to `fp-oracle`.
#
# The spec's first cut of this gate allowlisted only the new module files. That
# was wrong and would have failed on the first commit: a new instruction cannot
# compile without being registered in instructions/mod.rs, state/mod.rs, lib.rs
# and errors.rs. Those four ARE canonical files.
#
# So the gate has two tiers:
#
#   TIER 1 - MODULE FILES. New files, wholly owned by the module. Any diff.
#   TIER 2 - REGISTRATION FILES. Canonical, but may be touched ADDITIVELY ONLY:
#            zero deleted lines. A pure-addition diff to a mod/lib/errors file
#            cannot change existing behaviour, which is the property that makes
#            the module detachable. One deletion and the gate fails.
#
# Everything else under programs/opta/src is forbidden and fails the gate.
#
# The six oracle_source match arms are NOT exempted and never will be. Arming
# them deletes and rewrites lines in canonical read paths, so this gate MUST go
# red on the `arm-6-sites` commit. That is the signal that the module has left
# isolation and the plug ceremony has begun -- not a reason to weaken the gate.
# =============================================================================

set -euo pipefail

BASE="${1:-origin/master}"
SCOPE="programs/opta/src"

MODULE_FILES='^programs/opta/src/(state/opta_price_feed\.rs|utils/opta_price_read\.rs|instructions/(init_opta_price_feed|push_opta_price|set_feed_authority|set_oracle_source|close_opta_price_feed)\.rs)$'
REGISTRATION_FILES='^programs/opta/src/(lib\.rs|errors\.rs|state/mod\.rs|instructions/mod\.rs|utils/mod\.rs)$'

fail=0

echo "FP-ORACLE isolation gate — diff base: ${BASE}"
echo

# Merge-base -> WORKING TREE, not BASE...HEAD. The three-dot form audits only
# committed changes, so a dirty checkout with canonical edits read GREEN on
# 2026-09-18 while six instruction files were modified but not yet committed.
# A gate that cannot see the working tree cannot fail before the commit it is
# meant to stop.
MB=$(git merge-base "${BASE}" HEAD) || { echo "cannot resolve merge-base for ${BASE}"; exit 2; }
changed=$(git diff --name-only "${MB}" -- "${SCOPE}")
if [ -z "${changed}" ]; then
  echo "  no canonical-scope changes at all — gate GREEN"
  exit 0
fi

echo "TIER 1 — module files (any diff allowed):"
echo "${changed}" | grep -E "${MODULE_FILES}" | sed 's/^/    ok   /' || echo "    (none)"
echo

echo "TIER 2 — registration files (additive only, zero deletions):"
while read -r f; do
  [ -z "${f}" ] && continue
  # numstat: <added> <deleted> <path>
  del=$(git diff --numstat "${MB}" -- "${f}" | awk '{print $2}')
  add=$(git diff --numstat "${MB}" -- "${f}" | awk '{print $1}')
  if [ "${del:-0}" -eq 0 ]; then
    printf '    ok   %-40s +%s -0\n' "${f}" "${add:-0}"
  else
    printf '    FAIL %-40s +%s -%s  (deletions are not additive)\n' "${f}" "${add:-0}" "${del}"
    fail=1
  fi
done < <(echo "${changed}" | grep -E "${REGISTRATION_FILES}")
echo

echo "FORBIDDEN — anything else in ${SCOPE}:"
others=$(echo "${changed}" | grep -Ev "${MODULE_FILES}" | grep -Ev "${REGISTRATION_FILES}" || true)
if [ -n "${others}" ]; then
  echo "${others}" | sed 's/^/    FAIL /'
  fail=1
else
  echo "    (none)"
fi
echo

# ---- TIER 3: RETIRED at the plug ceremony ---------------------------------
# The cfg-gated declare_id! block and the fp-scratch feature were deleted when
# the six oracle_source arms were armed (wave 1). There is one program and one
# id again; nothing is left for tier 3 to prove. fp-oracle-identity-proof.sh was
# deleted with it. Tiers 1 and 2 remain meaningful until the branch merges.
echo "TIER 3 — retired (plug ceremony; single canonical declare_id)"
echo

if [ "${fail}" -ne 0 ]; then
  echo "CANONICAL PATH TOUCHED — STOP."
  echo "If this is the deliberate arm-6-sites commit, the plug ceremony has begun:"
  echo "say so explicitly and get the P0/P1 gate, do not edit this script."
  exit 1
fi

echo "gate GREEN — module is still detachable."
exit 0
