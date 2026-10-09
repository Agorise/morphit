# Morphit v1.21.4

A server on a network that filters Tor now moves its Tor onto bridges by itself, so its .onion stays
reachable. The twice-a-day release check, new in v1.21.3, works now: it could not run anywhere. An
upgrade no longer refuses a release because one node's history did not list its on-chain record yet.
A Tor/I2P-only server can now hold its own copy of the federation snapshot.

**Upgrading:** `sudo morphit-ops upgrade` on every server, Tor/I2P-only ones included. No database change.
This upgrade is run by the upgrade program of the release the server runs now. The repairs below run
from this release during the upgrade; the changes to how an upgrade reads the release record and to its
last lines take effect from the next upgrade. **Every instance must run v1.21.1 or later before 2026-11-01 00:00 UTC**, when the
stricter consensus rules start.

## Tor on a network that filters it

On 2026-10-09, morphitir's Tor loaded nothing:

- Its network sends every torproject.org name to a sinkhole (`10.10.34.36`).
- Connections to Tor relays open, but the circuits built over them stall.
- Plain Tor loaded 0 of 6 pages, and so did a fresh Tor client.
- The .onion could not publish its address record, so nobody could reach it over Tor.

Over the Tor Project's built-in bridges, Snowflake and obfs4, Tor connected at once. With those bridges
in `/etc/tor/torrc`, morphitir's .onion answered, from morphitir itself and from morphit.io.

- **The Tor bridges repair.** It runs in the upgrade's background checks, and on a new timer
  (`morphit-tor-bridges.timer`: half an hour after the timer starts, at boot or when the upgrade turns
  it on, then every 6 hours). To run it now: `sudo morphit-ops upgrade --tor-bridges`.
  - It first checks that Tor works: this server's own .onion, then a page through Tor. A Tor that works
    without bridges keeps its configuration.
  - When Tor loads nothing, it installs the transport programs from the distribution
    (`snowflake-client`, `obfs4proxy`).
  - A Tor/I2P-only server uses obfs4 only: Snowflake needs DNS, which that server's egress rule refuses.
    Its downloads go through Tor, so it installs `obfs4proxy` while Tor still works. If its Tor loads
    nothing before that, the result says how to bring the package in by hand.
  - It writes the bridges into `/etc/tor/torrc` between `# >>> morphit: Tor bridges` markers, only
    after `tor --verify-config` accepts the file. The first original is kept as
    `/etc/tor/torrc.bak-before-bridges`. The onion service's keys are not touched.
  - Tor restarts and must connect within 5 minutes; then the .onion or a page must load through it.
  - A server already on bridges that loads nothing gets the release's bridges again, then plain Tor;
    when plain Tor works, the bridges come out again.
  - A server on bridges that works is checked, at most once a day, with a separate, throwaway Tor client
    without bridges, run as Tor's own user. It connects to public Tor relays, which a filtering network
    can see. When it loads through plain Tor, the bridges come out, proven the same way. If this
    server's Tor then does not work without them, they go back, proven, and plain Tor waits a week.
  - When nothing works, the previous `torrc` goes back and Tor restarts on it. If it cannot be written
    back, the result says so.
  - `/etc/tor/torrc` is read again before each write, by this repair and by the onion proof-of-work
    repair. An edit made meanwhile, by an operator or another repair, is never overwritten or put back
    over.
  - Each Snowflake bridge also names one domain front as `front=`, the only form Ubuntu's
    `snowflake-client` reads.
  - The whole repair takes at most 45 minutes, and runs one at a time.
  - The timer only runs with an upgrade program that knows `--tor-bridges`. On a server moved back to an
    older release it does nothing.
- **The bridges ship with the release.** A network that filters Tor blocks torproject.org too, so the
  list Tor Browser uses is in `ops/tor/builtin-bridges.json`. docs/OPERATIONS.md §51.0 says how to
  refresh it.
- **The IPFS seed check tries a .onion three times.** When it still fails, it says why (curl's own
  message) and names the repair, instead of one try and "HTTP 000".

## The release check

- **It works now.** In v1.21.3 it failed on every server with "morphit-indexer.service is not running"
  while the indexer ran:
  - It runs as a throwaway user in a sandbox that cannot read `/etc/morphit/indexer.env`. So it could
    not tell a clearnet server from a Tor/I2P-only one, and took the strict path.
  - That path proves the answer on the indexer's address comes from the indexer service. To do so it
    asked `systemctl` for the indexer's process ID, and `systemctl` cannot reach systemd from that
    sandbox ("Transport endpoint is not connected").
  - It now reads the indexer's processes from its cgroup, which only systemd writes. The listener must
    still belong to the indexer's user. Proven on morphitir's real unit.
- **A reason too long for its alert ends with "…"**, instead of breaking off mid-word; one that already
  ends with a full stop no longer gets a second one.

## Upgrades and the release record

- **One node's answer no longer decides that a release has no record.** On 2026-10-08 morphit.io's
  upgrade read @morphit's history through one node that did not list the new record yet, and refused;
  the same command a minute later worked.
  - The upgrade now asks this server's indexer, then each configured Blurt node directly (not on a
    Tor/I2P-only server).
  - When a node answered without the record, or listed it without having its block yet, it asks again
    for up to 3 minutes, under the spinner, before refusing.
  - The record's signature decides, so any node may be asked. On a clearnet server, a release signed
    by a pinned key needs no record and never waits.
  - The wait ends on time: no node is asked once the 3 minutes are up.
- **The last lines say "Every service restarted on it (checked)."** whenever each restarted service,
  the MCP server and the Matrix alert bot included, was seen to stay up on the new version. Before, any
  unrelated warning, such as one from the IPFS seed check, dropped that sentence. It is left out when
  one did not come back, or when no service was restarted.

## The federation snapshot

- **A Tor/I2P-only server can mirror the snapshot.** The mirror only asked IPFS's own network. A
  Tor/I2P-only server sees two or three IPFS peers, and they need not hold the snapshot, so morphitlat
  never became a mirror.
  - When IPFS cannot fetch it, the mirror now asks the publisher's own .onion and .b32.i2p (from its
    on-chain registration) for the snapshot as a CAR (`/ipfs/<cid>?format=car`), and imports it under
    the same CID.
  - Only the snapshot's own CID is pinned from it, whatever the peer's CAR names as its root. A peer's
    answer is read only up to 64 MB, and a redirect is never followed.
  - Fetching stops 18 minutes into the mirror's run, leaving the later steps their time within its 30
    minutes. A server with only a few IPFS peers gives the swarm 3 minutes and leaves the rest to the
    federation peers.
  - The check against the signed SHA-256 still decides whether it is kept.
  - morphit.io answers `?format=car` both from its IPFS node and through its site (kubo 0.42.0).

## Releases (maintainer)

- **Block 4 waits until the nodes list the record.** After the broadcast it waits up to 5 minutes
  until the nodes list the transaction in @morphit's history, which is where upgrades look for it.
  Start Block 5 when it prints "Block 5 can start". This is what protects servers still running an
  older upgrade program, which believes the first node that answers. A node that listed it once counts
  as listing it, even if it stops answering.
  - It asks the public nodes. A Tor/I2P-only server on an older upgrade program reads through its own
    hidden nodes, which can list the record later: if its upgrade says there is no record, run it again
    a few minutes later.

## Correction to the v1.21.3 notes

- They said "This upgrade is run by v1.21.2's upgrade program". Servers on v1.21.1, such as morphitir
  and morphitlat, ran v1.21.1's.
