#!/bin/sh
# verify-cid-public.sh — the release GUARD. (v1.9.3, the maintainer)
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
ATTEMPTS="${MORPHIT_GUARD_ATTEMPTS:-8}"
SLEEP_S="${MORPHIT_GUARD_SLEEP:-10}"
# This instance's OWN origin, if we can find one. These are the paths the
# federation actually uses and they are authoritative; public gateways are a
# convenience for outsiders with no peer list.
SELF_ORIGIN="${MORPHIT_GUARD_SELF_ORIGIN:-}"
if [ -z "$SELF_ORIGIN" ]; then
	for _f in /opt/morphit/morphit.config.env /opt/morphit/morphit.env /etc/morphit/indexer.env; do
		[ -r "$_f" ] || continue
		_v="$(sed -n 's#^[[:space:]]*\(export *\)\{0,1\}MORPHIT_INSTANCE_ORIGIN=[[:space:]]*##p' "$_f" 2>/dev/null | tail -1)" || true
		[ -z "${_v:-}" ] && _v="$(sed -n 's#^[[:space:]]*\(export *\)\{0,1\}MORPHIT_INDEXER_PUBLIC_ORIGIN=[[:space:]]*##p' "$_f" 2>/dev/null | tail -1)" || true
		if [ -n "${_v:-}" ]; then
			SELF_ORIGIN="$(printf '%s' "$_v" | sed -e 's#^"\(.*\)"$#\1#' -e "s#^'\(.*\)'\$#\1#" -e 's#/*$##')"
			break
		fi
	done
fi

# Does a source serve THIS release's metadata? Cheap: a few hundred bytes.
_serves_metadata() {
	_b="$(curl -fsSL --max-time 25 "$1/$CID/metadata.json" 2>/dev/null || true)"
	[ -n "$_b" ] || return 1
	printf '%s' "$_b" | grep -q "\"version\"[[:space:]]*:[[:space:]]*\"$WANT_VER\"" || return 1
	return 0
}

# ── 1. OUR OWN origin first. Authoritative, instant, and the seeder proved
#       the identical path seconds earlier during the upgrade. ───────────
if [ -n "$SELF_ORIGIN" ]; then
	echo "verify-cid-public: checking this instance serves $CID (version $WANT_VER) …" >&2
	if _serves_metadata "$SELF_ORIGIN/ipfs"; then
		echo "verify-cid-public: ✓ $SELF_ORIGIN serves this release. That is the path the federation uses." >&2
		# Warm a public gateway in the BACKGROUND so the first outside visitor does
		# not hit a cold fetch — but never wait on it. Gating a release on a third
		# party we do not depend on is what turned this check into a 10-minute stall.
		for gw in $GATEWAYS; do
			( curl -fsSL --max-time 600 -o /dev/null "$gw/$CID/morphit-latest.tar.gz" >/dev/null 2>&1 & ) 2>/dev/null
		done
		echo "verify-cid-public: (warming public gateways in the background; not waited on)" >&2
		exit 0
	fi
	echo "verify-cid-public: this instance did NOT serve it — that is the real problem; checking public gateways too …" >&2
fi

# ── 2. Public gateways — RESOLVABILITY only, not a 33 MB download. ──────
# The old check pulled the full tarball through a public gateway on every round,
# so each round waited on a cold multi-megabyte transfer and the budget was
# routinely exhausted on healthy content. Resolving metadata.json proves an
# outsider can FIND it, which is all this guard needs to establish.
echo "verify-cid-public: checking $CID resolves (version $WANT_VER) on a public gateway…" >&2
round=1
while [ "$round" -le "$ATTEMPTS" ]; do
	for gw in $GATEWAYS; do
		if _serves_metadata "$gw"; then
			echo "verify-cid-public: ✓ resolvable on $gw (round $round) — version $WANT_VER confirmed." >&2
			( curl -fsSL --max-time 600 -o /dev/null "$gw/$CID/morphit-latest.tar.gz" >/dev/null 2>&1 & ) 2>/dev/null
			echo "verify-cid-public: (warming the tarball in the background; not waited on)" >&2
			exit 0
		fi
	done
	echo "verify-cid-public: round $round/$ATTEMPTS — not yet resolvable, waiting ${SLEEP_S}s (cold content propagates)…" >&2
	round=$((round + 1))
	[ "$round" -le "$ATTEMPTS" ] && sleep "$SLEEP_S"
done

echo "verify-cid-public: ✗ $CID did not resolve on a public gateway within budget." >&2
if [ -n "$SELF_ORIGIN" ]; then
	echo "  Your own origin did not serve it either, so this is NOT just slow propagation." >&2
	echo "  DO NOT BROADCAST. Check: systemctl status ipfs, and whether the seed step ran." >&2
	exit 1
fi
echo "  Could not determine this instance's own origin, so this check could only ask" >&2
echo "  third-party gateways — which are slow for fresh content and are NOT the path" >&2
echo "  the federation uses. Verify locally before deciding:" >&2
echo "    curl -fsS -o /dev/null -w '%{http_code}\n' https://<your-domain>/ipfs/$CID/metadata.json" >&2
exit 1
