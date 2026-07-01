#!/usr/bin/env bash
# Morphit — regenerate apps/web/static/og-image.png from og-image.svg.
#
# Why this script exists:
#
#   The SVG is the source of truth for the social-share OG image, but
#   Twitter/X, LinkedIn, Slack, and Discord don't reliably render SVG
#   OG images (Twitter rejects SVG outright per their card spec).  The
#   PNG ships alongside the SVG as the primary og:image / twitter:image.
#
# When to run this:
#
#   - You edit apps/web/static/og-image.svg (any visual change to the
#     OG card).
#   - The og-image-freshness-smoke fails because the PNG is older than
#     the SVG.
#
# Usage:
#
#   bash scripts/build-og-image-png.sh
#
# Dependencies:
#
#   - python3 + cairosvg (`pip install cairosvg`).  Offline-installable;
#     no network required at run time.  Alternatives like `rsvg-convert`
#     also work — patch this script if you prefer those.
#
# CI: the og-image-freshness smoke (apps/web/scripts/og-image-
# freshness-smoke.ts) catches missed regenerations before tarball.

set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

SVG="apps/web/static/og-image.svg"
PNG="apps/web/static/og-image.png"

if [ ! -f "$SVG" ]; then
	echo "build-og-image-png: source $SVG missing" >&2
	exit 1
fi

if ! python3 -c "import cairosvg" >/dev/null 2>&1; then
	echo "build-og-image-png: cairosvg not installed."
	echo "Install with: pip install --break-system-packages cairosvg"
	echo "(Or 'pip install cairosvg' inside a virtualenv.)"
	exit 1
fi

# Twitter Card summary_large_image: 1200×630 max.  Facebook OG
# recommended: 1200×630.  Same canvas serves both.
python3 - <<PY
import cairosvg
cairosvg.svg2png(
    url='${SVG}',
    write_to='${PNG}',
    output_width=1200,
    output_height=630,
)
PY

bytes=$(wc -c <"$PNG" | tr -d ' ')

# cp116 (A15 hardening) — write a sidecar file containing the SHA-256
# of the SVG source.  The freshness smoke compares this against the
# CURRENT SVG hash.  This is robust to git checkout (which resets
# mtimes); content-hash matches iff the PNG was generated from THIS
# version of the SVG.  See docs/REVISIT-LIST.md CP113 Lesson #3.
SIDECAR="${PNG}.svg-sha256"
SVG_HASH="$(sha256sum "$SVG" | awk '{print $1}')"
echo "$SVG_HASH" >"$SIDECAR"

echo "✓ regenerated ${PNG} (${bytes} bytes)"
echo "✓ wrote sidecar ${SIDECAR} (svg sha256: ${SVG_HASH:0:16}...)"
