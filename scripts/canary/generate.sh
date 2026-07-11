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
OUT="$REPO_ROOT/apps/web/static/canary.txt"

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

# ─── Freshness proof: Bitcoin chain head ─────────────────────────

echo "canary: fetching Bitcoin chain head..." >&2
# blockstream.info is a publicly-readable Bitcoin endpoint; operators
# concerned about it can swap to their own bitcoind via env var
# (not currently parameterized — file an issue if you need it).
BTC_HEAD_HEIGHT="$(curl -fsSL --max-time 15 "https://blockstream.info/api/blocks/tip/height")"
BTC_HEAD_HASH="$(curl -fsSL --max-time 15 "https://blockstream.info/api/blocks/tip/hash")"

if [ -z "$BTC_HEAD_HEIGHT" ] || ! [[ "$BTC_HEAD_HEIGHT" =~ ^[0-9]+$ ]]; then
	echo "canary: blockstream returned bad height: $BTC_HEAD_HEIGHT" >&2
	exit 1
fi
if [ -z "$BTC_HEAD_HASH" ] || [ "${#BTC_HEAD_HASH}" -ne 64 ]; then
	echo "canary: blockstream returned bad hash: $BTC_HEAD_HASH" >&2
	exit 1
fi

# ─── Freshness proof: news entropy ───────────────────────────────

echo "canary: fetching news headline from $NEWS_RSS..." >&2
NEWS_XML="$(curl -fsSL --max-time 15 "$NEWS_RSS")"
# Extract the first <title> after <item> — robust against varying
# RSS layouts.  Strip CDATA wrappers and HTML entities.
NEWS_HEADLINE="$(echo "$NEWS_XML" \
	| awk 'BEGIN{RS="<item>"} NR==2{print}' \
	| grep -o '<title>[^<]*</title>' \
	| head -1 \
	| sed -e 's|<title>||' -e 's|</title>||' \
	      -e 's|<!\[CDATA\[||g' -e 's|\]\]>||g' \
	      -e 's|&amp;|\&|g' -e 's|&lt;|<|g' -e 's|&gt;|>|g' -e 's|&quot;|"|g' \
	      -e 's|&apos;|'\''|g')"

if [ -z "$NEWS_HEADLINE" ]; then
	# Fall back to channel title rather than failing — most public RSS
	# feeds work, but some operators may use a custom feed shape.
	NEWS_HEADLINE="(no headline extracted from $NEWS_RSS)"
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
