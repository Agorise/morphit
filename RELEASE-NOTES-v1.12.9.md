# Morphit v1.12.9

**Theme: a tighter tor-only node. This release stops a tor-only indexer from reaching clearnet Blurt RPC (which would reveal the node's real IP to those RPC operators), fixes web-push configuration on tor-only nodes so the relay never crash-loops over an invalid VAPID subject, and makes the warrant-canary restore itself automatically on upgrade for appliance/Ansible installs.**

## Fixed

**Tor-only indexers now read the chain over hidden services only.** A tor-only node was still reaching six clearnet Blurt RPC endpoints, exposing its real IP to those operators — the exact exposure tor-only exists to prevent. The indexer now empties its clearnet RPC pool on tor-only and reads purely over the hidden-service (.onion / .b32.i2p) pool; the "at least one chain source" requirement is now enforced over the combined local + clearnet + hidden pool, so a hidden-only configuration is valid while a truly source-less one is still rejected. Clearnet nodes are unchanged.

**Web push no longer misconfigures itself on tor-only nodes.** The VAPID subject was derived as `https://<domain>`, which is a domain-less, invalid `https://` on a tor-only node. It now derives a `mailto:` from the operator's contact URL when that is a `mailto:`, and otherwise stays empty — which cleanly disables push instead of producing an invalid subject. Clearnet nodes still derive `https://<domain>` as before. (The always-on in-tab ambient notifications — tab title and favicon unread badge — already work on tor-only regardless of push.)

**The warrant canary restores itself on upgrade for appliance/Ansible installs.** An upgrade could leave the canary missing until the next weekly refresh on boxes provisioned with a system `morphit-canary.service` (rather than a `~/.morphit` refresh script). The upgrade now triggers that service directly — the exact unit the weekly timer fires — and falls back to the home-directory refresh script for interactive installs. Either path restores the canary immediately with no manual step.

**Build-integrity manifests are now byte-identical regardless of deploy path.** The `.shipped` build marker is excluded from `/verify.json` hashing (it's a build-system signal, not a served asset), so an instance that re-ran the manifest step and one that kept the shipped manifest now produce identical `verify.json` files.

**Small UI fix.** On the "about this instance" page, a 56-character .onion origin now wraps instead of overflowing its cell.

**The warrant-canary refresh no longer reaches clearnet on a tor-only node.** The weekly canary's freshness-proof fetches (Blurt chain-head, Bitcoin head, news headline) were going directly to clearnet endpoints on a tor-only node, which could reveal the node's real IP to those third parties — the same class of exposure this release closes for the indexer. On tor-only, all three now route through the co-located Tor SOCKS proxy (DNS resolved proxy-side, so nothing leaks), reaching the same freshness sources through a Tor exit. It is fail-safe: if the Tor proxy is down the canary degrades or holds rather than ever falling back to a direct clearnet connection. Clearnet nodes are byte-identical to before.

## Notes

- No database migration in this release.
- The tor-only privacy work in this release (indexer hidden-only RPC + the canary routing over Tor) is code-complete but its live Tor routing was validated by shape/smoke, not end-to-end in CI — confirm on a real tor-only box that the canary's `route = tor-only (SOCKS …)` and the indexer reads only over hidden endpoints. Details in `docs/AUDIT-cp760-v1.12.9-DELTA-DEEP-DEEP.md`.
- Everything from v1.12.8 (the build-integrity banner bootstrap fix) is included.
