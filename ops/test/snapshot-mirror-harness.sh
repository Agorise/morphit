#!/usr/bin/env bash
# ops/test/snapshot-mirror-harness.sh — EXECUTE the mirror path.
#
# WHY
# The mirror job has the same shape as the publish job that produced seven
# production-only failures in one evening: it drops to another user, talks to a
# daemon, and runs under systemd hardening. It had exactly the same blind spot —
# it ran bare `ipfs` as root, so kubo looked in /root/.ipfs and the job refused to
# fetch a CID the machine was already serving. That was found on a live server,
# not in the battery, because nothing ever RAN it.
#
# So run it. A fake Blurt RPC serves a real `indexer_snapshot_v1` op; a stub kubo
# serves back a real tarball. The mirror must find the op, pin it, read it back,
# verify the sha256 against the op, and record state — using an explicit
# IPFS_PATH and never plain `sudo` (which cannot run under NoNewPrivileges).
#
# Hermetic: temp dir, stub binaries on PATH, loopback HTTP only, no root.
#
# Usage: bash ops/test/snapshot-mirror-harness.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MIRROR_TS="$REPO/apps/indexer/scripts/snapshot-mirror.ts"
TSX="$REPO/node_modules/.bin/tsx"
WORK="$(mktemp -d)"
RPC_PID=""
cleanup(){ [ -n "$RPC_PID" ] && kill "$RPC_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fails=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }

[ -x "$TSX" ] || { echo "tsx not installed — run npm ci"; exit 1; }

CHAIN_ID="cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f"

# ── A real snapshot tarball, and the sha the op must carry ───────────
SNAP="$WORK/snap"; mkdir -p "$SNAP"
head -c 400000 /dev/urandom | base64 | gzip > "$SNAP/indexer.sql.gz"
DUMP_SHA="$(sha256sum "$SNAP/indexer.sql.gz" | cut -d' ' -f1)"
cat > "$SNAP/manifest.json" <<EOF
{"snapshotFormatVersion":2,"chainId":"$CHAIN_ID","schemaVersion":59,
 "lastAppliedBlock":63610645,"dumpSha256":"$DUMP_SHA","indexerVersion":"1.17.6",
 "createdAt":"2026-09-13T00:00:00Z","pgMajor":16,"sourceLabel":"harness"}
EOF
TARBALL="$WORK/snapshot.tar.gz"
tar czf "$TARBALL" -C "$SNAP" manifest.json indexer.sql.gz
SIZE="$(stat -c %s "$TARBALL")"
# A syntactically VALID fake CID: 46 chars, base58 alphabet (which excludes
# 0/O/I/l). The first attempt used "...CID..." — the uppercase I is not base58,
# so the op was correctly rejected and the harness looked broken when the code
# was right. Worth keeping the comment: a fixture that the validator rejects
# tests nothing.
CID="QmHarnessMirroraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

# ── Fake Blurt RPC serving one indexer_snapshot_v1 op ────────────────
cat > "$WORK/rpc.mjs" <<'RPC'
import { createServer } from 'node:http';
const [,, port, cid, sha, chainId, size] = process.argv;
const payload = {
  ipfs_cid: cid, sha256: sha, chain_id: chainId, schema_version: 59,
  last_applied_block: 63610645, size_bytes: Number(size), indexer_version: '1.17.6'
};
const history = [[282, { op: ['custom_json', {
  id: 'indexer_snapshot_v1', required_posting_auths: ['morphit'],
  json: JSON.stringify(payload)
}], timestamp: '2026-09-13T00:00:00' }]];
createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    let id = 1;
    try { id = JSON.parse(b).id ?? 1; } catch { /* ignore */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: history }));
  });
}).listen(Number(port), '127.0.0.1');
RPC
PORT=45917
node "$WORK/rpc.mjs" "$PORT" "$CID" "$DUMP_SHA" "$CHAIN_ID" "$SIZE" &
RPC_PID=$!
sleep 1

# ── Stub kubo ────────────────────────────────────────────────────────
BIN="$WORK/bin"; mkdir -p "$BIN"
KUBO_REPO="$WORK/ipfsrepo"; mkdir -p "$KUBO_REPO"
cat > "$BIN/ipfs" <<STUB
#!/usr/bin/env bash
echo "IPFS_PATH=\${IPFS_PATH:-UNSET} argv=\$*" >> "$WORK/ipfs-calls.log"
case "\$*" in
	"id"*) echo '{"ID":"12D3KooWHarness"}' ;;
	"cat "*) cat "$TARBALL" ;;
	"pin ls"*) echo "$CID recursive" ;;
	"pin add"*) : ;;
	"pin rm"*) : ;;
	"repo gc"*) : ;;
	*) : ;;
esac
exit 0
STUB
# runuser stub: exec through, preserving the env the caller set.
printf '#!/usr/bin/env bash\nshift 2; [ "$1" = "--" ] && shift; exec "$@"\n' > "$BIN/runuser"
# A `sudo` that ALWAYS fails, exactly as it does under NoNewPrivileges. If the
# code reaches for sudo instead of runuser, this harness must notice.
printf '#!/usr/bin/env bash\necho "sudo: unable to open /etc/sudoers: Operation not permitted" >&2\nexit 1\n' > "$BIN/sudo"
chmod +x "$BIN"/*

: > "$WORK/ipfs-calls.log"
export PATH="$BIN:$PATH"
# IPFS_PATH is deliberately NOT exported. Under systemd the job's environment
# has none, and the script must therefore pass one explicitly on every call. An
# exported value here would be inherited by a bare `ipfs` and would hide exactly
# the bug that shipped (kubo reading /root/.ipfs). This is the second harness in
# which I made that mistake; a fixture that leaks state tests nothing.
export MORPHIT_SNAPSHOT_MIRROR_STATE="$WORK/mirror-state.json"
export MORPHIT_INDEXER_DATABASE_URL="postgres://unused"
export MORPHIT_INDEXER_CHAIN_ID="$CHAIN_ID"
export MORPHIT_INDEXER_PUBLIC_ORIGIN="https://harness.invalid"
export MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY="BLT1111111111111111111111111111111114T1Anm"
# Use the LOCAL (loopback) RPC tier, not the clearnet one. Clearnet endpoints
# must be https:// — a rule that exists so a node never leaks its IP to a
# plaintext RPC — and the harness must not weaken it to make itself pass. A
# co-located loopback blurtd is a supported deployment, so this is the honest
# lever, and it exercises the same code path.
export MORPHIT_INDEXER_LOCAL_RPC_ENDPOINTS="http://127.0.0.1:$PORT"
export MORPHIT_INDEXER_RPC_ENDPOINTS=""
export MORPHIT_INDEXER_LOCAL_RPC_AUTODETECT="0"

echo "── mirror path, executed ───────────────────────────────────────"

OUT="$(cd "$REPO" && "$TSX" --tsconfig "$REPO/tsconfig.smoke.json" "$MIRROR_TS" --signer morphit 2>&1)"; RC=$?

if [ "$RC" -eq 0 ]; then ok "mirror path runs to completion (exit 0)"; else
	no "mirror path exited $RC"; printf '%s\n' "$OUT" | sed 's/^/      /'
fi
case "$OUT" in
	*"newest snapshot"*) ok "found the anchored op on the (fake) chain" ;;
	*) no "did not find the anchored op"; printf '%s\n' "$OUT" | sed 's/^/      /' ;;
esac
case "$OUT" in
	*"verified against the on-chain sha256"*) ok "read the pinned bytes back and verified them against the op" ;;
	*"already mirroring"*) ok "recognised existing state without re-pinning (idempotent)" ;;
	*) no "never verified the snapshot against the on-chain sha256" ;;
esac

# ── The bug that shipped: bare `ipfs` as root uses the WRONG repo ─────
if grep -q 'IPFS_PATH=UNSET' "$WORK/ipfs-calls.log"; then
	no "an ipfs call ran with IPFS_PATH UNSET — kubo would read /root/.ipfs"
else
	ok "every ipfs call carried an explicit IPFS_PATH"
fi

# ── sudo must never be the drop-privilege tool under hardening ────────
if grep -qi 'unable to open /etc/sudoers' <<<"$OUT"; then
	no "the mirror shelled out to sudo — it cannot run under NoNewPrivileges"
else
	ok "does not depend on sudo (works under NoNewPrivileges)"
fi

# ── A wrong sha256 must be REFUSED, not served ───────────────────────
kill "$RPC_PID" 2>/dev/null; RPC_PID=""
node "$WORK/rpc.mjs" "$PORT" "$CID" "$(printf 'b%.0s' {1..64})" "$CHAIN_ID" "$SIZE" &
RPC_PID=$!
sleep 1
rm -f "$WORK/mirror-state.json"
OUT2="$(cd "$REPO" && "$TSX" --tsconfig "$REPO/tsconfig.smoke.json" "$MIRROR_TS" --signer morphit 2>&1)"
case "$OUT2" in
	*"MISMATCH"*|*"unpinning"*) ok "refuses a snapshot whose bytes do not match the signed sha256" ;;
	*) no "accepted a snapshot with a WRONG sha256 — it would serve bad bytes to newcomers" ;;
esac

# ── A foreign chain must be refused before any bandwidth is spent ─────
kill "$RPC_PID" 2>/dev/null; RPC_PID=""
node "$WORK/rpc.mjs" "$PORT" "$CID" "$DUMP_SHA" "deadbeefdeadbeef" "$SIZE" &
RPC_PID=$!
sleep 1
rm -f "$WORK/mirror-state.json"
OUT3="$(cd "$REPO" && "$TSX" --tsconfig "$REPO/tsconfig.smoke.json" "$MIRROR_TS" --signer morphit 2>&1)"
case "$OUT3" in
	*"refusing to mirror"*) ok "refuses a snapshot for a different chain" ;;
	*) no "did not refuse a foreign-chain snapshot" ;;
esac

echo ""
if [ "$fails" -gt 0 ]; then
	printf '\033[31m✗ %d mirror-harness check(s) failed\033[0m (%d passed)\n' "$fails" "$pass"
	exit 1
fi
printf '\033[32m✓ all %d mirror-path harness checks passed\033[0m\n' "$pass"
