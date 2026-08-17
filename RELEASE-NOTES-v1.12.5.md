# Morphit v1.12.5

**Theme: the tor-only relay comes up on its own. This release closes the last crashes on the hidden-service install path — a fresh tor-only node now boots every service, unattended, with no manual steps. Plus honest reporting fixes and a backup safeguard.**

## Fixed

**The relay no longer crash-loops on a tor-only node.** A tor-only node has no clearnet domain, so its Web Push (VAPID) subject rendered as a domain-less `https://`, which the relay rejected — taking the whole relay down over an optional feature. The relay now treats an unusable VAPID subject as "web push disabled" and boots normally (web push is a clearnet-only browser feature and doesn't apply to a tor-only node anyway). The operator gets a clear, non-alarming log line explaining push is off.

**Dynamic DNS is no longer set up — or flagged — on a tor-only node.** A tor-only node has no clearnet domain for dynamic DNS to update, so the ddns role is now skipped entirely and the install summary no longer expects or reports the `morphit-ddns.timer`. No more spurious "dynamic DNS ✗" on a hidden-service install.

**The relay is no longer mislabeled "answered, but not as the relay."** The health command's classifier was treating the relay's `/v1/health` (which has no chain-head field, because it isn't an indexer) as an indexer that hadn't synced. A healthy relay now reports correctly.

**Backups never keep a schemaless fragment.** If a backup runs before the indexer has migrated its schema (a race possible on a fresh node), it now skips cleanly instead of keeping a tiny, useless dump that health would flag as "failing." The next run captures a real backup once the schema exists.

## Notes

- No database migration in this release.
- All fixes are on the tor-only install path or in operational reporting; clearnet nodes are unaffected (a clearnet relay with a valid VAPID subject still has web push enabled exactly as before).
- With this release, a fully air-gapped tor-only install brings up every service — indexer, relay, transports, canary, backups — on its own after first connectivity.
