#!/usr/bin/env bash
#
# Morphit — ELI5 RELEASE BLOCKS (canonical, executable).
#
# WHY THIS FILE EXISTS
# --------------------
# On 2026-07-09 the release blocks were reconstructed from memory
# instead of reproduced from the record. The result invented a `<your-vps>`
# placeholder, a `morphit-ops canary-repair` command that does not exist, and
# wrong script paths, and it had to be caught by hand. The blocks were RIGHT in the record
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
# HOW TO PRESENT THE OUTPUT (a repeated request — do NOT miss this)
# ---------------------------------------------------------------------
# Relay the blocks below as SEPARATE fenced code blocks, each containing ONLY
# the raw shell commands the maintainer runs. Nothing else goes inside a code block: no
# "BLOCK N" label, no description, no "wait for CI green" gate text, no
# "choose option N" instruction. Those are NOTES — they go as plain text
# BETWEEN the code blocks, never inside them. Every code block must paste into
# a terminal and run verbatim, with zero editing-out of non-command lines.
# This script's output already separates commands from notes correctly; relay
# it faithfully rather than re-wrapping labels/gates into code blocks.
#
# GATES (do not collapse these):
#   • BLOCK 1 pushes main; WAIT for ci.yml green before the tag.
#   • BLOCK 2 pushes the signed tag; release.yml then builds, hashes, signs
#     (only when CI holds the signing key; otherwise nodes install the release
#     by its SHA-256 in the on-chain record), PUBLISHES the Forgejo release, and
#     attaches every asset (tarball, .sha256, distribution-anchor.env, the
#     offline bundle a zero-clearnet node upgrades from, and their .asc files
#     when signed). WAIT for release.yml green — you download + upload nothing.
#   • BLOCK 4 computes the manifest from the PUBLISHED tarball's prebuilt
#     apps/web/build, after checking that tarball against the SHA-256 the
#     release job anchored, and requires the canonical instance's SERVED
#     /verify.json to match it file for file. Never a laptop build:
#     cross-machine Vite/Rollup output is not reproducible, and a laptop-built
#     manifest puts a red "Build integrity check failed" banner on the live site
#     (learned 2026-07-08, v1.1.5). Never the served copy alone either: whatever
#     that box serves would be anchored for every instance.
#   • BLOCK 4 starts with `npm ci --ignore-scripts`: the laptop's repo is
#     refreshed by unpacking the release tarball over it, which updates the code
#     but NOT node_modules (v1.20.0's payload builder died on an older installed
#     library, 2026-09-30). No dependency install script runs on the machine
#     that holds the @morphit WIF.
#   • BLOCK 4 never sources the downloaded anchor: the payload builder PARSES it
#     (MORPHIT_BUILD_ANCHOR_FILE: known keys, exact value shapes, a pinned
#     signing key) and refuses any MORPHIT_BUILD_* value an earlier ceremony left
#     in the terminal (v1.20.2 carried v1.20.1's CID and IPNS record that way).
#     The anchor names the signed tag object release.yml built; it must be the
#     tag this repository made in BLOCK 2, so a tag moved after the push (back
#     to an older signed object of the same name) is refused. No extra command.
#   • A release with no IPFS CID is REFUSED by the payload builder: release.yml
#     could not compute it (v1.20.2), and zero-clearnet nodes cannot fetch a
#     release without one. The note after BLOCK 4 gives the payload line again
#     with `--ipfs-cid <cid>`, the CID morphit.io printed when it seeded the
#     release in BLOCK 3. The builder takes that flag only for an anchor that
#     has no CID; values left in the terminal are still refused.
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

# The message goes into Block 1 single-quoted, each ' written as '\'' — so a
# quote, backtick, $( ) or $ in it is pasted as text and never run.
MESSAGE_QUOTED="'${MESSAGE//\'/\'\\\'\'}'"

cat <<EOF
# ELI5 RELEASE — v${VERSION}

**BLOCK 1** — commit + push main (laptop, repo root):
\`\`\`
git add -A
git commit -m ${MESSAGE_QUOTED}
git push origin main
\`\`\`

---

**GATE: wait for CI to go green before Block 2.** (\`ci.yml\` — if it finds a problem, fix it and re-push before tagging.)

---

**BLOCK 2** — tag + push (laptop, repo root; signed). Pushing the tag fires \`release.yml\`, which builds, hashes, signs when the signing secret is set, **publishes the Forgejo release, and attaches the tarball + \`.sha256\` + \`distribution-anchor.env\` + the offline bundle** — you download and upload nothing:
\`\`\`
git tag -s v${VERSION} -m "Morphit v${VERSION}"
git push origin v${VERSION}
\`\`\`

---

**GATE: wait for \`release.yml\` to go green.** The v${VERSION} release now exists on Forgejo with every asset attached. \`release.yml\` also copies it to codeberg.org and gitea.com when their tokens are set (best-effort); the other mirrors get the commits and the tag through git push, not the release page.

---

**BLOCK 3** — upgrade the VPS (morphit.io, logged in as root; regenerates the served bundle + \`/verify.json\`; let it finish):
\`\`\`
sudo morphit-ops
\`\`\`
Then choose **option 2**. (The upgrade also self-seeds this release to IPFS if this box runs IPFS hosting — it becomes an origin host automatically; a box without hosting skips it.)

---

**BLOCK 4** — build the on-chain payload from the published release and dry-run it (laptop, repo root). The first line installs exactly this release's packages, running no install script; the second clears values an earlier ceremony left in this terminal; then fetch the anchor and the tarball \`release.yml\` published and the canonical instance's served verify.json. The manifest is computed from the tarball (checked against the anchored SHA-256) and must match what the site serves; the payload builder reads the anchor itself (it is never sourced):
\`\`\`
npm ci --ignore-scripts --no-audit --no-fund
unset \$(env | grep -o '^MORPHIT_BUILD_[A-Z0-9_]*')
curl -fsSL https://git.agorise.net/agorise/morphit/releases/download/v${VERSION}/distribution-anchor.env -o /tmp/morphit-anchor.env
curl -fsSL https://git.agorise.net/agorise/morphit/releases/download/v${VERSION}/morphit-v${VERSION}.tar.gz -o /tmp/morphit-v${VERSION}.tar.gz
curl -fsSL https://morphit.io/verify.json -o /tmp/morphit-verify.json
node apps/web/scripts/verify-json-to-release-manifest.mjs --anchor /tmp/morphit-anchor.env --tarball /tmp/morphit-v${VERSION}.tar.gz --served /tmp/morphit-verify.json > apps/web/build-manifest.release.json
MORPHIT_BUILD_ANCHOR_FILE=/tmp/morphit-anchor.env MORPHIT_BUILD_VERSION=${VERSION} MORPHIT_BUILD_BLURT_BASE=125 MORPHIT_BUILD_HASH_MANIFEST_FILE=apps/web/build-manifest.release.json ./node_modules/.bin/tsx apps/indexer/scripts/release-build-payload.ts < /dev/null > release.json
./node_modules/.bin/tsx apps/indexer/scripts/release-broadcast.ts release.json --dry-run
\`\`\`
The dry-run's printed payload should carry a \`distribution\` block (source_sha256 + gpg_fingerprint + \`ipfs_cid\` + \`ipns_name\` + the mirror list baked into the payload builder). If the manifest line stops with "does not match the release tarball", the canonical instance is not serving this release yet: finish Block 3 and fetch verify.json again.

If the payload line stops with "this release has no IPFS CID", \`release.yml\` could not compute it (as happened to v1.20.2), and a release without it cannot reach zero-clearnet nodes. morphit.io printed it in Block 3, on the line \`morphit-ipfs-seed: hosted v${VERSION} → bafy…\`. On the laptop, run the payload line again with that CID in place of \`<cid>\`, then the dry-run line again: \`MORPHIT_BUILD_ANCHOR_FILE=/tmp/morphit-anchor.env MORPHIT_BUILD_VERSION=${VERSION} MORPHIT_BUILD_BLURT_BASE=125 MORPHIT_BUILD_HASH_MANIFEST_FILE=apps/web/build-manifest.release.json ./node_modules/.bin/tsx apps/indexer/scripts/release-build-payload.ts --ipfs-cid <cid> < /dev/null > release.json\`

There is deliberately **no public-gateway check here**. Block 3 already asserted that the CID your box produced equals the one in the anchor (when the anchor carries one), and verified it serves over this instance's clearnet origin, its \`.onion\` and its \`.b32.i2p\` — the paths instances actually fetch from. A public gateway seeing it adds nothing to that, arrives minutes later, and depends on a third party we do not rely on. It used to gate this block and could stall a healthy release for half an hour. To confirm outside reachability by choice, it is a manual command that never blocks the ceremony: \`sh scripts/verify-cid-public.sh <cid> ${VERSION} https://morphit.io\`.

---

**BLOCK 5** — the real broadcast (laptop, repo root; masked \`@morphit\` WIF prompt; your key starts with \`5\`):
\`\`\`
./node_modules/.bin/tsx apps/indexer/scripts/release-broadcast.ts release.json
\`\`\`
Afterwards anyone can verify a download against the chain by re-fetching the canonical tarball from the release page: \`curl -fsSLO https://git.agorise.net/agorise/morphit/releases/download/v${VERSION}/morphit-v${VERSION}.tar.gz && node scripts/verify-download.mjs morphit-v${VERSION}.tar.gz\`, or clone any mirror and \`git verify-tag v${VERSION}\` (see docs/VERIFY-YOUR-DOWNLOAD.md).

---

**BLOCK 6** — canary repair (laptop — the canary is signed there, never on the server; the upgrade wipes \`build/canary.txt\` every time):
\`\`\`
bash ~/.morphit/update-canary.sh
\`\`\`
EOF
