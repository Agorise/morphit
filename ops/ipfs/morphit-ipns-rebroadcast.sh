#!/bin/sh
# morphit-ipns-rebroadcast.sh — re-announce Morphit's signed IPNS record to the
# public DHT, so ipns://<name> always resolves to the LATEST release — with NO
# third-party naming service and NO private key on this box. Runs on a timer.
#
# Privacy #1 / Decentralization #2 (Ken): the STABLE IPNS name the download page
# links (ipns://<name>/morphit-latest.tar.gz) resolves over the PUBLIC DHT. DHT
# IPNS records expire in ~48h, so every instance re-PUTs the SAME signed record
# every few hours — as long as ONE instance is alive, the name stays resolvable
# on any gateway. (w3name is gone: it stored records off-DHT, so gateways never
# found them.)
#
# TRUST MODEL — why this is safe on an untrusted federated instance: this node
# only REBROADCASTS a record @morphit already signed (read from this instance's
# OWN indexer, /v1/release -> distribution.ipns_record, which the indexer learned
# from the Blurt chain). Re-publishing an existing signed record to the DHT does
# NOT need the private key; MINTING or bumping one DOES (the sequence number is
# signed). So this node physically cannot repoint the name — the worst it can do
# is re-announce the record you signed. Kubo validates the signature before it
# accepts the PUT.
#
# POSIX sh (dash-safe). Every failure is non-fatal + logged — a rebroadcast
# problem must never take an instance down. No secrets; no key material ever
# touches this box.
#
# Config (env, e.g. from /etc/morphit/ipfs-pin.env):
#   MORPHIT_RELEASE_URL       full URL to /v1/release (default: local indexer).
#   MORPHIT_INDEXER_PORT      port for the default local URL (default 8088).
#   IPFS_PATH                 Kubo repo dir (default /var/lib/ipfs/.ipfs).
#   MORPHIT_IPNS_PUT_TIMEOUT  seconds for the DHT put (default 120).
#   MORPHIT_IPNS_DRYRUN       =1 to validate + print the plan WITHOUT putting.

set -u

log() { echo "morphit-ipns-rebroadcast: $*" >&2; }

RELEASE_URL="${MORPHIT_RELEASE_URL:-http://127.0.0.1:${MORPHIT_INDEXER_PORT:-8088}/v1/release}"
PUT_TIMEOUT="${MORPHIT_IPNS_PUT_TIMEOUT:-120}"
DRYRUN="${MORPHIT_IPNS_DRYRUN:-0}"
export IPFS_PATH="${IPFS_PATH:-/var/lib/ipfs/.ipfs}"

command -v ipfs >/dev/null 2>&1 || { log "ipfs (Kubo) not installed — skipping."; exit 0; }
command -v curl >/dev/null 2>&1 || { log "curl not installed — skipping."; exit 0; }
command -v base64 >/dev/null 2>&1 || { log "base64 not available — skipping."; exit 0; }

# 1. Ask our own indexer for the latest release's IPNS name + signed record.
RESP="$(curl -fsS --max-time 20 "$RELEASE_URL" 2>/dev/null)" || {
	log "could not reach $RELEASE_URL (indexer not up yet?) — will retry next run."
	exit 0
}

# jq-free flat-text extraction (same approach as morphit-ipfs-pin.sh).
extract() {
	printf '%s' "$RESP" \
		| grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
		| head -n1 \
		| sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/'
}

NAME="$(extract ipns_name)"
RECORD_B64="$(extract ipns_record)"
VER="$(extract version)"
if [ -z "${NAME:-}" ] || [ -z "${RECORD_B64:-}" ]; then
	log "release ${VER:-?} carries no ipns_name/ipns_record — nothing to rebroadcast (older release, or no signing key configured)."
	exit 0
fi

# 2. Decode the signed record to raw bytes. Kubo re-verifies the signature on PUT;
# here we only turn the base64 back into the marshaled record it will PUT.
TMP="$(mktemp)" || { log "mktemp failed — skipping."; exit 0; }
trap 'rm -f "$TMP"' EXIT
if ! printf '%s' "$RECORD_B64" | base64 -d > "$TMP" 2>/dev/null; then
	log "ipns_record is not valid base64 — refusing to PUT (release ${VER:-?})."
	exit 1
fi
[ -s "$TMP" ] || { log "decoded ipns_record is empty — refusing to PUT."; exit 1; }

KEY="/ipns/$NAME"

if [ "$DRYRUN" = "1" ]; then
	log "DRY RUN: would 'ipfs routing put $KEY' with a $(wc -c < "$TMP")-byte signed record (release ${VER:-?})."
	log "DRY RUN: after a real run, verify with: ipfs routing get $KEY  — and resolve ipns://$NAME on any gateway."
	exit 0
fi

# 3. Daemon reachable? (the timer may fire before Kubo is up.)
if ! ipfs --timeout=10s id >/dev/null 2>&1; then
	log "Kubo daemon not reachable (IPFS_PATH=$IPFS_PATH) — will retry next run."
	exit 0
fi

# 4. Re-announce to the DHT. `ipfs routing put` re-publishes the SIGNED record under
# its /ipns/<name> routing key WITHOUT the private key (Kubo validates the signature,
# then PUTs to the DHT), refreshing it before the ~48h DHT expiry.
# NB — verify on the box: if a Kubo build won't accept a foreign record via
# `routing put`, the HTTP Routing V1 endpoint PUTs the same signed bytes:
#   curl -fsS -X PUT --data-binary @"$TMP" "http://127.0.0.1:8081/routing/v1/ipns/$NAME"
# (the gateway port is 8081 per morphit-ipfs-setup.sh). The CLI path is preferred
# where it works; both put an identical record.
log "rebroadcasting IPNS record for release ${VER:-?} -> $KEY (timeout ${PUT_TIMEOUT}s)…"
if ipfs --timeout="${PUT_TIMEOUT}s" routing put "$KEY" "$TMP" >/dev/null 2>&1; then
	log "rebroadcast OK — ipns://$NAME refreshed on the DHT (resolves to the latest release)."
	exit 0
else
	log "routing put did not finish for $KEY (DHT slow / daemon busy) — will retry next run."
	exit 1
fi
