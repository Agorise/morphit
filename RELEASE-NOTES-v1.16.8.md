# Morphit v1.16.8

**Hidden-only upgrades can now actually find their peers.** v1.16.6 made a
hidden-only node correctly resolve its upgrade over Tor/I2P and refuse clearnet —
but a field-name bug meant it never actually saw any federation peer's hidden
address, so every hidden-only upgrade dead-ended at "no federation peer exposes a
hidden IPFS gateway yet." This fixes the discovery.

## Fixed

- **Hidden-only upgrade now discovers peer gateways.** The upgrade reads the
  federation directory (`/v1/instances`) to find peers' Tor/I2P addresses, but the
  resolver read `i.tor` / `i.reg_alt_networks`, while the response actually nests
  them under `i.alt_networks` (`alt_networks.tor`, `alt_networks.i2p_b32`). So it
  found zero peers and always reported "no hidden gateway." It now reads
  `alt_networks` (with the others as fallbacks), so a hidden-only node sees every
  peer that advertises a hidden address and fetches the release over Tor/I2P.
- **Clearer fail-closed messaging.** When no peer *serves* the release (as opposed
  to none advertising an address), the error now names the fix: a federation peer
  must expose its IPFS gateway over Tor/I2P (`morphit-ops → Web firewall / IPFS
  gateway`), instead of a generic "no gateway."

## Notes

- No protocol/consensus change; clearnet instances are unaffected (they never use
  the hidden path). `hidden-upgrade-detection-smoke` now pins that the resolver
  reads `alt_networks` so this field-name mismatch can't recur.
- **Operator note for hidden-only nodes:** for a hidden-only node (e.g. one that
  eliminates clearnet entirely) to upgrade over Tor/I2P, at least one federation
  peer with a Tor/I2P address must expose its IPFS gateway over that hidden
  service. Enable it on a well-connected clearnet peer (one that already has a
  `.onion`/`.i2p`) so hidden-only nodes have a private source for releases.
- A node currently on the buggy v1.16.6/v1.16.7 hidden resolver cannot pull this
  fix over Tor/I2P (its own resolver can't find peers) — deliver v1.16.8 to it
  once via the offline / local-tarball upgrade path over a channel you control;
  every hidden upgrade after that works automatically.
