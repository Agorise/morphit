# Morphit v1.12.6

**Theme: the guided install never hangs, online or offline. The "list your instance" step now completes instantly on an offline/air-gapped install instead of blocking on a chain broadcast that has no network to reach.**

## Fixed

**The install's "list your instance on the federated directory" step no longer hangs offline.** On an offline or air-gapped install, that step signs your registration and tries to broadcast it to the chain — but with no network, the broadcast RPC calls had nothing to answer them and blocked until the operator pressed Ctrl-C. The step now checks whether the box can actually reach the chain first: if it can't, it skips the live attempt and relies on the deferred registration (which was already armed), so the install finishes cleanly and publishes your instance automatically the moment the box comes online. Nothing about the behavior on an *online* install changes — it still lists immediately.

**`morphit-ops register` run offline fails fast instead of hanging.** The registration broadcast now times out after 30 seconds with a clear message ("this box may not be online yet") rather than blocking indefinitely, so a manual registration on a not-yet-connected box returns control to you instead of appearing frozen.

## Notes

- No database migration in this release.
- These changes only affect the offline/air-gapped install and manual-registration paths; an online install and normal registration are unchanged.
- A registration that couldn't be broadcast (offline) is never lost — the deferred first-online registration publishes it automatically once the box has connectivity.
