#!/bin/sh
# stage-release-dir.sh — reconstruct the canonical, DETERMINISTIC IPFS release
# directory for a given tag. (v1.9.5, Ken)
#
# SINGLE SOURCE OF TRUTH for what goes into the release's IPFS directory, called
# by BOTH:
#   - release.yml (CI), which stages from the LOCAL just-built tarball (the release
#     isn't published yet) via the MORPHIT_STAGE_* env vars below, then runs
#     `ipfs add --only-hash` on the result to compute the canonical `ipfs_cid`; and
#   - morphit-ipfs-seed.sh (the seed box, post-publish), which stages by DOWNLOADING
#     the published tarball, then `ipfs add`s it to actually HOST + announce it.
# Both paths run the SAME metadata/latest/notes/readme logic, so the staged tree —
# and thus the CID — is byte-identical regardless of where the tarball came from.
# That is the whole point of one shared script: drift here = CID mismatch = the
# release guard rejects every release.
#
# DISCOVERABILITY (v1.9.5, Ken): the directory is a rich, self-describing bundle —
# a generated README.md, a keyword-tagged metadata.json, and the release notes —
# so IPFS content crawlers (and humans browsing a gateway) can find + identify it.
#
# CRITICAL — DETERMINISM: every file here MUST be reproducible byte-for-byte by BOTH
# the local (CI) and download (seed) paths. So:
#   - metadata.json / README.md contain ONLY tag-derived + checksum-derived values
#     and FIXED text, in a FIXED order. NO timestamp, host, or random (a live
#     `released_utc` here was the determinism bug this design fixes).
#   - RELEASE-NOTES.md is EXTRACTED FROM THE TARBALL (which both callers hold,
#     byte-identical), NOT fetched separately. Fetching a file CI has locally but the
#     seed cannot download would diverge the CID (the v1.9.3 notes-in-dir bug). The
#     rule is not "no notes" — it is "no EXTERNAL fetch-dependency": anything derived
#     from the verified tarball itself is fine.
# Signatures (.asc) still live on the release page/mirrors, not here.
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

# 1. Acquire the signed tarball (+ checksum) — LOCAL or DOWNLOAD.
if [ -n "${MORPHIT_STAGE_TARBALL:-}" ]; then
	# LOCAL mode (CI): copy the just-built files from the workspace.
	[ -s "$MORPHIT_STAGE_TARBALL" ] || { echo "stage-release-dir: MORPHIT_STAGE_TARBALL '$MORPHIT_STAGE_TARBALL' missing/empty" >&2; exit 1; }
	cp "$MORPHIT_STAGE_TARBALL" "$OUT/$TARBALL"
	[ -n "${MORPHIT_STAGE_SHA256:-}" ] && [ -s "${MORPHIT_STAGE_SHA256}" ] && cp "$MORPHIT_STAGE_SHA256" "$OUT/$TARBALL.sha256"
else
	# DOWNLOAD mode (seed): fetch the PUBLISHED release assets over https.
	command -v curl >/dev/null 2>&1 || { echo "stage-release-dir: curl not found (needed for download mode)" >&2; exit 1; }
	BASE="${MORPHIT_RELEASE_DOWNLOAD_BASE:-$REPO_URL/releases/download}"
	REL_BASE="$BASE/$TAG"
	echo "stage-release-dir: fetching $TARBALL + checksum…" >&2
	curl -fsSL "$REL_BASE/$TARBALL" -o "$OUT/$TARBALL"
	curl -fsSL "$REL_BASE/$TARBALL.sha256" -o "$OUT/$TARBALL.sha256"
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

# 4. Release notes — EXTRACTED FROM THE TARBALL (not fetched). The tarball is a
# `tar` of the repo tree, so it carries RELEASE-NOTES-<tag>.md at its root. Both
# callers hold the SAME verified tarball, so the extracted bytes are identical →
# the CID stays deterministic with NO external fetch-dependency. Best-effort: a tag
# that shipped no notes file simply gets no RELEASE-NOTES.md (both paths skip it
# identically, so determinism holds either way).
rm -f "$OUT/RELEASE-NOTES.md"
ESC_TAG="$(printf '%s' "$TAG" | sed 's/[.]/\\./g')"
NOTES_MEMBER="$(tar -tzf "$OUT/$TARBALL" 2>/dev/null | grep -E "(^|/)RELEASE-NOTES-${ESC_TAG}\.md$" | head -n1 || true)"
if [ -n "$NOTES_MEMBER" ]; then
	tar -xzf "$OUT/$TARBALL" -O "$NOTES_MEMBER" > "$OUT/RELEASE-NOTES.md" 2>/dev/null || rm -f "$OUT/RELEASE-NOTES.md"
fi
HAS_NOTES=0
[ -s "$OUT/RELEASE-NOTES.md" ] && HAS_NOTES=1

# 4b. README.md — a human- and crawler-readable index for the directory (IPFS
# search engines surface dirs that carry a README + rich metadata). Fully
# DETERMINISTIC: only the tag/version/sha + fixed prose, so both callers emit the
# same bytes.
{
	printf '# Morphit %s\n\n' "$VERSION"
	printf 'Non-custodial, no-KYC, censorship-resistant peer-to-peer marketplace for\n'
	printf 'fiat <-> crypto and barter, coordinated over the Blurt blockchain. AGPL-3.0.\n\n'
	printf 'This directory is a content-addressed copy of the %s release, pinned on IPFS.\n' "$TAG"
	printf 'The CID is immutable: the bytes below cannot change under this address.\n\n'
	printf '## Files\n\n'
	printf -- '- `%s` the release source tarball\n' "$TARBALL"
	printf -- '- `morphit-latest.tar.gz` identical bytes, stable name\n'
	printf -- '- `%s.sha256` SHA-256 checksum of the tarball\n' "$TARBALL"
	printf -- '- `metadata.json` machine-readable release metadata (version, sha256, keywords)\n'
	if [ "$HAS_NOTES" -eq 1 ]; then printf -- '- `RELEASE-NOTES.md` what changed in this release\n'; fi
	printf '\n## Verify your download\n\n'
	printf 'The tarball hash is anchored on-chain and the tarball is GPG-signed. Do not\n'
	printf 'trust this copy blindly. Verify it:\n\n'
	printf '```sh\n'
	printf 'sha256sum -c %s.sha256\n' "$TARBALL"
	printf '```\n\n'
	printf 'Expected SHA-256:\n\n'
	printf '```\n%s\n```\n\n' "$GOT_SHA"
	printf 'The same SHA-256 and the GPG fingerprint are published in the on-chain\n'
	printf 'release record; the full verification guide is at %s.\n\n' "$VERIFY_GUIDE"
	printf '## Links\n\n'
	printf -- '- Source and mirrors: %s\n' "$REPO_URL"
	printf -- '- This release: %s/releases/tag/%s\n' "$REPO_URL" "$TAG"
	printf '\n## Keywords\n\n'
	printf 'morphit, peer-to-peer, p2p marketplace, non-custodial, no-kyc, privacy,\n'
	printf 'decentralized, censorship-resistant, agorist, counter-economics, bitcoin,\n'
	printf 'monero, blurt, fiat-to-crypto, crypto-to-fiat, barter, dbbs\n'
} > "$OUT/README.md"

# 5. metadata.json — DETERMINISTIC ONLY. Fixed key order. No timestamp/host/random.
# v1.9.5 (Ken): enriched for discoverability — a keywords array + pointers to the
# README + notes. Every value is still tag/checksum-derived or fixed text, so both
# callers emit byte-identical JSON. release_notes is present only when the tag
# shipped notes (both paths agree via HAS_NOTES, so it stays deterministic).
{
	printf '{\n'
	printf '  "name": "Morphit",\n'
	printf '  "description": "Morphit — non-custodial, no-KYC, censorship-resistant P2P fiat<->crypto/barter marketplace on Blurt. Signed release; verify against the on-chain SHA-256 + GPG signature.",\n'
	printf '  "version": "%s",\n' "$VERSION"
	printf '  "tag": "%s",\n' "$TAG"
	printf '  "tarball": "%s",\n' "$TARBALL"
	printf '  "sha256": "%s",\n' "$GOT_SHA"
	printf '  "keywords": ["morphit", "peer-to-peer", "p2p-marketplace", "non-custodial", "no-kyc", "privacy", "decentralized", "censorship-resistant", "agorist", "counter-economics", "bitcoin", "monero", "blurt", "fiat-to-crypto", "barter", "dbbs"],\n'
	printf '  "readme": "README.md",\n'
	if [ "$HAS_NOTES" -eq 1 ]; then printf '  "release_notes": "RELEASE-NOTES.md",\n'; fi
	printf '  "repository": "%s",\n' "$REPO_URL"
	printf '  "release_url": "%s/releases/tag/%s",\n' "$REPO_URL" "$TAG"
	printf '  "verify_guide": "%s"\n' "$VERIFY_GUIDE"
	printf '}\n'
} > "$OUT/metadata.json"

echo "stage-release-dir: staged $TAG at $OUT" >&2
ls -1 "$OUT" | sed 's/^/  /' >&2
