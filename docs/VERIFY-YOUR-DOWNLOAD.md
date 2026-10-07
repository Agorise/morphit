# Verify your Morphit download

Morphit's source is public and pushed to **three independent git hosts**
— the project's own Forgejo, plus GitHub and Codeberg (Forgejo mirrors
every commit and signed tag to them automatically) — so no single host
can quietly disappear or tamper with it. This page shows you how to
**prove** that the code you got is the genuine, unmodified release.

Pick whichever matches how you got the code:

| You have… | Verify with | Proves |
| --- | --- | --- |
| a **git clone** (from any mirror) | `git verify-tag vX.Y.Z` | the release tag was GPG-signed by Morphit's key |
| the **source tarball** (from the release page) | `verify-download.mjs` (+ `git verify-tag`) | the bytes match what `@morphit` anchored on-chain, tied to the GPG-signed release tag |

Both trace back to the **same GPG key**, Morphit's release signing key:

```
7B4C 1D18 9DBB 610C 473B  59ED 5352 4E1F 1017 EB9C
```

`verify-download.mjs` has this fingerprint built in, and `@morphit`
also publishes it on the Blurt chain (a `morphit_release_v1` operation
with a `distribution` block). The expected hash comes from the
**blockchain**, checked against `@morphit`'s signature, not from the
host you downloaded from — so a malicious mirror can't serve you a bad
file *and* a matching "expected" value on its own web page. Compare the
fingerprint above with one you get through a different channel (the
Matrix room, another person's copy of the repo) before you trust it.

---

## Option A — verify a git clone (the signed tag)

If you cloned the repo from **any** of the three mirrors, verify the
release tag's signature. First import Morphit's public key (once). It
ships in the repository, so no key server is needed; confirm it is the
fingerprint above:

```sh
gpg --import .forgejo/release-signers/agorise.asc
gpg --fingerprint 7B4C1D189DBB610C473B59ED53524E1F1017EB9C
```

The key came with the code you are checking, so the fingerprint is what
you trust: compare it with one from a different channel (above). As an
optional cross-check, a key server should hand you the same key:
`gpg --keyserver keyserver.ubuntu.com --recv-keys 7B4C1D189DBB610C473B59ED53524E1F1017EB9C`.

Then, in your clone:

```sh
git fetch --tags
git verify-tag vX.Y.Z
git checkout vX.Y.Z
```

You want **`Good signature`** from Morphit's key. Because the commit and
the signed tag are byte-identical across Forgejo, GitHub, and Codeberg,
a tag that verifies is the genuine release no matter which mirror you
cloned from. That's the fully decentralized path — it needs no release
assets and no single host.

---

## Option B — verify the source tarball

The release page carries the source tarball, its checksum, and the
anchor CI recorded on-chain:

- `morphit-vX.Y.Z.tar.gz` — the source
- `morphit-vX.Y.Z.tar.gz.sha256` — its SHA-256
- `distribution-anchor.env` — the anchor CI wrote (the SHA-256 and the
  release-key fingerprint that also went on-chain)
- `morphit-vX.Y.Z.tar.gz.asc` — a detached GPG signature of the tarball,
  when the release job holds the signing key. A release without it is
  checked by its SHA-256 in the on-chain anchor (Step 1), which is what
  `morphit-ops upgrade` does too.
- `morphit-X.Y.Z-offline.tar.gz` (and its `.asc`, when signed) — the
  offline bundle (prebuilt dependencies and frontend, for upgrades without
  internet); its SHA-256 is in the on-chain anchor (`offline_sha256`).

---

### Step 1 — cross-check the on-chain anchor (always available)

`@morphit` publishes each release's hash, signing-key fingerprint, and
mirror list onto the Blurt chain (a `morphit_release_v1` operation with
a `distribution` block). The bundled verifier does not trust any single
Blurt node: it asks **two nodes on different hosts** (its default list is
six public clearnet nodes), requires
them to agree on the history and on the block that holds the release
op, recomputes the transaction id from that block, and checks that the
transaction's signature recovers to `@morphit`'s posting key, which is
pinned in the script (`BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9`).
Only then does it compare the anchor with your file. (This is stricter
than the browser's daily release check, which asks one node and relies on
the same signature check, asking a second node only when the
first fails or serves something that does not verify.)

```sh
node scripts/verify-download.mjs morphit-vX.Y.Z.tar.gz
```

or name the version you expect (this also verifies an OLDER release,
by finding that version's op):

```sh
node scripts/verify-download.mjs morphit-vX.Y.Z.tar.gz --version X.Y.Z
```

The offline bundle (`morphit-X.Y.Z-offline.tar.gz`) is checked the same
way, against the anchored `offline_sha256`; when the release carries its
`.asc`, verify that as in Step 2.

It prints your file's SHA-256 and tells you plainly whether it
**matches** the signed anchor. On a match it also shows the **GPG
fingerprint** to use in Step 2 — the one built into the script, not one
read from the chain (if the chain ever names a different key, it
refuses) — the mirror repos, and — **if the release was pinned to
IPFS** — a content-addressed **IPFS CID** (the CID *is* the hash, so no
gateway can serve altered bytes under it).

Exit codes: `0` verified · `1` mismatch, an op not signed by
`@morphit`, or an anchor naming a GPG key other than the pinned one ·
`2` usage error · `3` no two agreeing nodes · `4` no anchor found.

Because the expected hash and fingerprint come from the **blockchain**,
not from the host you downloaded from, a malicious mirror can't serve
you a bad file *and* a matching "expected" value on its own web page.

Note the two artifacts differ: this checks the **canonical release
tarball** from the release page. A source archive auto-generated by
GitHub or Codeberg from the tag has different bytes and won't match this
hash — for those, use **Option A** (`git verify-tag`) instead.

If it reports a **mismatch**, do not trust the download.

The verifier is dependency-free (only Node built-ins) and runs outside
a checkout. Read it — it's `scripts/verify-download.mjs` — so you don't
have to take even *it* on trust.

---

### Step 2 — confirm the signing key

Step 1 ties your tarball's bytes to `@morphit`'s signed anchor, which
names the release key. To confirm that key really signed this release,
verify the signed **tag**: clone any mirror and run **Option A**
(`git verify-tag vX.Y.Z`). A `Good signature` from that same fingerprint
closes the loop — the bytes match the chain, and the chain's key signed
the tag.

A release is signed on its bytes only when the release job held the
signing key. Then the release page also carries a `.asc` for the tarball
and for the offline bundle, and you can check a signature directly on the
bytes. A release without them is checked by Step 1 and the signed tag
above, which is also how `morphit-ops upgrade` installs it.

```sh
# import the key once (from your clone, or from the extracted tarball),
# and confirm its fingerprint (above)
gpg --import .forgejo/release-signers/agorise.asc
gpg --fingerprint 7B4C1D189DBB610C473B59ED53524E1F1017EB9C

# then verify the tarball (when the release carries its .asc)
gpg --verify morphit-vX.Y.Z.tar.gz.asc morphit-vX.Y.Z.tar.gz
sha256sum -c morphit-vX.Y.Z.tar.gz.sha256
```

A "Good signature" warning about the key not being *certified* is fine —
that just means you haven't personally signed the key; the fingerprint
match is what matters. If any check fails, **stop** — the file is not
what Morphit published.

### Pick your Blurt nodes

By default it uses a few public nodes. To choose your own, give a
comma-separated list of at least two nodes on **different hosts**
(the script counts hosts, so list nodes you know are run by different people):

```sh
MORPHIT_RPC=https://rpc.beblurt.com,https://rpc.blurt.one node scripts/verify-download.mjs morphit-vX.Y.Z.tar.gz
```

---

## If a host is unreachable

The code lives on three git hosts, so if one is down, clone from
another and use **Option A** (`git verify-tag`) — the signed tag is
identical everywhere:

```sh
git clone https://codeberg.org/agorise/morphit.git   # or the GitHub / Forgejo URL
cd morphit && git verify-tag vX.Y.Z
```

If the release was also pinned to IPFS, the verifier prints its CID. That
CID names a small **release directory** — the tarball (also under the
stable name `morphit-latest.tar.gz`), its `.sha256`, the release notes, a
`README.md` and a `metadata.json`; signatures are not in it, they stay on
the release page — so you can browse it, read the notes, or pull the exact
bytes and re-run the Option B checks:

```sh
# list what's in the release directory
ipfs ls <CID>
# fetch the tarball out of it (its bytes are content-addressed, so
# this is the same file the on-chain SHA-256 covers)
ipfs get <CID>/morphit-vX.Y.Z.tar.gz -o morphit-vX.Y.Z.tar.gz
```

No `ipfs` installed? A raw CID resolves on **any** public gateway (the CID is
the hash, so the gateway cannot serve altered bytes):

```sh
curl -fsSLo morphit-vX.Y.Z.tar.gz https://ipfs.io/ipfs/<CID>/morphit-vX.Y.Z.tar.gz
curl -fsSL https://ipfs.io/ipfs/<CID>/metadata.json   # version + sha256 + notes
```

Every Morphit instance re-hosts the current release over its own IPFS (Kubo)
node, so this content stays reachable without depending on any commercial
pinning service.

That CID is immutable — it only ever names *that* release. To always fetch
the **latest** release over IPFS, Morphit also publishes a stable **IPNS
name** (a `k51…` string, shown on the on-chain anchor as `ipns_name` and on
the download page). It resolves through a **w3name-aware** gateway —
`dweb.link` or `w3s.link` — to the newest release directory, which always
contains a stable-named `morphit-latest.tar.gz`:

```sh
# always the latest release tarball, by name instead of by CID
curl -fsSLo morphit-latest.tar.gz https://dweb.link/ipns/<name>/morphit-latest.tar.gz
# ...then run the same Option B checks on it (the on-chain SHA-256 tells you
# which version you actually got). Browse https://dweb.link/ipns/<name>/ for
# the versioned filename, release notes, and metadata.json.
```

Use `dweb.link` or `w3s.link` for the **IPNS name** — not `ipfs.io/ipns/…`. The
name is published via w3name, which those gateways resolve; the DHT-only
`ipfs.io/ipns` path does not (a raw `ipfs.io/ipfs/<CID>` fetch works fine — this
caveat is only for the `k51…` name).

IPNS is a convenience for *discovery* only — it is a mutable pointer, so a
copy fetched this way is still only trustworthy once it passes the
Option B checks above (the on-chain `source_sha256`, and the signed tag).
The immutable `ipfs_cid` and the signed tag remain the verification
anchors.

Because the signed tag and the on-chain hash (and the `.asc`, when the
release carries one) are all host-independent, code that passes
verification is the genuine release no matter where you pulled it from.

---

## Exit codes (for scripting `verify-download.mjs`)

`0` verified · `1` MISMATCH (do not trust) · `2` usage error ·
`3` no two Blurt nodes on different hosts gave the same answer ·
`4` no anchor found on chain.
