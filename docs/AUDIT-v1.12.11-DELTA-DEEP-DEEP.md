# AUDIT — v1.12.11 DELTA (deep-deep)

Adversarial self-review of everything changed since v1.12.10. Scope: the tor-only field bring-up fixes (operator-tag display, canary tor-only routing ×2, relay-probe loopback cp769, Matrix link, federation mismatch reclassification cp770) and the version bump. Method: re-read each change looking for a way it could leak, misreport, false-accuse, or regress.

Battery at time of audit: ~19,700 smoke scenarios / 0 failures; 2,131 vitest unit tests / 0 failing; 27/27 workspace typecheck; version 20/20; lockfile 4/4; doc-drift 32/32.

---

## Operator tag — live display (apps/web about-this-instance)

**Change.** The About page reads `operator_tag` from the live `/v1/instance` store (`$instance.operator_tag`), falling back to the build-time `verify.json` value.

**Review.**
- *Correctness:* the tag is mutable config; reading it live is strictly more correct than the frozen build-time value. The `?? verify.operator_tag` fallback preserves behaviour when the live store hasn't loaded (e.g. offline) — the page still shows the signed value rather than blanking. ✓
- *Trust:* `verify.json` remains the signed attestation; only the *displayed* mutable field prefers live. No signature or hash-manifest logic touched. ✓
- svelte-check clean; no type or a11y regressions.

**Residual risk.** None. If both live and signed are null, it correctly shows "unregistered".

---

## Canary tor-only routing (setup.sh + generate.sh)

**Change.** (a) `setup.sh` defaults the canary instance origin to the node's own `MORPHIT_INDEXER_PUBLIC_ORIGIN` (read from the config files), so tor-only auto-detection fires instead of depending on free-text input. (b) `generate.sh`, on a tor-only node with no pinned RPC, auto-selects ONE of the node's own hidden `.onion` Blurt RPCs for the chain-head fetch.

**Review.**
- *The bug this fixes was a real clearnet IP leak* (freshness fetches went direct when tor-only wasn't detected). Both fixes push toward tor-only routing, never away from it — a mis-detection now fails safe (routes over Tor) rather than leaking.
- *Single vs list:* `MORPHIT_CANARY_BLURT_RPC` is a single URL (`resolveCanaryNodes` returns `[trimmed]`, no comma-split — confirmed the hard way in the field). The auto-pick takes `head -1` of the `.onion` endpoints. Correct. ✓
- *No hidden endpoint present:* the generator prints a clear warning and proceeds; the head fetch may then fail, which is fail-CLOSED (a canary that can't prove freshness doesn't publish a stale one). ✓
- *Clearnet nodes unaffected:* the auto-pick is gated on `CANARY_TOR_ONLY = 1`; a clearnet node's canary behaviour is byte-identical. ✓
- *Origin default:* only fills the prompt default; the operator can still override. Reads the config files read-only. ✓
- Canary smokes green (setup 24, rpc-failover 13, template 1).

**Residual risk.** BTC head over Tor may still be "unavailable" on a tor-only node (clearnet explorers block Tor exits); this is best-effort in the generator (`|| true`) and does not block signing. An onion-Esplora BTC source is a noted future improvement, deliberately deferred (needs a verified official onion, not a forum-sourced one).

---

## cp769 — relay probe always includes loopback

**Change.** `buildRelayCandidates` now always appends a `127.0.0.1` candidate (port/path from the configured URL, else `8080/v1/health`); `probeRelayAny` no longer bails on an empty configured URL.

**Review.**
- *Correctness:* a bare-metal relay binds loopback; probing it is always valid and low-cost (one extra local fetch). Handles empty / mis-pointed `RELAY_HEALTH_URL`. ✓
- *Security/SSRF:* the candidate is hard-coded `127.0.0.1` — it can't be steered to an arbitrary host by config. The probe only reads a health endpoint and returns a boolean. ✓
- *No false "up":* loopback is only reported up if it actually answers `res.ok`. Adding a candidate can only turn a false-down into a true-up, never a false-up. ✓
- Locked: relay-probe-gateway-smoke 10→13 (empty, non-loopback, and unparseable configured URLs all still yield a loopback candidate).

**Residual risk.** The original live `up:false` on morphitlat wasn't reproduced in-sandbox (its `RELAY_HEALTH_URL` wasn't visible), so this is a defensive fix that *should* resolve it. Confirm on the box post-deploy that `/v1/health` shows `relay.up:true`.

---

## cp770 — unparseable /v1/instance → unreachable, not mismatch

**Change.** `probeOne` returns `mkUnreachable('instance_response_unparseable')` (was `mkMismatch('instance_response_malformed')`) when the fetched `/v1/instance` isn't a valid instance shape.

**Review.**
- *Does this open a fee-redirection hole?* No. The redirection checks — relay-account (line 544) and treasury (line 554) — run only on WELL-FORMED responses and are UNCHANGED. A malformed response can't carry a usable orderbook/treasury for the frontend anyway, so there's nothing to redirect. `mismatch` is now correctly reserved for a valid response whose *content* conflicts. ✓
- *Is "unreachable" the honest status?* Yes — an unparseable response means we couldn't validly read the peer (WAF challenge, HTML error, garbage). That's a reachability/transport outcome, not an identity accusation. It removes a false fee-redirection flag against healthy instances. ✓
- *Retry/backoff:* `unreachable` and `mismatch` are both in the re-probe set (line 283), so cadence is unchanged. ✓
- Locked: federation-probe-smoke updated, 25/25.

**Residual risk / honesty.** This fixes the false *accusation*, not the underlying inability of a tor-only node to fully probe a clearnet peer. That's an ARCHITECTURAL gap (peer hidden addresses live only in `/v1/instance`, not the on-chain registration) explicitly deferred to a future release — it needs alt-network addresses in the registration op (format + handler + schema change), which is too large and too risky to rush here.

---

## Matrix link (apps/web about-this-instance)

**Change.** The group-chat link uses `https://matrix.to/#/<alias>` instead of the bare `matrix:` URI scheme.

**Review.** The `matrix:` scheme silently no-ops without a registered protocol handler (the reported "invalid link"). matrix.to works in any browser; the room alias stays in the URL fragment (never sent to the matrix.to server) and the room is public, so no meaningful click leak. Consistent with the rest of the app. svelte-check clean. ✓

---

## Version bump

1.12.10 → 1.12.11 across 15 package.json + lockfile (all Morphit workspace entries) + 3 TS consts + docs/API.md + apps/indexer/README.md + RELEASE-NOTES-v1.12.11.md. Internal deps use `"*"`; no pin edits. version-consistency 20/20.

---

## Verdict

The delta is CLEAR. Every change fails safe: canary mis-detection now routes over Tor rather than leaking; the relay probe can only correct a false-down; the mismatch reclassification narrows a security *accusation* to genuine content conflicts while leaving the fee-redirection checks intact. Two items are honestly out of scope and documented: the live relay-probe confirmation (needs the box) and the tor-only→clearnet-peer reachability architecture (a future registration-format change). No leak, no corruption, no weakened security check, no regression found. No database migration.
