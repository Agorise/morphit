# Morphit v1.17.2

Hidden-seeding and fast-sync release. Two things were quietly broken in the same
place: a Tor/I2P-only instance could not upgrade from the federation for weeks
because of a single missing firewall rule, and a Tor/I2P-only instance could not
*fast-sync at all* because the snapshot it needs was only ever reachable over
clearnet. Both are fixed, along with the checks that reported success while the
first one was broken. No protocol or consensus change.

## Added

- **Every instance now mirrors the federation indexer snapshot.** Fast-sync is
  what gets a brand-new node from an empty database to a live orderbook in
  minutes instead of days, and it depends on one small (~600 kB) file that
  `@morphit` anchors on-chain. Until now nothing kept that file reachable from
  anywhere except the canonical box and a few public clearnet IPFS gateways —
  which made one box a single point of failure for every new instance, and made
  fast-sync impossible for a zero-clearnet node. Your instance now pins that file
  and re-serves it over your clearnet origin, your `.onion` and your `.b32.i2p`,
  refreshing weekly and after every upgrade. Mirroring is not a trust claim: a
  newcomer proves every byte against the signed on-chain SHA-256, so a bad mirror
  is caught by arithmetic rather than by reputation. Nothing to configure.
- **Fast-sync works over Tor and I2P.** A new node now prefers federation peers
  on the transport it already speaks, ahead of any clearnet source. A hidden-only
  node omits clearnet sources entirely and falls back to a full replay rather than
  reaching for a public gateway — finishing faster is never worth deanonymising
  the box. Peers are discovered from the same chain history the node already reads
  to find the snapshot, so a brand-new box with no indexer yet still finds a
  private mirror, and no address is baked into the source tree to go stale.
- **The frontend-to-gateway firewall path now repairs itself.** Every upgrade
  probes the connection from inside the frontend container and, if it is being
  dropped, fixes it in place — firewall rule, then a fallback rule, then a
  container restart, verifying after each and reporting which one worked. An
  instance admin is never asked to paste a firewall command.

## Fixed

- **Hidden-only instances can upgrade from the federation again.** The frontend
  proxies `/ipfs/` and `/ipns/` to the IPFS gateway on the host, but the firewall
  had no rule for that port — so the container-to-host connection was dropped, nginx
  timed out, and every `.onion` / `.b32.i2p` release fetch returned a stock 404. Any
  instance running the web firewall was therefore **unable to serve releases over
  Tor or I2P**, which is why hidden-only nodes fell back to stale copies from
  elsewhere and failed their integrity check. Hardening now opens that port to the
  web-firewall network only (never the public), when this box hosts IPFS — and the
  self-heal above delivers the same fix to instances the installer never manages.
- **The seeding self-check actually runs now.** The check introduced for this
  release used a Bash-only construct in a script that runs under `/bin/sh`, which
  on Ubuntu aborts the moment it is called. In practice the entire per-transport
  verification — and the step after it — never executed on a single real box. It
  is now plain POSIX shell, and a probe that cannot connect reports that instead
  of killing the script, which matters because an unreachable gateway is exactly
  what it exists to detect.
- **No more false "your firewall is broken" warning.** The same check asked the
  frontend for the release using the loopback address, which the web firewall
  rejects on every path even on a perfectly healthy box — so it would have told
  every operator at once that their firewall was dropping connections. It now asks
  using the instance's real hostname, and treats a refusal from its own probe as
  inconclusive rather than as a fault.
- **Reachability checks no longer time out on healthy nodes.** The Tor and I2P
  checks downloaded the full ~33 MB release tarball, which routinely outruns any
  sane timeout over a hidden transport and reported working nodes as broken. They
  now fetch a small file over the identical path.
- **"Working seeder" is verified, not assumed.** The previous self-check asked
  the *local* gateway whether it served the release and then announced the box was a
  working seeder over every transport. That passed happily while no peer could fetch
  anything. It now checks the path a peer actually uses — through the frontend, then
  end-to-end over each configured `.onion` and `.b32.i2p` — and reports each
  transport separately, with the exact fix when one fails.
- **No more false "unsigned tarball will be refused" warning.** A release fetched
  over Tor/I2P carries no detached signature by design: it is verified against the
  SHA-256 anchored on-chain, read from the node's own indexer. The warning now
  describes what actually happens — the on-chain hash is used, and the upgrade is
  refused only if neither a signature nor a matching hash can be established.

## Changed

- **The health report no longer overstates IPFS seeding.** Its "ok" verdict is based
  on local timer runs (the release is pinned, the IPNS record was rebroadcast), which
  does not prove a peer can fetch it. The wording now says exactly that, and points at
  the upgrade's seed step for the real per-transport reachability check.
- **Snapshot publishing is a single-signer job, and is off by default.** Exactly one
  instance in the federation exports and anchors the snapshot; everyone else mirrors
  it. An ordinary instance will never begin anchoring snapshots under its own account
  just because it was installed with defaults.

## Security

- The new firewall rule is scoped to the pinned web-firewall network and opens only
  the read-only release gateway, which serves pinned releases and nothing else. It is
  gated on the box actually hosting IPFS, so a node without IPFS opens no new port,
  and a Tor/I2P-only box gains no clearnet exposure.
- A mirroring instance verifies the snapshot against the on-chain SHA-256 before it
  will serve it, and removes the pin if the hash does not match — so a box can never
  become a mirror for content the signer did not publish.
- The self-heal only ever adds a rule permitting the pinned container network to reach
  the local read-only gateway, and verifies by observing the connection rather than
  trusting a command's exit code.

## Notes

- No protocol/consensus change. All changes are operator-facing seeding, upgrade,
  fast-sync and reporting accuracy.
- Mirroring rides on IPFS release hosting: a box without Kubo skips it silently.
  `OPERATIONS.md` §52 covers the whole pipeline, including how to opt out.
