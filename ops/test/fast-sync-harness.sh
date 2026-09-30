#!/usr/bin/env bash
# ops/test/fast-sync-harness.sh — EXECUTE fast-sync on a ZERO-CLEARNET node.
#
# WHY THIS IS THE ONE THAT MATTERS
# Fast-sync exists so a brand-new instance is useful in minutes instead of days,
# and the whole point of the design is that it works for nodes with NO clearnet —
# the ones whose privacy posture we most want to encourage. That claim was never
# actually tested. Every rehearsal so far pulled over clearnet from a laptop.
#
# When it finally ran on a real zero-clearnet box (morphitlat) it failed, because
# `installHiddenServiceDispatcher` was called only from the indexer SERVICE. Any
# standalone script aimed its request straight at a `.b32.i2p` hostname with no
# proxy and got `fetch failed`. So a hidden-only node could not even READ THE
# CHAIN to discover the snapshot, let alone fetch it.
#
# This drives the real `snapshot-bootstrap.ts --verify-only` against faithful
# Tor SOCKS5 and i2pd HTTP proxy stubs, over BOTH networks, and asserts on the
# PROXY LOG — so "it worked" is only accepted when the traffic genuinely went
# through the proxy. Tor and I2P are different code paths (a hand-rolled SOCKS5
# connector vs a CONNECT connector); passing one proves nothing about the other.
#
# It also asserts the fail-closed property: a hidden-only node must NEVER reach
# for a clearnet source, even when one is on offer.
#
# Hermetic: temp dir, loopback only, no daemon, no root, no real network.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BOOT="$REPO/apps/indexer/scripts/snapshot-bootstrap.ts"
TSX="$REPO/node_modules/.bin/tsx"
WORK="$(mktemp -d)"
STUB_PID=""
cleanup(){ [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fails=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

[ -x "$TSX" ] || { echo "tsx not installed — run npm ci"; exit 1; }

CHAIN_ID="cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f"
ONION="$(printf 'a%.0s' $(seq 56)).onion"
I2P="$(printf 'b%.0s' $(seq 52)).b32.i2p"
# 46-char base58 (no 0/O/I/l) — an invalid CID is rejected by the op validator,
# which makes the harness look broken while the code is right.
CID="QmHarnessFastSync$(printf 'a%.0s' $(seq 29))"

# ── A real snapshot tarball (manifest v2 + gzipped dump) ─────────────
SNAP="$WORK/snap"; mkdir -p "$SNAP"
head -c 300000 /dev/urandom | base64 | gzip > "$SNAP/indexer.sql.gz"
DUMP_SHA="$(sha256sum "$SNAP/indexer.sql.gz" | cut -d' ' -f1)"
cat > "$SNAP/manifest.json" <<EOF
{"snapshotFormatVersion":2,"chainId":"$CHAIN_ID","schemaVersion":59,
 "lastAppliedBlock":63610645,"dumpSha256":"$DUMP_SHA","indexerVersion":"1.17.8",
 "createdAt":"2026-09-13T00:00:00Z","pgMajor":16,"sourceLabel":"harness"}
EOF
TARBALL="$WORK/snapshot.tar.gz"
tar czf "$TARBALL" -C "$SNAP" manifest.json indexer.sql.gz
SIZE="$(stat -c %s "$TARBALL")"

# ── Chain history: the snapshot op PLUS the signer's own registration ─
# The registration is how a brand-new node learns a peer's hidden addresses
# without any baked-in list — it is already reading this account's history to
# find the snapshot, and the alt_addresses ride along for free.
#
# v1.18.0 deep-deep (rv2-1): the snapshot op must be SIGNED by the pinned key and
# served with its block, and two RPC operators must agree on it — so the fixture
# is built by signed-snapshot-op.mjs with a test key, that key is pinned below,
# and every run lists two RPC addresses (two operators) on the same transport.
REG='[[281,{"op":["custom_json",{"id":"morphit_operator_register_v1","required_posting_auths":["morphit"],"json":"{\"alt_addresses\":{\"tor\":\"'"$ONION"'\",\"i2p_b32\":\"'"$I2P"'\"}}"}],"timestamp":"2026-09-13T00:00:00"}]]'
PAYLOAD="{\"ipfs_cid\":\"$CID\",\"sha256\":\"$DUMP_SHA\",\"chain_id\":\"$CHAIN_ID\",\"schema_version\":59,\"last_applied_block\":63610645,\"size_bytes\":$SIZE,\"indexer_version\":\"1.17.8\"}"
(cd "$REPO" && node ops/test/lib/signed-snapshot-op.mjs "$PAYLOAD" "$REG") > "$WORK/signed.json"
PINNED="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pubkey)' "$WORK/signed.json")"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(j.history))' "$WORK/signed.json" > "$WORK/history.json"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(j.rpc))' "$WORK/signed.json" > "$WORK/rpc.json"
ONION2="$(printf 'c%.0s' $(seq 56)).onion"
I2P2="$(printf 'd%.0s' $(seq 52)).b32.i2p"

PLOG="$WORK/proxy.log"; : > "$PLOG"
MORPHIT_STUB_BODY="$(cat "$WORK/history.json")" MORPHIT_STUB_RPC="$(cat "$WORK/rpc.json")" MORPHIT_STUB_FILE="$TARBALL" \
	node "$REPO/ops/test/lib/hidden-proxy-stubs.mjs" 0 0 0 "$PLOG" \
	> "$WORK/ready" 2>&1 &
STUB_PID=$!
# Ports are the kernel's pick (0): fixed ones inside the ephemeral range could
# already be held by another socket on a busy CI box, and the stubs used to say
# "ready" before listening — so the harness tested against nothing (CI,
# 2026-09-29). They now print their real ports only once all three listen.
for _i in $(seq 1 120); do grep -qE '^stubs-(ready|failed)' "$WORK/ready" 2>/dev/null && break; sleep 0.25; done
grep -q '^stubs-ready ' "$WORK/ready" || { echo "proxy stubs failed to start:"; cat "$WORK/ready"; exit 1; }
read -r _ ORIGIN_PORT I2P_PROXY_PORT TOR_SOCKS_PORT < <(grep '^stubs-ready ' "$WORK/ready")

echo "── fast-sync on a zero-clearnet node, executed ─────────────────"

run_bootstrap() {
	cd "$REPO" && env \
		MORPHIT_INDEXER_DATABASE_URL="postgres://unused" \
		MORPHIT_INDEXER_CHAIN_ID="$CHAIN_ID" \
		MORPHIT_INDEXER_PUBLIC_ORIGIN="https://harness.invalid" \
		MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY="$PINNED" \
		MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS="" \
		MORPHIT_INDEXER_RPC_ENDPOINTS="" \
		MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS="$1" \
		MORPHIT_INDEXER_TOR_SOCKS="127.0.0.1:$TOR_SOCKS_PORT" \
		MORPHIT_INDEXER_I2P_HTTP_PROXY="127.0.0.1:$I2P_PROXY_PORT" \
		MORPHIT_TOR_SOCKS="127.0.0.1:$TOR_SOCKS_PORT" \
		MORPHIT_I2P_HTTP_PROXY="http://127.0.0.1:$I2P_PROXY_PORT" \
		MORPHIT_LOCAL_IPFS_GATEWAY="" \
		"$TSX" --tsconfig "$REPO/tsconfig.smoke.json" "$BOOT" \
		--from-chain --i-trust-signer --verify-only 2>&1
}

for net in i2p tor; do
	[ "$net" = "i2p" ] && RPC="http://$I2P,http://$I2P2" || RPC="http://$ONION,http://$ONION2"
	: > "$PLOG"
	OUT="$(run_bootstrap "$RPC")"
	case "$OUT" in
		*"DRY RUN PASSED"*)
			ok "zero-clearnet fast-sync fetched AND verified the snapshot over ${net}" ;;
		*)
			no "zero-clearnet fast-sync over ${net} FAILED"
			printf '%s\n' "$OUT" | sed 's/^/      /' | tail -5 ;;
	esac
	# The log is the real assertion: reaching the origin directly must not count.
	if grep -qE 'tor-socks|i2p-proxy' "$PLOG"; then
		ok "  …and the traffic genuinely traversed the ${net} proxy"
	else
		no "  …but NOTHING traversed the ${net} proxy — it went direct"
	fi
	# Chain read and content fetch are separate hops; both must be proxied.
	if grep -q 'origin GET /ipfs/' "$PLOG"; then
		ok "  …including the snapshot download itself, not just the chain read"
	else
		no "  …the snapshot body was never fetched through the proxy"
	fi
done

# ── Fail-closed: a hidden-only node must refuse clearnet outright ─────
# Offer a clearnet gateway that WOULD serve it. A hidden-only node must still
# refuse rather than quietly deanonymise itself to finish faster.
: > "$PLOG"
OUT_FC="$(cd "$REPO" && env \
	MORPHIT_INDEXER_DATABASE_URL="postgres://unused" \
	MORPHIT_INDEXER_CHAIN_ID="$CHAIN_ID" \
	MORPHIT_INDEXER_PUBLIC_ORIGIN="https://harness.invalid" \
	MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY="$PINNED" \
	MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS="" \
	MORPHIT_INDEXER_RPC_ENDPOINTS="" \
	MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS="http://$I2P,http://$I2P2" \
	MORPHIT_INDEXER_TOR_SOCKS="127.0.0.1:$TOR_SOCKS_PORT" \
	MORPHIT_INDEXER_I2P_HTTP_PROXY="127.0.0.1:$I2P_PROXY_PORT" \
	MORPHIT_IPFS_GATEWAYS="http://127.0.0.1:$ORIGIN_PORT" \
	"$TSX" --tsconfig "$REPO/tsconfig.smoke.json" "$BOOT" \
	--from-chain --i-trust-signer --verify-only 2>&1)"
# Assert BEHAVIOUR, not the label. The "clearnet sources omitted" text is
# printed from a config boolean, so it keeps appearing even if the omission
# itself is broken — a mutation that let a hidden-only node use clearnet slipped
# straight past an assertion on that string. The honest signal is the SOURCE
# COUNT: with two hidden peers and a clearnet gateway on offer, a fail-closed
# node must list exactly the two, and must never try the clearnet one.
SRC_LINE="$(printf '%s' "$OUT_FC" | grep -oE '[0-9]+ sources? to try' | head -1)"
case "$SRC_LINE" in
	"2 sources to try")
		ok "a clearnet gateway on offer is EXCLUDED from the source list (2 hidden only)" ;;
	*)
		no "hidden-only source list was '$SRC_LINE' — a clearnet source leaked in"
		printf '%s\n' "$OUT_FC" | sed 's/^/      /' | tail -4 ;;
esac
if grep -qE 'fetching from (127\.0\.0\.1|ipfs\.io|dweb\.link|cloudflare)' <<<"$OUT_FC"; then
	no "  …but it ATTEMPTED a clearnet source anyway"
else
	ok "  …and never attempted one"
fi

echo ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m✗ %d fast-sync harness check(s) failed\033[0m (%d passed)\n' "$fails" "$pass"
	exit 1
fi
printf '\033[32m✓ all %d fast-sync harness checks passed\033[0m\n' "$pass"
