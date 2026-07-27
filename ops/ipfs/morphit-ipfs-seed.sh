#!/bin/sh
# morphit-ipfs-seed.sh — make THIS node the origin IPFS host for a release.
# (v1.9.3, Ken)
#
# Sibling to morphit-ipfs-pin.sh, but for the ORIGIN. The pin script FETCHES an
# already-network-available CID (`ipfs pin add`); this script HOSTS a release the
# network may not have yet, by reconstructing the exact release directory and
# `ipfs add`ing it. Naturally run on Ken's release box (the first node to hold the
# files); every other instance then pins from it via morphit-ipfs-pin.sh.
#
# Determinism: the directory is built by ops/ipfs/stage-release-dir.sh — the SAME
# script CI uses for its `--only-hash` CID — so the CID produced here EQUALS the
# canonical `ipfs_cid` CI anchored on-chain. This script asserts that equality and
# fails loud on mismatch (belt-and-suspenders against a Kubo default change or a
# staging drift). Proven end-to-end in the cp573 spike: a VPS `ipfs add` resolved
# on ipfs.io + dweb.link.
#
# Usage:  morphit-ipfs-seed.sh <tag> [expected_cid]
#   e.g.  morphit-ipfs-seed.sh v1.9.3 bafybeibebk6sxb...
#   - <tag>          the release tag to seed (vX.Y.Z).
#   - [expected_cid] the CID this MUST produce (the tag's anchored ipfs_cid). If
#                    omitted, it is read from the TAG's published
#                    distribution-anchor.env (release.yml attaches it) — the
#                    tag-authoritative CID. NOT /v1/release, which serves the
#                    CURRENTLY broadcast release and would be the WRONG (older)
#                    CID when seeding a newer release pre-broadcast (e.g. from the
#                    morphit-ops upgrade). If the anchor has no CID yet, the
#                    script just adds + prints (no assertion).
# Env:
#   IPFS_PATH                 Kubo repo (default /var/lib/ipfs/.ipfs)
#   MORPHIT_RELEASE_DOWNLOAD_BASE   base URL for release assets (fetch the tag's anchor when expected_cid omitted)
#   IPFS_ADD_TIMEOUT          seconds for the add (default 900)
# Run as the ipfs service user (the systemd unit / morphit-ops handle that):
#   sudo -u ipfs env IPFS_PATH=/var/lib/ipfs/.ipfs morphit-ipfs-seed.sh v1.9.3 <cid>
# POSIX sh. Idempotent (re-adding the same bytes is a no-op → same CID).
set -eu

log() { echo "morphit-ipfs-seed: $*" >&2; }

TAG="${1:-}"
EXPECTED="${2:-}"
if [ -z "$TAG" ]; then
	echo "usage: morphit-ipfs-seed.sh <tag> [expected_cid]" >&2
	exit 2
fi
case "$TAG" in
	v[0-9]*.[0-9]*.[0-9]*) : ;;
	*) log "tag '$TAG' is not vX.Y.Z"; exit 2 ;;
esac

export IPFS_PATH="${IPFS_PATH:-/var/lib/ipfs/.ipfs}"
ADD_TIMEOUT="${IPFS_ADD_TIMEOUT:-900}"

command -v ipfs >/dev/null 2>&1 || { log "ipfs (Kubo) not installed — run morphit-ipfs-setup.sh first."; exit 1; }

# Locate the staging script next to this one.
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
STAGER="$HERE/stage-release-dir.sh"
[ -x "$STAGER" ] || [ -f "$STAGER" ] || { log "stage-release-dir.sh not found next to this script"; exit 1; }

# 1. Daemon reachable? (the add needs it; the timer/unit starts it.)
if ! ipfs --timeout=10s id >/dev/null 2>&1; then
	log "Kubo daemon not reachable (IPFS_PATH=$IPFS_PATH) — is ipfs.service up?"
	exit 1
fi

# 2. If no expected CID was passed, read it from the TAG's published
#    distribution-anchor.env (release.yml attaches it) — the tag-authoritative
#    CID. NOT /v1/release, which serves the CURRENTLY broadcast release (the
#    WRONG, older CID when seeding a newer release pre-broadcast).
if [ -z "$EXPECTED" ] && command -v curl >/dev/null 2>&1; then
	ANCHOR_URL="${MORPHIT_RELEASE_DOWNLOAD_BASE:-https://git.agorise.net/agorise/morphit/releases/download}/$TAG/distribution-anchor.env"
	ANCHOR="$(curl -fsS --max-time 20 "$ANCHOR_URL" 2>/dev/null || true)"
	EXPECTED="$(printf '%s' "$ANCHOR" \
		| sed -n 's/^[[:space:]]*export MORPHIT_BUILD_IPFS_CID=//p' \
		| tr -d '"' | head -n1)"
	[ -n "$EXPECTED" ] && log "expected CID from $TAG anchor: $EXPECTED"
fi

# 3. Reconstruct the canonical directory (SAME script CI hashed) + add it.
STAGE="$(mktemp -d)/morphit"
mkdir -p "$STAGE"
log "staging $TAG…"
sh "$STAGER" "$TAG" "$STAGE"

log "ipfs add (timeout ${ADD_TIMEOUT}s)…"
CID="$(ipfs --timeout="${ADD_TIMEOUT}s" add -rQ --cid-version 1 "$STAGE")"
rm -rf "$(dirname "$STAGE")" 2>/dev/null || true
[ -n "$CID" ] || { log "ipfs add produced no CID"; exit 1; }
log "hosted $TAG → $CID"

# 4. Determinism assertion — the produced CID MUST equal the anchored one.
if [ -n "$EXPECTED" ]; then
	if [ "$CID" != "$EXPECTED" ]; then
		log "✗ CID MISMATCH — produced $CID but the release anchors $EXPECTED."
		log "  Staging drifted or Kubo defaults changed. NOT the canonical bytes; refusing silently to seed a divergent CID."
		exit 1
	fi
	log "✓ CID matches the anchored ipfs_cid ($CID)."
fi

# 5. Announce it promptly so gateways + other instances can find it (best-effort).
if ipfs --timeout=60s routing provide "$CID" >/dev/null 2>&1; then
	log "announced $CID to the network."
else
	log "routing provide did not complete (non-fatal) — the daemon reprovides on its own schedule."
fi

echo "$CID"
log "done. Resolve: https://ipfs.io/ipfs/$CID/metadata.json  |  ipns://<name>/morphit-latest.tar.gz"
