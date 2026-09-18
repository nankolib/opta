#!/usr/bin/env bash
# ============================================================================
# fp-oracle-l1-preflight.sh — scripted toolchain gate for the canonical upgrade.
# Exit 0 = every pin holds. Exit 1 = a pin is wrong (STOP). Exit 2 = a tool is
# missing (INCONCLUSIVE — not a pass).
#
# Exists because ~/.cargo/bin/anchor on the WSL side is a standalone anchor-cli
# 1.1.2 that shadows avm's 0.32.1: `avm use 0.32.1` says "Now using" and the
# `anchor` on PATH stays 1.1.2. A build under the wrong CLI is not the artifact
# that was soaked. Run with PATH="$HOME/.local/anchor032:$PATH".
# ============================================================================
set -u
want_anchor="0.32.1"
want_solana="4.1.0"      # Agave 4.1.x — SBPFv3 verifier; 2.2.14 rejects locally
fail=0; inc=0
chk() { # name, actual, want-substring
  if [ -z "$2" ]; then printf '  MISSING  %-16s (not on PATH)\n' "$1"; inc=1
  elif printf '%s' "$2" | grep -q "$3"; then printf '  ok       %-16s %s\n' "$1" "$2"
  else printf '  WRONG    %-16s %s  (want %s)\n' "$1" "$2" "$3"; fail=1; fi
}
echo "FP-ORACLE L1 PREFLIGHT — toolchain pins"
chk anchor  "$(anchor --version 2>/dev/null)"          "$want_anchor"
chk solana  "$(solana --version 2>/dev/null)"          "$want_solana"
chk node    "$(node --version 2>/dev/null)"            "v"
chk which-anchor "$(command -v anchor 2>/dev/null)"    "anchor032"
# the shadowing binary must NOT be the one resolved
if [ "$(command -v anchor 2>/dev/null)" = "$HOME/.cargo/bin/anchor" ]; then
  echo "  WRONG    anchor resolves to ~/.cargo/bin/anchor (the 1.x shadow)"; fail=1
fi
# the tree must be the committed one
# Content, not bytes: this is a Windows checkout read from WSL, and line endings
# differ by design (autocrlf on one side only). A CR-only difference is not a
# change; a real one is.
if git diff --ignore-cr-at-eol --quiet -- programs crank app/src tests scripts 2>/dev/null; then
  echo "  ok       working tree clean (content)   HEAD $(git rev-parse --short HEAD)"
else
  echo "  WRONG    working tree has uncommitted CONTENT changes under programs/crank/app/tests/scripts:"
  git diff --ignore-cr-at-eol --stat -- programs crank app/src tests scripts | tail -6 | sed 's/^/           /'
  fail=1
fi
[ -f "$HOME/.opta-rpc-helius" ] && echo "  ok       ~/.opta-rpc-helius present (never echoed)" || { echo "  MISSING  ~/.opta-rpc-helius"; inc=1; }
[ -f "$HOME/.config/solana/id.json" ] && echo "  ok       upgrade-authority keypair present at ~/.config/solana/id.json" || { echo "  MISSING  ~/.config/solana/id.json"; inc=1; }
echo
if [ "$inc" -ne 0 ]; then echo "RESULT: INCONCLUSIVE — a tool or file is missing. NOT a pass."; exit 2; fi
if [ "$fail" -ne 0 ]; then echo "RESULT: FAIL — a pin is wrong. STOP."; exit 1; fi
echo "RESULT: PASS — pins hold."
exit 0
