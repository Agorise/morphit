# Morphit v1.12.11

**Theme: finishing tor-only node bring-up. This release fixes the problems a real tor-only deployment hit end to end — the warrant canary silently fetching its freshness proofs over clearnet, the operator tag never appearing on the About page, a healthy relay being reported as down, and the Matrix chat link not opening. All are small, self-contained fixes so a tor-only node comes up clean without hand-tuning.**

## Fixed

**The warrant canary no longer leaks over clearnet on a tor-only node.** The canary auto-detects tor-only from the instance's origin, but setup accepted a free-text URL — so an origin that wasn't the node's real `.onion` silently disabled tor-only routing, and the freshness fetches (Blurt head, BTC head, news) went out over clearnet, revealing the node's IP. Two fixes close this: setup now **defaults the instance URL to the node's own configured public origin** (the `.onion` on a tor-only box), so auto-detection fires; and on a tor-only node the generator now **auto-selects one of the node's own hidden `.onion` Blurt RPCs** for the chain-head proof, so it fetches over Tor natively instead of pushing a clearnet RPC through a Tor exit (which those RPCs' firewalls reject). A tor-only node now signs a leak-free canary with no manual configuration.

**The operator tag now shows on the About page.** The page read the operator tag from the build-time `verify.json`, so setting the tag in the settings editor and restarting the indexer never changed the displayed value — it only updated after a full frontend rebuild. The page now reads the tag from the live `/v1/instance` endpoint (falling back to the signed `verify.json`), so a tag change appears as soon as the indexer restarts.

**`/v1/health` no longer reports a healthy relay as down.** The relay-reachability probe tried the configured URL, the host's own IP addresses, and the container bridge gateway — but not loopback, unless the configured URL already was loopback. On a bare-metal node whose relay binds `127.0.0.1`, an empty or differently-pointed `RELAY_HEALTH_URL` made a perfectly healthy relay read as down, disagreeing with `morphit-ops health` and a direct curl. The probe now always tries `127.0.0.1` as well (preserving the configured port and path), so a local relay is always found.

**The Matrix chat link opens in a browser.** The About page linked the group chat with the bare `matrix:` URI scheme, which most browsers have no handler for, so the link silently did nothing. It now uses the universal `matrix.to` link (the same one used elsewhere in the app); the room alias stays in the URL fragment, which browsers don't send to the matrix.to server, and the room is public.

**A tor-only node no longer falsely accuses a clearnet peer of a fee-redirection "mismatch".** A tor-only node reaching a clearnet peer's `/v1/instance` over a Tor exit often gets a firewall challenge page instead of JSON. The probe treated any unreadable response as a "mismatch" — which is a fee-redirection *accusation* shown against a perfectly healthy instance. An unreadable response is now correctly classified as **unreachable**, not a mismatch. The actual fee-redirection checks (relay account and treasury) still run on well-formed responses, so nothing that could redirect fees slips through.

## Notes

- No database migration in this release.
- A related **architectural limitation** remains (a larger change for a future release): a peer's hidden (`.onion`/`.i2p`) addresses live only inside its `/v1/instance` response, not in its on-chain registration — so a tor-only node has no Tor-native way to reach a clearnet peer at all. This release stops the *false accusation* (above); fully probing clearnet peers from a tor-only node needs alt-network addresses added to the registration op.
- Everything from v1.12.10 (the tor-only clearnet-probe fix, the `/v1/health` operational-snapshot resilience, and the federation mismatch-while-syncing suppression) is included.
