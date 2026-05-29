#!/usr/bin/env bash
set -u
START="${1:-1}"; END="${2:-9999}"
repo="$(cd "$(dirname "$0")/.." && pwd)"; cd "$repo"
TSX="$repo/node_modules/.bin/tsx"
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
  if [ ! -f "$path" ]; then echo "  ✗ $name (missing)"; failed=$((failed+1)); continue; fi
  TSX_ARGS=(--tsconfig "$repo/tsconfig.smoke.json")
  if (cd "$repo/$dir" && timeout --signal=TERM --kill-after=5 240 "$TSX" "${TSX_ARGS[@]}" "scripts/$name.ts" >"$SMOKE_OUT" 2>&1); then
    n=$(grep "^✓ all" "$SMOKE_OUT" | sed "s/.*all \([0-9]*\).*/\1/")
    if [ -z "$n" ] || [ "$n" -eq 0 ] 2>/dev/null; then
      failed=$((failed+1)); echo "  ✗ $name (no canonical line)"; tail -6 "$SMOKE_OUT" | sed 's/^/      /'
    else total=$((total+n)); fi
  else
    failed=$((failed+1)); echo "  ✗ $name"; tail -12 "$SMOKE_OUT" | sed 's/^/      /'
  fi
done
echo "──────────────────────────────────────────────────────"
echo "Chunk [$START..$END]: $total scenarios, $failed runners failed"
