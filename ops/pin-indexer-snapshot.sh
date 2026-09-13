#!/usr/bin/env bash
#
# pin-indexer-snapshot.sh (cp766) — pin a signed indexer-DB snapshot to THIS
# node's kubo, publish an "always-newest" IPNS pointer, and emit a ready-to-
# broadcast indexer_snapshot_v1 payload for indexer-snapshot-broadcast.ts.
#
# Run on a CAUGHT-UP publishing node (morphit.io / morphitlat), giving it the
# tarball that snapshot-export.ts produced:
#   sudo bash pin-indexer-snapshot.sh /path/to/morphit-indexer-snapshot-<block>-<date>.tar.gz
#
# Every op value (sha256 of the inner dump, chain_id, schema_version,
# last_applied_block, indexer_version) is read straight out of the tarball's
# manifest.json — no separate values file to keep in sync. The snapshot gets its
# OWN dedicated IPNS key (never the release or block_log key). The @morphit
# indexer_snapshot_v1 op is the trust anchor; the importer proves the download
# against sha256 + re-verifies the tail from chain, so it is safe to host anywhere.
#
# Overridable: IPNS_KEY (default indexer-snapshot), FORGEJO_URL (optional https
# mirror recorded in the op), WORKDIR (default <ipfs repo>/indexer-snapshots).
#
set -uo pipefail
TARBALL="${1:-}"
IPNS_KEY="${IPNS_KEY:-indexer-snapshot}"
g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
bad(){ printf '  %s\xe2\x9c\x97%s %s\n' "$r" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
die(){ bad "$1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash pin-indexer-snapshot.sh <snapshot.tar.gz>"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "snapshot tarball not found. usage: pin-indexer-snapshot.sh <morphit-indexer-snapshot-*.tar.gz>"
command -v python3 >/dev/null 2>&1 || die "python3 is required to read the manifest (present by default on Ubuntu/Mint)."
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required."

hdr "0. Read the manifest from inside the tarball (the op values live here)"
# Extract manifest.json to stdout without unpacking the (large) dump.
MANIFEST_JSON="$(tar -xzO -f "$TARBALL" manifest.json 2>/dev/null)" || die "could not read manifest.json from the tarball — is this a snapshot-export.ts archive?"
[ -n "$MANIFEST_JSON" ] || die "manifest.json is empty in the tarball."
# Pull + validate the fields we need. python exits non-zero (→ die) on anything
# missing/malformed, so a bad manifest can never produce a half-formed op.
read -r FMT CHAIN_ID SCHEMA_VERSION LAST_BLOCK DUMP_SHA256 INDEXER_VERSION < <(
	# The manifest goes in through the ENVIRONMENT, not a pipe. `python3 -` reads
	# the PROGRAM from stdin, and the heredoc below already claims stdin — so a
	# piped `printf ... |` was silently discarded and json.load(sys.stdin) always
	# saw an empty stream ("Expecting value: line 1 column 1"). That is why this
	# script could never publish, and why no snapshot had ever been anchored.
	MANIFEST_JSON="$MANIFEST_JSON" python3 - <<'PY'
import json,os,sys,re
try:
    m=json.loads(os.environ["MANIFEST_JSON"])
except Exception as e:
    sys.stderr.write(f"manifest JSON parse failed: {e}\n"); sys.exit(1)
def need(k):
    v=m.get(k)
    if v is None: sys.stderr.write(f"manifest missing '{k}'\n"); sys.exit(1)
    return v
fmt=int(need("snapshotFormatVersion"))
if fmt < 2: sys.stderr.write(f"snapshot format v{fmt} is pre-federation (needs v2+); re-export with a current build.\n"); sys.exit(1)
chain=str(need("chainId"))
schema=int(need("schemaVersion"))
lab=int(need("lastAppliedBlock"))
sha=str(need("dumpSha256"))
if not re.fullmatch(r"[0-9a-f]{64}", sha): sys.stderr.write("dumpSha256 is not 64 lowercase hex.\n"); sys.exit(1)
iv=str(m.get("indexerVersion") or "").strip() or "unknown"
if " " in chain or " " in sha: sys.stderr.write("unexpected whitespace in manifest field.\n"); sys.exit(1)
print(fmt, chain, schema, lab, sha, iv)
PY
) || die "manifest is missing required v2 fields or is malformed — refusing to publish."
[ -n "$DUMP_SHA256" ] || die "could not read dumpSha256 from manifest."
SIZE_BYTES="$(stat -c %s "$TARBALL")"
ok "manifest: chain ${CHAIN_ID} · schema v${SCHEMA_VERSION} · block ${LAST_BLOCK} · dumpSha256 ${DUMP_SHA256:0:12}… · indexer v${INDEXER_VERSION}"
# Report kB, not MB. Integer division floored a 583,544-byte snapshot to "0 MB",
# which reads like the export failed. These artifacts are ~600 kB by design.
ok "tarball size: $((SIZE_BYTES/1024)) kB"

hdr "1. Locate kubo + its repo root"
KUBO_PID="$(pgrep -x ipfs | head -1 || true)"
[ -n "$KUBO_PID" ] || die "no running 'ipfs' (kubo) daemon found."
KUBO_USER="$(ps -o user= -p "$KUBO_PID" | tr -d ' ')"
IPFS(){ sudo -u "$KUBO_USER" ipfs "$@"; }
IPFS id >/dev/null 2>&1 || die "cannot reach the kubo API as user '$KUBO_USER'."
IPFS_PATH="$(tr '\0' '\n' < "/proc/$KUBO_PID/environ" 2>/dev/null | grep -m1 '^IPFS_PATH=' | cut -d= -f2- || true)"
[ -n "$IPFS_PATH" ] || IPFS_PATH="$(getent passwd "$KUBO_USER" | cut -d: -f6)/.ipfs"
[ -d "$IPFS_PATH" ] || IPFS_PATH="/var/lib/ipfs"
[ -d "$IPFS_PATH" ] || die "could not locate the IPFS repo root."
WORKDIR="${WORKDIR:-$IPFS_PATH/indexer-snapshots}"
ARCHIVE_NAME="morphit-indexer-snapshot-${LAST_BLOCK}.tar.gz"
LOCAL="$WORKDIR/$ARCHIVE_NAME"
PAYLOAD="$WORKDIR/indexer-snapshot-payload-${LAST_BLOCK}.json"
mkdir -p "$WORKDIR"; chown "$KUBO_USER" "$WORKDIR" 2>/dev/null || true
ok "kubo pid=$KUBO_PID owner=$KUBO_USER repo=$IPFS_PATH"
ok "staging dir (inside repo, nocopy-safe): $WORKDIR"

hdr "2. Stage the tarball inside the kubo repo (nocopy-safe)"
same_fs(){ [ "$(stat -c %d "$(dirname "$1")" 2>/dev/null)" = "$(stat -c %d "$(dirname "$2")" 2>/dev/null)" ]; }
if [ "$(readlink -f "$TARBALL")" = "$(readlink -f "$LOCAL")" ]; then
	ok "tarball is already staged in the repo"
elif same_fs "$TARBALL" "$LOCAL"; then
	cp -f "$TARBALL" "$LOCAL" || die "copy into repo failed"
	ok "copied into the repo (same filesystem)"
else
	AVAIL_KB="$(df -Pk "$WORKDIR" | awk 'NR==2{print $4}')"
	NEED_KB=$(( SIZE_BYTES/1024 + 256*1024 ))
	[ "$AVAIL_KB" -ge "$NEED_KB" ] || die "not enough room in $WORKDIR to stage the tarball (need ~$((NEED_KB/1024/1024)) GB). Set WORKDIR to a dir on the same disk as the tarball, still inside the kubo repo ($IPFS_PATH)."
	cp -f "$TARBALL" "$LOCAL" || die "copy into repo failed"
	ok "copied into the repo (across filesystems)"
fi
chown "$KUBO_USER" "$LOCAL" 2>/dev/null || true; chmod 0644 "$LOCAL"
# Re-verify the inner dump's sha matches the manifest (defence in depth: the
# tarball we're about to publish must match what the op will claim).
STAGED_SHA="$(tar -xzO -f "$LOCAL" indexer.sql.gz 2>/dev/null | sha256sum | awk '{print $1}')" || die "could not read indexer.sql.gz from the staged tarball."
[ "$STAGED_SHA" = "$DUMP_SHA256" ] || die "staged tarball's indexer.sql.gz sha256 ($STAGED_SHA) != manifest dumpSha256 ($DUMP_SHA256). Refusing to publish a mismatched snapshot."
ok "staged tarball verified: inner dump sha256 matches the manifest"

hdr "3. Ensure filestore (nocopy) is enabled"
if [ "$(IPFS config --json Experimental.FilestoreEnabled 2>/dev/null || echo false)" = "true" ]; then
	ok "filestore already enabled"
else
	IPFS config --json Experimental.FilestoreEnabled true || die "could not enable filestore"
	UNIT="$(systemctl list-units --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -iE 'ipfs|kubo' | head -1 || true)"
	[ -n "$UNIT" ] && { systemctl restart "$UNIT" && ok "restarted $UNIT"; }
	for _ in $(seq 1 20); do sleep 3; IPFS id >/dev/null 2>&1 && break; done
	IPFS id >/dev/null 2>&1 || die "kubo did not come back after restart."
	ok "filestore enabled"
fi

hdr "4. Add + pin the snapshot tarball (nocopy)"
CID="$(IPFS add --nocopy --pin=true -Q "$LOCAL")" || die "ipfs add failed"
[ -n "$CID" ] || die "ipfs add returned no CID"
ok "pinned as CID: $CID"

hdr "5. Publish the always-newest IPNS pointer (dedicated key: $IPNS_KEY)"
if IPFS key list 2>/dev/null | grep -qx "$IPNS_KEY"; then ok "reusing IPNS key '$IPNS_KEY'"
else IPFS key gen --type=ed25519 "$IPNS_KEY" >/dev/null || die "could not create IPNS key"; ok "created IPNS key '$IPNS_KEY'"; fi
IPNS_NAME="$(IPFS key list -l 2>/dev/null | awk -v k="$IPNS_KEY" '$2==k{print $1}')"
[ -n "$IPNS_NAME" ] || die "could not resolve IPNS name for key '$IPNS_KEY'"
echo "  publishing /ipns/$IPNS_NAME -> /ipfs/$CID ..."
IPFS name publish --key="$IPNS_KEY" --allow-offline "/ipfs/$CID" >/dev/null || warn "name publish reported an issue (will re-announce)"
ok "IPNS name: $IPNS_NAME"

hdr "6. Announce to the DHT"
( IPFS routing provide "$CID" >/dev/null 2>&1 || IPFS dht provide "$CID" >/dev/null 2>&1 ) &
ok "provide kicked off (public-gateway propagation can take a few minutes)"

hdr "7. Emit the indexer_snapshot_v1 payload"
# forgejo_url is OPTIONAL; only include the line if the operator set FORGEJO_URL.
FORGEJO_LINE=""
if [ -n "${FORGEJO_URL:-}" ]; then
	case "$FORGEJO_URL" in
		https://*) FORGEJO_LINE=",
  \"forgejo_url\": \"$FORGEJO_URL\"" ;;
		*) warn "FORGEJO_URL is not an https:// URL — omitting it from the op." ;;
	esac
fi
cat > "$PAYLOAD" <<JSON
{
  "ipfs_cid": "$CID",
  "sha256": "$DUMP_SHA256",
  "chain_id": "$CHAIN_ID",
  "schema_version": $SCHEMA_VERSION,
  "last_applied_block": $LAST_BLOCK,
  "size_bytes": $SIZE_BYTES,
  "indexer_version": "$INDEXER_VERSION",
  "ipns_name": "$IPNS_NAME"$FORGEJO_LINE
}
JSON
chown "$KUBO_USER" "$PAYLOAD" 2>/dev/null || true
ok "wrote $PAYLOAD"
# Machine-readable locator for the caller (snapshot-autopublish.sh). Emitted on
# STDOUT with a stable prefix so the automation never has to go hunting the
# filesystem for a file this script already knows the exact path of.
echo "MORPHIT_SNAPSHOT_PAYLOAD=$PAYLOAD"
echo ""; sed 's/^/    /' "$PAYLOAD"

hdr "8. Verify public-gateway reachability BEFORE broadcasting (guard)"
# Reuse the release guard shape: only anchor a CID the public web can actually
# fetch. Non-fatal here (propagation lag), but tells you whether to wait.
if command -v curl >/dev/null 2>&1; then
	if curl -fsSL --max-time 45 -o /dev/null "https://ipfs.io/ipfs/$CID" 2>/dev/null; then
		ok "CID reachable on a public gateway"
	else
		warn "CID not yet reachable on ipfs.io — DHT propagation can take a few minutes. Re-check before broadcasting."
	fi
fi

hdr "DONE — next: broadcast from your laptop"
echo "  1. Copy the payload down:"
echo "       scp morphit@<this-node>:$PAYLOAD ."
echo "  2. In the Morphit repo (dry-run, then real — prompts for the @morphit POSTING WIF):"
echo "       node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/indexer/scripts/indexer-snapshot-broadcast.ts indexer-snapshot-payload-${LAST_BLOCK}.json --dry-run"
echo "       node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/indexer/scripts/indexer-snapshot-broadcast.ts indexer-snapshot-payload-${LAST_BLOCK}.json"
echo ""
echo "  A fresh node then fast-syncs with:  morphit-ops fast-sync"
echo "  (or directly: snapshot-bootstrap.ts --from-chain --i-trust-signer)"
