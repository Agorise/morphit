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
#                                    BTC freshness proof. Left unset, the fetch
#                                    fails over across the canonical
#                                    DEFAULT_BTC_EXPLORER_APIS list; if EVERY
#                                    explorer is unreachable the BTC head
#                                    degrades gracefully (the Blurt head is the
#                                    primary proof) rather than aborting.
#   $MORPHIT_CANARY_NEWS_RSS       — RSS feed URL for news entropy
#                                    (default: https://cointelegraph.com/rss,
#                                    operator should pick a
#                                    high-frequency public feed
#                                    they trust).
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
TEMPLATE="$REPO_ROOT/apps/web/static/canary.txt.template"
# cp763 — the signed canary is written to MORPHIT_CANARY_OUT when set, else the
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

# ─── Tor-only privacy: route freshness-proof fetches over Tor (cp761) ─────
# On a tor-only node the outbound freshness-proof fetches (Blurt head, BTC head,
# news) MUST go through the co-located Tor SOCKS proxy — a direct clearnet fetch
# would reveal the node's real IP to those endpoints, the exact exposure tor-only
# exists to avoid (cp755 closed the equivalent leak for the indexer). We reach the
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
		[ -z "$_hidden" ] && [ -r /etc/morphit/indexer.env ] && \
			_hidden="$(grep -E '^MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=' /etc/morphit/indexer.env | head -1 | cut -d= -f2- | tr -d '"')"
		_onion="$(printf '%s' "$_hidden" | tr ',' '\n' | grep -i '\.onion' | head -1 | tr -d '[:space:]')"
		if [ -n "$_onion" ]; then
			export MORPHIT_CANARY_BLURT_RPC="$_onion"
			echo "canary: tor-only — auto-selected hidden Blurt RPC $_onion for the chain-head fetch" >&2
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

if [ -z "$BLURT_HEAD_HEIGHT" ] || [ "$BLURT_HEAD_HEIGHT" = "null" ]; then
	echo "canary: Blurt RPC returned no head_block_number" >&2
	exit 1
fi

# ─── Freshness proof: Bitcoin chain head (SECONDARY) ─────────────
# Fetched through the shared explorer rotator (scripts/canary/fetch-btc-head.ts):
# it hops across the canonical DEFAULT_BTC_EXPLORER_APIS list (Esplora bases)
# until one answers, so a single dead or region-blocked explorer no longer
# stalls the canary — the same fix the Blurt head got in cp451. Pin one base
# with MORPHIT_CANARY_BTC_EXPLORER (e.g. your own bitcoind/Esplora).
#
# The BTC head is a SECONDARY freshness proof — the Blurt head above already
# proves the canary is fresh — so if EVERY explorer is unreachable we DEGRADE
# (record it as unavailable) instead of aborting. The trailing `|| true` keeps
# a total explorer outage from tripping `set -e`. On success the helper prints
# ONE tab-separated line: <height>\t<hash>.
# cp613: before this, the canary pinned blockstream.info alone with a fatal
# abort, and a single timeout there killed the whole weekly refresh.
BTC_HEAD_LINE="$("$RUN_TSX" "$REPO_ROOT/scripts/canary/fetch-btc-head.ts" || true)"
if [ -n "$BTC_HEAD_LINE" ]; then
	BTC_HEAD_HEIGHT="$(printf '%s' "$BTC_HEAD_LINE" | cut -f1)"
	BTC_HEAD_HASH="$(printf '%s' "$BTC_HEAD_LINE" | cut -f2)"
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
# public feeds across different organisations and countries (cp614): BBC, The
# Guardian, NPR, Al Jazeera, and the New York Times. Spread this wide so a
# single provider outage or a Cloudflare 403 cannot drop the news line.
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
	# Extract the first <title> after <item> - robust against varying RSS
	# layouts. Strip CDATA wrappers and HTML entities. Trailing `|| true`
	# lets a feed with no <item>/<title> match fall through, not abort.
	NEWS_HEADLINE="$(echo "$NEWS_XML" \
		| awk 'BEGIN{RS="<item>"} NR==2{print}' \
		| grep -o '<title>[^<]*</title>' \
		| head -1 \
		| sed -e 's|<title>||' -e 's|</title>||' \
		      -e 's|<!\[CDATA\[||g' -e 's|\]\]>||g' \
		      -e 's|&amp;|\&|g' -e 's|&lt;|<|g' -e 's|&gt;|>|g' -e 's|&quot;|"|g' \
		      -e 's|&apos;|'\''|g' || true)"
	[ -n "$NEWS_HEADLINE" ] || continue
	NEWS_WON_SRC="$feed"
	break
done

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

# Ken's sitewide date/time standard: day-first full month name, then a
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

# Read template, substitute placeholders.  We do this in awk for
# strict literal substitution (sed would re-interpret special
# characters in news headlines).
awk \
	-v operator_name="$MORPHIT_CANARY_OPERATOR_NAME" \
	-v origin="$MORPHIT_CANARY_INSTANCE_ORIGIN" \
	-v generated="$GENERATED_AT_ISO" \
	-v valid="$VALID_THROUGH_ISO" \
	-v op_account="$MORPHIT_CANARY_OPERATOR_ACCOUNT" \
	-v blurt_height="$BLURT_HEAD_HEIGHT" \
	-v blurt_hash="$BLURT_HEAD_HASH" \
	-v blurt_ts="$BLURT_HEAD_TIMESTAMP" \
	-v btc_height="$BTC_HEAD_HEIGHT" \
	-v btc_hash="$BTC_HEAD_HASH" \
	-v news="$NEWS_HEADLINE" \
	-v news_src="$NEWS_RSS" \
	-v news_at="$NEWS_FETCHED_AT" \
	'{
		gsub(/\{\{OPERATOR_NAME\}\}/,       operator_name);
		gsub(/\{\{INSTANCE_ORIGIN\}\}/,     origin);
		gsub(/\{\{GENERATED_AT_ISO\}\}/,    generated);
		gsub(/\{\{VALID_THROUGH_ISO\}\}/,   valid);
		gsub(/\{\{OPERATOR_ACCOUNT\}\}/,    op_account);
		gsub(/\{\{BLURT_HEAD_HEIGHT\}\}/,   blurt_height);
		gsub(/\{\{BLURT_HEAD_HASH\}\}/,     blurt_hash);
		gsub(/\{\{BLURT_HEAD_TIMESTAMP\}\}/,blurt_ts);
		gsub(/\{\{BTC_HEAD_HEIGHT\}\}/,     btc_height);
		gsub(/\{\{BTC_HEAD_HASH\}\}/,       btc_hash);
		gsub(/\{\{NEWS_HEADLINE\}\}/,       news);
		gsub(/\{\{NEWS_SOURCE\}\}/,         news_src);
		gsub(/\{\{NEWS_FETCHED_AT\}\}/,     news_at);
		print
	}' "$TEMPLATE" > "$UNSIGNED"

# Drop everything from the BEGIN PGP SIGNATURE block onward — gpg
# will append its own signature block to the cleartext.
sed -i '/-----BEGIN PGP SIGNATURE-----/,$d' "$UNSIGNED"

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
