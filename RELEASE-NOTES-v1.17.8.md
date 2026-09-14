# Morphit v1.17.8

Makes fast-sync actually work on a node with no clearnet — the case the whole
feature exists for, and the one that had never been tested. No protocol or
consensus change.

## Fixed

- **A Tor/I2P-only node can now fast-sync at all.** Routing for hidden addresses
  was switched on by the indexer service and nowhere else, so the service read
  the chain happily over I2P while any of the tools running beside it aimed the
  same request straight at a hidden address with no proxy and got a bare
  "failed". A hidden-only node therefore could not even look up where the
  snapshot was, let alone fetch it — which is why one such instance would not
  mirror. Both the snapshot fetcher and the mirror now switch routing on
  themselves, and still refuse to fall back to the open internet.
- **Serving snapshots over the web works on more instances.** The web front end
  passed the visitor's own hostname through to the local IPFS gateway. A gateway
  treats an unfamiliar hostname as a name it might have to look up, and on a node
  configured not to fetch, that request simply hangs — so the page eventually
  returned "not found". It now passes an address the gateway recognises. The
  affected instance's Tor and I2P paths were unaffected throughout, which is why
  this went unnoticed.
- **The gateway self-check stops reporting a healthy box as broken.** It was
  asking with the same unusable hostname, so it declared the connection blocked
  on machines where it was fine, and its firewall repairs were aimed at a problem
  that did not exist.
- **Mirroring waits for the network to come up.** A node restarts IPFS during an
  upgrade and the mirror ran immediately afterwards, when IPFS was answering but
  had no connections yet. It spent ten minutes trying to fetch from a network it
  had not joined, then gave up. It now waits for connections and, if there are
  none, says so and retries later instead of stalling.

## Added

- **Fast-sync is now genuinely tested on a simulated zero-clearnet node**, over
  Tor and I2P separately — they are different code paths, so passing one proves
  nothing about the other. The tests use faithful stand-ins for both proxies and
  confirm the traffic really went through them, rather than trusting that the
  request succeeded.
- **That test also proves the privacy guarantee**: offered a working open-internet
  source, a hidden-only node still refuses it rather than quietly using it to
  finish sooner.

## Notes

- No protocol/consensus change. Everything here is operator-facing.
- An instance that could not mirror before will do so on its next upgrade, or
  at its next scheduled attempt.
- `OPERATIONS.md` §52 covers the snapshot pipeline and how to check it.
