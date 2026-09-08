# Morphit v1.16.11

**The hidden-upgrade path is now self-sufficient end to end**, and a self-heal
shipped in a release now takes effect on *that* upgrade instead of the next one.
This closes out the zero-clearnet upgrade story: expose → advertise → discover →
fetch, all automatic, no operator ever hand-signs or hand-configures anything.

## Fixed

- **The `/ipns/…` release pointer is signed again.** The federation's stable IPNS
  name had frozen at an old release because the CI signing step is gated on a
  `MORPHIT_IPNS_KEY` secret that wasn't set — so every hidden upgrade that resolved
  the release by IPNS got stale bytes and (correctly) rejected them. With the key
  in place, each release re-signs the record and every instance rebroadcasts it, so
  `/ipns/…` resolves to the current release across the whole federation. The stable
  name is rotated to a fresh identity (`k51qzi5uqu5dgkxm…`); the site, docs, and the
  on-chain `ipns_name` all track it (the on-chain value is derived from the key at
  release time, so it can't drift from the site).
- **Hidden peer discovery no longer drops Tor.** `resolvePeerGateways` used an
  `else if` that only kept a peer's `.b32.i2p` address whenever it had one, so
  `.onion` peers were never tried. It now offers both transports per peer.
- **Self-heals apply on the upgrade that ships them.** After the upgrade rebuilds
  the new `ops-cli` bundle it re-execs the *new* binary for a dedicated self-heal
  phase (`__post-upgrade-selfheal`), falling back to in-process if that binary is
  too old. So from here on, a fix that self-heals a box lands on the upgrade that
  introduces it — no more "the fix is in, but you have to upgrade twice."

## Added

- **Seeder discoverability nudge.** The health report now reminds a node that is
  seeding the release to publish its Tor/I2P address on-chain (via
  `morphit-ops register`) so hidden-only nodes can actually discover and fetch from
  it — the advertise half of "expose → advertise → discover."

## Notes

- No protocol/consensus change; clearnet upgrades are unaffected. The IPNS-name
  rotation is transparent to users (the download page and on-chain pointer both
  carry the new name from this release forward). A node still on an older version
  that can only reach stale peers may need one offline hop to reach a version with
  fetch-by-CID (v1.16.10) — after which it upgrades over the hidden network with no
  further manual steps.
