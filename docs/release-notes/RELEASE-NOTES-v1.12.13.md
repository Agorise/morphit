# Morphit v1.12.13

**Theme: the real fix for `/v1/health` reporting a healthy relay as down. The probe was being routed through the wrong network layer.**

## Fixed

**`/v1/health` now reports the relay's true up/down state on a node that uses hidden (Tor/I2P) RPC endpoints.** A node configured with Tor or I2P Blurt RPC installs a global request-routing dispatcher so chain reads go over those networks. The relay-health probe used the ordinary global fetch, so its request to the **local** relay was sent through that same Tor/I2P routing layer — which breaks a local connection — and a perfectly healthy relay read as `up:false`. (This is why the earlier candidate-selection fixes didn't resolve it: the probe was finding the right address, but the request itself was being misrouted.) The probe now connects to the relay **directly**, bypassing the global router entirely — a local health check has no business going through the Tor/I2P layer. Verified with a dispatcher-bypass test: a request through the router fails, the same request direct succeeds.

## Notes

- No database migration in this release.
- Diagnosis note for operators: this only affected nodes that have hidden RPC endpoints configured (which install the global router). A clearnet-only node was unaffected. If your node showed `relay:up:false` while `morphit-ops health` showed the relay up, this is the fix.
- Everything from v1.12.12 and earlier is included.
