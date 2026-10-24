#!/usr/bin/env bash
#
# scripts/canary/generate.sh
#
# Generates a fresh, PGP-signed canary.txt for this Morphit
# instance.  Run weekly via cron.
#
# Output: apps/web/static/canary.txt
#
# Inputs (all required, validated up front):
#   $MORPHIT_CANARY_PGP_KEY_ID     — fingerprint of the signing
#                                    key (must be in operator's
#                                    GPG keyring, with a passphrase
#                                    stored in the agent or
#                                    inputtable).
#   $MORPHIT_CANARY_OPERATOR_NAME  — human-readable operator name
#                                    (e.g. "morphit.io").
#   $MORPHIT_CANARY_INSTANCE_ORIGIN — e.g. "https://morphit.io".
#   $MORPHIT_CANARY_OPERATOR_ACCOUNT — Blurt account name of the
#                                      operator (must match what's
#                                      in morphit_operator_register_v1).
#   $MORPHIT_CANARY_BLURT_RPC      — OPTIONAL. Pin ONE Blurt RPC URL for the
#                                    chain-head fetch. Left unset (the
#                                    default), the fetch fails over across the
#                                    canonical DEFAULT_BLURT_RPC_ENDPOINTS
#                                    rotator list, so a single dead node cannot
#                                    stall the canary.
#   $MORPHIT_CANARY_BTC_EXPLORER   — OPTIONAL. Pin ONE Bitcoin Esplora API base
#                                    (e.g. your own bitcoind/Esplora) for the
#                                    BTC freshness proof — that one only (no
#                                    other explorer, hidden or not, is then
#                                    asked). Left unset, the fetch fails over
#                                    across the canonical clearnet list
#                                    (DEFAULT_CANARY_BTC_SOURCES), then the
#                                    onion and I2P explorers through Tor / i2pd
#                                    (two must agree); if EVERY explorer is
#                                    unreachable the BTC head degrades
#                                    gracefully (the Blurt head is the primary
#                                    proof) rather than aborting.
#   $MORPHIT_CANARY_NEWS_RSS       — RSS feed URL for news entropy
#                                    (default: https://cointelegraph.com/rss,
#                                    operator should pick a
#                                    high-frequency public feed
#                                    they trust).
#   $MORPHIT_CANARY_ONION_NEWS_RSS — OPTIONAL (v1.21.15). Space-separated onion
#                                    RSS feeds asked through Tor when every
#                                    clearnet feed fails (first on a tor-only
#                                    node). Default: the BBC's onion feed.
#   $MORPHIT_CANARY_ONION_NEWS_WAIT — OPTIONAL. Seconds the onion feeds get
#                                    (1-600, default 60).
#   $MORPHIT_CANARY_TOR_ONLY       — OPTIONAL. 1/0; unset, derived from a
#                                    .onion / .i2p instance origin.
#   $MORPHIT_CANARY_TOR_SOCKS      — OPTIONAL. Tor's SocksPort for every hidden
#                                    source (default 127.0.0.1:9050).
#   $MORPHIT_CANARY_I2P_HTTP_PROXY — OPTIONAL (v1.21.15). i2pd's HTTP proxy for
#                                    the I2P sources (default 127.0.0.1:4444).
#
# Cron suggestion (weekly, Sundays at 03:14 UTC):
#   14 3 * * 0  cd /opt/morphit && bash scripts/canary/generate.sh \
#               >> /var/log/morphit/canary.log 2>&1
#
# Why a shell script rather than a Node program:
#   - Few dependencies (gpg, curl, date are present on every operator
#     host; node — for the shared RPC-rotator helper — is present on any
#     Morphit host, since the indexer and relay run on it).
#   - The signing key never enters JavaScript memory; gpg owns it.
#   - Easier for an operator to audit every line.

set -euo pipefail

# ─── Configuration & validation ──────────────────────────────────

required() {
	local name="$1"
	local value="${!name:-}"
	if [ -z "$value" ]; then
		echo "canary: required env var $name is unset" >&2
		exit 1
	fi
}

required MORPHIT_CANARY_PGP_KEY_ID
required MORPHIT_CANARY_OPERATOR_NAME
required MORPHIT_CANARY_INSTANCE_ORIGIN
required MORPHIT_CANARY_OPERATOR_ACCOUNT

NEWS_RSS="${MORPHIT_CANARY_NEWS_RSS:-https://cointelegraph.com/rss}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# The template is a build input, not a page: it lives next to this script.
# (Its old place, apps/web/static/, served it publicly; still read from there
# when a tree has not moved it yet.)
TEMPLATE="$REPO_ROOT/scripts/canary/canary.txt.template"
[ -f "$TEMPLATE" ] || TEMPLATE="$REPO_ROOT/apps/web/static/canary.txt.template"
# the signed canary is written to MORPHIT_CANARY_OUT when set, else the
# legacy in-tree static/ path.  setup.sh points this at a USER-WRITABLE staging
# dir (~/.morphit/canary) so the refresh never needs to write the root-owned
# source tree; the template above is only READ (readable even when root-owned).
# The default is unchanged, so an existing generated refresh script that doesn't
# set MORPHIT_CANARY_OUT keeps its old behaviour.
OUT="${MORPHIT_CANARY_OUT:-$REPO_ROOT/apps/web/static/canary.txt}"
mkdir -p "$(dirname "$OUT")" 2>/dev/null || true

if [ ! -f "$TEMPLATE" ]; then
	echo "canary: template missing at $TEMPLATE" >&2
	exit 1
fi

# Tools — fail loud if any is missing. (jq is gone: the Blurt head now
# comes back parsed from the rotator helper; BTC + news stay plain curl.)
for tool in gpg curl date node; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "canary: required tool '$tool' not found in PATH" >&2
		exit 1
	fi
done

# The Blurt chain-head fetch runs through the shared RPC rotator helper
# (scripts/canary/fetch-blurt-head.ts), which needs tsx from the repo's
# installed dependencies.
RUN_TSX="$REPO_ROOT/node_modules/.bin/tsx"
if [ ! -x "$RUN_TSX" ]; then
	echo "canary: tsx not found at $RUN_TSX — run 'npm ci' in $REPO_ROOT first" >&2
	exit 1
fi

# ─── Tor-only privacy: route freshness-proof fetches over Tor ─────
# On a tor-only node the outbound freshness-proof fetches (Blurt head, BTC head,
# news) MUST go through the co-located Tor SOCKS proxy — a direct clearnet fetch
# would reveal the node's real IP to those endpoints, the exact exposure tor-only
# exists to avoid (a later change closed the equivalent leak for the indexer). We reach the
# SAME clearnet freshness sources via a Tor exit, so the IP is hidden and proof
# diversity is preserved. Detection: explicit MORPHIT_CANARY_TOR_ONLY wins, else
# auto-derive from a hidden-service instance origin (.onion / .b32.i2p). The Node
# helpers read MORPHIT_CANARY_TOR_ONLY + MORPHIT_CANARY_TOR_SOCKS (exported below)
# and pin undici's global dispatcher to the proxy; the news curl gets --proxy.
# FAIL-SAFE: on tor-only every fetch is pinned to the proxy with NO clearnet
# fallback — a down proxy degrades/blocks the canary, it can never leak.
_origin_host="$(printf '%s' "$MORPHIT_CANARY_INSTANCE_ORIGIN" \
	| sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#[:/].*$##' | tr 'A-Z' 'a-z')"
case "${MORPHIT_CANARY_TOR_ONLY:-auto}" in
	1 | true | yes | on) CANARY_TOR_ONLY=1 ;;
	0 | false | no | off) CANARY_TOR_ONLY=0 ;;
	*)
		case "$_origin_host" in
			*.onion | *.i2p) CANARY_TOR_ONLY=1 ;;
			*) CANARY_TOR_ONLY=0 ;;
		esac
		;;
esac
CANARY_TOR_SOCKS="${MORPHIT_CANARY_TOR_SOCKS:-127.0.0.1:9050}"
export MORPHIT_CANARY_TOR_ONLY="$CANARY_TOR_ONLY"
export MORPHIT_CANARY_TOR_SOCKS="$CANARY_TOR_SOCKS"
# curl proxy args — empty on clearnet so behavior is byte-identical there. On
# tor-only we use socks5h:// so DNS is resolved proxy-side (a plain socks5://
# would leak the DNS lookup of the news host off the box).
CURL_PROXY_ARGS=()
if [ "$CANARY_TOR_ONLY" = 1 ]; then
	CURL_PROXY_ARGS=(--proxy "socks5h://$CANARY_TOR_SOCKS")
	echo "canary: tor-only — routing freshness-proof fetches over Tor SOCKS $CANARY_TOR_SOCKS" >&2
	# On a tor-only node the DEFAULT clearnet Blurt RPCs fail when pushed through a
	# Tor exit (their WAFs answer HTTP 400/403). If the operator hasn't pinned a
	# node, auto-pick ONE of THIS node's own hidden .onion Blurt RPCs so the head
	# fetch goes over Tor natively. (MORPHIT_CANARY_BLURT_RPC is a single URL.)
	if [ -z "${MORPHIT_CANARY_BLURT_RPC:-}" ]; then
		_hidden="${MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS:-}"
		# `|| true` on BOTH greps is load-bearing under `set -euo pipefail`: grep
		# exits 1 when it matches nothing, pipefail propagates that through the rest
		# of the pipeline, and a command-substitution assignment returning non-zero
		# aborts the script. An indexer.env without this key — or a node with no
		# .onion RPC among its endpoints — would kill the WEEKLY CANARY REFRESH
		# outright, letting the canary go stale on its own timer with no error an
		# operator would ever see. (Same defect that made setup.sh die silently right
		# after the operator-name prompt.)
		if [ -z "$_hidden" ] && [ -r /etc/morphit/indexer.env ]; then
			_hidden="$(grep -E '^MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=' /etc/morphit/indexer.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')" || true
		fi
		# ALL the hidden .onion RPCs, comma-joined — NOT just the first (review D12).
		# resolveCanaryNodes honours a comma-separated override PREFERRED-FIRST and
		# fails over across every entry, so one down onion no longer stalls the
		# weekly canary refresh (the old `head -1` pinned exactly one, exclusively).
		_onions="$(printf '%s' "${_hidden:-}" | tr ',' '\n' | grep -i '\.onion' | tr -d '[:space:]' | grep -v '^$' | paste -sd, -)" || true
		: "${_onions:=}"
		if [ -n "$_onions" ]; then
			export MORPHIT_CANARY_BLURT_RPC="$_onions"
			_onion_count="$(printf '%s' "$_onions" | tr ',' '\n' | grep -c .)" || true
			echo "canary: tor-only — auto-selected $_onion_count hidden Blurt RPC(s) for the chain-head fetch (fails over across all)" >&2
		else
			echo "canary: tor-only but no hidden .onion Blurt RPC found — the head fetch may fail over Tor. Set MORPHIT_CANARY_BLURT_RPC to a hidden node." >&2
		fi
	fi
fi

# ─── Freshness proof: Blurt chain head ───────────────────────────
# Fetched through the shared RPC rotator (scripts/canary/fetch-blurt-head.ts):
# it hops across the canonical DEFAULT_BLURT_RPC_ENDPOINTS list until a node
# answers, so a single witness's dead TLS cert (a 526, say) no longer stalls
# the whole canary. Set MORPHIT_CANARY_BLURT_RPC to pin one node on purpose.
# On success the helper prints ONE tab-separated line: <height> <hash> <time>.
BLURT_HEAD_LINE="$("$RUN_TSX" "$REPO_ROOT/scripts/canary/fetch-blurt-head.ts")" || {
	echo "canary: could not fetch Blurt chain head from any endpoint" >&2
	exit 1
}
BLURT_HEAD_HEIGHT="$(printf '%s' "$BLURT_HEAD_LINE" | cut -f1)"
BLURT_HEAD_HASH="$(printf '%s' "$BLURT_HEAD_LINE" | cut -f2)"
BLURT_HEAD_TIMESTAMP="$(printf '%s' "$BLURT_HEAD_LINE" | cut -f3)Z"

# The helper checks these already; checked again here because they go into a
# signed statement (v1.21.15): a height in digits, a 40-hex block id whose
# first 8 hex digits are that height (how Blurt builds a block id), and a chain
# time in its own format.
case "$BLURT_HEAD_HEIGHT" in
	'' | *[!0-9]*)
		echo "canary: Blurt RPC returned no usable head_block_number" >&2
		exit 1
		;;
esac
if ! printf '%s' "$BLURT_HEAD_HASH" | grep -Eq '^[0-9a-f]{40}$' ||
	[ "$((16#${BLURT_HEAD_HASH:0:8}))" != "$((10#$BLURT_HEAD_HEIGHT))" ]; then
	echo "canary: Blurt RPC returned a block id that does not belong to block $BLURT_HEAD_HEIGHT" >&2
	exit 1
fi
if ! printf '%s' "$BLURT_HEAD_TIMESTAMP" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
	echo "canary: Blurt RPC returned no usable chain time" >&2
	exit 1
fi

# ─── Freshness proof: Bitcoin chain head (SECONDARY) ─────────────
# Fetched through the shared explorer rotator (scripts/canary/fetch-btc-head.ts):
# it hops across the canonical clearnet list (DEFAULT_CANARY_BTC_SOURCES)
# until one answers, so a single dead or region-blocked explorer no longer
# stalls the canary — the same fix the Blurt head got. Pin one base
# with MORPHIT_CANARY_BTC_EXPLORER (e.g. your own bitcoind/Esplora).
# v1.21.15: the onion and I2P explorers too, through Tor / i2pd only — first on
# a Tor-only node, and on a clearnet node when every clearnet explorer failed;
# all at once, and the first head two of them agree on is used.
#
# The BTC head is a SECONDARY freshness proof — the Blurt head above already
# proves the canary is fresh — so if EVERY explorer is unreachable we DEGRADE
# (record it as unavailable) instead of aborting. The trailing `|| true` keeps
# a total explorer outage from tripping `set -e`. On success the helper prints
# ONE tab-separated line: <height>\t<hash>.
# before this, the canary pinned blockstream.info alone with a fatal
# abort, and a single timeout there killed the whole weekly refresh.
BTC_HEAD_LINE="$("$RUN_TSX" "$REPO_ROOT/scripts/canary/fetch-btc-head.ts" || true)"
BTC_HEAD_HEIGHT="$(printf '%s' "$BTC_HEAD_LINE" | cut -f1)"
BTC_HEAD_HASH="$(printf '%s' "$BTC_HEAD_LINE" | cut -f2)"
# Checked again before it is signed (v1.21.15): digits, and a 64-hex hash.
if printf '%s' "$BTC_HEAD_HEIGHT" | grep -Eq '^[0-9]+$' &&
	printf '%s' "$BTC_HEAD_HASH" | grep -Eq '^[0-9a-f]{64}$'; then
	:
else
	echo "canary: all Bitcoin explorers unreachable — degrading the BTC head (the Blurt chain head above is the primary freshness proof)" >&2
	BTC_HEAD_HEIGHT="(unavailable at signing time — every configured Bitcoin explorer was unreachable; the Blurt chain head above is the primary freshness proof)"
	BTC_HEAD_HASH="(unavailable)"
fi

# ─── Freshness proof: news entropy ───────────────────────────────

# Try the operator's configured feed first, then reliable public
# fallbacks. A single hard-coded source is a single point of failure:
# Cloudflare-fronted feeds (e.g. Cointelegraph) intermittently 403 a
# plain curl, and under `set -e` that would abort the whole canary even
# though the two chain heads above already prove freshness. So every
# fetch is best-effort (never fatal), we stop at the first feed that
# yields a headline, and record which feed actually won.
NEWS_UA='Mozilla/5.0 (X11; Linux x86_64) Morphit-Canary'
NEWS_HEADLINE=''
NEWS_WON_SRC=''
# The operator's configured feed first, then five independent, high-frequency
# public feeds across different organisations and countries: BBC, The
# Guardian, NPR, Al Jazeera, and the New York Times. Spread this wide so a
# single provider outage or a Cloudflare 403 cannot drop the news line.
# One feed's first headline (empty when it has none). Extract the first
# <title> after <item> - robust against varying RSS layouts. Strip CDATA
# wrappers and HTML entities. Trailing `|| true` lets a feed with no
# <item>/<title> match fall through, not abort.
news_headline_of() {
	news_clean "$(echo "$1" \
		| awk 'BEGIN{RS="<item>"} NR==2{print}' \
		| grep -o '<title>[^<]*</title>' \
		| head -1 \
		| sed -e 's|<title>||' -e 's|</title>||' \
		      -e 's|<!\[CDATA\[||g' -e 's|\]\]>||g' \
		      -e 's|&amp;|\&|g' -e 's|&lt;|<|g' -e 's|&gt;|>|g' -e 's|&quot;|"|g' \
		      -e 's|&apos;|'\''|g' || true)"
}

# A headline is text from someone else's server going into a SIGNED file
# (v1.21.15): keep it to one line of plain printable ASCII (the canary is pure
# ASCII; accented letters and curly quotes are transliterated where iconv can),
# no backslash, braces made parentheses (so it can never read as a
# {{PLACEHOLDER}}), spaces collapsed, at most 200 characters. One that holds
# "-----" (it could read as a PGP armor line) is not used at all: empty.
news_clean() {
	local h
	h="$(printf '%s' "$1" | tr '\t\r\n' '   ')"
	if command -v iconv >/dev/null 2>&1; then
		# -c leaves out what it cannot convert (and then exits 1: not an error).
		local t
		t="$(printf '%s' "$h" | LC_ALL=C.UTF-8 iconv -c -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null)" || true
		if [ -n "$t" ]; then h="$t"; fi
	fi
	h="$(printf '%s' "$h" | LC_ALL=C tr -cd '\040-\176' | LC_ALL=C tr -d '\\' | LC_ALL=C tr '{}' '()' \
		| sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//')"
	h="${h:0:200}"
	case "$h" in *-----*) h='' ;; esac
	printf '%s' "$h"
}

# The operator's feed and the clearnet ones, in order, first headline wins.
news_from_clearnet_feeds() {
	for feed in "$NEWS_RSS" \
		"https://feeds.bbci.co.uk/news/rss.xml" \
		"https://www.theguardian.com/world/rss" \
		"https://feeds.npr.org/1001/rss.xml" \
		"https://www.aljazeera.com/xml/rss/all.xml" \
		"https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"; do
		echo "canary: fetching news headline from $feed..." >&2
		# `|| true` keeps a failed/blocked fetch from tripping `set -e`. On tor-only
		# CURL_PROXY_ARGS pins the fetch to Tor SOCKS (socks5h → proxy-side DNS); on
		# clearnet it is empty, so this line is byte-identical to before.
		NEWS_XML="$(curl -fsSL "${CURL_PROXY_ARGS[@]}" --max-time 15 -A "$NEWS_UA" "$feed" || true)"
		[ -n "$NEWS_XML" ] || continue
		NEWS_HEADLINE="$(news_headline_of "$NEWS_XML")"
		[ -n "$NEWS_HEADLINE" ] || continue
		NEWS_WON_SRC="$feed"
		return 0
	done
	return 1
}

# v1.21.15: the same newsrooms' ONION feeds, asked ALL AT ONCE through the
# box's Tor SOCKS proxy (socks5h: the name is resolved inside Tor; one circuit
# each), the fastest one with a headline wins. Tried FIRST on a tor-only node
# and, on a clearnet node, only when every clearnet feed above failed — the
# owner's rule: when clearnet does not answer, use the hidden sources. Never
# fetched without the proxy. MORPHIT_CANARY_ONION_NEWS_RSS (space-separated)
# replaces the list.
# Default: the BBC's onion feed — the one of five newsroom onion feeds that
# loaded in Tor Browser when the maintainer checked on 2026-10-23 (The
# Guardian's and the New York Times' timed out, ProPublica's onion was not
# found).
ONION_NEWS_RSS="${MORPHIT_CANARY_ONION_NEWS_RSS:-https://www.bbcnewsd73hkzno2ini43t4gblxvycyac5aw4gnv7t2rccijh7745uqd.onion/news/rss.xml}"
# How long the onion feeds get, in seconds (MORPHIT_CANARY_ONION_NEWS_WAIT,
# whole seconds 1-600; default 60 — an onion rendezvous alone can take tens of
# seconds). After it, every fetch still running is stopped.
ONION_NEWS_WAIT="${MORPHIT_CANARY_ONION_NEWS_WAIT:-60}"
case "$ONION_NEWS_WAIT" in
	'' | *[!0-9]* | 0*) ONION_NEWS_WAIT=60 ;;
esac
[ "$ONION_NEWS_WAIT" -le 600 ] || ONION_NEWS_WAIT=600
news_from_onion_feeds() {
	_dir="$(mktemp -d)"
	_n=0
	for feed in $ONION_NEWS_RSS; do
		# The HOST must be an .onion (not just the path: https://x.example/a.onion/).
		_host="$(printf '%s' "$feed" | sed -n 's#^https\{0,1\}://\([^/:?]*\).*$#\1#p' | tr 'A-Z' 'a-z')"
		case "$_host" in
			*.onion) : ;;
			*) echo "canary: ignoring onion news feed '$feed' (not an .onion address)" >&2; continue ;;
		esac
		_n=$((_n + 1))
		echo "canary: fetching news headline from $feed over Tor..." >&2
		(
			# Stopped once another feed has won: the TERM reaches curl too, and
			# this subshell waits for it, so the stopped curl is reaped here —
			# not left as a zombie for whatever adopts it (a container's PID 1
			# often never reaps; v1.21.15).
			_curl=''
			trap 'if [ -n "$_curl" ]; then kill "$_curl" 2>/dev/null; wait "$_curl" 2>/dev/null; fi; exit 0' TERM
			curl -fsSL --socks5-hostname "$CANARY_TOR_SOCKS" --proxy-user "morphit-news-$_n:x" \
				--max-time "$ONION_NEWS_WAIT" -A "$NEWS_UA" "$feed" >"$_dir/$_n.xml" 2>/dev/null &
			_curl=$!
			wait "$_curl" || true
			printf '%s\n' "$feed" >"$_dir/$_n.src"
			: >"$_dir/$_n.done"
		) &
	done
	_left=$((ONION_NEWS_WAIT * 10)) # in 0.1 s steps
	_seen=' '
	while [ "$_left" -gt 0 ]; do
		# Counted BEFORE the scan: a feed that finishes during the scan is read
		# on the next pass, never skipped by the "all finished" exit below.
		_finished="$(find "$_dir" -name '*.done' | wc -l)"
		for _d in $(ls -tr "$_dir"/*.done 2>/dev/null); do
			_k="$(basename "$_d" .done)"
			case "$_seen" in *" $_k "*) continue ;; esac
			_seen="$_seen$_k "
			_h="$(news_headline_of "$(cat "$_dir/$_k.xml" 2>/dev/null)")"
			if [ -n "$_h" ]; then
				NEWS_HEADLINE="$_h"
				NEWS_WON_SRC="$(cat "$_dir/$_k.src")"
				kill $(jobs -p) 2>/dev/null || true
				# Wait for the stopped fetches to end, so each is reaped here, not left
				# as a zombie for whatever adopts it once this script exits.
				wait 2>/dev/null || true
				rm -rf "$_dir"
				return 0
			fi
		done
		[ "$_finished" -ge "$_n" ] && break
		sleep 0.1
		_left=$((_left - 1))
	done
	kill $(jobs -p) 2>/dev/null || true
	wait 2>/dev/null || true
	rm -rf "$_dir"
	return 1
}

if [ "$CANARY_TOR_ONLY" = 1 ]; then
	news_from_onion_feeds || news_from_clearnet_feeds || true
else
	news_from_clearnet_feeds || news_from_onion_feeds || true
fi

if [ -n "$NEWS_WON_SRC" ]; then
	# Record the feed that actually produced the headline (emitted below
	# as NEWS_SOURCE in the signed canary).
	NEWS_RSS="$NEWS_WON_SRC"
else
	# Every feed failed or yielded nothing - do NOT abort. The Blurt and
	# Bitcoin chain heads above are the primary, sufficient freshness
	# proof; this news line is only supplementary entropy.
	NEWS_HEADLINE="(no news headline available; see chain heads above for freshness)"
fi

# ─── Compose ─────────────────────────────────────────────────────

# The maintainer's sitewide date/time standard: day-first full month name, then a
# 24-hour UTC clock with seconds — e.g. "8 July, 2026 @ 23:45:18 UTC".
# A Zulu ISO stamp ("2026-07-08T23:45:18Z") is precise but reads as
# machine output to a human trying to judge whether a warrant canary is
# fresh, which is the ONE thing this file exists to communicate.
#
# LC_ALL=C pins English month names (the canary is an English-language
# legal declaration) AND keeps `date` from emitting locale-specific
# multibyte characters into a file we deliberately hold to pure ASCII —
# a warrant canary must survive being read in any viewer, with any
# charset guess, without a single mojibake byte.
#
# `scripts/canary/verify.ts` parses BOTH this format and the legacy ISO
# form, so canaries signed before this change still verify.
canary_stamp() {
	# $1 = a `date`-parseable instant, or empty for "now".
	if [ -n "${1:-}" ]; then
		LC_ALL=C date -u -d "$1" +'%-d %B, %Y @ %H:%M:%S UTC'
	else
		LC_ALL=C date -u +'%-d %B, %Y @ %H:%M:%S UTC'
	fi
}

GENERATED_AT_ISO="$(canary_stamp)"
# Valid through: 14 days from now.  This is the silent-canary
# threshold — readers should treat the canary as untrusted past
# this point.
VALID_THROUGH_ISO="$(canary_stamp '+14 days')"
NEWS_FETCHED_AT="$GENERATED_AT_ISO"
# The Blurt head timestamp arrives from the chain as ISO/Zulu; render it
# in the same human format.  Fall back to the raw value if it doesn't
# parse (a malformed RPC response must not abort canary generation).
if [ -n "${BLURT_HEAD_TIMESTAMP:-}" ]; then
	BLURT_HEAD_TIMESTAMP="$(canary_stamp "$BLURT_HEAD_TIMESTAMP" 2>/dev/null || printf '%s' "$BLURT_HEAD_TIMESTAMP")"
fi

# Build the unsigned text with all fields filled.  Use a temp file
# so the gpg input is byte-stable.
UNSIGNED="$(mktemp -t morphit-canary-XXXXXX.txt)"
trap 'rm -f "$UNSIGNED"' EXIT

# Read template, substitute placeholders.  Every value reaches awk through
# its environment (ENVIRON) and is put in place with index/substr: a literal
# copy. (v1.21.15: `-v` turned a backslash in a value into an escape, and
# gsub() turned an `&` into the matched placeholder — a "Q&A" headline came out
# as "Q{{NEWS_HEADLINE}}A", which verify.ts then rejects.)
C_OPERATOR_NAME="$MORPHIT_CANARY_OPERATOR_NAME" \
C_INSTANCE_ORIGIN="$MORPHIT_CANARY_INSTANCE_ORIGIN" \
C_GENERATED_AT_ISO="$GENERATED_AT_ISO" \
C_VALID_THROUGH_ISO="$VALID_THROUGH_ISO" \
C_OPERATOR_ACCOUNT="$MORPHIT_CANARY_OPERATOR_ACCOUNT" \
C_BLURT_HEAD_HEIGHT="$BLURT_HEAD_HEIGHT" \
C_BLURT_HEAD_HASH="$BLURT_HEAD_HASH" \
C_BLURT_HEAD_TIMESTAMP="$BLURT_HEAD_TIMESTAMP" \
C_BTC_HEAD_HEIGHT="$BTC_HEAD_HEIGHT" \
C_BTC_HEAD_HASH="$BTC_HEAD_HASH" \
C_NEWS_HEADLINE="$NEWS_HEADLINE" \
C_NEWS_SOURCE="$NEWS_RSS" \
C_NEWS_FETCHED_AT="$NEWS_FETCHED_AT" \
awk '
	# Replace every {{NAME}} in the line with ENVIRON["C_NAME"], literally.
	function put(name,    ph, val, i, out) {
		ph = "{{" name "}}"
		val = ENVIRON["C_" name]
		out = ""
		while ((i = index(line, ph)) > 0) {
			out = out substr(line, 1, i - 1) val
			line = substr(line, i + length(ph))
		}
		line = out line
	}
	{
		line = $0
		put("OPERATOR_NAME")
		put("INSTANCE_ORIGIN")
		put("GENERATED_AT_ISO")
		put("VALID_THROUGH_ISO")
		put("OPERATOR_ACCOUNT")
		put("BLURT_HEAD_HEIGHT")
		put("BLURT_HEAD_HASH")
		put("BLURT_HEAD_TIMESTAMP")
		put("BTC_HEAD_HEIGHT")
		put("BTC_HEAD_HASH")
		put("NEWS_HEADLINE")
		put("NEWS_SOURCE")
		put("NEWS_FETCHED_AT")
		print line
	}' "$TEMPLATE" > "$UNSIGNED"

# Drop everything from the BEGIN PGP SIGNATURE block onward — gpg
# will append its own signature block to the cleartext.
# Anchored: only the template's own armor line (a whole line), never text in
# a value.
sed -i '/^-----BEGIN PGP SIGNATURE-----$/,$d' "$UNSIGNED"

# ─── Sign ────────────────────────────────────────────────────────

echo "canary: signing with key $MORPHIT_CANARY_PGP_KEY_ID..." >&2
gpg --batch --yes \
	--local-user "$MORPHIT_CANARY_PGP_KEY_ID" \
	--clearsign \
	--digest-algo SHA512 \
	--output "$OUT" \
	"$UNSIGNED"

echo "canary: wrote $OUT" >&2
echo "canary: generated_at=$GENERATED_AT_ISO valid_through=$VALID_THROUGH_ISO" >&2
echo "canary: blurt_head=$BLURT_HEAD_HEIGHT btc_head=$BTC_HEAD_HEIGHT" >&2
