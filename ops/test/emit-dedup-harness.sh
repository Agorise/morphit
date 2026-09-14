#!/usr/bin/env bash
# ops/test/emit-dedup-harness.sh — EXECUTE emit()'s repeat suppression.
#
# The suite as a whole runs with MORPHIT_EMIT_DEDUP=0 (see scripts/run-smokes.sh)
# because smokes assert on emitted events and CI runs them three times over.
# So the suppression needs its OWN test, with dedup explicitly on and a state dir
# of its own — otherwise the feature ships untested.
#
# The properties that matter, in order of how badly each failure hurts:
#   1. FAILS OPEN — an unwritable state dir must alert every time, never go quiet
#   2. a CHANGED payload is never suppressed
#   3. the window expires, so a persisting problem re-announces
#   4. identical repeats inside the window are suppressed
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fails=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

mkdir -p "$WORK/bin" "$WORK/state"
printf '#!/usr/bin/env bash\ncat\n' > "$WORK/bin/systemd-cat"
chmod +x "$WORK/bin/systemd-cat"
export PATH="$WORK/bin:$PATH"

fire() { # $1=payload  $2..=extra env assignments
	env MORPHIT_EMIT_DEDUP=1 MORPHIT_EMIT_STATE_DIR="$WORK/state" "${@:2}" \
		bash -c ". \"$REPO/ops/scripts/lib/emit.sh\"
export MORPHIT_EMIT_MODULE=harness MORPHIT_EMIT_TAG=harness
emit warn thing_broke '$1'" 2>/dev/null | grep -c thing_broke || true
}

echo "── emit() repeat suppression, executed ─────────────────────────"

n1=$(fire '{"u":"a"}'); n2=$(fire '{"u":"a"}'); n3=$(fire '{"u":"a"}')
[ "$n1" = "1" ] && ok "the first occurrence is reported" || no "the first occurrence was NOT reported (got $n1)"
[ "$n2$n3" = "00" ] && ok "identical repeats inside the window are suppressed" \
	|| no "an identical repeat was re-reported (n2=$n2 n3=$n3)"

nc=$(fire '{"u":"b"}')
[ "$nc" = "1" ] && ok "a CHANGED payload is reported immediately" || no "a changed payload was suppressed (got $nc)"

nw=$(fire '{"u":"a"}' MORPHIT_EMIT_REPEAT_SEC=0)
[ "$nw" = "1" ] && ok "the window expires, so a persisting problem re-announces" \
	|| no "nothing re-announced after the window (got $nw) — suppression became silence"

o1=$(fire '{"u":"c"}' MORPHIT_EMIT_STATE_DIR=/proc/cannot-write)
o2=$(fire '{"u":"c"}' MORPHIT_EMIT_STATE_DIR=/proc/cannot-write)
[ "$o1$o2" = "11" ] && ok "FAILS OPEN: unwritable state alerts every time, never goes silent" \
	|| no "went quiet when state was unwritable (o1=$o1 o2=$o2) — the worst outcome"

nd=$(env MORPHIT_EMIT_DEDUP=0 MORPHIT_EMIT_STATE_DIR="$WORK/state" bash -c ". \"$REPO/ops/scripts/lib/emit.sh\"
export MORPHIT_EMIT_MODULE=harness MORPHIT_EMIT_TAG=harness
emit warn thing_broke '{\"u\":\"a\"}'" 2>/dev/null | grep -c thing_broke || true)
[ "$nd" = "1" ] && ok "MORPHIT_EMIT_DEDUP=0 disables suppression entirely" || no "could not disable suppression (got $nd)"

echo ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m✗ %d emit-dedup check(s) failed\033[0m (%d passed)\n' "$fails" "$pass"; exit 1
fi
printf '\033[32m✓ all %d emit-dedup checks passed\033[0m\n' "$pass"
