#!/usr/bin/env bash
#
# Morphit — ELI5 RELEASE BLOCKS (canonical, executable).
#
# WHY THIS FILE EXISTS
# --------------------
# On 2026-07-09 (cp445) the six release blocks were reconstructed from memory
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
# GATES (do not collapse these):
#   • BLOCK 2 waits for CI to go green — the signed tag fires release.yml.
#   • BLOCK 4 derives the manifest from the VPS's SERVED /verify.json, never a
#     laptop build: cross-machine Vite/Rollup output is not reproducible, and a
#     laptop-built manifest puts a red "Build integrity check failed" banner on
#     the live site (learned 2026-07-08, v1.1.5).
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

**BLOCK 1** — commit + push (laptop, repo root):
\`\`\`
git add -A
git commit -m "${MESSAGE}"
git push origin main
\`\`\`

---

**GATE: wait for CI to go green before Block 2.**

---

**BLOCK 2** — tag (signed, with a message):
\`\`\`
git tag -s v${VERSION} -m "Morphit v${VERSION}"
git push origin v${VERSION}
\`\`\`

---

**BLOCK 3** — upgrade the VPS (regenerates the served bundle + \`/verify.json\`; let it finish):
\`\`\`
sudo morphit-ops
\`\`\`
Then choose **option 2**.

---

**BLOCK 4** — build the on-chain payload **from the VPS's served verify.json**, and dry-run it (laptop, repo root):
\`\`\`
curl -fsSL https://morphit.io/verify.json -o ~/verify.json
node apps/web/scripts/verify-json-to-release-manifest.mjs ~/verify.json > apps/web/build-manifest.release.json
MORPHIT_BUILD_VERSION=${VERSION} MORPHIT_BUILD_HASH_MANIFEST_FILE=apps/web/build-manifest.release.json npx tsx apps/indexer/scripts/release-build-payload.ts < /dev/null > release.json
npx tsx apps/indexer/scripts/release-broadcast.ts release.json --dry-run
\`\`\`

---

**BLOCK 5** — the real broadcast (masked \`@morphit\` WIF prompt; your key starts with \`5\`):
\`\`\`
npx tsx apps/indexer/scripts/release-broadcast.ts release.json
\`\`\`

---

**BLOCK 6** — canary repair (the upgrade wipes \`build/canary.txt\` every time):
\`\`\`
bash ~/Documents/Agorise/Morphit/morphit-canary-setup.sh
\`\`\`
EOF
