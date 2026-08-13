# Morphit v1.11.3

**Theme: a calmer, clearer install. The setup wizard reads like a smooth, successful setup — even with the network unplugged — and it can now turn on alerts for you. Plus: you can switch a node between Tor-only and clearnet whenever you like.**

## Added

**Set up alerts right from the install wizard.** The guided install now asks — right after the Matrix-contact question — whether you'd like your node to message you on Matrix when something needs attention (low disk, a backup that didn't run, a service down, a TLS certificate nearing expiry). Paste a bot account's access token and the personal `@you:server` address to alert, and alerting comes on by default: the Matrix bot plus the disk, SMART, package, and service monitors (and certificate-expiry monitoring on a clearnet node) all start together. Don't have a bot token handy? Press Enter to skip and turn it on any time later with `morphit-ops matrix`. Alerts only ever go to a private `@user:server`, never a `#room`.

**A documented way to switch a node between Tor-only and clearnet.** A node that started Tor-only can gain a clearnet domain later, and a clearnet node can drop back to Tor-only — either direction, as often as you like. Re-run the guided install and pick the other mode: your database, keys, and existing `.onion` address are all preserved, the clearnet web front and certificate are added or dropped automatically, and your on-chain registration re-publishes with the new address. See the new "Switching between Tor-only and clearnet" section in `RUN-A-MORPHIT-NODE.md`.

## Fixed

**The setup wizard no longer looks alarming.** On a normal install — and especially an offline or air-gapped one — the wizard used to surface a lot of noise that read like failures even though the install succeeded. That's cleaned up across the board:

- Benign system messages that read like errors ("Permission denied" while setting up temporary directories, an unsandboxed-apt notice, a harmless collection-download message) no longer appear.
- The check that confirms your site serves fresh updates no longer prints a wall of "retrying" lines followed by a warning; it reports a single calm status line, and is skipped with a friendly note when the box is offline.
- A successful container build is no longer labelled as a "warning."
- The warrant-canary and privacy-address (Tor/I2P) steps explain themselves plainly instead of using alarming technical wording — and on an offline box, the canary clearly says it will publish itself automatically once the box is online, rather than looking like a failure.
- The closing "no alerting" notice is now a short, calm, optional suggestion — and doesn't appear at all when you set up alerts during the install.
- Assorted wording that leaned on the word "fail" has been softened where nothing had actually failed.

**`/v1/health` now agrees with `morphit-ops health` about the relay.** On a containerized deployment the relay binds to the Docker bridge gateway (so the web container can reach it), not to loopback — and the indexer's public `/v1/health` was probing loopback only, so it reported the relay **down** even while the local health view (which also tries the bridge gateway) showed it **up**. The public health check now tries the same addresses, so the two agree.

**A crash-looping service no longer looks like it's just "starting."** `morphit-ops health` read only a unit's top-level state, so a service that was failing and being auto-restarted (for example, a Matrix bot with a bad token or an unreachable homeserver) showed as a calm "starting" indefinitely. It now recognises the restart loop and reports it as failed, with a pointer to `journalctl -u <unit>` so you can see why.

## Notes

- **No database migrations. No breaking changes.**
- Switching a node's mode, and setting up alerts, are both non-destructive and fully reversible.
