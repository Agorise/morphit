#!/usr/bin/env bash
set -u
repo="$(cd "$(dirname "$0")" && pwd)"; cd "$repo"; TSX="$repo/node_modules/.bin/tsx"
CHUNK="${1:-40}"; LIST="${2:-/tmp/smokes.list}"; SMOKE_TIMEOUT="${MORPHIT_SMOKE_TIMEOUT:-90}"
mapfile -t E < "$LIST"; n=${#E[@]}; ts=0; pass=0; fail=0; FL=(); OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT; i=0
while [ $i -lt $n ]; do
  end=$((i+CHUNK)); [ $end -gt $n ] && end=$n; cp=0; cf=0; cs=0
  for ((j=i;j<end;j++)); do
    e="${E[$j]}"; d="${e%:*}"; nm="${e##*:}"; p="$repo/$d/scripts/$nm.ts"
    [ -f "$p" ] || { echo "  MISSING $e"; fail=$((fail+1)); cf=$((cf+1)); FL+=("$e[missing]"); continue; }
    if [ -f "$repo/$d/tsconfig.smoke.json" ]; then A=(--tsconfig "$repo/$d/tsconfig.smoke.json"); elif [ -f "$repo/tsconfig.smoke.json" ]; then A=(--tsconfig "$repo/tsconfig.smoke.json"); else A=(); fi
    if (cd "$repo/$d" && timeout --signal=TERM --kill-after=5 "$SMOKE_TIMEOUT" "$TSX" "${A[@]}" "scripts/$nm.ts" >"$OUT" 2>&1); then
      ln=$(grep "^✓ all" "$OUT"|tail -1)
      if [ -n "$ln" ]; then sc=$(printf '%s' "$ln"|sed "s/^✓ all \([0-9]*\).*/\1/"); [ -z "$sc" ]&&sc=0; ts=$((ts+sc));cs=$((cs+sc));pass=$((pass+1));cp=$((cp+1)); else fail=$((fail+1));cf=$((cf+1));FL+=("$e[nocanon]");echo "  ⚠ $e"; fi
    else rc=$?; fail=$((fail+1));cf=$((cf+1));FL+=("$e[rc=$rc]");echo "  ✗ $e rc=$rc $(tail -1 "$OUT")"; fi
  done
  printf 'CHUNK [%3d-%3d] pass=%-3d fail=%-2d scen=%-6d\n' "$((i+1))" "$end" "$cp" "$cf" "$cs"; i=$end
done
echo "════ RUNNERS:$n PASS:$pass FAIL:$fail SCEN:$ts ════"
[ "$fail" -gt 0 ] && { echo "FAILURES:"; for x in "${FL[@]}"; do echo "  $x"; done; }
