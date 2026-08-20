#!/usr/bin/env bash
#
# relay-health-fix.sh — make /v1/health report the relay's REAL status.
# Run on the box (morphit.io or morphitlat):  sudo bash relay-health-fix.sh
#
# The indexer's relay probe (MORPHIT_INDEXER_RELAY_HEALTH_URL) is empty by
# default, so relay up/down is never measured and reads a misleading false.
# The relay does NOT always listen on loopback — behind a containerized front
# (BunkerWeb/nginx) it binds the DOCKER BRIDGE (e.g. 172.18.0.1) so the container
# can reach it. This DISCOVERS where the relay actually answers (four independent
# ways), points the probe there, restarts, and verifies. It changes nothing if
# the relay can't be found (then it's really down / mis-bound, and says so).
#
set -uo pipefail
ENV_FILES=(/etc/morphit/relay.env /etc/morphit/indexer.env /opt/morphit/morphit.env /opt/morphit/morphit.config.env)
IDXENV="${IDXENV:-/etc/morphit/indexer.env}"
g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
bad(){ printf '  %s\xe2\x9c\x97%s %s\n' "$r" "$x" "$1"; }
hdr(){ printf '\n%s-- %s --%s\n' "$b" "$1" "$x"; }
envget(){ local v f; for f in "${ENV_FILES[@]}"; do [ -r "$f" ] || continue
	v="$(grep -E "^(export +)?$1=" "$f" 2>/dev/null | tail -1 | sed -E "s/^(export +)?$1=//; s/^[\"']//; s/[\"']\$//; s/[[:space:]].*//")"
	[ -n "$v" ] && { printf '%s' "$v"; return 0; }; done; }

[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo bash relay-health-fix.sh"; exit 1; }
[ -f "$IDXENV" ] || { bad "indexer env not found at $IDXENV (set IDXENV=...)"; exit 1; }

RPORT="$(envget MORPHIT_RELAY_LISTEN_PORT)";   RPORT="${RPORT:-8080}"
IPORT="$(envget MORPHIT_INDEXER_LISTEN_PORT)"; IPORT="${IPORT:-8081}"

# ── shape tests ──────────────────────────────────────────────────────
is_relay(){ local body code; body="$(curl -s --max-time 3 "$1" 2>/dev/null | tr -d '\000')"; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null || echo 000)"
	[ "$code" = "200" ] && printf '%s' "$body" | grep -q '"status":"ok"' && ! printf '%s' "$body" | grep -q 'indexed_block'; }
relay_up_at(){ local h; h="$(curl -s --max-time 4 "$1" 2>/dev/null | tr -d '\000')"; [ -n "$h" ] || return 1
	printf '%s' "$h" | grep -o '"relay":[[:space:]]*{[^}]*}' | grep -o '"up":[[:space:]]*[a-z]*' | grep -o '[a-z]*$'; }

hdr "1. Discover where the relay actually answers"
declare -a CANDS=()
addcand(){ case " ${CANDS[*]-} " in *" $1 "*) ;; *) CANDS+=("$1");; esac; }

# (a) ask morphit-ops itself — it already prints the exact URL it uses
OPS="$(command -v morphit-ops || echo /usr/local/bin/morphit-ops)"
if [ -x "$OPS" ] || command -v morphit-ops >/dev/null 2>&1; then
	while read -r u; do addcand "$u"; done < <(morphit-ops health 2>/dev/null | grep -oiE 'http://[0-9a-z._-]+:[0-9]+/v1/health' | sort -u)
fi
# (b) ss — every address:port actually LISTENing on the relay port (authoritative)
for a in $(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E "[:.]${RPORT}\$" | sed -E "s/:${RPORT}\$//" | tr -d '[]' | sort -u); do
	case "$a" in 0.0.0.0|"*"|::) addcand "http://127.0.0.1:${RPORT}/v1/health";; *) addcand "http://${a}:${RPORT}/v1/health";; esac
done
# (c) any docker bridge IPs (docker0 / br-*) at the relay port
for ip in $(ip -4 -o addr show 2>/dev/null | awk '$2 ~ /^(docker0|br-)/ {print $4}' | cut -d/ -f1); do addcand "http://${ip}:${RPORT}/v1/health"; done
# (d) plain loopback + configured relay listen host + default gateway
addcand "http://127.0.0.1:${RPORT}/v1/health"
RHOST="$(envget MORPHIT_RELAY_LISTEN_HOST)"; [ -n "$RHOST" ] && [ "$RHOST" != "0.0.0.0" ] && addcand "http://${RHOST}:${RPORT}/v1/health"
GW="$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')"; [ -n "$GW" ] && addcand "http://${GW}:${RPORT}/v1/health"
# also sweep EVERY local listener for a relay-shaped response (covers a non-standard port)
for hp in $(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E '^(127\.0\.0\.1|172\.|10\.|192\.168\.)' | sort -u); do addcand "http://${hp}/v1/health"; done

RELAY_URL=""
for u in "${CANDS[@]}"; do
	if is_relay "$u"; then RELAY_URL="$u"; ok "relay answers at $u"; break; else printf '    - %s (no)\n' "$u"; fi
done
if [ -z "$RELAY_URL" ]; then
	bad "relay not found on any discovered address. It is genuinely down or mis-bound."
	echo "     check:  systemctl status morphit-relay   and   sudo ss -ltnp | grep -E ':(${RPORT}|8080)'"
	exit 2
fi

hdr "2. Point the indexer's relay probe at it"
CUR="$(envget MORPHIT_INDEXER_RELAY_HEALTH_URL)"
if [ "$CUR" = "$RELAY_URL" ]; then ok "already set to $RELAY_URL (restart + verify only)"
else
	cp -a "$IDXENV" "$IDXENV.bak-$(date +%s)" && ok "backed up $IDXENV"
	if grep -qE '^(export +)?MORPHIT_INDEXER_RELAY_HEALTH_URL=' "$IDXENV"; then
		sed -i -E "s#^(export +)?MORPHIT_INDEXER_RELAY_HEALTH_URL=.*#MORPHIT_INDEXER_RELAY_HEALTH_URL=$RELAY_URL#" "$IDXENV"
	else printf '\n# relay-health-fix.sh: enable the relay health probe\nMORPHIT_INDEXER_RELAY_HEALTH_URL=%s\n' "$RELAY_URL" >> "$IDXENV"; fi
	ok "set MORPHIT_INDEXER_RELAY_HEALTH_URL=$RELAY_URL"
fi

hdr "3. Restart the indexer + verify"
systemctl restart morphit-indexer 2>/dev/null && ok "restarted morphit-indexer" || warn "couldn't restart via systemd"
# discover the indexer's own health URL the same way (morphit-ops + ss + bridge + loopback)
declare -a IH=()
addih(){ case " ${IH[*]-} " in *" $1 "*) ;; *) IH+=("$1");; esac; }
while read -r u; do addih "$u"; done < <(morphit-ops health 2>/dev/null | grep -oiE 'http://[0-9a-z._-]+:'"${IPORT}"'/v1/health' | sort -u)
for a in $(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E "[:.]${IPORT}\$" | sed -E "s/:${IPORT}\$//" | tr -d '[]' | sort -u); do
	case "$a" in 0.0.0.0|"*"|::) addih "http://127.0.0.1:${IPORT}/v1/health";; *) addih "http://${a}:${IPORT}/v1/health";; esac; done
addih "http://127.0.0.1:${IPORT}/v1/health"; [ -n "$GW" ] && addih "http://${GW}:${IPORT}/v1/health"
echo "  waiting for the indexer to refresh its snapshot..."
UP=""
for _ in 1 2 3 4 5 6 7; do sleep 6
	for ih in "${IH[@]}"; do UP="$(relay_up_at "$ih" || true)"; [ -n "$UP" ] && break; done
	[ -n "$UP" ] && break
done

hdr "Result"
if [ "$UP" = "true" ]; then
	printf '%s%s\xe2\x9c\x93 relay is now up:true on /v1/health.%s   (probe -> %s)\n' "$g" "$b" "$x" "$RELAY_URL"; exit 0
elif [ "$UP" = "false" ]; then
	bad "still up:false even though the relay answers 200 at $RELAY_URL."
	echo "     The indexer process can't reach it from its own context. Paste me:"
	echo "       systemctl show morphit-indexer -p ExecStart ; grep -E 'LISTEN|RELAY' $IDXENV"; exit 2
else warn "couldn't read relay.up yet. Re-check: curl -s ${IH[0]:-http://127.0.0.1:$IPORT/v1/health} | grep -A2 relay"; exit 2; fi
