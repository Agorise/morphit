#!/bin/sh
# stage-release-dir.sh — reconstruct the canonical, DETERMINISTIC IPFS release
# directory for a given tag. (v1.9.3, Ken)
#
# SINGLE SOURCE OF TRUTH for what goes into the release's IPFS directory, called
# by BOTH:
#   - release.yml (CI), which stages from the LOCAL just-built tarball (the release
#     isn't published yet) via the MORPHIT_STAGE_* env vars below, then runs
#     `ipfs add --only-hash` on the result to compute the canonical `ipfs_cid`; and
#   - morphit-ipfs-seed.sh (the seed box, post-publish), which stages by DOWNLOADING
#     the published tarball, then `ipfs add`s it to actually HOST + announce it.
# Both paths run the SAME metadata/latest/notes logic, so the staged tree — and
# thus the CID — is byte-identical regardless of where the tarball came from. That
# is the whole point of one shared script: drift here = CID mismatch = the release
# guard rejects every release.
#
# CRITICAL: metadata.json contains ONLY tag-derived + checksum-derived fixed values
# in a FIXED key order. NO timestamp, host, or random (a live `released_utc` here
# was the determinism bug this design fixes). If you add a field it MUST be
# deterministic from the tag + the tarball's sha256, and both callers get it free.
#
# Usage:  stage-release-dir.sh <tag> <out-dir>
# Acquisition (pick one; env vars win when set):
#   LOCAL (CI):  set MORPHIT_STAGE_TARBALL=/path/morphit-<tag>.tar.gz (must exist).
#                Optional: MORPHIT_STAGE_SHA256, MORPHIT_STAGE_NOTES, MORPHIT_STAGE_ASC.
#   DOWNLOAD (seed): leave MORPHIT_STAGE_TARBALL unset → fetch the published assets
#                from MORPHIT_RELEASE_DOWNLOAD_BASE (default: the Forgejo repo).
# Other env:
#   MORPHIT_VERIFY_GUIDE_URL   verify-guide URL baked into metadata.json
# Output (bare names at root so ipns://<name>/<file> resolves directly):
#   morphit-<tag>.tar.gz  morphit-latest.tar.gz  morphit-<tag>.tar.gz.sha256
#   [morphit-<tag>.tar.gz.asc]  [RELEASE-NOTES.md  RELEASE-NOTES-<tag>.md]  metadata.json
# POSIX sh. Deterministic. No secrets.
set -eu

TAG="${1:-}"
OUT="${2:-}"
if [ -z "$TAG" ] || [ -z "$OUT" ]; then
	echo "usage: stage-release-dir.sh <tag> <out-dir>" >&2
	exit 2
fi
case "$TAG" in
	v[0-9]*.[0-9]*.[0-9]*) : ;;
	*) echo "stage-release-dir: tag '$TAG' is not vX.Y.Z" >&2; exit 2 ;;
esac
VERSION="${TAG#v}"
TARBALL="morphit-$TAG.tar.gz"
VERIFY_GUIDE="${MORPHIT_VERIFY_GUIDE_URL:-https://morphit.io/en/download}"
REPO_URL="https://git.agorise.net/agorise/morphit"

command -v sha256sum >/dev/null 2>&1 || { echo "stage-release-dir: sha256sum not found" >&2; exit 1; }
mkdir -p "$OUT"

# 1. Acquire the signed tarball (+ checksum/notes/asc) — LOCAL or DOWNLOAD.
if [ -n "${MORPHIT_STAGE_TARBALL:-}" ]; then
	# LOCAL mode (CI): copy the just-built files from the workspace.
	[ -s "$MORPHIT_STAGE_TARBALL" ] || { echo "stage-release-dir: MORPHIT_STAGE_TARBALL '$MORPHIT_STAGE_TARBALL' missing/empty" >&2; exit 1; }
	cp "$MORPHIT_STAGE_TARBALL" "$OUT/$TARBALL"
	[ -n "${MORPHIT_STAGE_SHA256:-}" ] && [ -s "$MORPHIT_STAGE_SHA256" ] && cp "$MORPHIT_STAGE_SHA256" "$OUT/$TARBALL.sha256"
	[ -n "${MORPHIT_STAGE_ASC:-}" ] && [ -s "$MORPHIT_STAGE_ASC" ] && cp "$MORPHIT_STAGE_ASC" "$OUT/$TARBALL.asc"
	if [ -n "${MORPHIT_STAGE_NOTES:-}" ] && [ -s "$MORPHIT_STAGE_NOTES" ]; then
		cp "$MORPHIT_STAGE_NOTES" "$OUT/RELEASE-NOTES-$TAG.md"
	fi
else
	# DOWNLOAD mode (seed): fetch the PUBLISHED release assets over https.
	command -v curl >/dev/null 2>&1 || { echo "stage-release-dir: curl not found (needed for download mode)" >&2; exit 1; }
	BASE="${MORPHIT_RELEASE_DOWNLOAD_BASE:-$REPO_URL/releases/download}"
	REL_BASE="$BASE/$TAG"
	echo "stage-release-dir: fetching $TARBALL + checksum…" >&2
	curl -fsSL "$REL_BASE/$TARBALL" -o "$OUT/$TARBALL"
	curl -fsSL "$REL_BASE/$TARBALL.sha256" -o "$OUT/$TARBALL.sha256"
	curl -fsSL "$REL_BASE/$TARBALL.asc" -o "$OUT/$TARBALL.asc" 2>/dev/null || rm -f "$OUT/$TARBALL.asc"
	curl -fsSL "$REL_BASE/RELEASE-NOTES-$TAG.md" -o "$OUT/RELEASE-NOTES-$TAG.md" 2>/dev/null || rm -f "$OUT/RELEASE-NOTES-$TAG.md"
fi

# 2. Compute the tarball's actual SHA-256 (authoritative for metadata).
GOT_SHA="$(sha256sum "$OUT/$TARBALL" | awk '{print $1}')"
[ -n "$GOT_SHA" ] || { echo "stage-release-dir: could not hash $TARBALL" >&2; exit 1; }

# 2a. If a .sha256 sidecar is present, it MUST match (integrity) — else write one.
if [ -s "$OUT/$TARBALL.sha256" ]; then
	WANT_SHA="$(awk '{print $1}' "$OUT/$TARBALL.sha256")"
	if [ -n "$WANT_SHA" ] && [ "$GOT_SHA" != "$WANT_SHA" ]; then
		echo "stage-release-dir: SHA-256 mismatch for $TARBALL (got $GOT_SHA want $WANT_SHA) — aborting." >&2
		exit 1
	fi
else
	printf '%s  %s\n' "$GOT_SHA" "$TARBALL" > "$OUT/$TARBALL.sha256"
fi

# 3. Stable-named copy of the SAME bytes (ipns://<name>/morphit-latest.tar.gz).
cp "$OUT/$TARBALL" "$OUT/morphit-latest.tar.gz"

# 4. Release notes: stable name alongside the versioned one (same bytes) if present.
if [ -s "$OUT/RELEASE-NOTES-$TAG.md" ]; then
	cp "$OUT/RELEASE-NOTES-$TAG.md" "$OUT/RELEASE-NOTES.md"
fi

# 5. metadata.json — DETERMINISTIC ONLY. Fixed key order. No timestamp/host/random.
{
	printf '{\n'
	printf '  "name": "Morphit",\n'
	printf '  "description": "Morphit — non-custodial, no-KYC P2P fiat<->crypto/barter marketplace on Blurt. Signed release; verify per RELEASE-NOTES.md.",\n'
	printf '  "version": "%s",\n' "$VERSION"
	printf '  "tag": "%s",\n' "$TAG"
	printf '  "tarball": "%s",\n' "$TARBALL"
	printf '  "sha256": "%s",\n' "$GOT_SHA"
	printf '  "repository": "%s",\n' "$REPO_URL"
	printf '  "release_url": "%s/releases/tag/%s",\n' "$REPO_URL" "$TAG"
	printf '  "verify_guide": "%s"\n' "$VERIFY_GUIDE"
	printf '}\n'
} > "$OUT/metadata.json"

echo "stage-release-dir: staged $TAG at $OUT" >&2
ls -1 "$OUT" | sed 's/^/  /' >&2
