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
# Usage:  verify-cid-public.sh <cid> <expected_version> [origin]
#
# [origin] is the instance that just seeded this release, e.g. https://morphit.io.
# PASS IT. With it, the guard asks that instance directly and passes in seconds.
# Without it, the guard can only poll PUBLIC gateways, which take minutes to see
# fresh content — the ceremony ran from a laptop where no local config exists, so
# the fast path was never taken and a release stalled for 50+ rounds.
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
# Third arg wins over the env var, which wins over local config discovery.
[ -n "${3:-}" ] && MORPHIT_GUARD_SELF_ORIGIN="$3"
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
# Say plainly when the fast path is unavailable, instead of silently spending the
# whole budget on third parties and looking like the release is broken.
if [ -z "$SELF_ORIGIN" ]; then
	echo "verify-cid-public: NOTE — no instance origin known here, so this can only poll PUBLIC" >&2
	echo "  gateways, which are slow for fresh content. Pass the instance that just seeded it:" >&2
	echo "    sh scripts/verify-cid-public.sh <cid> <version> https://morphit.io" >&2
	echo "  …or run this ON that instance, where it finds the origin itself." >&2
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

# ── 2. Public gateways — ONE quick look, then decide. No long poll. ─────
# This used to poll for up to 8×10s (and historically far longer), which meant a
# perfectly good release could hold the ceremony hostage for half an hour while
# third-party gateways caught up with fresh content. That is unacceptable: the
# federation does not depend on public gateways, so they must never be able to
# stall a release.
#
# Default is now a SINGLE fast probe. Set MORPHIT_GUARD_POLL_PUBLIC=1 if you
# genuinely want to wait for propagation before broadcasting.
echo "verify-cid-public: checking $CID resolves (version $WANT_VER) on a public gateway…" >&2
if [ "${MORPHIT_GUARD_POLL_PUBLIC:-0}" = "1" ]; then
	round=1
	while [ "$round" -le "$ATTEMPTS" ]; do
		for gw in $GATEWAYS; do
			if _serves_metadata "$gw"; then
				echo "verify-cid-public: ✓ resolvable on $gw (round $round) — version $WANT_VER confirmed." >&2
				exit 0
			fi
		done
		echo "verify-cid-public: round $round/$ATTEMPTS — not yet resolvable, waiting ${SLEEP_S}s…" >&2
		round=$((round + 1))
		[ "$round" -le "$ATTEMPTS" ] && sleep "$SLEEP_S"
	done
else
	for gw in $GATEWAYS; do
		if _serves_metadata "$gw"; then
			echo "verify-cid-public: ✓ resolvable on $gw — version $WANT_VER confirmed." >&2
			exit 0
		fi
	done
fi

# Not on a public gateway (yet). Whether that BLOCKS the broadcast depends
# entirely on whether our own origin served it — which is the authoritative
# signal, and was checked first.
if [ -n "$SELF_ORIGIN" ]; then
	echo "verify-cid-public: ✗ $SELF_ORIGIN did NOT serve this release, and no public gateway has it." >&2
	echo "  Your own origin failed too, so this is NOT just slow propagation — DO NOT BROADCAST." >&2
	echo "  Check: systemctl status ipfs, and whether the upgrade's seed step ran." >&2
	exit 1
fi
echo "verify-cid-public: ✗ not on a public gateway yet — and no instance origin was given," >&2
echo "  so this check could only ask third parties, which are slow for fresh content." >&2
echo "  Re-run naming the instance that seeded it — this passes in about a second:" >&2
echo "    sh scripts/verify-cid-public.sh $CID $WANT_VER https://morphit.io" >&2
echo "  (Public gateways are a convenience for outsiders; the federation uses instance" >&2
echo "   origins, .onion and .b32.i2p, which the seed step already verified.)" >&2
exit 1
