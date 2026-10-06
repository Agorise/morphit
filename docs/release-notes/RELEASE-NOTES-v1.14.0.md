# Morphit v1.14.0

**Theme: a brand-new node reaches a live orderbook in minutes instead of days — and while it catches up, its operator sees exactly what's happening.**

## Added

**Fast-sync a fresh node from a signed, verifiable snapshot.** Standing up a new instance no longer means replaying millions of blocks over (often slow or censored) RPC for days. A caught-up federation node now publishes a snapshot of its indexed state to IPFS and anchors a signed pointer to it on-chain; a fresh node fetches it, verifies it three independent ways, restores it, and only catches up the short remaining tail. Days become minutes.

- New operator command: `sudo morphit-ops fast-sync` (offered as the recommended path when setting up a new node). It reads the newest snapshot pointer published by a signer you trust, downloads it (with an HTTPS mirror fallback), and proves the download against the on-chain hash — the manifest, the file, and the signed pointer must all agree — before anything is restored.
- The trust surface is explicit and layered: you trust the publisher only for the older, settled state; the recent tail is re-verified by normal indexing, and a built-in spot-check confirms the snapshot's records genuinely match the chain before the node serves. Prefer zero trust? A full trustless replay is always one setting away.
- Publishing side: a daily auto-publish timer keeps a fresh snapshot available, and only ever publishes from a node that is itself fully caught up and healthy.

**The orderbook now explains itself while an instance is still catching up.** Instead of an empty or broken-looking orderbook on a node that hasn't finished syncing, visitors see a clear banner — how far along the sync is, and roughly when orders should be available (in UTC) — in all ten languages. The estimate is derived from the node's actual catch-up rate and shown as "estimating" until there's enough signal to be meaningful.

## Changed

- The public censorship-resistant RPC roster carried by every node now includes the newly-online hidden-service nodes alongside the existing ones, so a fresh install reaches the whole set immediately.
- The RPC-endpoints status card now reads **"offline at the moment"** rather than "unreachable" for a node that didn't answer on its last check — clearer, and less alarming for a node that's merely re-establishing.

## Notes

- No database migration and no on-chain changes are required to upgrade.
- Everything from v1.13.2 and earlier is included.
