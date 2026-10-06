# Morphit v1.0.0-beta.4

A small but important fix on top of beta.3: the indexer could fail
to start on instances that set a Matrix **room** for operator
alerts. If you are on beta.3 (or earlier) and your indexer starts
fine, this release is still recommended but not urgent. If your
indexer crashes at boot with `ReferenceError: require is not
defined`, this release fixes it.

## Added

- **`morphit-ops doctor` — a read-only "will my node start?" check.**
  Run it from your install directory and it tells you, in plain
  English, whether the indexer and relay will start with the config
  you have on disk — *before* you start them. It reports exactly
  what is wrong (a missing required setting, a value in the wrong
  file, a key-file permission) and how to fix it, and it changes
  nothing on your system. If your node won't boot, run `morphit-ops
  doctor` first. It also runs a short **security check**: it tells
  you whether your relay's active key is encrypted or stored in
  plaintext (and how to encrypt it), and flags any secret file that
  other users on the box can read. (This security check is
  operator-only — it is deliberately not exposed on the public
  health endpoint.)

## Fixed

- **Indexer crashed at startup when `MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM`
  was set.** The config code validated the Matrix room alias using a
  CommonJS `require()` call, which is undefined in the indexer's
  ES-module runtime — so boot failed with `ReferenceError: require is
  not defined` the moment a non-empty room value was present.
  Instances that left the room unset were unaffected, which is why
  it surfaced late. The validator now uses a normal module import.
  Added a startup regression test (and a repo-wide guard against
  this whole class of CommonJS-in-ESM bug) so it cannot recur.

- **Setup wizard never wrote two settings the indexer requires.**
  An instance configured with `morphit-ops init` (rather than the
  Ansible playbook) was missing `MORPHIT_INDEXER_PUBLIC_ORIGIN` and
  `MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY`, so the indexer refused
  to start with `config validation failed: ... Required`. The wizard
  now writes both — the public origin (the same one it already asks
  you for) and the official `@morphit` posting key (a fixed value,
  the same for every instance). If you set up via the wizard and your
  indexer won't start citing these, re-run `npx morphit-ops init` on
  this release, or add both to your `morphit.env` by hand (see
  `ops/env/indexer.env.example`).

## Everything from beta.3 still applies

beta.3 fixed the setup wizard writing two settings into the wrong
file (which stopped the indexer from booting with an "operator
allowlist" error), added the guided `morphit-ops install`, the
`docs/start-here/` navigation hub, the migrate-to-release-track
guide, and made `morphit-ops upgrade` discover pre-release-flagged
releases. See `RELEASE-NOTES-v1.0.0-beta.3.md` for details.

## Upgrading

- If you installed cleanly from the beta.3 release and your indexer
  runs, just `npx morphit-ops upgrade` to pick this up (it carries
  your config and keys forward).
- If your beta.3 indexer crashed at boot with the `require` error,
  upgrade to this release and start it again — no config change
  needed on your side.

## Verify the download

```
sha256sum -c morphit-v1.0.0-beta.4.tar.gz.sha256
```

Output must say `OK` before you extract.

## Status

Pre-launch beta. Not yet recommended for production traffic. The
canonical public instance is morphit.io. Community operators
welcome — start at `docs/start-here/`.
