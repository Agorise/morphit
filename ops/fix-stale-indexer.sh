#!/usr/bin/env bash
# fix-stale-indexer.sh — the process serving /v1/health is a STALE orphan not
# managed by systemd, so no code change or restart ever reached it. This shows
# it, kills the stale indexer process(es), clears the tsx cache, cleanly restarts
# morphit-indexer, and verifies /v1/health. Run on the box:
#   sudo bash fix-stale-indexer.sh
set -uo pipefail
IDXDIR="${IDXDIR:-/opt/morphit/apps/indexer}"
ENV_FILES=(/opt/morphit/morphit.env /opt/morphit/morphit.config.env /etc/morphit/indexer.env)
g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
bad(){ printf '  %s\xe2\x9c\x97%s %s\n' "$r" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
set -a; for f in "${ENV_FILES[@]}"; do [ -f "$f" ] && . "$f"; done; set +a
IHOST="${MORPHIT_INDEXER_LISTEN_HOST:-172.18.0.1}"; IPORT="${MORPHIT_INDEXER_LISTEN_PORT:-8081}"

pdetail(){ # $1=pid
	local pid="$1"; [ -z "$pid" ] && return
	local cmd cwd start
	cmd="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)"
	cwd="$(readlink /proc/$pid/cwd 2>/dev/null)"
	start="$(ps -o lstart= -p "$pid" 2>/dev/null | xargs)"
	printf '    pid=%s started="%s"\n      cwd=%s\n      cmd=%s\n' "$pid" "${start:-?}" "${cwd:-?}" "${cmd:-?}"
}

hdr "1. Who serves the indexer health port ($IHOST:$IPORT) vs. what systemd manages"
PORT_PID="$(ss -ltnp 2>/dev/null | grep "$IHOST:$IPORT " | grep -oP 'pid=\K[0-9]+' | head -1)"
MAIN_PID="$(systemctl show morphit-indexer -p MainPID --value 2>/dev/null)"
echo "  systemd morphit-indexer MainPID = ${MAIN_PID:-none}"
echo "  process listening on $IHOST:$IPORT:"
pdetail "$PORT_PID"
[ -n "${MAIN_PID:-}" ] && [ "$MAIN_PID" != "0" ] && { echo "  systemd's process:"; pdetail "$MAIN_PID"; }

# collect ALL node processes that look like the morphit indexer (cwd or cmd in apps/indexer)
mapfile -t IDX_PIDS < <(
	for pid in $(pgrep -f 'src/main.ts' 2>/dev/null; pgrep node 2>/dev/null); do
		c="$(readlink /proc/$pid/cwd 2>/dev/null)"; m="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)"
		case "$c$m" in *apps/indexer*|*morphit*indexer*) echo "$pid";; esac
	done | sort -un
)
hdr "2. All indexer-like node processes on this host"
for p in "${IDX_PIDS[@]}"; do pdetail "$p"; done

# decide which are STALE: anything serving the port or matching apps/indexer that is NOT the systemd MainPID
STALE=()
for p in "$PORT_PID" "${IDX_PIDS[@]}"; do
	[ -z "$p" ] && continue
	[ "$p" = "${MAIN_PID:-}" ] && continue
	# guard: only ever kill a process whose cwd/cmd is clearly the morphit indexer
	c="$(readlink /proc/$p/cwd 2>/dev/null)"; m="$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)"
	case "$c$m" in *apps/indexer*|*morphit*) STALE+=("$p");; esac
done
# de-dup
mapfile -t STALE < <(printf '%s\n' "${STALE[@]}" | awk 'NF' | sort -un)

hdr "3. Stop systemd, kill stale orphan(s), clear tsx cache"
systemctl stop morphit-indexer 2>/dev/null && ok "stopped morphit-indexer (systemd)" || warn "couldn't stop via systemd"
sleep 2
if [ "${#STALE[@]}" -gt 0 ]; then
	for p in "${STALE[@]}"; do
		kill -0 "$p" 2>/dev/null || continue
		echo "    killing stale indexer pid $p"; kill "$p" 2>/dev/null || true
	done
	sleep 3
	for p in "${STALE[@]}"; do kill -0 "$p" 2>/dev/null && { echo "    force-killing $p"; kill -9 "$p" 2>/dev/null || true; }; done
	ok "stale orphan process(es) killed"
else
	warn "no stale orphan identified (the port holder may already be systemd's) — will still clear cache + clean restart"
fi
# clear any tsx/esbuild compile cache so the fresh start recompiles the current source
for cache in "$IDXDIR/node_modules/.cache" /opt/morphit/node_modules/.cache "$HOME/.cache/tsx" /root/.cache/tsx /tmp/tsx-*; do
	[ -e "$cache" ] && { rm -rf "$cache" 2>/dev/null && echo "    cleared cache: $cache"; }
done
ok "cache cleared"
# confirm the port is now free
if ss -ltn 2>/dev/null | grep -q "$IHOST:$IPORT "; then bad "something STILL holds $IHOST:$IPORT — inspect: sudo ss -ltnp | grep $IPORT"; else ok "$IHOST:$IPORT is now free"; fi

hdr "4. Clean start + verify"
systemctl start morphit-indexer 2>/dev/null && ok "started morphit-indexer" || bad "failed to start — check: journalctl -u morphit-indexer -n 40"
NEW_PID="$(systemctl show morphit-indexer -p MainPID --value 2>/dev/null)"
echo "  new MainPID = ${NEW_PID:-none}"
echo "  waiting for it to bind + refresh the snapshot..."
UP=""
for _ in $(seq 1 12); do sleep 6
	J="$(curl -s --max-time 4 "http://$IHOST:$IPORT/v1/health" 2>/dev/null)"; [ -z "$J" ] && continue
	UP="$(printf '%s' "$J" | grep -o '"relay":[[:space:]]*{[^}]*}' | grep -o '"up":[[:space:]]*[a-z]*' | grep -o '[a-z]*$')"
	[ "$UP" = "true" ] && break
done

hdr "VERDICT"
if [ "$UP" = "true" ]; then
	printf '%s%s\xe2\x9c\x93 /v1/health now reports relay: { up: true }. The stale orphan was the whole problem.%s\n' "$g" "$b" "$x"
	echo "  The deployed v1.12.13 code was already correct — it just was never the process serving the endpoint."
	exit 0
else
	bad "/v1/health relay is '${UP:-unreadable}'. The port holder was likely systemd's own PID (not an orphan)."
	echo "  Paste sections 1-2 above so I can see the PIDs/cwd and take the next step."
	exit 2
fi
