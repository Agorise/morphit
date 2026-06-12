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
#   $MORPHIT_CANARY_BLURT_RPC      — Blurt RPC URL for chain-head
#                                    fetch (default: https://rpc.blurt.blog).
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
#   - Reduces dependencies (gpg, curl, jq are present on every
#     operator host already).
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

BLURT_RPC="${MORPHIT_CANARY_BLURT_RPC:-https://rpc.blurt.blog}"
NEWS_RSS="${MORPHIT_CANARY_NEWS_RSS:-https://cointelegraph.com/rss}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="$REPO_ROOT/apps/web/static/canary.txt.template"
OUT="$REPO_ROOT/apps/web/static/canary.txt"

if [ ! -f "$TEMPLATE" ]; then
	echo "canary: template missing at $TEMPLATE" >&2
	exit 1
fi

# Tools — fail loud if any is missing.
for tool in gpg curl jq date; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "canary: required tool '$tool' not found in PATH" >&2
		exit 1
	fi
done

# ─── Freshness proof: Blurt chain head ───────────────────────────

echo "canary: fetching Blurt chain head from $BLURT_RPC..." >&2
BLURT_RESP="$(curl -fsSL --max-time 15 -X POST -H "Content-Type: application/json" \
	-d '{"jsonrpc":"2.0","method":"condenser_api.get_dynamic_global_properties","params":[],"id":1}' \
	"$BLURT_RPC")"

BLURT_HEAD_HEIGHT="$(echo "$BLURT_RESP" | jq -r '.result.head_block_number')"
BLURT_HEAD_HASH="$(echo "$BLURT_RESP" | jq -r '.result.head_block_id')"
BLURT_HEAD_TIMESTAMP="$(echo "$BLURT_RESP" | jq -r '.result.time')Z"

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

GENERATED_AT_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Valid through: 14 days from now.  This is the silent-canary
# threshold — readers should treat the canary as untrusted past
# this point.
VALID_THROUGH_ISO="$(date -u -d '+14 days' +%Y-%m-%dT%H:%M:%SZ)"
NEWS_FETCHED_AT="$GENERATED_AT_ISO"

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
