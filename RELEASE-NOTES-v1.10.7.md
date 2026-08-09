# Morphit v1.10.7

**Theme: a smooth first install. This fixes a guided-install failure, clears a false "APT is corrupt" warning on Linux Mint, and makes the long filesystem-baseline step show that it's actually working.**

This is a maintenance release. There are no database migrations and no breaking changes.

## Fixed

**Guided install no longer fails when dynamic DNS is enabled.** Several parts of the install place helper scripts in a shared directory, but that directory was only created by an optional step that runs late. If you enabled dynamic DNS, an earlier step tried to write its script before the directory existed and the install stopped with "destination directory does not exist." The shared directory is now created up front, so every part of the install finds it.

**No more false "Your APT configuration is corrupt" warning on Linux Mint.** The offline install bundle's local package index was missing a compressed form that newer apt looks for first, which made apt log harmless errors — and Mint's Update Manager reported them as a corrupt configuration. The bundle now ships that compressed index, so apt is quiet and the warning is gone. (Nothing was ever actually broken; the install worked regardless.)

## Changed

**The filesystem-integrity baseline step now shows it's working.** Building this baseline fingerprints your entire disk and, on a low-power mini-PC, can take considerably longer than the old "5–15 minutes" estimate — with no output in between, it looked frozen. The step now explains up front that it can take 15–40 minutes on slow hardware, runs in the background, and prints a steady heartbeat so you can see it's still going. (The tool reports no percentage, so it's an elapsed-time heartbeat rather than a true progress bar.)

**A clearer note in the node-operator guide** about the download size for a fresh install.

## Notes

- No database migrations. No breaking changes.
- If a guided install previously stopped at the dynamic-DNS step, this release resolves it.
