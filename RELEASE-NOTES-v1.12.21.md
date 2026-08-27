# Morphit v1.12.21

**Theme: a faster, calmer, self-tidying upgrade — and a status label that tells the truth.**

## Improved

**Upgrading no longer downloads the same release twice.** After an upgrade, the box re-seeds the release to IPFS so it becomes an origin host. That seeding step used to re-fetch the ~13 MB release tarball over the network — the very tarball the upgrade had just downloaded seconds earlier — which was painfully slow on a Tor-only node. The upgrade now hands the seed the tarball it already has (a local copy, no second download), and cleans up the download scratch afterward so nothing is left on disk.

**A braille spinner now runs during any slow step.** The seed's `ipfs add` and DHT announce, and the stager's download, previously printed a line and then sat silent for minutes with no sign of life. They now show an animated spinner with a message whenever the terminal is interactive, so an operator is never left wondering whether the process hung. (Piped or logged runs stay clean — the spinner only shows on a real terminal.)

**Leftover processes from the previous install are stopped automatically.** When a process was still running with its working directory inside the old install (now the `.bak` backup), the upgrade used to only print a warning and leave it running stale code alongside the new services. It now stops those superseded processes automatically — a graceful signal first, then a forced stop for any straggler — touching only processes rooted in the backup directory.

**The install summary now checks the IPNS keep-alive timer.** The health roll-up already checked the hourly IPFS pin timer; it now also checks `morphit-ipns-rebroadcast.timer`, the 4-hourly job that re-publishes the signed IPNS record to the DHT so `ipns://<name>` stays resolvable (DHT records expire in ~48h). A box that seeds content but silently isn't keeping its name alive now gets surfaced.

## Fixed

**An RPC endpoint no longer reads as "cooling down" one moment and "unreachable" the next.** A failing hidden node showed a gray "cooling down" label from the passive health snapshot, then flipped to a red "unreachable" from the live probe — the same node described two contradictory ways. The status now shows the actual failure reason ("timed out", "connection refused", …) consistently, and treats cooldown as the internal backoff detail it is. A node that isn't answering inside its probe window (12s for Tor, 20s for I2P) now reads coherently as what it is, pointing the operator at the real problem instead of a vague one.

## Notes

- No database migration in this release.
- Everything from v1.12.20 and earlier is included.
