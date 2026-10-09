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
#   • BLOCK 3 computes the manifest from the PUBLISHED tarball's prebuilt
#     apps/web/build, after checking that tarball against the SHA-256 the
#     release job anchored, and requires the tarball's own verify.json (the list
#     every instance serves at /verify.json) to name the same hash for every
#     bootstrap file (page, service worker, entry scripts). Never a
#     laptop build: cross-machine Vite/Rollup output is not reproducible, and a
#     laptop-built manifest puts a red "Build integrity check failed" banner on
#     the live site (learned 2026-07-08, v1.1.5). The served copy is checked
#     only after the upgrade (BLOCK 6): whatever that box serves must never be
#     what is anchored.
#   • BLOCK 3 starts with `npm ci --ignore-scripts`: the laptop's repo is
#     refreshed by unpacking the release tarball over it, which updates the code
#     but NOT node_modules (v1.20.0's payload builder died on an older installed
#     library, 2026-09-30). No dependency install script runs on the machine
#     that holds the @morphit WIF.
#   • BLOCK 3 never sources the downloaded anchor: the payload builder PARSES it
#     (MORPHIT_BUILD_ANCHOR_FILE: known keys, exact value shapes, a pinned
#     signing key) and refuses any MORPHIT_BUILD_* value an earlier ceremony left
#     in the terminal (v1.20.2 carried v1.20.1's CID and IPNS record that way).
#     The anchor names the signed tag object release.yml built; it must be the
#     tag this repository made in BLOCK 2, so a tag moved after the push (back
#     to an older signed object of the same name) is refused. No extra command.
#   • A release with no IPFS CID is REFUSED by the payload builder: release.yml
#     could not compute it (v1.20.2), and zero-clearnet nodes cannot fetch a
#     release without one. Only then does the builder print the fallback (one
#     line under BLOCK 3 says so; the fallback itself is not printed every
#     time, since a successful dry-run means it is not needed): a command for
#     morphit.io that seeds the release with the release's OWN seed scripts
#     from the checked tarball (it hosts it, installs nothing, and prints the
#     CID), then the payload line again with `--ipfs-cid <cid>`. The builder
#     takes that flag only for an anchor that has no CID; values left in the
#     terminal are still refused.
#   • Broadcasting (BLOCK 4) is a laptop step ONLY: the @morphit spending WIF
#     must never live in CI.
#   • BLOCK 4 comes BEFORE the upgrade (BLOCK 5). Since v1.21.0 `morphit-ops
#     upgrade` installs a release only with a signature from a pinned key or by
#     its SHA-256 in @morphit's on-chain record; CI holds no signing key, so the
#     record must exist first. The v1.21.1 ceremony upgraded before it
#     broadcast, and morphit.io refused the release ("The release is not
#     signed, and no signed on-chain release record names its hash").
#   • Because the broadcast comes first, every node (morphit.io included)
#     judges the new record with the PREVIOUS release's validator, and an op it
#     rejects stays rejected after it upgrades. A change that widens what the
#     record may carry ships in one release; only a later release's record
#     uses it (docs/OPERATIONS.md §40.6).
#   • BLOCK 6 checks, after the upgrade, that morphit.io SERVES the anchored
#     build, and repairs the canary (`morphit-ops upgrade` wipes
#     build/canary.txt). Not optional.
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

**BLOCK 3** — build the on-chain payload from the published release and dry-run it (laptop, repo root):
\`\`\`
npm ci --ignore-scripts --no-audit --no-fund
unset \$(env | grep -o '^MORPHIT_BUILD_[A-Z0-9_]*')
rm -f /tmp/morphit-anchor.env /tmp/morphit-v${VERSION}.tar.gz /tmp/morphit-build-manifest.json /tmp/morphit-release.json
curl -fsSL https://git.agorise.net/agorise/morphit/releases/download/v${VERSION}/distribution-anchor.env -o /tmp/morphit-anchor.env
curl -fsSL https://git.agorise.net/agorise/morphit/releases/download/v${VERSION}/morphit-v${VERSION}.tar.gz -o /tmp/morphit-v${VERSION}.tar.gz
node apps/web/scripts/verify-json-to-release-manifest.mjs --anchor /tmp/morphit-anchor.env --tarball /tmp/morphit-v${VERSION}.tar.gz > /tmp/morphit-build-manifest.json
MORPHIT_BUILD_ANCHOR_FILE=/tmp/morphit-anchor.env MORPHIT_BUILD_VERSION=${VERSION} MORPHIT_BUILD_BLURT_BASE=125 MORPHIT_BUILD_HASH_MANIFEST_FILE=/tmp/morphit-build-manifest.json ./node_modules/.bin/tsx apps/indexer/scripts/release-build-payload.ts < /dev/null > /tmp/morphit-release.json
./node_modules/.bin/tsx apps/indexer/scripts/release-broadcast.ts /tmp/morphit-release.json --dry-run
\`\`\`
The dry-run prints the payload; its \`distribution\` block carries the \`ipfs_cid\`. If it ran, Block 3 is done. Only if the payload line stops with "this release has no IPFS CID" is there more to do: it prints the one command to run on morphit.io and how to retry.

---

**BLOCK 4** — the real broadcast (laptop, repo root; masked \`@morphit\` WIF prompt; your key starts with \`5\`). It comes before the upgrade: an unsigned release installs only by its SHA-256 in this on-chain record:
\`\`\`
./node_modules/.bin/tsx apps/indexer/scripts/release-broadcast.ts /tmp/morphit-release.json
\`\`\`
Afterwards anyone can verify a download against the chain by re-fetching the canonical tarball from the release page: \`curl -fsSLO https://git.agorise.net/agorise/morphit/releases/download/v${VERSION}/morphit-v${VERSION}.tar.gz && node scripts/verify-download.mjs morphit-v${VERSION}.tar.gz\`, or clone any mirror and \`git verify-tag v${VERSION}\` (see docs/VERIFY-YOUR-DOWNLOAD.md).

Until morphit.io upgrades, its visitors notice nothing, and get no tamper alarm: a browser checks the build only when it runs the version the record announces.

---

**BLOCK 5** — upgrade the VPS (morphit.io, logged in as root; installs the release by its on-chain record, regenerates the served bundle + \`/verify.json\`; let it finish):
\`\`\`
sudo morphit-ops
\`\`\`
Then choose **option 2**. It prints \`✓ Integrity verified (onchain-anchored-sha256)\`. (The upgrade also self-seeds this release to IPFS if this box runs IPFS hosting — it becomes an origin host automatically; a box without hosting skips it.) The other instances can upgrade now: morphitir and timeapp since Block 4, morphitlat after this block, because it fetches the release from morphit.io over Tor/I2P.

There is deliberately **no public-gateway check here**. This block already asserts that the CID your box produced equals the one in the anchor (when the anchor carries one), and verifies it serves over this instance's clearnet origin, its \`.onion\` and its \`.b32.i2p\` — the paths instances actually fetch from. A public gateway seeing it adds nothing to that, arrives minutes later, and depends on a third party we do not rely on. It used to gate the ceremony and could stall a healthy release for half an hour. To confirm outside reachability by choice, it is a manual command that never blocks the ceremony: \`sh scripts/verify-cid-public.sh <cid> ${VERSION} https://morphit.io\`.

---

**BLOCK 6** — check what morphit.io now serves, then repair the canary (laptop, repo root — the canary is signed there, never on the server; the upgrade wipes \`build/canary.txt\` every time). The first lines fetch the served verify.json and require it to name the anchored tarball's hash for every bootstrap file (the page, the service worker, the entry scripts):
\`\`\`
rm -f /tmp/morphit-verify.json
curl -fsSL https://morphit.io/verify.json -o /tmp/morphit-verify.json
node apps/web/scripts/verify-json-to-release-manifest.mjs --anchor /tmp/morphit-anchor.env --tarball /tmp/morphit-v${VERSION}.tar.gz --served /tmp/morphit-verify.json > /dev/null
bash ~/.morphit/update-canary.sh
\`\`\`
The \`node\` line ends with "the served verify.json matches". If it says "does not match", morphit.io serves something other than the anchored build: its visitors see the tamper alarm. Do not ignore it.
EOF
