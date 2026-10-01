# Morphit v1.20.1

A fix release for problems found while upgrading the live instances to v1.20.0. There are no
database changes and no changes to on-chain operations.

## Fixed — upgrades and operations

- **BunkerWeb could stop taking any new settings.**
  - Morphit's firewall exception for its API was stored twice on some servers. With two copies,
    BunkerWeb rejects every new config it builds and quietly keeps serving the last one that
    worked. On one instance that had been true for three weeks, so settings changed since then,
    including the one that stops visitors choosing their own IP address, never took effect.
  - The upgrade now keeps exactly one copy and removes the others, after a backup of BunkerWeb's
    database. It then checks on the live site that the API still gets through and the rest of
    the site is still protected, and puts the copies back if not.
  - The upgrade now reads BunkerWeb's own verdict on every change. If BunkerWeb refuses a config,
    you see nginx's reason instead of a vague "not applied yet".
- **Slow BunkerWeb servers finish their settings change.**
  - Where BunkerWeb's downloads time out, it needs minutes to rebuild its config after a change,
    which is longer than the upgrade could wait. The change was always put back.
  - On a BunkerWeb server the privacy and header settings are now applied in the background, for
    as long as BunkerWeb needs. The upgrade shows the progress while it can, and
    `sudo morphit-ops status` shows the result under "Web proxy (BunkerWeb)".
- **A relay that stopped could stay stopped.** The relay could end without an error, so systemd
  did not restart it, and the upgrade then skipped it because it was not running. One instance's
  relay was down for three days this way, and sign-ups there failed.
  - The relay and the indexer now restart after any exit.
  - A relay that ends without being asked to logs why and exits with an error.
  - The upgrade starts an enabled relay that is not running, and checks that it stays up.
- **The sign-up limits work.** The relay could not reach its state folder, so the daily sign-up
  ceiling was never saved and a `SIGNUPS_DISABLED` file was never seen. The folder is now
  `/var/lib/morphit-relay`. The upgrade moves anything already in the old one, so paused sign-ups
  stay paused, and `/var/lib/morphit/relay` now points to the new folder.
- **The release ceremony's payload step installs its packages first** (`npm ci`), so it cannot
  run against outdated ones on the maintainer's computer.

## Upgrading

Run `sudo morphit-ops upgrade` on each server. Nothing needs doing by hand.

- **On a BunkerWeb server,** the upgrade ends with the result of the background settings change,
  or says it is still running. Check it later with `sudo morphit-ops status`.
- **Signed-up counts:** the first day after the upgrade starts a fresh daily count, because the
  old count was never saved.
