#!/bin/sh
# verify-cid-public.sh — the release GUARD. (v1.9.3, Ken)
#
# Refuses to let a release anchor/broadcast a CID the public can't actually fetch.
# Run on the laptop during the ELI5 ceremony, AFTER the seed box has `ipfs add`ed
# the release (morphit-ipfs-seed.sh) and BEFORE the on-chain broadcast. If this
# fails, DO NOT broadcast — an immutable Blurt op pointing at unreachable content
# is permanent. This is the check that would have stopped the dead Qmb11…/empty
# bafkr… CIDs from ever nearing the chain.
#
# Rule (from the cp573 spike): pass on the FIRST independent public gateway that
# serves the CID's metadata.json with the expected version. A healthy node
# routinely has one gateway serve instantly while another 504s on cold content, so
# requiring ALL gateways would be flaky and could block a good release. We poll a
# couple, with backoff, and succeed on first hit.
#
# Usage:  verify-cid-public.sh <cid> <expected_version>
#   e.g.  verify-cid-public.sh bafybei... 1.9.3
# Env:
#   MORPHIT_GUARD_GATEWAYS   space-separated gateway bases (default: ipfs.io + dweb.link)
#   MORPHIT_GUARD_ATTEMPTS   poll rounds across all gateways (default 12)
#   MORPHIT_GUARD_SLEEP      seconds between rounds (default 15)  → ~3 min budget
# Exit: 0 = a public gateway served the right content; 1 = never resolved in budget.
# POSIX sh. Read-only (fetches), no secrets.
set -u

CID="${1:-}"
WANT_VER="${2:-}"
if [ -z "$CID" ] || [ -z "$WANT_VER" ]; then
	echo "usage: verify-cid-public.sh <cid> <expected_version>" >&2
	exit 2
fi
command -v curl >/dev/null 2>&1 || { echo "verify-cid-public: curl not found" >&2; exit 1; }

GATEWAYS="${MORPHIT_GUARD_GATEWAYS:-https://ipfs.io/ipfs https://dweb.link/ipfs}"
ATTEMPTS="${MORPHIT_GUARD_ATTEMPTS:-12}"
SLEEP_S="${MORPHIT_GUARD_SLEEP:-15}"

echo "verify-cid-public: checking $CID resolves (version $WANT_VER) on a public gateway…" >&2

round=1
while [ "$round" -le "$ATTEMPTS" ]; do
	for gw in $GATEWAYS; do
		URL="$gw/$CID/metadata.json"
		BODY="$(curl -fsSL --max-time 25 "$URL" 2>/dev/null || true)"
		if [ -n "$BODY" ]; then
			# Confirm it's the RIGHT release's directory, not just any 200.
			if printf '%s' "$BODY" | grep -q "\"version\"[[:space:]]*:[[:space:]]*\"$WANT_VER\""; then
				echo "verify-cid-public: ✓ served by $gw (round $round) — version $WANT_VER confirmed." >&2
				echo "  $URL" >&2
				exit 0
			else
				echo "verify-cid-public: $gw served metadata but version != $WANT_VER — wrong CID? Not accepting." >&2
			fi
		fi
	done
	echo "verify-cid-public: round $round/$ATTEMPTS — not yet resolvable, waiting ${SLEEP_S}s (cold content propagates)…" >&2
	round=$((round + 1))
	[ "$round" -le "$ATTEMPTS" ] && sleep "$SLEEP_S"
done

echo "verify-cid-public: ✗ $CID did NOT resolve on any public gateway within budget." >&2
echo "  DO NOT BROADCAST. Check the seed: is ipfs.service up, is TCP/UDP 4001 reachable," >&2
echo "  and did 'ipfs routing provide' run? (See docs/IPFS-DISTRIBUTION-v1.9.3.md §6.)" >&2
exit 1
