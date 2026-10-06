# Morphit v1.17.4

A polish release, written entirely from watching three real upgrades. Nothing
here changes what Morphit does — it changes what the upgrade *tells you* while
it does it. No protocol or consensus change.

## Fixed

- **Long steps no longer look frozen.** Installing dependencies, redeploying the
  MCP server, seeding to IPFS and refreshing the snapshot mirror could each sit
  silent for a minute or more with nothing on screen. Every one of them now turns
  a spinner while it works, so you can always tell the difference between "busy"
  and "stuck". Their output is replayed in full when the step finishes.
- **The seeding self-check can finally see your addresses.** It reported "no
  public origin found" and "no hidden address configured" on all three
  instances — including one that is reachable *only* over Tor and I2P, where the
  message was plainly absurd. Cause: it read one config file and your settings
  live in the other one. It now reads both, plus the web-firewall's own hostname
  as a last resort.
- **Hidden-only upgrades show their release notes.** A node that fetches over
  Tor/I2P had no release page to read notes from, so it printed an empty heading
  and you upgraded blind. The notes ship inside the tarball, so they are now read
  from there — the same bytes the SHA-256 already covers.
- **The gateway check no longer raises a false alarm.** It asked the gateway for
  an address the gateway does not serve, then read the resulting error as proof
  the connection was blocked — so it announced a problem on every instance,
  including ones demonstrably working. It now asks for something the gateway does
  serve, and treats any reply at all as proof the path is open.

- **Your own instance card now shows your own badge.** A node scores its
  clearnet-elimination gate for peers, but never recorded it for itself — so the
  one instance that had actually earned the "Zero use of clearnet internet" medal
  was the only place it didn't appear. Every peer showed it correctly. The self
  card now reads the same gate everyone else sees.
- **Your own instance card no longer disagrees with your peers about your
  status.** A node labelled itself only "Good" or "Syncing", while peers applied
  an orderbook-activity rule and could show "Quiet" — the same instance described
  two ways with nothing to explain the gap. The self card now applies the same
  rule. It only relabels on a definite answer, so a lookup that tells it nothing
  can never mark a busy instance quiet.

## Added

- **A safe way to rehearse fast-sync.** `--verify-only` runs the entire consumer
  path — find the signed snapshot on-chain, pick a mirror, download it over
  whichever transport suits the node, and prove every byte against the on-chain
  SHA-256 — then stops before touching any database and tells you what it found.
  It needs no indexer, no Postgres and no server, so you can rehearse the whole
  thing from a laptop and know it works *before* a brand-new instance depends on
  it.
- **The snapshot publisher's timer installs itself.** The publish units were only
  laid down by the automated server setup, which never runs on a hand-built
  install — including the canonical one. They are now installed on every upgrade
  but stay inert until you opt in by creating `/etc/morphit/snapshot-publish.env`,
  so exactly one instance publishes and no upgrade can make a box start signing
  snapshots by surprise.

## Changed

- **Less alarming output when a check is inconclusive.** The gateway check used to
  end with a warning that hidden-only peers could not upgrade from your box — a
  consequence it had not actually established, printed after the upgrade's own
  success message. It now reports only what it observed, says plainly that it can
  be wrong, and makes clear that nothing about it blocks your upgrade.

## Notes

- No protocol/consensus change. Everything here is operator-facing output quality.
- If v1.17.3 told you your box had no hidden address or warned that hidden peers
  could not upgrade from it, neither was true — both were reporting bugs, fixed
  here.
