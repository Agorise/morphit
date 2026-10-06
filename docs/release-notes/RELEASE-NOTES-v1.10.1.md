# Morphit v1.10.1

**Theme: a node you can look after with less effort. This release is a cluster of practical improvements for the people who run Morphit instances — clearer status while a fresh node catches up, at-a-glance proof that your node is helping host the release, one command that hands your whole health picture to a monitor, and upgrades that keep working when the internet doesn't. Underneath, a brand-new node now writes its catch-up to the database in safer, bounded batches.**

This is a maintenance release. There are no database migrations and no breaking changes; an ordinary online instance behaves exactly as before.

## Added

**See whether your node is seeding the release.** Every instance runs a small IPFS node that pins the signed release and rebroadcasts the `ipns://` record so releases stay hosted and resolvable as long as any instance is alive. The node-health view now shows an **IPFS/IPNS release seeding** line — `ok`, `degraded`, `down`, or `not-configured` — so you can tell at a glance that your box is doing its share, without digging through logs.

**One command for monitoring.** `morphit-ops health --json` now prints the *whole* node-health view as one machine-readable object — indexer, relay, system (CPU/memory/disk), background services, backups, the warrant canary, and the new IPFS/IPNS seeding state. Point Zabbix (or any monitor) at it — run it on a timer into a file, or through an agent — and alert on any section leaving its healthy state. Host-level operational detail like this stays out of the public health endpoint on purpose, so a passing stranger can't learn that your backups are failing or your disk is full.

**Upgrade with no internet, from a USB stick or a folder.** Copy the signed `-offline` tarball (and its signature) onto the box and run `morphit-ops upgrade --from-file=…`, or simply drop it into the offline release folder — the main menu then shows **● update available (offline tarball ready)** on its own, and a normal upgrade uses it automatically whenever the network can't be reached. An upgrade that begins online even finishes from that dropped tarball if the connection drops partway through. Unsigned tarballs are refused.

**Set up your warrant canary during install.** The guided home install now offers to set up your warrant canary right then, instead of leaving it as a separate follow-up step.

**Clearer instance status.** The public instances list now tells apart a node that is still catching up (**Syncing**) from one that has genuinely fallen behind (**stale**), and the status dropdown uses plain-language labels for each state.

## Changed

**Safer initial sync.** When a fresh node replays the Blurt chain to build its local view, it now commits each window of blocks in one bounded database transaction rather than one transaction per block. If the machine crashes mid-catch-up, the partial window rolls back cleanly and the node resumes from exactly where it left off — with no half-written state and no risk of a long transaction stalling the database. The same data ends up stored; there is nothing to configure.

**Releases mirrored automatically.** Each release is now also published to the codeberg.org and gitea.com mirrors (when their tokens are configured), so upgrades keep finding a release even if the main forge is unreachable.

## Fixed

**IPNS rebroadcast on ansible-managed nodes.** An instance installed through the ansible role now also rebroadcasts its IPNS record on a timer. Previously only the hand-run IPFS setup did this, so an ansible-managed node could quietly stop keeping the `ipns://` name alive. The rebroadcast needs no key — it simply re-announces the release's own on-chain-signed record — and now runs everywhere.

## Notes

- No database migrations. No breaking changes.
- The complete node-health picture (including backups, disk, and IPFS seeding) is available through `morphit-ops health --json`, locally or over SSH; it is deliberately not exposed on the public `/v1/health` endpoint.
