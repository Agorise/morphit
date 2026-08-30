# Morphit v1.14.1

**A UX + hardening follow-up to v1.14.0. No new features, no database migration, no on-chain changes.**

## Changed

**Fast-sync is now the default when setting up a new node.** The guided install wizard (`morphit-ops install`) now offers fast-sync as a default-yes step: a new operator just presses Enter to restore the newest signed federation snapshot and be live in minutes, and has to actively decline to fall back to a full replay. This is what v1.14.0's release notes described; in v1.14.0 fast-sync existed only as a separate command, so this closes that gap.

## Fixed

**The stats-page RPC endpoints card now tells the truth on refresh.** Clicking the card's refresh button (or reloading the page) fires a live re-probe of every node — but a node that had just been shut down kept showing its stale last-known latency instead of going offline. The card's anti-flicker rule (which correctly ignores a single jittery Tor/I2P miss on a node that's actually up) was suppressing *every* fresh miss, because a failed probe always reported exactly one failure. Now a missed probe is retried once, and only a genuine double-miss is reported as a real outage — so a node you shut down shows as "offline at the moment" on the next refresh, while a merely-flaky-but-alive node still doesn't false-alarm.

**fail2ban can no longer lock out your admin machine.** The standard node hardening (both the Ansible role and the manual OPERATIONS.md §34 steps) now writes an `ignoreip` whitelist into fail2ban's `jail.local`, with a `fail2ban_ignoreip` variable for your admin IP. This prevents the failure mode where a noisy release ceremony (repeated SSH passphrase prompts → failed auths) got the operator's own IP banned mid-release.

## Notes

- Upgrade in place; everything from v1.14.0 and earlier is included.
