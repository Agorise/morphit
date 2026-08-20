# Morphit v1.12.14

**Theme: `/v1/health` reports the relay's true state — the fix, verified live. Plus the auto-detect hardening around it and a small instances-page copy change.**

## Fixed

**A healthy relay no longer reads as `up:false` on `/v1/health`.** On a node whose indexer runs under a systemd sandbox, `os.networkInterfaces()` — called while building the relay-probe candidate list — threw `EAFNOSUPPORT` ("Unknown system error 97") because the unit's `RestrictAddressFamilies` did not include `AF_NETLINK`, the address family libuv needs to enumerate interfaces. That exception rejected the entire relay probe *before any network request was made*, so the health snapshot kept its default `false` and never recovered — a running, reachable relay reported as down. Two changes fix it: the probe's interface enumeration is now wrapped so it can never throw out of the probe (it falls back to the configured URL and loopback), and the indexer service unit now grants `AF_NETLINK` so interface enumeration works and the relay auto-detection functions fully. Verified on a live node: the endpoint flips from `up:false` to `up:true`.

## Changed

- The relay-reachability probe auto-discovers the relay across every local address it could bind — loopback, each host interface (including the docker bridge a container-fronted relay uses), and the gateway — with no configuration required; a configured `MORPHIT_INDEXER_RELAY_HEALTH_URL` is still honoured. The local probe uses `node:http` directly.
- Instances page: the bookmarking tip now reads "bookmark a few of these instances — and their Tor, I2P, Lokinet or ENS addresses" and notes that because the orderbook lives on the public blockchain, the same orders and trades are reachable in many other places if any one site is inaccessible.

## Removed

- Two internal coordination documents (`HIDDEN-RPC-Q2-RESPONSE.md`, `HIDDEN-RPC-SNAPSHOT-INSTRUCTIONS.md`) removed from the repository.

## Notes

- No database migration in this release.
- Operators upgrading from a build that showed `relay:up:false` while `morphit-ops health` showed the relay up: this release is that fix. The unit change takes effect once the updated `morphit-indexer.service` is installed by the upgrade.
- Everything from v1.12.13 and earlier is included.
