#!/bin/sh
# morphit-tor-timesync.sh — keep a TOR-ONLY node's clock right with no clearnet
# NTP. (v1.20.0, C13)
#
# WHY NOT NTP. NTP is UDP, and Tor carries only TCP, so NTP cannot go over Tor;
# chrony on a tor-only node therefore polled public pools straight from the
# box's home IP. Instead this reads the HTTP `Date` header of several
# independent ONION services, over the node's own Tor SocksPort (socks5h: the
# names are resolved inside Tor), and steps the clock only when they agree.
#
# WHY THESE SOURCES. Onion addresses authenticate the server, so no TLS is
# needed and no exit relay sees the request. The Blurt RPC onions in
# indexer.env are NOT used by default: they are blurtd's own webserver (port
# 8091, websocketpp), which sends no Date header. The defaults below are
# long-lived onion services of six unrelated organisations (listed with proofs
# at github.com/alecmuffett/real-world-onion-sites). Set your own in
# /etc/morphit/tor-timesync.env (MORPHIT_TOR_TIME_SOURCES, space-separated).
#
# THE RULE (so no single source can move the clock):
#   - each answer gives an offset = server Date + 0.5 s (Date is whole seconds)
#     - our clock at the middle of request-sent .. first-byte-back (curl's own
#     timings, so a slow Tor circuit setup never enters it); an answer that took
#     longer than MAX_GAP (8 s) from request to first byte is not used;
#   - at least MIN (3) sources must answer, and more than two thirds of the
#     answers must lie within AGREE (10 s) of their median; outliers are named
#     in the log and ignored;
#   - the clock is stepped only when that consensus says it is more than
#     STEP_AT (30 s) off, and never by more than MAX_STEP (2 days) — a clock
#     that far off needs a person (and Tor itself stops working well before);
#   - and never while Tor is still bootstrapping (just started): that run
#     reports tor-starting and changes nothing.
#
# Usage:  morphit-tor-timesync.sh [--check]
#   --check   measure and report only; never change the clock.
# The last line is machine-readable:
#   MORPHIT_TOR_TIME result=<in-tolerance|stepped|would-step|few-answers|disagree|too-far|tor-starting|step-failed>
#     answered=<n> agreed=<n> offset=<seconds> sources=<host,host,...>
# Exit status: 0 when a consensus was reached (whether or not the clock moved),
# 1 when it was not (nothing was changed), 2 on a usage/config error.
# POSIX sh. Runs as root from morphit-tor-timesync.service (stepping the clock
# needs CAP_SYS_TIME). Never writes anything but the clock and its log lines.
set -u

log() { printf 'morphit-tor-timesync: %s\n' "$*" >&2; }

[ -r /etc/morphit/tor-timesync.env ] && . /etc/morphit/tor-timesync.env

# Has Tor finished bootstrapping since it last started? Debian/Ubuntu run the
# daemon as tor@default (tor.service is its umbrella). Tor logs
# "Bootstrapped 100%" once; we look for it in the journal since the unit
# became active. When systemd or the journal cannot tell us, we do not block
# (the answer-gap check and the source consensus still apply).
tor_bootstrapped() {
	command -v systemctl >/dev/null 2>&1 && command -v journalctl >/dev/null 2>&1 || return 0
	for u in tor@default tor; do
		since="$(systemctl show -p ActiveEnterTimestamp --value "$u" 2>/dev/null)"
		[ -n "$since" ] && [ "$since" != "n/a" ] || continue
		journalctl -q -u "$u" --since "$since" -o cat 2>/dev/null | grep -q 'Bootstrapped 100%' && return 0
		return 1
	done
	return 0
}

CHECK_ONLY=no
case "${1:-}" in
	--check) CHECK_ONLY=yes ;;
	'') : ;;
	*) echo "usage: morphit-tor-timesync.sh [--check]" >&2; exit 2 ;;
esac

# Tor's SocksPort: explicit setting, else the indexer's own, else Tor's default.
if [ -z "${MORPHIT_TOR_SOCKS:-}" ] && [ -r "${MORPHIT_INDEXER_ENV:-/etc/morphit/indexer.env}" ]; then
	MORPHIT_TOR_SOCKS="$(sed -n 's/^[[:space:]]*MORPHIT_INDEXER_TOR_SOCKS=//p' "${MORPHIT_INDEXER_ENV:-/etc/morphit/indexer.env}" | tail -n1 | tr -d "\"' \t\r")"
fi
SOCKS="${MORPHIT_TOR_SOCKS:-127.0.0.1:9050}"
case "$SOCKS" in
	*[!0-9.:]* | '' | :* | *:) log "MORPHIT_TOR_SOCKS must be <IPv4>:<port>, got '$SOCKS'"; exit 2 ;;
esac

SOURCES="${MORPHIT_TOR_TIME_SOURCES:-http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/ \
http://jvgypgbnfyvfopg5msp6nwr2sl2fd6xmnguq35n7rfkw3yungjn2i4yd.onion/ \
http://vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion/ \
http://www.qubesosfasa4zl44o4tws22di6kepyzfeqv3tg4e3ztknltfxqrymdad.onion/ \
http://dds6qkxpwdeubwucdiaord2xgbbeyds25rbsgr73tbfpqpt4a6vjwsyd.onion/ \
http://7sk2kov2xwx6cbc32phynrifegg6pklmzs7luwcggtzrnlsolxxuyfyd.onion/}"
MIN="${MORPHIT_TOR_TIME_MIN:-3}"
AGREE="${MORPHIT_TOR_TIME_AGREE:-10}"
STEP_AT="${MORPHIT_TOR_TIME_STEP_AT:-30}"
MAX_STEP="${MORPHIT_TOR_TIME_MAX_STEP:-172800}"
TIMEOUT="${MORPHIT_TOR_TIME_TIMEOUT:-90}"
MAX_GAP="${MORPHIT_TOR_TIME_MAX_GAP:-8}"
for n in "$MIN" "$AGREE" "$STEP_AT" "$MAX_STEP" "$TIMEOUT" "$MAX_GAP"; do
	case "$n" in '' | *[!0-9]*) log "numeric settings must be whole numbers"; exit 2 ;; esac
done
[ "$MIN" -ge 3 ] || { log "MORPHIT_TOR_TIME_MIN must be at least 3"; exit 2; }
command -v curl >/dev/null 2>&1 || { log "curl is not installed"; exit 2; }

WORK="$(mktemp -d)" || exit 2
trap 'rm -rf "$WORK"' EXIT

# Ask every source at once (each over its own Tor circuit), one result file each.
i=0
seen=' '
for url in $SOURCES; do
	case "$url" in
		http://* | https://*) : ;;
		*) log "ignoring '$url' (not an http:// or https:// address)"; continue ;;
	esac
	host="$(printf '%s' "$url" | sed -e 's#^[a-z]*://##' -e 's#[/:].*$##')"
	case "$host" in '' | *[!a-z0-9.-]*) log "ignoring '$url' (not a plain host name)"; continue ;; esac
	case "$seen" in *" $host "*) continue ;; esac # one answer per host
	seen="$seen$host "
	i=$((i + 1))
	(
		t0="$(date +%s.%N)"
		# -I: headers only (into h.$i). Any status carries a Date header; -f is
		# not used. --proxy-user gives each source its own Tor circuit
		# (IsolateSOCKSAuth). -w reports, relative to t0, when the request went
		# out (time_pretransfer: the Tor circuit and the connection are already
		# up) and when the first byte of the answer came back (time_starttransfer).
		# The server wrote its Date between those two moments, so the circuit
		# setup — which can take a minute on a cold Tor — never skews the result.
		tm="$(curl -sS -I -o "$WORK/h.$i" -w '%{time_pretransfer} %{time_starttransfer}' \
			--max-time "$TIMEOUT" --socks5-hostname "$SOCKS" \
			--proxy-user "morphit-time-$i:x" -H 'Cache-Control: no-cache' "$url" 2>/dev/null)"
		# No answer at all (Tor down, circuit refused): nothing to read, and no
		# "cannot open" noise in the log for each source.
		[ -s "$WORK/h.$i" ] || exit 0
		hdr="$(tr -d '\r' <"$WORK/h.$i" | sed -n 's/^[Dd][Aa][Tt][Ee]:[[:space:]]*//p' | head -n1)"
		[ -n "$hdr" ] || exit 0
		srv="$(date -u -d "$hdr" +%s 2>/dev/null)" || exit 0
		set -- $tm
		pre="${1:-}"
		start="${2:-}"
		case "$pre$start" in '' | *[!0-9.]*) exit 0 ;; esac
		# A slow answer is an imprecise one: skip it rather than guess.
		if awk -v a="$pre" -v b="$start" -v g="$MAX_GAP" 'BEGIN { exit !((b - a) > g) }'; then
			printf '%s\n' "$host" >"$WORK/slow.$i"
			exit 0
		fi
		# offset = server time - our time when the server wrote it (the middle of
		# request-out .. answer-in); Date is whole seconds, hence + 0.5.
		printf '%s %s\n' "$(awk -v s="$srv" -v t="$t0" -v a="$pre" -v b="$start" 'BEGIN { printf "%.3f", s + 0.5 - (t + (a + b) / 2) }')" "$host" >"$WORK/r.$i"
	) &
done
wait

cat "$WORK"/r.* 2>/dev/null | sort -n >"$WORK/all"
if ls "$WORK"/slow.* >/dev/null 2>&1; then
	log "not used (answered too slowly to time precisely, over ${MAX_GAP} s): $(cat "$WORK"/slow.* | paste -sd, -)"
fi
answered="$(wc -l <"$WORK/all" | tr -d ' ')"
hosts_all="$(awk '{print $2}' "$WORK/all" | paste -sd, -)"
report() { echo "MORPHIT_TOR_TIME result=$1 answered=$answered agreed=${agreed:-0} offset=${offset:-0} sources=${hosts_ok:-$hosts_all}"; }

if [ "$answered" -lt "$MIN" ]; then
	log "only $answered of $i time sources answered over Tor (need $MIN); the clock was not changed."
	report few-answers
	exit 1
fi

# Median of all answers, then the ones within AGREE of it, then their median.
awk -v agree="$AGREE" -v okfile="$WORK/ok" '
	{ o[NR] = $1; h[NR] = $2 }
	END {
		n = NR
		med = (n % 2) ? o[(n + 1) / 2] : (o[n / 2] + o[n / 2 + 1]) / 2
		k = 0; hs = ""
		for (j = 1; j <= n; j++) {
			d = o[j] - med; if (d < 0) d = -d
			if (d <= agree) { k++; a[k] = o[j]; hs = hs (hs == "" ? "" : ",") h[j] }
			else printf "morphit-tor-timesync: ignoring %s: it is %.1f s away from the others\n", h[j], d > "/dev/stderr"
		}
		m = (k % 2) ? a[(k + 1) / 2] : (a[k / 2] + a[k / 2 + 1]) / 2
		print hs > okfile
		printf "%d %.1f\n", k, (k > 0 ? m : 0)
	}' "$WORK/all" >"$WORK/stats"
read -r agreed offset <"$WORK/stats"
hosts_ok="$(cat "$WORK/ok" 2>/dev/null)"

# More than two thirds must agree (3 of 3, 3 of 4, 4 of 5, 5 of 6 …).
if [ "$agreed" -lt "$MIN" ] || [ $((agreed * 3)) -le $((answered * 2)) ]; then
	log "the $answered time sources that answered do not agree closely enough; the clock was not changed."
	report disagree
	exit 1
fi

abs="$(awk -v o="$offset" 'BEGIN { if (o < 0) o = -o; printf "%d", o + 0.5 }')"
if [ "$abs" -le "$STEP_AT" ]; then
	log "clock is right to within ${abs} s ($agreed of $answered sources agree: $hosts_ok)."
	report in-tolerance
	exit 0
fi
if [ "$abs" -gt "$MAX_STEP" ]; then
	log "the sources agree the clock is ${abs} s off — more than this job will correct on its own. Set it by hand (on this node: sudo date -u -s '<correct UTC time>')."
	report too-far
	exit 1
fi
if ! tor_bootstrapped; then
	log "the clock looks ${offset} s off, but Tor has not finished starting up (bootstrap below 100%), so it is not changed on this run; the next run decides."
	report tor-starting
	exit 1
fi
if [ "$CHECK_ONLY" = yes ]; then
	log "clock is ${offset} s off ($agreed of $answered sources agree); --check, so not changing it."
	report would-step
	exit 0
fi
step="$(awk -v o="$offset" 'BEGIN { printf "%d", (o < 0 ? o - 0.5 : o + 0.5) }')"
if date -u -s "@$(($(date +%s) + step))" >/dev/null 2>&1; then
	log "stepped the clock by ${step} s ($agreed of $answered onion sources agree: $hosts_ok)."
	# Keep the hardware clock in step too, when there is one (best effort).
	command -v hwclock >/dev/null 2>&1 && hwclock --systohc --utc >/dev/null 2>&1 || true
	report stepped
	exit 0
fi
log "could not set the clock (needs root / CAP_SYS_TIME)."
report step-failed
exit 1
