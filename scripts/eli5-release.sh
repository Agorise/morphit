#!/usr/bin/env bash
#
# Morphit — ELI5 RELEASE BLOCKS (canonical, executable).
#
# WHY THIS FILE EXISTS
# --------------------
# On 2026-07-09 (cp445) the release blocks were reconstructed from memory
# instead of reproduced from the record. The result invented a `<your-vps>`
# placeholder, a `morphit-ops canary-repair` command that does not exist, and
# wrong script paths. Ken had to catch it. The blocks were RIGHT in the record
# the whole time.
#
# A rule that says "remember to copy it exactly" is a rule that depends on
# remembering. So the blocks now live here, as code, and this script prints them
# filled in for a given version. Nobody has to retype them, and nobody should.
#
#   bash scripts/eli5-release.sh 1.3.0 "commit message here"
#
# `eli5-release-blocks-smoke.ts` verifies every script path referenced below
# actually exists, that the env-var names match what release-build-payload.ts
# reads, and that no placeholder ever creeps back in. If you change a command
# here, that smoke tells you whether the command is real.
#
# HOW TO PRESENT THE OUTPUT (Ken's repeated request — do NOT miss this)
# ---------------------------------------------------------------------
# Relay the blocks below as SEPARATE fenced code blocks, each containing ONLY
# the raw shell commands Ken runs. Nothing else goes inside a code block: no
# "BLOCK N" label, no description, no "wait for CI green" gate text, no
# "choose option N" instruction. Those are NOTES — they go as plain text
# BETWEEN the code blocks, never inside them. Every code block must paste into
# a terminal and run verbatim, with zero editing-out of non-command lines.
# This script's output already separates commands from notes correctly; relay
# it faithfully rather than re-wrapping labels/gates into code blocks.
#
# GATES (do not collapse these):
#   • BLOCK 1 pushes main; WAIT for ci.yml green before the tag.
#   • BLOCK 2 pushes the signed tag; release.yml then builds, hashes, signs,
#     PUBLISHES the Forgejo release, and attaches every asset (tarball,
#     .sha256, distribution-anchor.env). WAIT for release.yml green — you
#     download + upload nothing.
#   • BLOCK 4 derives the manifest from the VPS's SERVED /verify.json, never a
#     laptop build: cross-machine Vite/Rollup output is not reproducible, and a
#     laptop-built manifest puts a red "Build integrity check failed" banner on
#     the live site (learned 2026-07-08, v1.1.5). It also fetches the anchor
#     release.yml attached, so the on-chain source_sha256 is the PUBLISHED
#     tarball's hash — not a local git-archive (that mismatch was the old
#     release-sign.sh footgun).
#   • Broadcasting (BLOCK 5) is a laptop step ONLY: the @morphit spending WIF
#     must never live in CI.
#   • BLOCK 6 is not optional: `morphit-ops upgrade` wipes build/canary.txt.
#
set -euo pipefail

VERSION="${1:-}"
MESSAGE="${2:-Morphit v${VERSION}}"

if [[ -z "$VERSION" ]]; then
	echo "usage: bash scripts/eli5-release.sh <version> [commit message]" >&2
	echo "   eg: bash scripts/eli5-release.sh 1.3.0 \"v1.3.0 — active-key unlock\"" >&2
	exit 1
fi

cat <<EOF
# ELI5 RELEASE — v${VERSION}

**BLOCK 1** — commit + push main (laptop, repo root):
\`\`\`
git add -A
git commit -m "${MESSAGE}"
git push origin main
\`\`\`

---

**GATE: wait for CI to go green before Block 2.** (\`ci.yml\` — if it finds a problem, fix it and re-push before tagging.)

---

**BLOCK 2** — tag + push (signed). Pushing the tag fires \`release.yml\`, which builds, hashes, signs (if a signing secret is set), **publishes the Forgejo release, and attaches the tarball + \`.sha256\` + \`distribution-anchor.env\`** — you download and upload nothing:
\`\`\`
git tag -s v${VERSION} -m "Morphit v${VERSION}"
git push origin v${VERSION}
\`\`\`

---

**GATE: wait for \`release.yml\` to go green.** The v${VERSION} release now exists on Forgejo with every asset attached, auto-mirrored to GitHub + Codeberg.

---

**BLOCK 3** — upgrade the VPS (regenerates the served bundle + \`/verify.json\`; let it finish):
\`\`\`
sudo morphit-ops
\`\`\`
Then choose **option 2**.

---

**BLOCK 4** — build the on-chain payload from the VPS's served verify.json **plus** the published distribution anchor, and dry-run it (laptop, repo root). The first line fetches the anchor \`release.yml\` attached to the release; \`source\` loads the SHA-256 + fingerprint (the mirror list is baked into the payload builder):
\`\`\`
curl -fsSL https://git.agorise.net/agorise/morphit/releases/download/v${VERSION}/distribution-anchor.env -o /tmp/morphit-anchor.env
source /tmp/morphit-anchor.env
curl -fsSL https://morphit.io/verify.json -o ~/verify.json
node apps/web/scripts/verify-json-to-release-manifest.mjs ~/verify.json > apps/web/build-manifest.release.json
MORPHIT_BUILD_VERSION=${VERSION} MORPHIT_BUILD_BLURT_BASE=125 MORPHIT_BUILD_HASH_MANIFEST_FILE=apps/web/build-manifest.release.json npx tsx apps/indexer/scripts/release-build-payload.ts < /dev/null > release.json
npx tsx apps/indexer/scripts/release-broadcast.ts release.json --dry-run
\`\`\`
The dry-run's printed payload should carry a \`distribution\` block (source_sha256 + gpg_fingerprint + the auto-baked GitHub + Codeberg mirror list). If it does not, the anchor env was not sourced.

---

**BLOCK 5** — the real broadcast (masked \`@morphit\` WIF prompt; your key starts with \`5\`):
\`\`\`
npx tsx apps/indexer/scripts/release-broadcast.ts release.json
\`\`\`
Afterwards anyone can verify a download against the chain by re-fetching the canonical tarball from the release page: \`curl -fsSLO https://git.agorise.net/agorise/morphit/releases/download/v${VERSION}/morphit-v${VERSION}.tar.gz && node scripts/verify-download.mjs morphit-v${VERSION}.tar.gz\`, or clone any mirror and \`git verify-tag v${VERSION}\` (see docs/VERIFY-YOUR-DOWNLOAD.md).

---

**BLOCK 6** — canary repair (the upgrade wipes \`build/canary.txt\` every time):
\`\`\`
bash ~/Documents/Agorise/Morphit/morphit-canary-setup.sh
\`\`\`
EOF
