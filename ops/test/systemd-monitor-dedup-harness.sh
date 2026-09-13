#!/usr/bin/env bash
# ops/test/systemd-monitor-dedup-harness.sh — EXECUTE the alert monitor.
#
# WHY
# The systemd monitor re-announced the SAME unchanged failed unit on every scan.
# With a 5-minute timer that is a CRITICAL alert every 5 minutes for one fact
# the operator already knows — which is how someone learns to ignore alerts
# altogether, a worse outcome than sending none.
#
# The fix (alert on state CHANGE, plus a recovery notice) is only meaningful as
# a SEQUENCE across runs, which no text-matching assertion can check. So drive
# the real script through a full cycle against a stub systemctl and assert on
# what it emitted at each step.
#
# The subtle requirement, and the reason a "clear the record on recovery" step
# exists: after a unit recovers, its NEXT failure must alert again. A dedup that
# remembers forever would silently swallow a real re-failure.
#
# Hermetic: temp dir, stub systemctl/systemd-cat on PATH, no systemd, no root.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MON="$REPO/ops/scripts/morphit-systemd-monitor.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fails=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

BIN="$WORK/bin"; mkdir -p "$BIN" "$WORK/state"
UNIT="morphit-snapshot-publish.service"
echo failed > "$WORK/unit-state"

cat > "$BIN/systemctl" <<STUB
#!/usr/bin/env bash
cur="\$(cat "$WORK/unit-state" 2>/dev/null || echo failed)"
case "\$*" in
	*"list-unit-files"*) echo "$UNIT enabled enabled"; exit 0 ;;
	"is-failed --quiet $UNIT") [ "\$cur" = failed ] && exit 0 || exit 1 ;;
	*"-p SubState"*)    echo failed; exit 0 ;;
	*"-p Result"*)      echo exit-code; exit 0 ;;
	*"-p NRestarts"*)   echo 0; exit 0 ;;
	*"-p ActiveState"*) echo "\$cur"; exit 0 ;;
esac
exit 0
STUB
# emit() ships records to journald via systemd-cat; make them visible instead.
printf '#!/usr/bin/env bash\ncat\n' > "$BIN/systemd-cat"
chmod +x "$BIN"/*

export PATH="$BIN:$PATH"
export MORPHIT_MONITOR_STATE_DIR="$WORK/state"

scan(){ bash "$MON" 2>&1 | grep -oE '"event":"[a-z_]+"' | sed 's/.*:"//;s/"//' | tr '\n' ' '; }

echo "── alert monitor, executed across a state cycle ────────────────"

s1="$(scan)"
case "$s1" in *unit_failed*) ok "a newly failed unit alerts once" ;; *) no "a failed unit did not alert (got: '$s1')" ;; esac

s2="$(scan)"; s3="$(scan)"
if [ -z "$(printf '%s%s' "$s2" "$s3" | tr -d ' ')" ]; then
	ok "the SAME unchanged failure stays silent on later scans (no 5-minute spam)"
else
	no "re-alerted for an unchanged failure (scan2='$s2' scan3='$s3')"
fi

echo active > "$WORK/unit-state"
s4="$(scan)"
case "$s4" in *unit_recovered*) ok "recovery is reported once" ;; *) no "no recovery notice (got: '$s4')" ;; esac

s5="$(scan)"
if [ -z "$(printf '%s' "$s5" | tr -d ' ')" ]; then ok "a healthy unit stays silent"; else no "chattered about a healthy unit (got: '$s5')"; fi

echo failed > "$WORK/unit-state"
s6="$(scan)"
case "$s6" in
	*unit_failed*) ok "a RE-failure after recovery alerts again (dedup never swallows a real one)" ;;
	*) no "a re-failure was silently suppressed (got: '$s6') — worse than the spam it replaced" ;;
esac

# An unwritable state dir must degrade to the OLD behaviour (alert every scan),
# never to silence. Losing alerts is the one outcome worse than too many.
rm -rf "$WORK/state"
export MORPHIT_MONITOR_STATE_DIR=/proc/cannot-write-here
s7="$(scan)"; s8="$(scan)"
if [ -n "$(printf '%s' "$s7" | tr -d ' ')" ] && [ -n "$(printf '%s' "$s8" | tr -d ' ')" ]; then
	ok "an unwritable state dir degrades to alerting every scan, never to silence"
else
	no "alerts went SILENT when state could not be written (s7='$s7' s8='$s8')"
fi

echo ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m✗ %d monitor-dedup check(s) failed\033[0m (%d passed)\n' "$fails" "$pass"
	exit 1
fi
printf '\033[32m✓ all %d monitor-dedup checks passed\033[0m\n' "$pass"
