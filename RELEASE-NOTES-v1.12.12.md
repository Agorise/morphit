# Morphit v1.12.12

**Theme: the relay's health shows up correctly with zero configuration. One fix, applying a principle: a node should auto-detect its own topology, not make the operator hand-configure it.**

## Fixed

**`/v1/health` now reports the relay's real up/down state without any configuration.** The relay-reachability probe only worked when the operator set `MORPHIT_INDEXER_RELAY_HEALTH_URL`, and even the fallback only tried loopback. But the relay doesn't always listen on loopback: behind a containerized web front (BunkerWeb/nginx), it binds the **docker bridge address** (e.g. `172.18.0.1`) so the container can reach it. With the probe URL unset — the default — a perfectly healthy relay read as `up:false`, disagreeing with `morphit-ops health` and a direct request. The probe now **always auto-discovers the relay** across every address it could bind — loopback, each host interface (which includes the docker bridge), and the default gateway — at the relay's canonical `/v1/health` path. No configuration required; a configured URL is still honoured verbatim when present, and a public URL can no longer misdirect the local probe onto `:443` or a reverse-proxy path.

## Notes

- No database migration in this release.
- This continues the direction from v1.12.11 (the warrant canary auto-detecting tor-only and its own hidden RPC): a node should discover its own topology rather than depend on the operator getting a config value exactly right. Required configuration for things a node can determine itself is a source of silent, hard-to-diagnose breakage.
- Everything from v1.12.11 (the tor-only canary routing, the operator-tag live display, the Matrix link, and the federation mismatch reclassification) is included.
