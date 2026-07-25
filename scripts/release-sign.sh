#!/usr/bin/env bash
#
# Morphit — release tarball signing script (OFFLINE / FALLBACK ONLY).
#
# ⚠️  THE CANONICAL RELEASE IS BUILT BY CI, NOT BY THIS SCRIPT.  ⚠️
# `.forgejo/workflows/release.yml` (fired by the pushed signed tag) builds the
# tarball, hashes it (SHA-256), signs it if a signing secret is set, PUBLISHES
# the Forgejo release, attaches the assets, and writes the on-chain
# `distribution-anchor.env`. The bytes people download come from THAT job, and
# the ELI5 ceremony fetches the anchor it wrote. You normally never run this.
#
# This script builds the tarball a DIFFERENT way — `git archive` with a
# `morphit-v$VERSION/` prefix and no in-tarball `release-info.json` — so its
# SHA-256 does NOT match the CI-published tarball. Therefore:
#
#   • Do NOT anchor this script's hash on-chain for a CI release. The ceremony
#     uses the anchor CI wrote; anchoring this hash instead would make
#     verify-download.mjs fail against the real (CI-served) download.
#   • Use this only for offline / air-gapped signing when CI is unavailable —
#     and then you MUST also publish THIS script's exact tarball as the release
#     asset, so the served bytes match the hash this writes.
#
# Outputs (release/ dir): morphit-v$VERSION.tar.gz plus .sha256 / .sha512 /
# .asc (if GPG configured), CHECKSUMS(.asc), and distribution-anchor.env.
#
# Usage:
#
#   ./scripts/release-sign.sh                # uses package.json version
#   ./scripts/release-sign.sh v1.2.3         # explicit version override
#   MORPHIT_GPG_KEY=xxx ./scripts/release-sign.sh
#                                            # sign with named GPG key
#
# Prerequisites:
#   - git, tar, sha256sum, sha512sum (standard on Linux/BSD)
#   - gpg (optional — script gracefully skips signing if absent)
#
# The script DOES NOT push to forgejo or upload anywhere.  It just
# produces the artifacts; the human operator does the upload.  This
# is deliberate: signing keys + repo push tokens shouldn't be in
# the same automated context, by separation-of-privilege principle.
#
# Verification on the user's end:
#   sha256sum -c morphit-v1.2.3.tar.gz.sha256
#   gpg --verify morphit-v1.2.3.tar.gz.asc   morphit-v1.2.3.tar.gz
#   gpg --verify CHECKSUMS.asc CHECKSUMS

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
RELEASE_DIR="${REPO_ROOT}/release"

# ─── Determine version ──────────────────────────────────────────
VERSION="${1:-}"
if [[ -z "${VERSION}" ]]; then
    if [[ -f "${REPO_ROOT}/package.json" ]]; then
        VERSION="$(grep '"version"' "${REPO_ROOT}/package.json" | head -1 | sed -E 's/.*"version"\s*:\s*"([^"]+)".*/\1/')"
    fi
fi
if [[ -z "${VERSION}" ]]; then
    echo "ERROR: could not determine version. Pass as first argument or ensure package.json has a version field." >&2
    exit 1
fi
# Strip leading 'v' if present so we always have a clean semver
VERSION="${VERSION#v}"

ARTIFACT_NAME="morphit-v${VERSION}.tar.gz"
ARTIFACT_PATH="${RELEASE_DIR}/${ARTIFACT_NAME}"

echo "▶ Morphit release signing"
echo "  version:  v${VERSION}"
echo "  artifact: ${ARTIFACT_NAME}"
echo

# ─── Prepare release dir ──────────────────────────────────────────
mkdir -p "${RELEASE_DIR}"
# Don't clobber an existing release artifact silently
if [[ -e "${ARTIFACT_PATH}" ]]; then
    echo "ERROR: ${ARTIFACT_NAME} already exists in ${RELEASE_DIR}/" >&2
    echo "  Move or delete it first; we don't overwrite signed artifacts." >&2
    exit 1
fi

# ─── Build tarball ────────────────────────────────────────────────
echo "▶ Creating source tarball..."
cd "${REPO_ROOT}"
# git archive uses the index, which means uncommitted files are
# excluded.  This is correct: a release should be reproducible
# from the tagged commit, not from your dirty worktree.
if git rev-parse --git-dir &>/dev/null; then
    git archive --format=tar.gz \
        --prefix="morphit-v${VERSION}/" \
        -o "${ARTIFACT_PATH}" HEAD
    echo "  ✓ git archive (clean from HEAD; uncommitted files excluded)"
else
    # Fallback for non-git contexts: use tar with explicit excludes
    # matching what .gitignore would normally exclude.
    echo "  WARNING: not a git checkout — using tar with manual excludes"
    tar -czf "${ARTIFACT_PATH}" \
        --transform="s,^,morphit-v${VERSION}/," \
        --exclude='node_modules' \
        --exclude='.svelte-kit' \
        --exclude='dist' \
        --exclude='.git' \
        --exclude='*.log' \
        --exclude='release' \
        --exclude='/mnt' \
        .
fi

ARTIFACT_SIZE=$(stat -c%s "${ARTIFACT_PATH}" 2>/dev/null || stat -f%z "${ARTIFACT_PATH}")
echo "  ✓ ${ARTIFACT_NAME} (${ARTIFACT_SIZE} bytes)"
echo

# ─── Hash the tarball ─────────────────────────────────────────────
echo "▶ Hashing..."
cd "${RELEASE_DIR}"

# SHA-256 (the canonical one users will verify against)
sha256sum "${ARTIFACT_NAME}" > "${ARTIFACT_NAME}.sha256"
SHA256_HEX="$(awk '{print $1}' < "${ARTIFACT_NAME}.sha256")"
echo "  ✓ SHA-256: ${SHA256_HEX}"

# SHA-512 (defense in depth, future-proofing)
sha512sum "${ARTIFACT_NAME}" > "${ARTIFACT_NAME}.sha512"
SHA512_HEX="$(awk '{print $1}' < "${ARTIFACT_NAME}.sha512")"
echo "  ✓ SHA-512: ${SHA512_HEX:0:32}..."

# Combined CHECKSUMS file — a single file users can sign-verify once
# and trust everything within.
{
    echo "# Morphit release v${VERSION}"
    echo "# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "#"
    echo "# Verify with:"
    echo "#   sha256sum -c CHECKSUMS"
    echo "#   gpg --verify CHECKSUMS.asc CHECKSUMS"
    echo
    cat "${ARTIFACT_NAME}.sha256"
} > CHECKSUMS
echo "  ✓ CHECKSUMS"
echo

# ─── GPG sign (optional) ──────────────────────────────────────────
echo "▶ GPG signing..."
if ! command -v gpg &>/dev/null; then
    echo "  WARNING: gpg not installed — skipping signature step."
    echo "  Install gpg and re-run to add signature artifacts."
elif [[ -z "${MORPHIT_GPG_KEY:-}" ]] && ! gpg --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec:'; then
    echo "  WARNING: no MORPHIT_GPG_KEY set and no default secret key — skipping."
    echo "  To enable: set MORPHIT_GPG_KEY=<key-id> or import a default key."
else
    GPG_OPTS=""
    if [[ -n "${MORPHIT_GPG_KEY:-}" ]]; then
        GPG_OPTS="--local-user ${MORPHIT_GPG_KEY}"
    fi

    # Detached ASCII-armored signature for the tarball itself
    # shellcheck disable=SC2086
    gpg ${GPG_OPTS} --armor --detach-sign --output "${ARTIFACT_NAME}.asc" "${ARTIFACT_NAME}"
    echo "  ✓ ${ARTIFACT_NAME}.asc"

    # Detached signature for CHECKSUMS too — gives users a single-
    # file-to-verify story
    # shellcheck disable=SC2086
    gpg ${GPG_OPTS} --armor --detach-sign --output CHECKSUMS.asc CHECKSUMS
    echo "  ✓ CHECKSUMS.asc"

    # Full GPG fingerprint (40-hex v4 / 64-hex v5) — the `fpr` colon
    # record is the whole fingerprint, unlike the "using ... key XXXX"
    # line which is only the long key-id. cp556: the distribution anchor
    # pins the FULL fingerprint, so extract it here.
    FPR_KEYSPEC="${MORPHIT_GPG_KEY:-}"
    GPG_FINGERPRINT="$(gpg --list-secret-keys --with-colons ${FPR_KEYSPEC} 2>/dev/null \
        | awk -F: '$1=="fpr"{print $10; exit}')"
    if [[ -n "${GPG_FINGERPRINT}" ]]; then
        echo
        echo "  Signed by key fingerprint: ${GPG_FINGERPRINT}"
        echo "  Publish this fingerprint alongside the release so users can"
        echo "  verify they have the right public key."
    fi

    # ─── cp556: distribution-anchor values, ready to paste ────────────
    # These feed the release-op payload builder so the SAME signed bytes
    # can be anchored on-chain (morphit_release_v1 → distribution). The
    # payload build step `source`s the env file written below.
    #
    # Mirrors default to the hosts Forgejo auto-mirrors commits+tags to
    # (Codeberg + GitHub). Override with MORPHIT_RELEASE_MIRRORS (a
    # comma-separated list) if your repo lives elsewhere. IPFS is
    # OPTIONAL and off by default — set MORPHIT_BUILD_IPFS_CID before the
    # payload build only if you pin the tarball to IPFS.
    MIRRORS="${MORPHIT_RELEASE_MIRRORS:-https://codeberg.org/agorise/morphit,https://github.com/agorise/morphit}"
    echo
    echo "  ── Distribution anchor (sourced automatically in the payload build) ──"
    echo "  MORPHIT_BUILD_SOURCE_SHA256=${SHA256_HEX}"
    if [[ -n "${GPG_FINGERPRINT}" ]]; then
        echo "  MORPHIT_BUILD_GPG_FINGERPRINT=${GPG_FINGERPRINT}"
    fi
    echo "  MORPHIT_BUILD_MIRRORS=${MIRRORS}"

    # Persist the values to a sourceable env file so the release ceremony
    # (eli5-release.sh) can `source` them into the payload-build step
    # rather than re-deriving or hand-pasting.
    ANCHOR_ENV="${RELEASE_DIR}/distribution-anchor.env"
    {
        echo "# Morphit distribution anchor for v${VERSION} — source this before building the release-op payload."
        echo "export MORPHIT_BUILD_SOURCE_SHA256=${SHA256_HEX}"
        if [[ -n "${GPG_FINGERPRINT}" ]]; then
            echo "export MORPHIT_BUILD_GPG_FINGERPRINT=${GPG_FINGERPRINT}"
        fi
        echo "export MORPHIT_BUILD_MIRRORS=${MIRRORS}"
        echo "# Optional — set only if you pin the tarball to IPFS:"
        echo "# export MORPHIT_BUILD_IPFS_CID=<cid>"
    } > "${ANCHOR_ENV}"
    echo
    echo "  Wrote ${ANCHOR_ENV} (sourced by the payload-build step)."
fi
echo

# ─── Summary ──────────────────────────────────────────────────────
echo "▶ Release ${VERSION} prepared in ${RELEASE_DIR}/"
ls -la "${RELEASE_DIR}/"
echo
echo "Next steps (decentralized distribution — same signed bytes, many hosts):"
echo "  1. Attach these artifacts to the Forgejo release page:"
echo "       ${ARTIFACT_NAME}, .sha256, .sha512, .asc, CHECKSUMS, CHECKSUMS.asc"
echo "     (The names already match the release-asset convention — no rename needed.)"
echo "  2. Mirroring is AUTOMATIC — Forgejo pushes commits + the signed tag to"
echo "     GitHub + Codeberg on push, so the code is already on 3 independent hosts."
echo "     Nothing to do here (those hosts are the default anchor mirrors). NOTE the"
echo "     mirrors carry the signed TAG, not this release asset — so the source_sha256"
echo "     anchor is for THIS canonical tarball; 'git verify-tag' is the mirror-agnostic"
echo "     check."
echo "  3. Once uploaded you can DELETE the local release/ tarball — the anchor is"
echo "     already in release/distribution-anchor.env, which the payload build sources."
echo "  4. ANCHOR on-chain — the ELI5 ceremony (scripts/eli5-release.sh) sources"
echo "     release/distribution-anchor.env and broadcasts morphit_release_v1 with"
echo "     the distribution block (source_sha256 + gpg_fingerprint + mirrors)."
echo "  5. (Optional) pin the tarball to IPFS and set MORPHIT_BUILD_IPFS_CID before"
echo "     the payload build to add a content-addressed copy to the anchor."
echo "  6. Anyone can then verify a download against the chain — re-fetch the canonical"
echo "     tarball from the release page (you need not keep a local copy) and run:"
echo "       node scripts/verify-download.mjs \"${ARTIFACT_NAME}\"    # tarball vs chain anchor"
echo "       git verify-tag v${VERSION}                              # signed tag from any mirror"
echo "     (see docs/VERIFY-YOUR-DOWNLOAD.md)."
echo "  7. Update the project's website to reference the new version."
