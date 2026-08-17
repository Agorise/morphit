# Morphit v1.12.7

**Theme: federated instances stop showing a false "Build integrity check failed" banner, tor-only visitors never touch the clear net, and health/backup reporting on a fresh node is honest and self-healing.**

## Fixed

**Federated instances no longer show a false "Build integrity check failed" banner.** Until now, each operator rebuilt the web frontend locally during install/upgrade, and because those builds aren't byte-reproducible across machines, an honest instance's assets didn't match the hashes published on-chain — tripping the tamper banner on every federated node. The release now ships one canonical, prebuilt frontend, and instances deploy those exact bytes instead of rebuilding (falling back to a local build only if the prebuilt is ever absent). Every instance now serves identical assets that match the on-chain pin. The frontend is generic — each instance still loads its own identity (name, addresses) at runtime — so one build serves the whole federation.

**A visitor on a tor-only site never opens a clearnet connection.** When a page is served from a `.onion`/`.i2p` address, the app now uses a hidden-service-only RPC pool with no clearnet fall-through at all — a Tor/I2P visitor's browser can never reach out to the clear net, not even as a fallback. Clearnet instances are unchanged (they still try hidden nodes first for Tor-Browser visitors, then clearnet).

**"Blurt RPC connectivity" is reported honestly on a fresh/offline node.** The indexer counted an RPC endpoint as healthy merely because it wasn't in a cooldown — which is true of every endpoint the instant the node starts, before any probe has run. So a fresh or offline node briefly claimed RPC connectivity it didn't have. An endpoint now counts as healthy only after a real success, so a not-yet-connected node honestly reports zero.

**A fresh node's first backup now lands on its own.** On a fresh (especially offline) node the indexer can take a couple of minutes to finish migrating its schema; the first backup would fire before the schema existed, correctly skip, and then wait until the next daily run — leaving the operator at "no backup yet." The install now retries the first backup until a real dump lands.

**`morphit-ops register` run offline fails fast instead of hanging.** The registration broadcast now times out after 15 seconds with a clear message rather than blocking on an unreachable RPC.

## Notes

- No database migration in this release.
- Instances install/upgrade faster now (no local frontend rebuild in the common case).
- If you operate an instance: after upgrading, your served `/verify.json` will match the canonical on-chain hashes, so the build-integrity check passes.
