# Release-signer keys

This directory holds the ASCII-armored GPG public keys (`.asc`) of the
maintainers who sign Morphit release tags and release tarballs. It supplies key
MATERIAL only. Which keys are trusted is decided by fingerprint, in two places
that a pushed tag cannot change on its own:

- `MORPHIT_RELEASE_SIGNERS` in `.forgejo/workflows/release.yml` (job `env`),
  which the release job checks the tag signature and its own signing key
  against;
- `RELEASE_SIGNER_FINGERPRINTS` in `packages/operator-config/src/trustAnchors.ts`,
  which every installed node checks a downloaded tarball's `.asc` against
  (`morphit-ops upgrade`).

`scripts/release-signer-pin-smoke.ts` fails when the two lists differ.

A key committed here whose fingerprint is not in both lists is ignored: a good
signature from it counts as no signature.

## What the release job checks

On every pushed `v*` tag, before any dependency is installed:

1. the tag is an annotated tag whose signature verifies;
2. the signing key's fingerprint is in `MORPHIT_RELEASE_SIGNERS`;
3. the tagged commit is on `main`.

When the `MORPHIT_RELEASE_SIGNING_KEY` secret is set, it then signs the
tarball and the offline bundle with that key, which must be a pinned key; an
unpinned key fails the release. When the secret is not set, the release is
published without `.asc` files and its anchor names the pinned key that
signed the tag; installed nodes then accept it only by the SHA-256 in
@morphit's signed on-chain record.

These checks run inside the tagged tree's own workflow, so they stop a key
someone slipped into this directory, not someone who can rewrite the workflow
in the tag. That is what Forgejo's protected tags and a release runner that
runs no pull-request code are for; both are repository settings.

## Adding or removing a signer

1. The maintainer exports the public key:
   ```
   gpg --armor --export <fingerprint> > <handle>.asc
   ```
2. A pull request adds `.forgejo/release-signers/<handle>.asc` AND the
   fingerprint to both lists above. The fingerprint is checked out of band
   (Matrix DM, in person) before merging.
3. Removing a signer removes its fingerprint from both lists (and its `.asc`).

Installed nodes learn a new fingerprint only through an upgrade their current
pins already accept, so add a new signer one release before it signs.

## At release time

```
git tag -s vX.Y.Z -m "Morphit vX.Y.Z"
git push origin vX.Y.Z
```
