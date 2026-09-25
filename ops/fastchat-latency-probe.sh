#!/usr/bin/env bash
# ops/fastchat-latency-probe.sh — measure the REAL federation chat latency
# between two instances, on the machines that actually have Tor and I2P.
#
# WHY THIS SCRIPT EXISTS
# The smoke (apps/indexer/scripts/federation-chat-fast-smoke.ts) proves the
# architecture fits inside six seconds under a STATED, modelled hidden-network
# latency. It cannot prove anything about your actual circuits, because the
# machine it runs on has no Tor daemon and no I2P router. Only your boxes do.
#
# So this measures the thing the smoke models: how long a hidden round trip to a
# peer really takes, over the SAME path the indexer uses — Tor through its SOCKS
# port, I2P as a CONNECT tunnel through the router's HTTP proxy — and therefore
# how much of the six-second budget the transport leaves for everything else.
#
# WHICH MACHINE TO RUN THIS ON
#   Run it on the SENDING instance — the box whose users are sending chat
#   messages — pointed at the OTHER instance's .onion or .b32.i2p address. Then
#   run it again the other way round, on the other box, because circuits are not
#   symmetric and the slow direction is the one your users will notice.
#
# WHAT IT DOES NOT DO
# It sends no chat messages and needs no accounts. Every request is a GET of the
# peer's public /v1/health, which is exactly the request the warm-up makes. It
# changes nothing on either box.
#
# IT NEVER USES THE CLEARNET UNLESS TOLD TO (v1.18.0 review). Given a clearnet
# address it used to connect directly, from this box's own IP — which on a
# tor-only home server is the one thing that box exists not to do. A clearnet
# address is now refused unless you pass --allow-clearnet; use the peer's .onion
# or .b32.i2p instead.
#
# USAGE (on the sending box)
#   bash ops/fastchat-latency-probe.sh http://<peer>.b32.i2p
#   bash ops/fastchat-latency-probe.sh http://<peer>.onion --samples 20
#
# SETTINGS are read the way the indexer reads them: MORPHIT_INDEXER_TOR_SOCKS and
# MORPHIT_INDEXER_I2P_HTTP_PROXY from the environment, else from this box's
# indexer config (/etc/morphit/indexer.env, /opt/morphit/morphit.env), else the
# standard 127.0.0.1:9050 and 127.0.0.1:4444.
set -uo pipefail

PEER="${1:-}"
SAMPLES=10
TARGET_MS=6000
ALLOW_CLEARNET=0

shift || true
while [ $# -gt 0 ]; do
	case "$1" in
		--samples) SAMPLES="${2:-10}"; shift 2 ;;
		--target-ms) TARGET_MS="${2:-6000}"; shift 2 ;;
		--allow-clearnet) ALLOW_CLEARNET=1; shift ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

if [ -z "$PEER" ]; then
	cat >&2 <<'USAGE'
usage: bash ops/fastchat-latency-probe.sh <peer-origin> [--samples N] [--target-ms N]

  <peer-origin>   e.g. http://abc...xyz.b32.i2p  or  http://abc...xyz.onion
                  Run this ON THE SENDING BOX, pointed at the OTHER instance.

Run it in both directions. Circuits are not symmetric, and the slow direction
is the one your users will notice.
USAGE
	exit 2
fi
case "$SAMPLES" in ''|*[!0-9]*) echo "--samples must be a number" >&2; exit 2 ;; esac
case "$TARGET_MS" in ''|*[!0-9]*) echo "--target-ms must be a number" >&2; exit 2 ;; esac
[ "$SAMPLES" -ge 2 ] || { echo "--samples must be at least 2" >&2; exit 2; }

# ── Which network: from the HOST, parsed, never from how the string ends ──
# (v1.18.0 deep-deep, L2) This used to strip a scheme, cut at the first '/' and
# the first ':', and then look at the suffix — so 'http://evil.example?.loki'
# (a query string) or '...#.onion' (a fragment) was classified as a hidden
# network, given no proxy (Lokinet) or the Tor one, and slipped past the
# --allow-clearnet guard. The peer must now be a bare origin: scheme, host,
# optional port, optional trailing slash — nothing that could make the host
# curl connects to differ from the host classified here.
origin_re='^https?://([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?/?$'
if ! [[ "$PEER" =~ $origin_re ]]; then
	cat >&2 <<EOF
'$PEER' is not a bare origin. Give the peer as scheme + host (+ optional port),
for example http://<56 characters>.onion or http://<52 characters>.b32.i2p —
no path, query, fragment or user name.
EOF
	exit 2
fi
host="$(printf '%s' "${BASH_REMATCH[1]}" | tr 'A-Z' 'a-z')"
case "$host" in
	*.onion) network=tor ;;
	*.i2p)   network=i2p ;;
	*.loki)  network=loki ;;
	*)       network=clearnet ;;
esac

if [ "$network" = clearnet ] && [ "$ALLOW_CLEARNET" -ne 1 ]; then
	cat >&2 <<EOF
'$host' is a clearnet address. This probe measures the hidden routes fast chat
uses, and contacting a clearnet address would do so from this box's own IP.
Point it at the peer's .onion or .b32.i2p address instead (the peer's directory
card lists them). To measure clearnet anyway, add --allow-clearnet.
EOF
	exit 2
fi

# ── Proxy settings, read the way the indexer reads them ─────────────────
# The indexer's own variable names first (the environment, then its config
# files), so this measures the path the indexer will actually take.
# (v1.18.0 deep-deep, L2) A setting that is PRESENT BUT BLANK means that
# network is switched off — exactly as the indexer reads it
# (`MORPHIT_INDEXER_TOR_SOCKS ?? '127.0.0.1:9050'`, then trimmed). The old
# `${VAR:-…}` treated blank as unset and fell back to the standard port, so the
# "switched off" message below could never print. The default applies only when
# the name is set nowhere.
setting() { # <name> <default> — environment if SET, else the last assignment in the env files, else default
	local name="$1" def="$2" f v="" found=0 line
	if [ -n "${!name+set}" ]; then
		v="${!name}"; found=1
	else
		for f in /etc/morphit/indexer.env /opt/morphit/morphit.env /opt/morphit/morphit.config.env; do
			[ -r "$f" ] || continue
			line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}=" "$f" 2>/dev/null | tail -n1)" || true
			[ -n "$line" ] && { v="${line#*=}"; found=1; }
		done
		v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
	fi
	[ "$found" -eq 1 ] || v="$def"
	printf '%s' "$v" | tr -d '[:space:]'
}
bare_hostport() { # strip any scheme and trailing slash: http://h:p/ → h:p
	local v="${1#*://}"; printf '%s' "${v%%/*}"
}
TOR_SOCKS="$(bare_hostport "$(setting MORPHIT_INDEXER_TOR_SOCKS 127.0.0.1:9050)")"
I2P_HTTP="$(bare_hostport "$(setting MORPHIT_INDEXER_I2P_HTTP_PROXY 127.0.0.1:4444)")"

case "$network" in
	tor)
		[ -n "$TOR_SOCKS" ] || { echo "Tor is switched off in this box's indexer settings." >&2; exit 2; }
		CURL_PROXY=(--socks5-hostname "$TOR_SOCKS") ;;
	i2p)
		[ -n "$I2P_HTTP" ] || { echo "I2P is switched off in this box's indexer settings." >&2; exit 2; }
		# --proxytunnel: a CONNECT tunnel, exactly what the indexer opens. A
		# plain proxied GET is a different path, and a proxy that REFUSES the
		# tunnel then shows up as a failure here, as it does for the indexer.
		CURL_PROXY=(--proxy "http://$I2P_HTTP" --proxytunnel) ;;
	loki)
		echo "NOTE: .loki is reached through lokinet's own resolver; this box must run lokinet." >&2
		CURL_PROXY=() ;;
	clearnet)
		echo "NOTE: measuring over the CLEARNET, from this box's own IP (--allow-clearnet)." >&2
		CURL_PROXY=() ;;
esac

URL="${PEER%/}/v1/health"

# ── A spinner, so a slow circuit never looks like a hang ────────────────
SPIN_PID=''
spin_start() {
	[ -t 1 ] || { printf '    %s\n' "$1"; return; }
	( frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'; i=0
	  while :; do printf '\r    %s %s' "${frames:$((i % 10)):1}" "$1"; i=$((i + 1)); sleep 0.1; done ) &
	SPIN_PID=$!
}
spin_stop() {
	[ -n "$SPIN_PID" ] || return 0
	kill "$SPIN_PID" 2>/dev/null; wait "$SPIN_PID" 2>/dev/null
	SPIN_PID=''
	printf '\r\033[K'
}
trap 'spin_stop' EXIT

# ── One timed request ────────────────────────────────────────────────────
# Echoes "<ms> <http code>", or nothing when no HTTP answer came back at all.
# Only an answer FROM THE PEER counts: a Tor SOCKS failure and a refused I2P
# CONNECT are curl errors, never an HTTP status, so a status here is the peer's.
timed_get() { # <extra curl args...>
	local out
	out="$(curl -sS -o /dev/null -w '%{time_total} %{http_code}' --max-time 120 \
		"${CURL_PROXY[@]+"${CURL_PROXY[@]}"}" "$@" "$URL" 2>/dev/null)" || return 0
	awk -v t="${out% *}" -v c="${out#* }" 'BEGIN{ if (c+0 >= 100) printf "%d %d", t*1000, c }'
}
counts() { # <http code> — does this answer measure the round trip?
	[ "$1" -ge 200 ] && [ "$1" -lt 500 ]
}

echo "fastchat latency probe — run on the SENDING box, pointed at the other instance"
echo "  peer      : $PEER"
echo "  transport : $network$( [ "$network" = tor ] && printf ' (via %s)' "$TOR_SOCKS" )$( [ "$network" = i2p ] && printf ' (CONNECT via %s)' "$I2P_HTTP" )"
echo "  samples   : $SAMPLES"
echo "  budget    : ${TARGET_MS}ms end to end"
echo ''

# ── 1. COLD: what a first contact costs ─────────────────────────────────
# Over Tor each sample gets its OWN circuit: a distinct SOCKS username makes Tor
# isolate the stream (IsolateSOCKSAuth, on by default), so these are real cold
# circuit builds rather than three requests sharing one. Over I2P the router's
# tunnels are shared by everything on this box, so this is first contact over
# tunnels that already exist — the best case for a cold message.
echo "cold (3 samples) — what a message pays with NO warm-up:"
cold_total=0; cold_n=0
for i in 1 2 3; do
	extra=()
	[ "$network" = tor ] && extra=(--proxy-user "morphit-cold-$$-$i:x")
	spin_start "building a route to the peer (up to 2 minutes)…"
	r="$(timed_get "${extra[@]+"${extra[@]}"}")"
	spin_stop
	if [ -z "$r" ]; then
		echo "    no answer (the route could not be built within 120s)"
	elif ! counts "${r#* }"; then
		echo "    the peer answered HTTP ${r#* } — not counted"
	else
		ms="${r% *}"
		echo "    ${ms}ms"
		cold_total=$((cold_total + ms)); cold_n=$((cold_n + 1))
	fi
done
echo ''

if [ "$cold_n" -eq 0 ]; then
	echo "The peer could not be reached over $network from this box."
	echo ""
	echo "Worth checking, on THIS box:"
	case "$network" in
		tor) echo "  - Tor is running and listening on $TOR_SOCKS:"
		     echo "      systemctl status tor ; ss -lntp | grep ${TOR_SOCKS##*:}" ;;
		i2p) echo "  - the I2P router is running and its HTTP proxy is $I2P_HTTP:"
		     echo "      systemctl status i2pd ; ss -lntp | grep ${I2P_HTTP##*:}" ;;
	esac
	echo "  - the address is the peer's current one (the peer's directory card shows it)"
	exit 1
fi

# ── 2. WARM: what a message pays on a kept-alive connection ─────────────
# One curl process, many requests, keep-alive on: the same reuse the indexer's
# pooled dispatcher gets. This is the number that decides whether six seconds
# is achievable in practice.
echo "warm (one connection reused, $SAMPLES samples) — what a message pays WITH the warm-up:"
# One -o per --url. curl applies output files to URLs IN ORDER, so a single
# `-o /dev/null` covers only the FIRST transfer and every later response body
# goes to stdout — where it lands in front of the timing and silently parses as
# zero. That is not a hypothetical: this script reported 0ms against a server
# deliberately holding each request for 300ms until it was fixed.
warm_args=()
for _ in $(seq "$SAMPLES"); do warm_args+=(-o /dev/null --url "$URL"); done
spin_start "timing $SAMPLES requests on one connection…"
warm_raw="$(curl -sS --max-time 300 \
	"${CURL_PROXY[@]+"${CURL_PROXY[@]}"}" \
	"${warm_args[@]}" \
	-w '%{time_total} %{http_code}\n' 2>/dev/null)"
spin_stop

# curl writes the -w line once per transfer, and %{time_total} is that transfer
# alone. Skip the first: it is the one that paid for the connection.
first=1; sum=0; n=0; max=0; refused=0
while read -r t code; do
	[ -n "${t:-}" ] || continue
	ms="$(awk -v x="$t" 'BEGIN{printf "%d", x*1000}')"
	if [ "$first" -eq 1 ]; then first=0; echo "    ${ms}ms  (first — includes the connection)"; continue; fi
	if ! counts "${code:-0}"; then
		refused=$((refused + 1)); echo "    HTTP ${code:-none} — not counted"; continue
	fi
	echo "    ${ms}ms"
	sum=$((sum + ms)); n=$((n + 1))
	[ "$ms" -gt "$max" ] && max="$ms"
done <<< "$warm_raw"

if [ "$n" -eq 0 ]; then
	echo ''
	if [ "$refused" -gt 0 ]; then
		echo "No warm sample came back with an answer from the peer ($refused were not counted)."
	else
		echo "No warm sample came back with an answer from the peer."
	fi
	echo "The route works cold but not on a reused connection, so keep-alive is being"
	echo "dropped somewhere between here and the peer. Re-run with --samples 10 or more;"
	echo "if it repeats, that is worth looking into on both boxes."
	exit 1
fi

avg=$((sum / n))
echo ''
echo "────────────────────────────────────────────────────────"
echo "warm round trip to this peer: avg ${avg}ms, worst ${max}ms  (over $n samples)"
echo ''

# ── 3. The verdict, in terms of the delivery budget ─────────────────────
#
# A message between two privacy-only users can cross THREE hidden legs:
#   sender's browser → sender's instance      1 hop
#   sender's instance → recipient's instance  1 hop   (what we just measured)
#   recipient's instance → recipient's browser 1 hop
# A user who reaches their instance over the clearnet does not pay their leg,
# so this is an ESTIMATE for the privacy-only case, and deliberately cautious.
budget_avg=$((avg * 3))
budget_max=$((max * 3))
echo "estimated delivery if all three legs are hidden:"
echo "  typical : ${budget_avg}ms"
echo "  worst   : ${budget_max}ms"
echo ''

if [ "$budget_max" -lt "$TARGET_MS" ]; then
	echo "PASS — even the slowest round trip seen leaves this inside ${TARGET_MS}ms."
	exit 0
elif [ "$budget_avg" -lt "$TARGET_MS" ]; then
	echo "MOSTLY WITHIN — typical delivery fits in ${TARGET_MS}ms; the slowest round trip seen did not."
	echo ""
	echo "That is the network, not the software. Worth trying, on THIS box:"
	case "$network" in
		tor) echo "  - a longer-lived circuit: 'MaxCircuitDirtiness 600' in torrc" ;;
		i2p) echo "  - more tunnel redundancy, so one slow tunnel is not the only one:"
		     echo "    raise the inbound/outbound tunnel quantity for this router to 3-4" ;;
	esac
	echo "  - confirm the indexer's warm-up is running (look for 'Fed. chat' and 'warm'):"
	echo "      sudo morphit-ops health"
	exit 0
else
	echo "SLOWER THAN THE TARGET — at ${avg}ms a round trip, three hidden legs come to"
	echo "about ${budget_avg}ms. Messages still arrive; they take longer than ${TARGET_MS}ms."
	echo ""
	echo "The software already takes the short path (no waiting on blocks, a kept-alive"
	echo "connection), so what remains is the network. Things to try, on THIS box:"
	case "$network" in
		tor) echo "  - see whether Tor is picking slow relays: 'grep -i circuit /var/log/tor/notices.log'"
		     echo "  - 'MaxCircuitDirtiness 600' in torrc keeps a good circuit longer"
		     echo "  - if this box is also a Tor relay, it is competing with itself" ;;
		i2p) echo "  - tunnel length: 2 hops each way is the usual latency/anonymity balance"
		     echo "  - the router's tunnel build success rate: a low rate means much of this"
		     echo "    number is rebuilds, not transit" ;;
	esac
	echo "  - and measure the reverse direction too, from the other box"
	exit 1
fi
