#!/usr/bin/env bash
#
# snapshot-mirror.sh — the job morphit-snapshot-mirror.timer runs on EVERY
# instance. Keeps this box serving the newest federation indexer snapshot so a
# brand-new node can fast-sync from whichever peer is nearest to it.
#
# Companion to snapshot-autopublish.sh, and the division of labour matters:
#   - autopublish  runs ONLY on the canonical box (@morphit): it EXPORTS its own
#                  DB, pins it, and ANCHORS the result on-chain. One signer.
#   - this script  runs EVERYWHERE: it pins the CID that was already anchored and
#                  re-serves it. Many mirrors, no new signature, no new trust.
#
# A newcomer proves the bytes against the on-chain SHA-256, so mirroring is a
# reachability contribution, not a trust claim — which is why every instance can
# do it without being vetted, and why losing any one box (including morphit.io)
# no longer stops new instances from coming online.
#
# Everything is best-effort: a box that cannot mirror right now just retries next
# run. The script always exits 0 so it can be safely chained into an upgrade.
#
# Config (env, e.g. /etc/morphit/snapshot-mirror.env):
#   MORPHIT_REPO_PATH     (default /opt/morphit)
#   MORPHIT_INDEXER_ENV   (default /etc/morphit/indexer.env)
#   MORPHIT_SNAPSHOT_SIGNER  (default morphit — whose anchor we mirror)
set -uo pipefail
REPO="${MORPHIT_REPO_PATH:-/opt/morphit}"
INDEXER_ENV="${MORPHIT_INDEXER_ENV:-/etc/morphit/indexer.env}"
SIGNER="${MORPHIT_SNAPSHOT_SIGNER:-morphit}"
TSX="$REPO/node_modules/.bin/tsx"
TSCFG="$REPO/tsconfig.smoke.json"
log() { printf '[snapshot-mirror] %s\n' "$1"; }
skip() { log "SKIP: $1"; exit 0; } # never a failure — mirroring is opportunistic

[ -d "$REPO" ] || skip "repo not found at $REPO (set MORPHIT_REPO_PATH)"
[ -x "$TSX" ] || skip "tsx not found at $TSX — is the repo installed?"
[ -r "$INDEXER_ENV" ] || skip "indexer env not readable at $INDEXER_ENV"
command -v ipfs >/dev/null 2>&1 || skip "no IPFS on this box — nothing to mirror"

# Load the indexer env INERTLY (never source it — values may contain spaces or
# shell metacharacters, and this file holds the node's real configuration).
set -a
while IFS='=' read -r k v; do
	case "$k" in
		MORPHIT_*) export "$k"="$(printf '%s' "$v" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")" ;;
	esac
done < "$INDEXER_ENV"
set +a
# Inside `morphit-ops upgrade` (output piped, not a systemd unit) the indexer
# library's own log lines (RPC pool, hidden routing) are noise: this script
# reports its result itself. The weekly timer (a systemd unit: INVOCATION_ID)
# and a run at a terminal keep the log level from indexer.env, with the reason
# each RPC node failed.
if [ "${MORPHIT_QUIET_BUILD:-}" = 1 ] || { [ -z "${INVOCATION_ID:-}" ] && [ ! -t 1 ]; }; then
	export MORPHIT_LOG_LEVEL=error
fi

cd "$REPO" || skip "could not enter $REPO"
"$TSX" --tsconfig "$TSCFG" apps/indexer/scripts/snapshot-mirror.ts --signer "$SIGNER" || true
exit 0
