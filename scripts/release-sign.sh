#!/usr/bin/env bash
#
# Morphit — release tarball signing script.
#
# Builds a source-release tarball from the current git checkout
# and produces:
#
#   release/morphit-v$VERSION-source.tar.gz
#   release/morphit-v$VERSION-source.tar.gz.sha256
#   release/morphit-v$VERSION-source.tar.gz.sha512
#   release/morphit-v$VERSION-source.tar.gz.asc       (if GPG configured)
#   release/CHECKSUMS                                  (combined manifest)
#   release/CHECKSUMS.asc                              (if GPG configured)
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
#   sha256sum -c morphit-v1.2.3-source.tar.gz.sha256
#   gpg --verify morphit-v1.2.3-source.tar.gz.asc   morphit-v1.2.3-source.tar.gz
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

ARTIFACT_NAME="morphit-v${VERSION}-source.tar.gz"
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

    # Show the signing key fingerprint so the operator can publish it
    # alongside the release
    SIGNER_KEY="$(gpg --verify CHECKSUMS.asc CHECKSUMS 2>&1 | grep -E 'using.*key' | head -1 | sed -E 's/.*key (\w+).*/\1/')"
    if [[ -n "${SIGNER_KEY}" ]]; then
        echo
        echo "  Signed by key fingerprint: ${SIGNER_KEY}"
        echo "  Publish this fingerprint alongside the release so users can"
        echo "  verify they have the right public key."
    fi
fi
echo

# ─── Summary ──────────────────────────────────────────────────────
echo "▶ Release ${VERSION} prepared in ${RELEASE_DIR}/"
ls -la "${RELEASE_DIR}/"
echo
echo "Next steps:"
echo "  1. Upload to forgejo: git.agorise.net/agorise/morphit/releases"
echo "  2. Broadcast morphit_release_v1 op on Blurt chain pointing"
echo "     at the release tarball + SHA-256.  See"
echo "     apps/indexer/src/indexer/handlers/release.ts for the op shape."
echo "  3. Update the project's website to reference the new version."
