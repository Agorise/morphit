#!/usr/bin/env bash
# cleanup-relay-debug.sh — remove the leftover backups/logs/temp files from the
# relay troubleshooting session. Touches ONLY .bak/.log/temp artifacts; never the
# live operationalHealth.ts or the RELAY_HEALTH_URL config. Safe anytime; ideally
# after the v1.12.14 upgrade. Run on the box:  sudo bash cleanup-relay-debug.sh
set -uo pipefail
IDXAPI="${IDXAPI:-/opt/morphit/apps/indexer/src/api}"
g=$'\e[32m'; y=$'\e[33m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

hdr "1. What will be removed (backups, debug logs, scp'd scripts, temp .ts)"
mapfile -t VICTIMS < <(
	ls -1 "$IDXAPI"/operationalHealth.ts.*bak* 2>/dev/null
	ls -1 "$IDXAPI"/operationalHealth.ts.livetest-bak 2>/dev/null
	ls -1 "$IDXAPI"/_relay_mech_test.*.ts "$IDXAPI"/_snap_diag.*.ts 2>/dev/null
	ls -1 /etc/morphit/indexer.env.bak-* 2>/dev/null
	ls -1 /opt/morphit/.relay-debug.log /opt/morphit/.relay-refresh-trace.log 2>/dev/null
	ls -1 /tmp/molog /tmp/morphit-relay-debug.log 2>/dev/null
	for s in relay-health-fix relay-updown-proof relay-snapshot-diag relay-runtime-debug \
	         relay-filelog-debug find-live-file show-indexer-runtime relay-refresh-trace \
	         apply-relay-fix diag-relay fix-stale-indexer cleanup-relay-debug; do
		ls -1 "/tmp/$s.sh" 2>/dev/null
	done
)
if [ "${#VICTIMS[@]}" -eq 0 ]; then ok "nothing to clean — already tidy."; else printf '    %s\n' "${VICTIMS[@]}"; fi

hdr "2. Safety check — the LIVE file + config are preserved"
if grep -q 'enumeration blocked by the sandbox\|networkInterfaces' "$IDXAPI/operationalHealth.ts" 2>/dev/null; then
	ok "live operationalHealth.ts present (kept) — has the relay probe code"
else warn "live operationalHealth.ts looks unexpected — NOT deleting anything; inspect manually"; exit 2; fi
grep -q '^MORPHIT_INDEXER_RELAY_HEALTH_URL=' /etc/morphit/indexer.env 2>/dev/null && ok "RELAY_HEALTH_URL config kept (correct + harmless)" || true

hdr "3. Remove the artifacts"
n=0
for f in "${VICTIMS[@]}"; do [ -e "$f" ] && rm -f "$f" && n=$((n+1)); done
ok "removed $n leftover file(s)"
# tsx cache is regenerated automatically; clear the stale ones too
for c in /tmp/tsx-*; do [ -e "$c" ] && rm -rf "$c" 2>/dev/null; done
ok "cleared stale tsx cache (regenerates on next start)"

hdr "4. Confirm the relay is still healthy"
IHOST="$(grep -h '^MORPHIT_INDEXER_LISTEN_HOST=' /opt/morphit/morphit.env /etc/morphit/indexer.env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"')"; IHOST="${IHOST:-172.18.0.1}"
printf '  /v1/health relay -> %s\n' "$(curl -s --max-time 4 "http://$IHOST:8081/v1/health" 2>/dev/null | grep -o '"relay":[[:space:]]*{[^}]*}')"
echo
ok "done — server tidy, live fix untouched."
