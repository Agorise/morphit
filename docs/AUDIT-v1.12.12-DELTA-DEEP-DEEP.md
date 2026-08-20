# AUDIT — v1.12.12 DELTA (deep-deep)

Adversarial self-review of everything changed since v1.12.11. Scope: cp771 (relay-probe zero-config auto-discovery) and the removal of two internal coordination docs. Method: re-read each change looking for a way it could misreport, probe the wrong thing, leak, or regress.

Battery at time of audit: ~19,700 smoke scenarios / 0 failures; 2,131 vitest unit tests / 0 failing; 27/27 workspace typecheck; version 20/20; lockfile 4/4; doc-drift 32/32.

---

## cp771 — relay up/down auto-detected with zero config

**Change.** `buildRelayCandidates` now ALWAYS builds local probe candidates — loopback, every host IPv4 (which includes the docker bridge address a container-fronted relay binds), and the default gateway — at the relay's canonical `/v1/health`, regardless of whether `MORPHIT_INDEXER_RELAY_HEALTH_URL` is set. A configured URL is still honoured verbatim (added first). The local port is the relay's default 8080, or the configured port when it's a real relay port (not a public 80/443).

**Review.**
- *Does it fix the real bug?* Yes. On morphit.io the relay binds `172.18.0.1` (docker bridge) so BunkerWeb can reach it; that address is a non-internal host interface, so it appears in `networkInterfaces()` → cp771 now probes `http://172.18.0.1:8080/v1/health` even with the probe URL empty. Previously (cp769) the host-IP candidates were only built when the URL parsed, so empty → loopback-only → miss.
- *Can it report a false "up"?* No. Each candidate is only "up" if it actually answers `res.ok`. Adding candidates can only turn a false-down into a true-up.
- *Can it probe something that ISN'T the relay and get fooled?* The probe treats any `res.ok` on `/v1/health` as the relay. A host interface with an unrelated service on 8080 answering 200 on `/v1/health` is the only way to a false positive — implausible on a Morphit host, and no worse than a mis-set configured URL. The live discovery *script* additionally shape-checks (relay has no `indexed_block`); the in-code probe deliberately stays a cheap boolean, matching prior behaviour.
- *SSRF / addresses:* candidates come only from the host's own interfaces and the default gateway — never from user input. The configured URL is operator-supplied, unchanged from before.
- *Public URL misdirection:* a configured `https://host/relay/v1/health` no longer drags the LOCAL probes onto `:443` or the `/relay/` proxy path — local candidates use `:8080` + `/v1/health`. Locked by smoke.
- *Port reuse:* an explicit non-standard relay port (e.g. `:9000`) IS reused for local candidates; `:80`/`:443` are not (a proxy front, never the relay itself). Locked by smoke.
- relay-probe-gateway-smoke expanded 13→17 (docker-bridge, public-URL-no-misdirect, no-/relay/-path-locally, explicit-port cases); operational-health 20/20 unchanged.

**Residual risk.** Low. The one theoretical false-positive (an unrelated 200-on-`/v1/health` service on a host interface) is not present on a Morphit node and is strictly no worse than the prior configured-URL behaviour. The change removes a whole class of "healthy relay reads down" config breakage.

**Design note (recorded in REVISIT).** cp771 + the v1.12.11 canary auto-detection establish the principle: a node auto-discovers its own topology rather than depending on the operator setting a value exactly right. Required config for self-determinable facts is silent, hard-to-diagnose breakage and an adoption tax.

---

## Removal of two internal coordination docs

`HIDDEN-RPC-Q2-RESPONSE.md` and `HIDDEN-RPC-SNAPSHOT-INSTRUCTIONS.md` removed from the repo root. Verified: no source, doc, script, or config references either file (grep clean); doc-drift 32/32 after removal. They were point-in-time coordination notes for an external developer, not part of the product. No code path affected.

---

## Version bump

1.12.11 → 1.12.12 across 15 package.json + lockfile + 3 TS consts + docs/API.md + apps/indexer/README.md + RELEASE-NOTES-v1.12.12.md. version-consistency 20/20.

---

## Verdict

CLEAR. cp771 can only correct a false-down, never manufacture a false-up, and removes a real config-dependence that caused repeated field breakage. The doc removals touch no code. No leak, no weakened check, no regression. No database migration.
