#!/usr/bin/env bash
#
# pin-snapshot.sh — pin the signed Blurt block_log snapshot to THIS node's kubo
# and publish an "always-newest" IPNS pointer, then emit a ready-to-broadcast
# chain_snapshot_v1 payload for chain-snapshot-broadcast.ts.
#
# Run on the pinning node (morphit.io):
#   sudo bash pin-snapshot.sh /path/to/snapshot-values.env
#
# Disk-safe via `ipfs add --nocopy` (references the archive, no 2x blockstore
# copy). kubo requires nocopy files INSIDE the repo root, so the archive is
# staged there. Reuses an already-downloaded, SHA-correct copy (moves it into
# place) rather than re-downloading. The snapshot gets its OWN dedicated IPNS key
# (never the release key). The @morphit chain_snapshot_v1 op is the trust anchor.
#
set -uo pipefail
VALUES="${1:-./snapshot-values.env}"
IPNS_KEY="${IPNS_KEY:-blurt-snapshot}"
SNAP_REPO="${SNAP_REPO:-https://git.agorise.net/agorise/blurt-blockchain-snapshot}"
g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; b=$'\e[1m'; x=$'\e[0m'
ok(){ printf '  %s\xe2\x9c\x93%s %s\n' "$g" "$x" "$1"; }
warn(){ printf '  %s\xe2\x9a\xa0%s %s\n' "$y" "$x" "$1"; }
bad(){ printf '  %s\xe2\x9c\x97%s %s\n' "$r" "$x" "$1"; }
hdr(){ printf '\n%s== %s ==%s\n' "$b" "$1" "$x"; }
die(){ bad "$1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash pin-snapshot.sh <snapshot-values.env>"
[ -f "$VALUES" ] || die "snapshot-values.env not found at: $VALUES"
set -a; . "$VALUES"; set +a
: "${SNAP_SHA256:?SNAP_SHA256 missing from values}"
: "${SNAP_HEIGHT:?SNAP_HEIGHT missing from values}"
: "${SNAP_SIZE_BYTES:?SNAP_SIZE_BYTES missing from values}"
BLURTD_VERSION="${BLURTD_VERSION:-${SNAP_BLURTD_IMAGE##*/}}"
BLURTD_VERSION="${BLURTD_VERSION:0:32}"
ARCHIVE_URL="${ARCHIVE_URL:-$SNAP_REPO/releases/download/$SNAP_HEIGHT/block_log-$SNAP_HEIGHT.tar.zst}"
ARCHIVE_NAME="block_log-$SNAP_HEIGHT.tar.zst"

hdr "0. Locate kubo + its repo root"
KUBO_PID="$(pgrep -x ipfs | head -1 || true)"
[ -n "$KUBO_PID" ] || die "no running 'ipfs' (kubo) daemon found."
KUBO_USER="$(ps -o user= -p "$KUBO_PID" | tr -d ' ')"
IPFS(){ sudo -u "$KUBO_USER" ipfs "$@"; }
IPFS id >/dev/null 2>&1 || die "cannot reach the kubo API as user '$KUBO_USER'."
IPFS_PATH="$(tr '\0' '\n' < "/proc/$KUBO_PID/environ" 2>/dev/null | grep -m1 '^IPFS_PATH=' | cut -d= -f2- || true)"
[ -n "$IPFS_PATH" ] || IPFS_PATH="$(getent passwd "$KUBO_USER" | cut -d: -f6)/.ipfs"
[ -d "$IPFS_PATH" ] || IPFS_PATH="/var/lib/ipfs"
[ -d "$IPFS_PATH" ] || die "could not locate the IPFS repo root."
WORKDIR="${WORKDIR:-$IPFS_PATH/snapshots}"
LOCAL="$WORKDIR/$ARCHIVE_NAME"
PAYLOAD="$WORKDIR/snapshot-payload-$SNAP_HEIGHT.json"
mkdir -p "$WORKDIR"; chown "$KUBO_USER" "$WORKDIR" 2>/dev/null || true
ok "kubo pid=$KUBO_PID owner=$KUBO_USER repo=$IPFS_PATH (v$(IPFS version --number 2>/dev/null || echo '?'))"
ok "staging dir (inside repo, nocopy-safe): $WORKDIR"

hdr "1. Locate the archive (NO re-download — reuse the copy already on disk)"
sha_ok(){ [ -f "$1" ] && [ "$(sha256sum "$1" | awk '{print $1}')" = "$SNAP_SHA256" ]; }
same_fs(){ [ "$(stat -c %d "$(dirname "$1")" 2>/dev/null)" = "$(stat -c %d "$(dirname "$2")" 2>/dev/null)" ]; }
if sha_ok "$LOCAL"; then
	ok "archive already staged in the repo and SHA-256 matches — nothing to move"
else
	FOUND=""
	# explicit likely spots first, then a shallow search of common roots
	for c in "/opt/morphit/snapshots/$ARCHIVE_NAME" "/tmp/$ARCHIVE_NAME" "$PWD/$ARCHIVE_NAME" "/root/$ARCHIVE_NAME"; do
		if sha_ok "$c"; then FOUND="$c"; break; fi
	done
	if [ -z "$FOUND" ]; then
		while IFS= read -r c; do if sha_ok "$c"; then FOUND="$c"; break; fi; done \
			< <(find /opt /var /root /home /tmp -maxdepth 5 -name "$ARCHIVE_NAME" -type f 2>/dev/null)
	fi
	if [ -z "$FOUND" ]; then
		if [ "${ALLOW_DOWNLOAD:-0}" = "1" ]; then
			AVAIL_KB="$(df -Pk "$WORKDIR" | awk 'NR==2{print $4}')"
			[ "$AVAIL_KB" -ge $(( SNAP_SIZE_BYTES/1024 + 2*1024*1024 )) ] || die "ALLOW_DOWNLOAD=1 but not enough space in $WORKDIR ($((AVAIL_KB/1024/1024)) GB free)."
			echo "  ALLOW_DOWNLOAD=1 — downloading $ARCHIVE_URL"
			curl -fSL -C - -o "$LOCAL" "$ARCHIVE_URL" || die "download failed"
			sha_ok "$LOCAL" || die "SHA-256 MISMATCH after download."
			ok "downloaded + SHA-256 verified"
		else
			die "no SHA-verified copy of $ARCHIVE_NAME found on disk, and downloading is DISABLED (disk is short). Put the archive somewhere on this box and re-run — or, only if you truly have room, re-run with ALLOW_DOWNLOAD=1."
		fi
	else
		if same_fs "$FOUND" "$LOCAL"; then
			mv -f "$FOUND" "$LOCAL" || die "move failed"
			ok "moved into the repo from $FOUND (same filesystem — instant, ZERO extra space used)"
		else
			AVAIL_KB="$(df -Pk "$WORKDIR" | awk 'NR==2{print $4}')"
			NEED_KB=$(( $(stat -c %s "$FOUND")/1024 + 512*1024 ))
			[ "$AVAIL_KB" -ge "$NEED_KB" ] || die "$FOUND is on a DIFFERENT filesystem than $WORKDIR and there isn't room to copy it across (need ~$((NEED_KB/1024/1024)) GB, have $((AVAIL_KB/1024/1024)) GB). Set WORKDIR to a dir on the same disk as $FOUND — note it must still be inside the kubo repo root ($IPFS_PATH) for nocopy."
			cp -f "$FOUND" "$LOCAL" && rm -f "$FOUND"
			ok "copied across filesystems from $FOUND + removed the source"
		fi
		sha_ok "$LOCAL" || die "archive verify failed after move; delete $LOCAL and re-run"
	fi
fi
chown "$KUBO_USER" "$LOCAL" 2>/dev/null || true; chmod 0644 "$LOCAL"
ok "archive in place, readable by $KUBO_USER"

hdr "2. Ensure filestore (nocopy) is enabled"
if [ "$(IPFS config --json Experimental.FilestoreEnabled 2>/dev/null || echo false)" = "true" ]; then
	ok "filestore already enabled"
else
	IPFS config --json Experimental.FilestoreEnabled true || die "could not enable filestore"
	UNIT="$(systemctl list-units --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -iE 'ipfs|kubo' | head -1 || true)"
	[ -n "$UNIT" ] && { systemctl restart "$UNIT" && ok "restarted $UNIT"; }
	echo "  waiting for kubo to come back..."
	for _ in $(seq 1 20); do sleep 3; IPFS id >/dev/null 2>&1 && break; done
	IPFS id >/dev/null 2>&1 || die "kubo did not come back after restart."
	ok "filestore enabled"
fi

hdr "3. Add + pin the snapshot (nocopy)"
CID="$(IPFS add --nocopy --pin=true -Q "$LOCAL")" || die "ipfs add failed"
[ -n "$CID" ] || die "ipfs add returned no CID"
ok "pinned as CID: $CID"

hdr "4. Publish the always-newest IPNS pointer (dedicated key: $IPNS_KEY)"
if IPFS key list 2>/dev/null | grep -qx "$IPNS_KEY"; then ok "reusing IPNS key '$IPNS_KEY'"
else IPFS key gen --type=ed25519 "$IPNS_KEY" >/dev/null || die "could not create IPNS key"; ok "created IPNS key '$IPNS_KEY'"; fi
IPNS_NAME="$(IPFS key list -l 2>/dev/null | awk -v k="$IPNS_KEY" '$2==k{print $1}')"
[ -n "$IPNS_NAME" ] || die "could not resolve IPNS name for key '$IPNS_KEY'"
echo "  publishing /ipns/$IPNS_NAME -> /ipfs/$CID ..."
IPFS name publish --key="$IPNS_KEY" --allow-offline "/ipfs/$CID" >/dev/null || warn "name publish reported an issue (will re-announce)"
ok "IPNS name: $IPNS_NAME"

hdr "5. Announce to the DHT"
( IPFS routing provide "$CID" >/dev/null 2>&1 || IPFS dht provide "$CID" >/dev/null 2>&1 ) &
ok "provide kicked off (public-gateway propagation can take a few minutes)"

hdr "6. Emit the chain_snapshot_v1 payload"
cat > "$PAYLOAD" <<JSON
{
  "ipfs_cid": "$CID",
  "sha256": "$SNAP_SHA256",
  "block_height": $SNAP_HEIGHT,
  "size_bytes": $SNAP_SIZE_BYTES,
  "blurtd_version": "$BLURTD_VERSION",
  "ipns_name": "$IPNS_NAME",
  "forgejo_url": "$ARCHIVE_URL"
}
JSON
chown "$KUBO_USER" "$PAYLOAD" 2>/dev/null || true
ok "wrote $PAYLOAD"
echo ""; sed 's/^/    /' "$PAYLOAD"

hdr "DONE — next: broadcast from your laptop"
echo "  1. Copy the payload down:"
echo "       scp morphit@morphit.io:$PAYLOAD ."
echo "  2. In the Morphit repo (dry-run, then real — prompts for the @morphit POSTING WIF):"
echo "       node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/indexer/scripts/chain-snapshot-broadcast.ts snapshot-payload-$SNAP_HEIGHT.json --dry-run"
echo "       node_modules/.bin/tsx --tsconfig tsconfig.smoke.json apps/indexer/scripts/chain-snapshot-broadcast.ts snapshot-payload-$SNAP_HEIGHT.json"
echo ""
echo "  Forgejo URL is the instant fallback; blurtd_version recorded as: $BLURTD_VERSION"
