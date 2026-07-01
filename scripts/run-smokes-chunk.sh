#!/usr/bin/env bash
set -u
START="${1:-1}"; END="${2:-9999}"
repo="$(cd "$(dirname "$0")/.." && pwd)"; cd "$repo"
# Resolve tsx portably (workspace first, then PATH) — mirrors scripts/run-smokes.sh.
# (Previously this hardcoded an absolute sandbox path, which broke on every
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
SMOKE_OUT="$(mktemp -t morphit-smoke.XXXXXX.out)"
trap 'rm -f "$SMOKE_OUT"' EXIT
idx=0
for entry in "${SMOKES[@]}"; do
  idx=$((idx+1))
  if [ "$idx" -lt "$START" ] || [ "$idx" -gt "$END" ]; then continue; fi
  dir="${entry%:*}"; name="${entry##*:}"
  path="$repo/$dir/scripts/$name.ts"
  if [ ! -f "$path" ]; then echo "  ✗ [$idx] $name (missing)"; failed=$((failed+1)); continue; fi
  if (cd "$repo/$dir" && timeout --signal=TERM --kill-after=5 240 "$TSX" --tsconfig "$repo/tsconfig.smoke.json" "scripts/$name.ts" >"$SMOKE_OUT" 2>&1); then
    n=$(grep "^✓ all" "$SMOKE_OUT" | sed "s/.*all \([0-9]*\).*/\1/")
    if [ -z "$n" ] || [ "$n" -eq 0 ] 2>/dev/null; then
      failed=$((failed+1)); echo "  ✗ [$idx] $name (no canonical line)"; tail -4 "$SMOKE_OUT" | sed 's/^/      /'
    else total=$((total+n)); fi
  else
    failed=$((failed+1)); echo "  ✗ [$idx] $name"; tail -10 "$SMOKE_OUT" | sed 's/^/      /'
  fi
done
echo "──────────────────────────────────────────────────────"
echo "Chunk [$START..$END]: $total scenarios, $failed runners failed"
