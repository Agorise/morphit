#!/bin/sh
# morphit-ipfs-pin.sh — pin THIS instance's current signed release to its own
# IPFS (Kubo) node, so Morphit's releases stay available even if every
# commercial pinning service drops them. Runs on a timer + on boot.
#
# Decentralization, priority #2: every Morphit operator helps host the signed
# releases. The CID is read from the instance's OWN indexer (/v1/release →
# distribution.ipfs_cid), which the indexer learned from the Blurt chain — so
# there's no trusted third party in the loop, and each node independently pins
# the exact bytes the chain anchors. Pinning is BY CID: `ipfs pin add` fetches
# and keeps the exact content the on-chain hash covers, so we never re-derive a
# (possibly different) CID.
#
# POSIX sh (dash-safe). Every failure is non-fatal + logged — a pin problem
# must never take an instance down. Idempotent: re-pinning a held CID is a no-op.
#
# Config (env, e.g. from /etc/morphit/ipfs-pin.env):
#   MORPHIT_RELEASE_URL   full URL to /v1/release (default: local indexer).
#   MORPHIT_INDEXER_PORT  port for the default local URL (default 8088).
#   IPFS_PATH             Kubo repo dir (default /var/lib/ipfs/.ipfs).
#   MORPHIT_IPFS_PIN_TIMEOUT  seconds for the pin fetch (default 900).

set -u

log() { echo "morphit-ipfs-pin: $*" >&2; }

# Manual runs (not via systemd) don't get the unit's EnvironmentFile, so load the
# operator's persisted config here too — keeps `sudo …morphit-ipfs-pin.sh` in sync
# with the timer (both then read MORPHIT_RELEASE_URL from the same file).
# Root-written (0640) trusted config; simple KEY=value lines, safe under `set -u`.
[ -r /etc/morphit/ipfs-pin.env ] && . /etc/morphit/ipfs-pin.env

RELEASE_URL="${MORPHIT_RELEASE_URL:-http://127.0.0.1:${MORPHIT_INDEXER_PORT:-8088}/v1/release}"
PIN_TIMEOUT="${MORPHIT_IPFS_PIN_TIMEOUT:-900}"
export IPFS_PATH="${IPFS_PATH:-/var/lib/ipfs/.ipfs}"

command -v ipfs >/dev/null 2>&1 || { log "ipfs (Kubo) not installed — skipping."; exit 0; }
command -v curl >/dev/null 2>&1 || { log "curl not installed — skipping."; exit 0; }

# 1. Ask our own indexer for the latest verified release + its distribution block.
RESP="$(curl -fsS --max-time 20 "$RELEASE_URL" 2>/dev/null)" || {
	log "could not reach $RELEASE_URL (indexer not up yet?) — will retry next run."
	exit 0
}

# 2. Pull ipfs_cid out of the (flat-text) JSON without a jq dependency.
CID="$(printf '%s' "$RESP" \
	| grep -o '"ipfs_cid"[[:space:]]*:[[:space:]]*"[^"]*"' \
	| head -n1 \
	| sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')"
if [ -z "${CID:-}" ]; then
	log "no ipfs_cid in the current release (release carried no pinned copy) — nothing to pin."
	exit 0
fi
VER="$(printf '%s' "$RESP" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')"

# 3. Make sure the daemon is reachable (the timer may fire before it's up).
if ! ipfs --timeout=10s id >/dev/null 2>&1; then
	log "Kubo daemon not reachable (IPFS_PATH=$IPFS_PATH) — will retry next run."
	exit 0
fi

# 4. Already pinned? (recursive pin of this CID present) → done.
if ipfs --timeout=20s pin ls --type=recursive "$CID" >/dev/null 2>&1; then
	log "release ${VER:-?} already pinned ($CID)."
	exit 0
fi

# 5. Pin it (fetches the exact anchored bytes, then keeps them).
log "pinning release ${VER:-?} → $CID (timeout ${PIN_TIMEOUT}s)…"
if ipfs --timeout="${PIN_TIMEOUT}s" pin add --progress=false "$CID" >/dev/null 2>&1; then
	log "pinned $CID — this node now serves release ${VER:-?} over IPFS."
	# Best-effort: drop stale pins from older releases so the repo doesn't grow
	# unbounded. Only unpins recursive roots that are NOT the current CID and
	# look like release dirs we pinned; GC actually frees the blocks.
	exit 0
else
	log "pin add did not finish for $CID (network slow / content not yet reachable) — will retry next run."
	exit 1
fi
