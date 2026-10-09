#!/usr/bin/env bash
set -u
START="${1:-1}"; END="${2:-9999}"
repo="$(cd "$(dirname "$0")/.." && pwd)"; cd "$repo"

# ─── Alert repeat-suppression OFF, exactly as run-smokes.sh does ──────
# This was MISSING here, and its absence produced the precise false failure
# run-smokes.sh warns about in its own comment: emit() suppresses an identical
# (module, event, payload) for 6h, so a smoke that drives a monitor and asserts
# on the event it emits reads the suppression as "the error branch never fired".
# `sidecar-envelope-error-path-smoke` fails here and passes there for no reason
# but this line — a runner difference masquerading as a code defect, which is
# worse than a plain failure because it sends you looking at the wrong file.
#
# Anything that changes the ENVIRONMENT a smoke runs in has to be set in BOTH
# runners or neither; `smoke-runner-env-parity-smoke` now enforces that.
export MORPHIT_EMIT_DEDUP=0
# Resolve tsx portably (workspace first, then PATH) — mirrors scripts/run-smokes.sh.
# (Previously this hardcoded an absolute build-machine path, which broke on every
# other machine and leaked the build environment's directory layout.)
if [ -x "$repo/node_modules/.bin/tsx" ]; then
  TSX="$repo/node_modules/.bin/tsx"
elif command -v tsx >/dev/null 2>&1; then
  TSX="$(command -v tsx)"
else
  echo "ERROR: tsx not found. Run 'npm install' from the repo root." >&2
  exit 2
fi
mapfile -t SMOKES < <(grep -E '^[[:space:]]*"[^"]+"' scripts/run-smokes.sh | sed -E 's/^[[:space:]]*"([^"]+)".*/\1/')
total=0; failed=0
# Mirror run-smokes.sh: per-smoke wall-clock, overridable for slow hosts.
SMOKE_TIMEOUT="${MORPHIT_SMOKE_TIMEOUT:-240}"
# Slow-solo smokes each run a whole toolchain — every workspace's vitest, the
# typecheck sweep, a cold vite build — and vitest-must-pass alone took 236 s on
# a 2-CPU host (2026-09-29, ~3,300 unit tests): right at the 240 s default. They
# get at least MORPHIT_SLOW_SMOKE_TIMEOUT (1200 s; vitest-must-pass took 528 s on an
# idle 2-CPU host on 2026-10-06, ~4,800 unit tests); every other smoke keeps
# SMOKE_TIMEOUT. smoke-runner-env-parity-smoke runs this function from both
# runners, so run-smokes.sh and run-smokes-chunk.sh cannot drift apart.
SLOW_SMOKE_TIMEOUT="${MORPHIT_SLOW_SMOKE_TIMEOUT:-1200}"
smoke_timeout_for() {
	case "$1" in
	vitest-must-pass-smoke | workspace-typecheck-smoke | web-build-smoke | bunkerweb-no-phone-home-smoke | kubo-no-phone-home-smoke)
		if [ "$SLOW_SMOKE_TIMEOUT" -gt "$SMOKE_TIMEOUT" ]; then echo "$SLOW_SMOKE_TIMEOUT"; else echo "$SMOKE_TIMEOUT"; fi
		;;
	*) echo "$SMOKE_TIMEOUT" ;;
	esac
}
SMOKE_OUT="$(mktemp -t morphit-smoke.XXXXXX.out)"
trap 'rm -f "$SMOKE_OUT"' EXIT
idx=0
for entry in "${SMOKES[@]}"; do
  idx=$((idx+1))
  if [ "$idx" -lt "$START" ] || [ "$idx" -gt "$END" ]; then continue; fi
  dir="${entry%:*}"; name="${entry##*:}"
  path="$repo/$dir/scripts/$name.ts"
  if [ ! -f "$path" ]; then echo "  ✗ [$idx] $name (missing)"; failed=$((failed+1)); continue; fi
  # Prefer a workspace-local tsconfig.smoke.json — apps/web ships its
  # own so $blurt/$indexer resolve to WEB, not the indexer. Mirror run-smokes.sh
  # exactly; hardcoding the repo-root config mis-resolves those per-app aliases.
  if [ -f "$repo/$dir/tsconfig.smoke.json" ]; then CFG="$repo/$dir/tsconfig.smoke.json"; else CFG="$repo/tsconfig.smoke.json"; fi
  if (cd "$repo/$dir" && timeout --signal=TERM --kill-after=5 "$(smoke_timeout_for "$name")" "$TSX" --tsconfig "$CFG" "scripts/$name.ts" >"$SMOKE_OUT" 2>&1); then
    # Anchor count extraction at ^✓ all N (see run-smokes.sh): a greedy
    # `.*all ` matches the "all " inside assemble-INSTALL / local-INSTALL
    # and captures empty, mis-reporting those two as "no canonical line".
    n=$(grep "^✓ all" "$SMOKE_OUT" | sed "s/^✓ all \([0-9]*\).*/\1/")
    if [ -z "$n" ] || [ "$n" -eq 0 ] 2>/dev/null; then
      failed=$((failed+1)); echo "  ✗ [$idx] $name (no canonical line)"; tail -4 "$SMOKE_OUT" | sed 's/^/      /'
    else total=$((total+n)); fi
  else
    failed=$((failed+1)); echo "  ✗ [$idx] $name"; tail -10 "$SMOKE_OUT" | sed 's/^/      /'
  fi
done
echo "──────────────────────────────────────────────────────"
echo "Chunk [$START..$END]: $total scenarios, $failed runners failed"
# Exit non-zero when any runner failed, as run-smokes.sh does: a caller that
# checks the status (a release battery in 50-runner chunks) must not read a
# failing chunk as passed (v1.21.3; smoke-runner-count-extraction-smoke).
[ "$failed" -eq 0 ]
