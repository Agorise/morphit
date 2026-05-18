#!/usr/bin/env bash
# Morphit — assemble apps/web/static/morphit-mediakit.zip from source.
#
# The mediakit is a single downloadable bundle linked from the
# footer ("Mediakit" link) of every page.  Press, integrators, and
# community members who want to write about Morphit, build something
# on top of it, or include the logo in a slide deck can grab the kit
# in one click instead of right-clicking SVGs out of the page source.
#
# What goes in the zip:
#   README.txt                — what this is + how to use it
#   MORPHIT-BRAG-LIST.md      — current public-facing claims (copied
#                                from the repo-root brag list)
#   logos/morphit-mark.svg    — the standalone mark, no wordmark
#   logos/morphit-wordmark.svg — the mark + "Morphit" wordmark
#
# When to run this:
#   - The brag list changes (any commit that edits MORPHIT-BRAG-LIST.md)
#   - The brand logos change (any commit that edits the SVGs in
#     apps/web/static/brand/)
#   - You're prepping a release tarball (cheap to re-run; idempotent)
#
# The CI mediakit-freshness smoke
# (apps/web/scripts/mediakit-freshness-smoke.ts) fails if the
# checked-in zip is older than its source files, so a missed run will
# be caught.
#
# Usage:
#   bash scripts/build-mediakit.sh

set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

# ─── Source files ──────────────────────────────────────────────────
BRAG_LIST="MORPHIT-BRAG-LIST.md"
MARK_SVG="apps/web/static/brand/morphit-mark.svg"
WORDMARK_SVG="apps/web/static/brand/morphit-wordmark.svg"

# ─── Destination ───────────────────────────────────────────────────
OUTPUT_DIR="apps/web/static"
OUTPUT_ZIP="${OUTPUT_DIR}/morphit-mediakit.zip"

# ─── Preflight ─────────────────────────────────────────────────────
for f in "$BRAG_LIST" "$MARK_SVG" "$WORDMARK_SVG"; do
	if [ ! -f "$f" ]; then
		echo "ERROR: missing source file: $f" >&2
		exit 1
	fi
done
if ! command -v zip >/dev/null 2>&1; then
	echo "ERROR: 'zip' utility not on PATH; apt install zip" >&2
	exit 1
fi

# ─── Stage in a tempdir so the zip is built from clean paths ───────
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/morphit-mediakit/logos"
cp "$BRAG_LIST" "$stage/morphit-mediakit/MORPHIT-BRAG-LIST.md"
cp "$MARK_SVG" "$stage/morphit-mediakit/logos/morphit-mark.svg"
cp "$WORDMARK_SVG" "$stage/morphit-mediakit/logos/morphit-wordmark.svg"

# README inside the zip — explains what's here and how to use it.
# Plain text so it opens in any environment (no markdown rendering
# required).  Kept short on purpose: the kit is for people who want
# to act, not read.
cat > "$stage/morphit-mediakit/README.txt" <<'EOF'
Morphit media kit
─────────────────

This bundle contains current brand assets and a public-facing claims
list for Morphit — a federated, non-custodial, no-KYC peer-to-peer
marketplace for fiat ↔ Bitcoin, Monero, BLURT, USDT, Bitcoin Cash,
Litecoin, and Dash trades.

Source repo:  https://git.agorise.net/agorise/morphit
Project URL:  https://morphit.io  (one instance among many)
License:      AGPL-3.0

Contents
────────
  MORPHIT-BRAG-LIST.md       Current public-facing claims — what we
                              built, what we got right, what we are
                              still working on.  Every claim is
                              backed by code in the repo or honestly
                              disclosed as backlog.  Use as a
                              reference when writing about Morphit.

  logos/morphit-mark.svg     The standalone Morphit mark (no
                              wordmark).  Use when the surrounding
                              context already says "Morphit" or
                              when you want a square icon.

  logos/morphit-wordmark.svg The mark together with the "Morphit"
                              wordmark.  Use when the logo needs to
                              identify itself.

Usage notes
───────────
You're welcome to use the logos to talk about Morphit — link to
the project, write articles, give talks, build integrations, host
your own instance.  Please don't modify the logos to represent
something other than Morphit, or use them in a way that implies
official endorsement of an unrelated product or service.

The brag list reflects the state of the repo at the time this
zip was built.  For the absolute latest, see MORPHIT-BRAG-LIST.md
in the source repo.
EOF

# ─── Build the zip ─────────────────────────────────────────────────
rm -f "$OUTPUT_ZIP"
(
	cd "$stage" && \
		zip -q -r "$OLDPWD/$OUTPUT_ZIP" morphit-mediakit
)

size=$(stat -c%s "$OUTPUT_ZIP" 2>/dev/null || stat -f%z "$OUTPUT_ZIP")
echo "✓ built $OUTPUT_ZIP ($size bytes)"

# ─── Show what landed inside, for visual confirmation ──────────────
echo ""
echo "Contents:"
unzip -l "$OUTPUT_ZIP"
