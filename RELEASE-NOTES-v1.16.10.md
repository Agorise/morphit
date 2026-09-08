# Morphit v1.16.10

**Every instance is now a Tor/I2P release seeder by default — automatically.**
This makes zero-clearnet upgrades self-sufficient across the federation: a
hidden-only node fetches the signed release from any peer over `.onion`/`.i2p`,
verified against the on-chain SHA-256, with no hand-signing and no manual gateway
setup. It's the piece that lets zero-clearnet instances proliferate without an
operator ever touching IPFS config.

## Changed

- **IPFS gateway exposed over Tor/I2P by default.** `morphit_ipfs_gateway_expose`
  now defaults on, and the upgrade **self-heals it on every existing instance** —
  no admin step. It sets `Gateway.NoFetch=true` *first* (so the gateway serves
  ONLY the release CIDs this node has pinned — never an arbitrary CID, never an
  open proxy), then binds the gateway bridge-reachable, restarts Kubo, ensures the
  IPNS rebroadcaster is running, and verifies the gateway is live. Best-effort and
  idempotent; a node without IPFS hosting simply no-ops.
- **Hidden-only nodes seed the canonical release too.** The offline bundle now
  ships the canonical `morphit-<ver>.tar.gz` under `.canonical-release/`, and an
  offline upgrade seeds *that* — so a zero-clearnet node produces the CID that
  matches the on-chain anchor and becomes a real Tor/I2P origin host, not just a
  consumer.

## Fixed

- **Hidden upgrade fetches by the on-chain CID, not a peer's IPNS.** It now tries
  `/ipfs/<ipfs_cid>/…` first — content-addressed, so it pulls the EXACT canonical
  bytes from any peer that has the CID pinned, regardless of that peer's IPNS
  freshness — with IPNS as a fallback. This is what let a stale/divergent peer
  break the fetch before; now a peer serving old bytes just loses the race to a
  canonical one. Every seeder also runs the IPNS rebroadcaster (anti-stale on the
  publisher side).
- **Deterministic seed across Kubo versions.** The `ipfs add` DAG params
  (`--chunker=size-262144 --raw-leaves`) are now pinned in both the CI anchor
  computation and the node seed, so every node — on any Kubo version — reproduces
  the same CID as the on-chain anchor. (No-op for modern Kubo, which already
  matched; fixes older ones.)

## Notes

- No protocol/consensus change. Clearnet upgrades are unchanged (git mirrors +
  on-chain SHA + HTTPS primary). The gateway exposure only affects a box that runs
  IPFS hosting and is safe by construction (`NoFetch`); the anchor CID for a given
  release only changes for releases cut *after* this one (v1.16.9's anchor is
  already published), so the deterministic-seed pinning takes effect going forward.
