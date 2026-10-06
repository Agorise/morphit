# Morphit v1.17.0

Operator-safety release. Hardening can no longer strand an operator or take a site
dark; fast-sync works on a stock box and recovers a stranded flagship from any
synced peer; Matrix alerts set themselves up with zero hand-editing; and hidden-only
instances are audited clean of any clearnet reliance.

## Fixed

- **Hardening can no longer lock you out of SSH.** `harden` set `PermitRootLogin no`
  whenever *any* key was authorized — including a root-only key — locking out an
  operator whose only login was root. It now disables root login only when a
  **non-root keyed user exists**, and otherwise keeps **key-only root**
  (`prohibit-password`), so it can never strand the sole operator.
- **Hardening can no longer take the public site dark.** Enabling UFW flushes
  nftables, wiping Docker's forwarding chains — external traffic reached the box
  but the DNAT-forward to the frontend container was dropped (the box looked
  healthy to itself while the world timed out). `harden` now **re-asserts Docker's
  chains** after the firewall change, **verifies** the NAT rules returned, and
  **hard-fails** if they didn't.
- **Fast-sync works on a stock box.** The snapshot bootstrap validated against a
  half-loaded environment and bailed (`MORPHIT_INDEXER_CHAIN_ID: Required`) because
  the fast-sync wrapper only inherited part of the operator env. It now **sources
  the same env files the indexer unit does**, so a correctly-configured box can
  fast-sync.
- **matrix-bot no longer crash-loops on an E2EE key collision.** Reusing an access
  token after a reinstall causes a "one time key … already exists" collision; the
  bot now **self-clears the dead crypto store**, prints a plain-language fix, and
  exits cleanly instead of hammering systemd.
- **timeapp language filter.** Browsing in a locale no longer auto-locks the order
  language filter (which hid other-language orders and re-appeared on refresh);
  clearing the filter now re-queries immediately.

## Added

- **Fast-sync is the default, and can import a peer snapshot.** The install offers
  it `[Y/n]`; the menu path now **offers to stop the indexer** (checking the real
  service state, no 90 s wait), **offers to discard existing data** (no `--force`
  archaeology), and **auto-restarts** after. New `morphit-ops fast-sync --from-file
  <snapshot.tar.gz>` imports a snapshot handed over from any synced peer — for when
  no fresh on-chain snapshot exists.
- **Harden self-heals a broken run (dead-man's-switch).** After a run that changes
  SSH or the firewall, an automatic revert is armed via a transient `systemd-run`
  timer (independent of your SSH session). Confirm you can still reach the box and
  it cancels; otherwise it **restores the exact pre-run SSH + firewall + Docker
  state** within ~2 minutes. Plus a post-harden self-test that fails loud on a
  lockout.
- **Matrix alerts set themselves up — no hand-editing.** `morphit-ops matrix setup`
  (and the install wizard, and harden) collect the recipient + the bot's
  username/password, **mint a fresh token** via the Matrix login API, persist it,
  clear the stale crypto store, start the bot, and send a test. Entering a Matrix
  address during setup wires the whole thing.
- **Health report:** a "Generating your health report…" spinner; CPU/Memory now
  show **free**; a "Reachable at" list of every address the node serves (clearnet +
  Tor `.onion` + I2P `.b32.i2p`); and the install wizard now has an explicit warrant
  canary step and offers to serve the frontend on a new vanity `.loki`/`.i2p`.

## Changed

- npm's update-notifier is silenced globally (no more "new major version of npm"
  noise on install/upgrade). Italian "commissione" → "commissione (fee)" on the
  order fee-status line. The redundant CryptoCompare price source is dropped
  (it required new auth); a source that's up for one asset but doesn't list another
  now reads **"no market"** instead of an alarming **"down"**.

## Security

- **Hidden-only instances stay clearnet-free.** Audited across all of the above:
  the harden auto-revert restores the **exact** pre-run firewall rules (never opens
  clearnet ports a hidden-only box didn't have); the post-harden self-test skips
  clearnet checks on a Tor/I2P-only box; the health "Reachable at" list never prints
  a clearnet address the node doesn't serve; and fast-sync's env-sourcing fix
  actually *improves* hidden-only sync (the bootstrap now gets the Tor/I2P proxy
  config). The Matrix token mint uses the same outbound path as the bot itself; a
  fully air-gapped box uses the paste-a-token path.
- **Matrix token stays 0600.** The bot access token is written only to
  `matrix-bot.env` (0600, owner-only) and preserved from there on re-render; only
  the non-secret recipient MXID lives in the group-readable operator config.

## Notes

- No protocol/consensus change. All changes are operator-facing safety, recovery,
  and privacy hardening.
