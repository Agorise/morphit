# Authorized release-signer keys

This directory holds the ASCII-armored GPG public keys (`.asc`) of
maintainers authorized to sign Morphit release tags.

## What this is for

The `.forgejo/workflows/release.yml` workflow runs on every annotated-tag
push that matches `v*`. **Before building the release artifacts**, it
imports every `*.asc` file in this directory into the CI runner's GPG
keyring and runs `git verify-tag <TAG>`. If the tag isn't signed, or
is signed by a key not present here, the release fails.

This is defense-in-depth against a compromised CI runner producing
tarballs from arbitrary commits — only commits signed by an authorized
maintainer can become releases.

## Adding a new authorized signer

1. The new maintainer generates a GPG key (`gpg --full-generate-key`,
   choose ECC (Curve 25519 if available), set a strong passphrase, no
   expiry or set ≥ 2y).
2. They export their public key:
   ```
   gpg --armor --export <key-id-or-email> > <handle>.asc
   ```
3. They open a PR adding `.forgejo/release-signers/<handle>.asc`.
   The PR should include the key's fingerprint in the description.
4. A current maintainer verifies the fingerprint out-of-band (Matrix
   DM, in-person, ...) before merging.

## Removing an authorized signer

Delete the corresponding `.asc` file. The next release will fail if
the removed signer's key was the one that signed the tag.

## What a signing maintainer does at release time

Once on a new machine:
```
git config --global user.signingkey <YOUR-KEY-ID>
git config --global tag.gpgSign true
```

For every release:
```
git tag -s v1.0.0-beta.3 -m "Morphit v1.0.0-beta.3"
git push origin v1.0.0-beta.3
```

The CI workflow runs, verifies the tag against this directory, and
produces the release artifacts.

## Format

Each file is one ASCII-armored GPG public key block, beginning with
`-----BEGIN PGP PUBLIC KEY BLOCK-----` and ending with
`-----END PGP PUBLIC KEY BLOCK-----`. Filename convention:
`<handle>.asc` (e.g. `ken.asc`). One key per file.
