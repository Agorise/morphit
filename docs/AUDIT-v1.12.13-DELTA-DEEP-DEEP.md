# AUDIT — v1.12.13 DELTA (deep-deep)

Adversarial self-review of the single change since v1.12.12: cp772, the relay-probe dispatcher bypass. This is the ROOT-CAUSE fix for `relay:up:false` on a healthy relay, after cp766/cp769/cp771 addressed the wrong layer.

Battery at time of audit: ~19,700 smoke scenarios / 0 failures; 2,131 vitest / 0 failing; 27/27 workspace typecheck; version 20/20; lockfile 4/4; doc-drift 32/32.

## cp772 — the local relay probe bypasses the global Tor/I2P router

**How the root cause was established (not guessed).** `diag-relay.sh` on the live box showed: the indexer process sees `172.18.0.1`; a plain node `fetch` to `http://172.18.0.1:8080/v1/health` returns `200`; `RELAY_HEALTH_URL` is set and sourced; cp771 is on disk — yet `up:false`. The only variable left was the request path. A node with Tor/I2P RPC endpoints calls `setGlobalDispatcher(router)`; `probeRelay` used the global `fetch`, so its request to the LOCAL relay was routed through that Tor/I2P layer, which breaks a local connection. A standalone dispatcher-bypass test confirmed: request through a broken global router → fails; same request with a dedicated direct `Agent` → succeeds.

**Change.** `probeRelay` passes `dispatcher: directRelayDispatcher` (a module-level `new Agent()` from undici) so the local probe connects directly, bypassing the global router.

**Review.**
- *Correctness:* the relay is always a local service (loopback / host / docker bridge). A local health probe going direct is unambiguously correct; routing it through the Tor/I2P layer never made sense. ✓
- *Does this weaken privacy / leak?* No — the opposite of a leak. The probe targets only local/candidate addresses built from the host's own interfaces (cp771) and the operator's configured URL. Sending a LOCAL probe direct rather than through Tor exposes nothing external. Chain reads (the reason the global router exists) are untouched — they still route over Tor/I2P. ✓
- *Resource:* one long-lived `Agent` (a connection pool) at module scope; negligible, and reused across probes. No per-probe allocation. ✓
- *Type safety:* the undici/undici-types dispatcher type mismatch is bridged with a single localized `as unknown as` cast on the fetch options; behaviour is a standard undici per-request dispatcher, supported by Node's fetch at runtime. workspace-typecheck 27/27. ✓
- *Regression surface:* only `probeRelay` changed. probeRelayAny, candidate building (cp771), and the operational snapshot (cp766) are unchanged. relay-probe-gateway-smoke 17→19 (locks that the direct dispatcher exists and is used); operational-health 20/20.
- *Clearnet-only nodes:* unaffected — they never install the global router, so their probe already went direct; adding an explicit direct dispatcher is a no-op for them. ✓

**Why the prior three fixes missed it.** cp766 (snapshot resilience), cp769 (loopback candidate), cp771 (auto-probe every local address) all improved candidate SELECTION. But the failure was in the request TRANSPORT — the fetch was correctly aimed and then misrouted. No amount of candidate work could fix a routed connection. The lesson, recorded in REVISIT: after repeated blind fixes, one observation of runtime ground truth (`diag-relay.sh`) located it immediately.

## Verdict

CLEAR, and this time proven rather than reasoned. The change can only turn a false-down into a true-up on affected (hidden-endpoint) nodes, touches nothing else, and does not affect chain-read routing or clearnet nodes. No leak, no weakened check, no regression. No database migration.
