# Morphit v1.0.0-beta.12

A reliability, operations, and polish release. It supersedes the
incomplete beta.11 (whose release never finished) and folds in all of
that work, then adds the headline change: **Morphit nodes now run as
proper systemd services that survive reboots and restart themselves —
and the relay unlocks its signing key at boot from an encrypted
credential, so there is no plaintext passphrase on disk and nothing to
type by hand.** Operators no longer need to babysit `screen` sessions.
The rest is a guided web-firewall installer, a smarter upgrade that
won't strand a running node on old code, clearer menu labelling, and a
round of front-end polish. **Recommended for all operators — the
systemd setup is a one-time migration that makes a node genuinely
unattended (see the migration note at the end and RUN-A-MORPHIT-NODE.md
"Set up systemd services").**

## Added

- **Proper systemd services for the indexer and relay — unattended,
  reboot-surviving, self-restarting.** The shipped
  `morphit-indexer.service` and `morphit-relay.service` now match the
  standard `/opt/morphit` layout, come back automatically after any
  reboot, and restart on failure. No more running the services inside
  `screen` and re-attaching to fix them. (If you installed somewhere
  other than `/opt/morphit`, a one-line systemd drop-in points the
  units at your paths — the docs show how.)

- **The relay's signing key is unlocked at boot by an encrypted
  credential — no plaintext passphrase, ever.** The relay's active key
  stays encrypted at rest; its passphrase is supplied via a systemd
  *encrypted credential* (`systemd-creds`), bound to the host (and the
  TPM, if present) and useless if copied off the machine. The decrypted
  value lives only in RAM and never appears in the process environment
  or on persistent disk. The relay unit **refuses to start without it**,
  by design, so a node can never silently fall back to a plaintext
  secret.

- **A guided, plain-English BunkerWeb installer in `morphit-ops`.** The
  web-firewall menu entry can now install and bring up the optional
  BunkerWeb WAF for you, with a confirmation at each step, instead of
  only reporting its status.

- **A no-database "is the indexer caught up?" health view in the menu.**
  A new menu item checks the running indexer over HTTP (`/v1/health`) —
  sync state, last indexed block, and lag — and works without database
  or config access, so you can check sync as an ordinary user.

- **Menu items that need elevated privileges now say so.** Every
  `morphit-ops` action that reads the root-owned config, touches the
  database, or runs a privileged system operation now carries a dim
  `(needs sudo)` on its first line. The only unprivileged actions — the
  HTTP health check and Quit — are left unmarked.

## Changed

- **The upgrade is safer about a running node.** `morphit-ops upgrade`
  now refuses to prune an old backup directory while processes are still
  running out of it, and warns — with process IDs and restart guidance —
  if it finds an indexer or relay still running on the old code after an
  upgrade (the exact situation that can otherwise strand a node on a
  stale tree).

- **Front-end polish.** A brighter, wider shimmer on the wordmark; the
  brand gradient now headlines the glossary, explorer, instances, and
  QR-pair-login pages; and the instances list renders each node's
  registration date in a clean "18 April, 2026" form (with a guard
  against placeholder/epoch dates).

- **Clearer privacy wording.** The privacy/terms copy that explains what
  is public on the blockchain now reads more plainly — your offers, and
  the feedback and reviews you leave and receive, are public for
  reputation, posterity, and your own research on other traders — across
  all ten languages.

- **A brighter "update available" marker** in the upgrade menu, so it
  stays legible on pale terminal themes.

## Fixed

- **The coin carousel renders left-to-right in right-to-left locales.**
  The scrolling asset strip is now forced `dir="ltr"` so the tickers
  don't reverse under the Farsi layout.

- **The upgrade reliably refreshes the front end.** The upgrade
  identifies the running front-end container by its build bind-mount and
  restarts it directly, with no assumptions about its compose project or
  container name — so the new build is actually served afterwards.

- **Removed a dead translation key.** An unused "welcome" string was
  deleted from the locale files.

## Under the hood

- `systemCheck` now recognises Linux Mint and verifies Postgres and
  Docker availability, and the main menu was reorganised into a
  top-to-bottom, newcomer-friendly walkthrough with plain-English
  recommendations and their trade-offs.
- The relay's key-unlock path gained non-interactive credential-file and
  environment-variable modes — the credential file is the enforced
  production path; the environment variable is dev-only and logs a
  warning — covered by fourteen unit scenarios.
- New regression coverage: the menu's `(needs sudo)` tagging is asserted
  against the live menu, so a future command can't silently gain or skip
  the marker.

---

**Upgrading an existing node to unattended systemd (one time).** After
you've updated the tree to beta.12:

1. Create the relay credential, using the same passphrase you already
   use to unlock the relay key:
   ```
   echo -n '<relay-passphrase>' | sudo systemd-creds encrypt --name=relay_passphrase - /etc/morphit/relay_passphrase.cred
   ```
2. Install and enable the services:
   ```
   sudo cp /opt/morphit/ops/systemd/morphit-{indexer,relay}.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now morphit-indexer morphit-relay
   ```
3. Verify: `sudo systemctl status morphit-indexer morphit-relay`, and
   check the indexer with `morphit-ops health`.
4. Once both are healthy, stop the old `screen` sessions.

See OPERATIONS.md §3 ("Relay reboot") and RUN-A-MORPHIT-NODE.md ("Set up
systemd services") for the full details and the threat model.
