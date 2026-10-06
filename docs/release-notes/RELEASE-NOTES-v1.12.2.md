# Morphit v1.12.2

**Theme: finish the offline-appliance story and make the node's own health report tell the truth. A node installed with no internet now completes itself the moment it comes online — TLS, on-chain registration, the warrant canary, and the Tor/I2P transports — with no manual steps. The health command reports sync state, node counts, backups, and the canary honestly.**

## Fixed

**A node installed offline now finishes itself when it first gets internet — including the hidden transports and the canary.** The "first-online" completion step already handled TLS and registration; it now also restarts Tor and i2pd (which, started with no network during an air-gapped install, would otherwise sit forever without bootstrapping) and publishes the warrant canary (whose freshness proofs need network). So a fully air-gapped install comes up complete the moment a link appears — no manual restart, no manual canary setup.

**The warrant canary sets itself up on an offline install instead of silently failing.** The canary setup aborted early on an air-gapped box because of a preflight check for a tool it only needs when actually publishing. It now arms the refresh script and weekly timer offline and defers only the network-dependent first publish — which first-online then does automatically once the box is online.

**Health: sync state reads "unknown" when the node can't reach any RPC, instead of a false "synced."** If every Blurt RPC endpoint is unreachable, the node genuinely can't see the chain head, so the health command now reports the sync state, chain head, and lag as "unknown" rather than showing a misleading "synced / 0 blocks behind."

**Health: the reachable-node count matches the list of nodes shown.** The "N/10 reachable" header is now counted from the same per-node list printed below it, so it can't disagree with the ✓/✗ rows (e.g. showing "9/10" when all ten are green).

**Health: the first database backup happens right after install, not up to half an hour later.** A fresh node now takes its first backup as soon as the indexer is up, instead of waiting on the backup timer's randomized delay — so the health command shows a real dump promptly.

**Health: layout + wording polish.** The TLS and AIDE lines align with the Services block above them, and a not-yet-published canary reads as a calm "not published yet — it needs network for its freshness proofs" rather than an alarming "missing."

## Notes

- No database migration in this release.
- Everything here is about install-time and operational reporting; there are no changes to trading, fees, or on-chain formats.
- Existing healthy nodes are unaffected; the fixes matter most for fresh and air-gapped installs.
