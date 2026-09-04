# Morphit v1.16.1

**Hidden-only nodes now upgrade over Tor/I2P and can honestly claim "Zero use of clearnet internet."** This completes the hidden-only privacy path started in v1.16.0: the last outbound leg — software upgrades — now rides the federation over Tor/I2P, fully verified and fail-closed, so a hidden-only node never touches a clearnet host for anything. The `clearnet_eliminated` gate flips true when a node proves every leg, and the directory shows it.

## Added

- **Hidden IPFS-over-Tor/I2P upgrades (fail-closed).** On a hidden-only node (clearnet RPC pool empty), `morphit-ops upgrade` fetches the release from federation peers' IPFS gateways over Tor/I2P — the stable on-chain IPNS pointer, raced across several peers, verified against the on-chain SHA-256 (anti-rollback), and **fail-closed**: if it can't get the release privately it stays on the current version, it never falls back to a clearnet mirror. A clearnet node's upgrade path is byte-for-byte unchanged.
- **`@morphit/hidden-transport`** — a new dependency-free workspace package holding the shared SOCKS5/Tor + I2P transport core, so the indexer and ops-cli use one copy with no drift. Pure node built-ins; bundles and installs fully offline.
- **The "Zero use of clearnet internet" directory label.** The federation probe now captures each peer's `clearnet_eliminated` gate and the directory card renders the strong claim when it's true (falling back to "No clearnet reliance" for a hidden-origin instance that hasn't proven every leg). Translated across all ten locales.

## Changed

- **`clearnet_eliminated` flips true** for a node that proves all seven legs — chain over onion/i2p, **Tor and I2P** transports (both required), federation-syndicated price, local-only frontend, the fail-closed hidden upgrade, and a clean (or absent) Matrix homeserver. `/v1/instance` also exposes `clearnet_eliminated_missing` listing any open legs, so an operator sees exactly what's left.

## Notes

- **No change for clearnet nodes.** Every hidden-only behaviour activates only when the clearnet RPC pool is empty; clearnet nodes upgrade exactly as before.
- **Additive schema (v59), safe to upgrade mid-sync.** `known_instances.cached_clearnet_eliminated` is additive with a false default; the probe fills it each cycle, older peers stay false.
- **Offline-first preserved.** No new external dependency anywhere; the hidden-transport package is workspace-linked and the whole tree still installs/upgrades from the bundled tarball with no network.
- **Still to come (separate, box-validated):** exposing each hosting instance's kubo gateway over its `.onion`/`.i2p` with `Gateway.NoFetch=true`, so hidden-only nodes can actually *fetch* the release from peers. Until that lands, a hidden-only `morphit-ops upgrade` fail-closes cleanly (the node upgrades offline as it does today) — the "zero clearnet" claim holds either way because the path never touches clearnet.
