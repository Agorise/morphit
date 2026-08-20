#!/usr/bin/env bash
# show-indexer-runtime.sh — read-only. Reveals the systemd sandboxing (esp.
# PrivateTmp) + where the indexer's output goes, so we can finally capture its
# in-process logs. Run on the box:  sudo bash show-indexer-runtime.sh
set -uo pipefail
b=$'\e[1m'; x=$'\e[0m'
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }

hdr "1. Sandboxing + output routing of morphit-indexer.service"
systemctl show morphit-indexer \
	-p PrivateTmp -p ProtectSystem -p ProtectHome -p ReadWritePaths -p ReadOnlyPaths \
	-p StandardOutput -p StandardError -p SyslogIdentifier -p User -p Group \
	-p WorkingDirectory -p StateDirectory -p LogsDirectory -p RuntimeDirectory -p MainPID \
	2>/dev/null | sed 's/^/  /'

hdr "2. Does the indexer log to the journal at all? (last 15 lines)"
journalctl -u morphit-indexer -n 15 --no-pager 2>/dev/null | sed 's/^/  /' || echo "  (no journal output)"

hdr "3. If PrivateTmp=yes, peek INTO the indexer's private /tmp for my old markers"
PID="$(systemctl show morphit-indexer -p MainPID --value 2>/dev/null)"
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
	# the child worker is what runs the code; find it (child of MainPID)
	CHILD="$(pgrep -P "$PID" 2>/dev/null | head -1)"; TARGET="${CHILD:-$PID}"
	echo "  worker pid = $TARGET"
	# a process's private /tmp is visible on the host under its root namespace
	for p in "$PID" "$TARGET"; do
		for f in molog morphit-relay-debug.log; do
			hostpath="/proc/$p/root/tmp/$f"
			[ -e "$hostpath" ] && { echo "  found $hostpath:"; tail -6 "$hostpath" | sed 's/^/      /'; }
		done
	done
	echo "  (if nothing above, either no marker fired or the path differs)"
else
	echo "  no MainPID"
fi

hdr "4. Writable places the indexer could log to (shared with host)"
echo "  WorkingDirectory owner/perm:"; ls -ld /opt/morphit/apps/indexer 2>/dev/null | sed 's/^/    /'
echo "  /opt/morphit owner/perm:";      ls -ld /opt/morphit 2>/dev/null | sed 's/^/    /'
echo ""
echo "Interpretation: PrivateTmp=yes => all my /tmp debug logs were invisible (private namespace)."
echo "Section 3 reads the indexer's PRIVATE /tmp via /proc/PID/root/tmp — that may already show the"
echo "probe result. If StandardError=journal but section 2 has no app logs, the app logger suppresses console."
