#!/usr/bin/env bash
#
# make-snapshot.sh — create a TRUSTLESS block_log snapshot on a hidden-rpc node
# (run this on Star OR Jade — not both at once; the other keeps serving).
#
# It briefly stops blurtd, packages the raw block_log (+ its index) straight out
# of the docker volume, prints the exact values you'll hand to the broadcast
# step, and restarts blurtd. blurtd is ALWAYS brought back up, even on error.
#
# The output archive is what hidden-rpc v0.1.6's installer expects: a tar
# containing a file named `block_log` (its place_block_log accepts
# .tar.zst/.tar.gz/.tar/bare). sha256 + blurtd's own replay make the download
# trustless, so it's safe to host anywhere (Forgejo).
#
#   sudo bash make-snapshot.sh
#
# Overridable: VOLUME (default blurtd), CONTAINER (default blurtd),
#              OUT (default ~/block_log-snapshot), ZSTD_LEVEL (default 3).
#
set -euo pipefail

VOLUME="${VOLUME:-blurtd}"
CONTAINER="${CONTAINER:-blurtd}"
OUT="${OUT:-$HOME/block_log-snapshot}"
ZSTD_LEVEL="${ZSTD_LEVEL:-3}"     # fast; block_log barely compresses, don't burn CPU
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
dock(){ $SUDO docker "$@"; }
vrun(){ dock run --rm -v "$VOLUME":/blurtd busybox "$@"; }

command -v docker >/dev/null || { echo "docker not found — is this a hidden-rpc node?"; exit 1; }
dock volume inspect "$VOLUME" >/dev/null 2>&1 || { echo "docker volume '$VOLUME' not found (set VOLUME=…)"; exit 1; }
vrun sh -c '[ -f /blurtd/blockchain/block_log ]' || { echo "no block_log in volume '$VOLUME' — is this node synced?"; exit 1; }
mkdir -p "$OUT"

# ── height from block_log.index (8 bytes per block) ──────────────────
IDXB=$(vrun sh -c 'wc -c < /blurtd/blockchain/block_log.index 2>/dev/null' | tr -d '[:space:]' || true)
if [ -n "${IDXB:-}" ] && [ "$IDXB" -gt 0 ] 2>/dev/null; then
	HEIGHT=$(( IDXB / 8 ))
else
	echo "!! couldn't read block_log.index; blurtd will rebuild it on the consumer,"
	echo "   but I need the height for the op. Enter the current head block number:"
	read -r HEIGHT
fi
BVER=$(dock inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || echo unknown)
echo "chain height ≈ $HEIGHT   |   blurtd image: $BVER"

# ── stop blurtd for a consistent copy; ALWAYS restart on the way out ──
STARTED=1
restart(){ if [ "$STARTED" = 0 ]; then echo "restarting blurtd…"; dock start "$CONTAINER" >/dev/null 2>&1 || true; STARTED=1; fi; }
trap restart EXIT
echo "stopping blurtd for a clean copy (this node stops serving until it's back)…"
dock stop "$CONTAINER" >/dev/null; STARTED=0

# ── package block_log (+ index) from the volume → compressed archive ─
if command -v zstd >/dev/null; then EXT="tar.zst"; COMP=(zstd -T0 "-$ZSTD_LEVEL" -q); else EXT="tar.gz"; COMP=(gzip -1); fi
ARCHIVE="$OUT/block_log-${HEIGHT}.${EXT}"
echo "packaging → $ARCHIVE   (~27–30 GB source; go make coffee)…"
vrun sh -c 'cd /blurtd/blockchain && tar cf - block_log $( [ -f block_log.index ] && echo block_log.index )' \
	| "${COMP[@]}" > "$ARCHIVE"

restart; trap - EXIT     # blurtd back up ASAP, before the slow hashing

# ── hash + size + write the values file ──────────────────────────────
echo "hashing (sha256 — the trust anchor)…"
SHA=$(sha256sum "$ARCHIVE" | awk '{print $1}')
SIZE=$(stat -c%s "$ARCHIVE")
VALUES="$OUT/snapshot-values.env"
cat > "$VALUES" <<EOF
# chain_snapshot_v1 values — pass this file to pin-snapshot.sh and broadcast-op.sh
SNAP_ARCHIVE="$ARCHIVE"
SNAP_SHA256="$SHA"
SNAP_HEIGHT="$HEIGHT"
SNAP_SIZE_BYTES="$SIZE"
SNAP_BLURTD_IMAGE="$BVER"
EOF

echo
echo "════════════════════════════════════════════════════════════"
echo "  DONE — blurtd is back up and serving."
echo "  archive : $ARCHIVE"
echo "            $(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes")"
echo "  sha256  : $SHA"
echo "  height  : $HEIGHT"
echo "  values  : $VALUES"
echo "════════════════════════════════════════════════════════════"
echo
echo "NEXT: upload  $ARCHIVE  to Forgejo (that's the https mirror), then run"
echo "      pin-snapshot.sh on a box with kubo to get the IPFS CID."
