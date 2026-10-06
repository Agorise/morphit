# Morphit v1.10.6

**Theme: guided (ansible) installs can upgrade reliably. This fixes a bug where an ansible-installed node's online upgrade could fail whenever a release introduced a new dependency.**

This is a maintenance release. There are no database migrations and no breaking changes.

## Fixed

**Online upgrades on ansible-installed nodes no longer fail on new dependencies.** The `morphit-ops` launcher created by the guided (ansible) install runs the tool in npm's offline mode for a fast start-up. That offline setting was being inherited by the upgrade's own dependency install step, forcing it to use only what was already in the local cache. On any upgrade that added or changed a dependency — for example a version jump that pulls a package the machine had never downloaded — the install step failed and the upgrade rolled back. Nodes installed manually were never affected because their launcher doesn't use offline mode. The upgrade now clears that inherited flag before installing dependencies, so it can reach the registry when it needs to. Genuinely offline (air-gapped) upgrades are unaffected: they ship their own bundled dependencies and never touch the registry.

## Changed

**Release automation now warns loudly if the offline install bundle is missing.** The self-contained offline tarball is built on a best-effort basis, so a release could previously ship without it and no one would notice until an offline operator got stuck. Release runs now surface a prominent warning when the offline bundle wasn't produced, so it can be built and attached before the release is announced.

## Notes

- No database migrations. No breaking changes.
- If a previous online upgrade on an ansible node failed part-way with a dependency/cache error and rolled back, this release resolves it.
