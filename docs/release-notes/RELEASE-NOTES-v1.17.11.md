# Morphit v1.17.11

Fixes the last reason a Tor/I2P-only instance could not mirror the federation
snapshot, and stops two checks reporting healthy instances as broken. No protocol
or consensus change.

## Fixed

- **A privacy-network-only instance can finally mirror the snapshot.** Requests to
  the chain were given ten seconds to complete. That is generous for the ordinary
  internet and impossible over Tor or I2P, where the connection has to be built
  before any data moves and half a minute is normal. So every attempt was
  cancelled before it could succeed — on working and broken addresses alike — and
  reported as "no usable endpoint", while the very same address answered a manual
  request in seconds. The allowance now depends on how the address is reached:
  ordinary addresses keep the short limit, privacy-network ones get a much longer
  one.
- **An instance no longer accuses itself of advertising the wrong address.** The
  new check read the first privacy address its router reported, which is only
  correct on a machine hosting exactly one. A machine hosting several compared a
  stranger's address against its own and declared correct settings wrong — while
  the line below confirmed that same address was serving. It now looks at the
  right entry, and says nothing at all when it cannot tell which one is ours.
- **An instance without ordinary internet is no longer reported as broken.** One
  check tried to reach the site the way an ordinary visitor would. A
  privacy-only instance has no such entrance — it is reached through its Tor and
  I2P addresses — so the check always failed and warned about an instance whose
  Tor and I2P checks passed two lines later. It is now skipped for those
  instances, with the reason stated.


- **Every part of Morphit now uses the full list of chain nodes.** The instance
  publishes a list of chain nodes on-chain so instances always have plenty to
  choose from. The part of Morphit that reads the chain used that full list; the
  part that *sends* things to the chain — account signups and transfers — did
  not, and stayed on the handful written into its configuration. That is
  backwards: sending is exactly what you least want failing when ordinary
  internet nodes go down, and it is what the privacy-network nodes exist to keep
  working. Both now use the whole list.
- **Short-lived jobs no longer start from scratch.** Your instance continuously
  learns which nodes are fast and which are down. Anything that runs and exits —
  the mirror job, a fast-sync, any one-off command — threw all of that away and
  worked through nodes in the order they happen to be listed, waiting out a full
  timeout on one that was already known to be down. That knowledge is now shared,
  so a one-off job goes straight to a good node. Nothing is ever struck off the
  list: a node that was down a minute ago may be back, and still gets its turn.

## Notes

- No protocol/consensus change. Everything here is operator-facing.
- An instance that could not mirror will do so on its next upgrade or its next
  scheduled attempt.
- If a recent upgrade warned that your privacy address was "advertised wrong",
  check it against what your router reports before changing anything — that
  warning was unreliable before this release.
