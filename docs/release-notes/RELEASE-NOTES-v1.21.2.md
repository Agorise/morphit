# Morphit v1.21.2

Upgrades that get through a censored network, a warrant canary that keeps renewing on Tor-only servers,
and a release ceremony in the right order.

**Upgrading:** `sudo morphit-ops upgrade` on every server, Tor/I2P-only ones included. No database change.
This upgrade is run by v1.21.1's upgrade program; the canary repair below runs from this release during
the upgrade. **Every instance must run v1.21.1 or later before 2026-11-01 00:00 UTC**, when the stricter
consensus rules start; this release changes none of them.

## Upgrades

- **From the next upgrade, a server that cannot reach the public Blurt nodes still finds the release record.** The upgrade asked
  its own indexer for the on-chain record for 4 seconds, then the public nodes. On a server whose indexer
  reaches the chain over Tor (where the public nodes are blocked), both could fail, and the upgrade
  refused the release. When the public nodes fail too, it now asks its own indexer again and gives it
  time to answer; the error names both paths when neither answers. This takes effect from the upgrade
  after this one (this one is still run by v1.21.1's program): if a server refuses this release with
  "all RPC endpoints unavailable", run the upgrade again once its network is better.

## Warrant canary

- **The weekly renewal runs the installed release's canary code.** The canary setup recorded the folder
  it was run from (an unpacked copy in `~/Downloads/morphit` on a wizard install), which no upgrade
  updates, so the weekly renewal kept running old code. The setup now records the installed
  `/opt/morphit`, and the upgrade repairs an existing weekly renewal that runs as root: it points it at
  the installed release, and rewrites one written by an older setup with the same key, operator, address
  and account, the public key exported once from root's keyring, then starts a renewal in the
  background. A renewal script in another account's home, an older one that uploads the canary to
  another server, or one missing a value is not changed; the upgrade names the command to run. On a
  server where the weekly renewal used the old copy, this upgrade's own renewal still runs before the
  repair: if its last lines list the warrant canary, run the command they give on that server
  (`sudo systemctl start morphit-canary.service`).
- **On a Tor-only server the canary carries the Bitcoin block height again.** Every Bitcoin explorer
  failed over Tor, so the canary's Bitcoin block height read "(unavailable at signing time …)". Their `https://` addresses are now
  reached through Tor with the certificate checked as usual. A failed source now shows the reason, not
  only "fetch failed".

## Releases (maintainer)

- **The ceremony broadcasts the on-chain record before morphit.io upgrades.** Since v1.21.0 an upgrade
  installs an unsigned release only by its SHA-256 in that record, so the old order (upgrade in Block 3,
  broadcast in Block 5) made morphit.io refuse the release ("The release is not signed, and no signed
  on-chain release record names its hash"). The blocks now run: Block 3 builds and dry-runs the payload (the
  manifest from the published tarball, checked against the `verify.json` inside it), Block 4 broadcasts,
  Block 5 upgrades morphit.io, Block 6 checks that morphit.io serves the anchored build and repairs the
  canary. If a release has no IPFS CID, Block 3 has morphit.io host the release (installing nothing) with
  the release's own seed scripts, taken from the published tarball after checking its SHA-256, and print
  the CID. Because the record now reaches every node before it upgrades, a change to what the record may
  contain ships in one release and is used only by a later one.
- **The key prompt of the broadcast scripts stays on screen.** Its last line (in the snapshot scripts,
  the whole "Paste the … POSTING WIF" line) was erased the moment it appeared, so they seemed never to
  ask for the key.
- **A broadcast a node accepts without a block number is looked up on the other nodes** by its
  transaction id, and reported as confirmed once another node lists it in its block, instead of "NOT
  confirmed by a second node". An answer counts only for exactly this id, in a block the transaction
  can be in; the nodes are asked together each round, until the transaction has expired. A
  "duplicate transaction" answer is looked up the same way.
