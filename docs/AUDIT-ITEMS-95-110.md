# Audit items #95–110 — explicit enumeration + status (cp167)

The cp138 audit plan numbered tasks T-01 through T-94 — all completed
during the cp138–cp157 static-audit campaign and now archived in
[`AUDIT-2026-05-FINAL-REPORT.md`](AUDIT-2026-05-FINAL-REPORT.md).

References elsewhere in the repo (notably `REVISIT-LIST.md` line 921
and the user-memory entry from cp157) call out items **#95–110** as
"out of static-audit scope." This document enumerates each of those
items explicitly so that pointing at "items #95–110" in conversation
or in a future audit pickup has unambiguous reference.

All items below are **not pending work for the static-audit campaign**.
Each is either:

- **Deployment-gated (#95–104):** Requires a running staging deploy,
  real network adversarial behavior, or live infrastructure.  Cannot
  be exercised from inside a code-review sandbox.  Covered in
  [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) under the
  "High-leverage tests I cannot run" enumeration.
- **Epistemic limit (#105–110):** Acknowledged blind spots of the
  static-audit approach itself.  These exist by definition; the
  goal is to document them so an external audit team knows where
  to look.

---

## Deployment-gated (out-of-static-scope)

### #95 — DAST against a running instance

Burp Suite Pro / ZAP / Nuclei sweep against a staging deploy.
Catches timing leaks under real load, response-header drift,
session fixation, content-type sniffing, and operator-stack
misconfigurations (nginx, BunkerWeb, kernel posture).

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §1.

**Mitigation in static scope:** Every code path that produces
HTTP responses has unit + smoke coverage for header shape.
`Cache-Control`, `X-Content-Type-Options`, `Strict-Transport-
Security`, `Content-Security-Policy`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy` all enforced in
`apps/web/src/hooks.server.ts` with smoke coverage.  The
`href-xss-smoke` catches the most likely XSS vector (operator/
peer-controlled `href={}` bindings).

---

### #96 — Active fuzzing (libFuzzer / AFL / Atheris)

24-hour mutation-fuzz campaigns against the chain-op JSON
payload parsers, chat-payload decoder, address validators,
keystore envelope decoder, and HTTP body parsers.

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §2.

**Mitigation in static scope:** Each parser has property-based
testing via fast-check in its smoke (`*-smoke.ts` files).
fast-check covers a meaningful slice of input space but cannot
match the coverage-guided mutation a real fuzzer produces.

---

### #97 — Cryptographic specialist review

Specialist crypto review of `keystore.ts`, `keystoreYubikey.ts`,
`keystoreTotp.ts`, `passkeys/`, and `chat/` for primitive
selection, padding oracles, nonce reuse, key-derivation
parameters, and forward-secrecy posture.

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §3.

**Mitigation in static scope:** All crypto primitives use
WebCrypto (browser-native) or Node's `node:crypto` (vetted).
No hand-rolled primitives.  Scrypt parameters (N=131072, r=8,
p=1) verified against OWASP recommended floor.  AES-256-GCM
nonces are 12-byte cryptographically-random — no reuse risk
because each envelope generates a fresh nonce at encrypt time.

---

### #98 — Threat-modeling workshop with outside engineers

1–2 day STRIDE/PASTA session.  Catches threats that emerge
from system composition (multiple trust boundaries combined)
which source review touches partially.

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §4.

**Mitigation in static scope:** Each ADR (0001–0044) carries
its own threat-model section.  `THREAT-MODEL.md` documents
the per-boundary STRIDE matrix.  Persona-walkthroughs in
the standing 4-persona discipline (Bob, Sally-user, Sally-
operator, Charlie) re-walk the boundaries each session.

---

### #99 — Supply-chain attack review

Specialist review of dependency tree for typosquats, malicious
maintainer-takeover indicators, transitive-dep risk.

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §5.

**Mitigation in static scope:** `package-lock.json` committed
across all workspaces, `workspace-deps-pin-check.ts` smoke
enforces pinned versions, supply-chain audit completed in
cp138 Phase A (findings A4-A10 all shipped).

---

### #100 — Browser-fingerprinting analysis

Specialist analysis of the JS bundle for fingerprintable
behaviors that distinguish users across sessions.

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §6.

**Mitigation in static scope:** No analytics scripts loaded.
No third-party CDNs (other than Anthropic SDK in MCP-server,
not in user-facing bundle).  Service worker doesn't track.
`apps/web/src/lib/utils/idempotencyKey.ts` uses
crypto.randomUUID for client IDs — no persistent fingerprint.

---

### #101 — Tor / I2P / hidden-service operational testing

Real operational testing under hidden-service deploy: does
the JS bundle work?  Are there leaks (clearnet calls, WebRTC
discovery, etc.)?  How does latency affect UX?

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §7.

**Mitigation in static scope:** `apps/web/static/_headers`
sets WebRTC ICE-server gating headers; no clearnet fetch()
calls in the JS bundle (all backend calls go to the operator's
own indexer); the alt-network metadata in `/v1/instance` is
documented as operator-supplied.

---

### #102 — Real-load + chaos testing

Production-load simulation + chaos engineering (network
partitions, RPC outages, DB failover) to find emergent
failure modes.

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §8.

**Mitigation in static scope:** Smoke tests cover happy-path
+ adversarial-input + boundary conditions.  Cannot reproduce
multi-instance federation under network partition without
real deploy.

---

### #103 — Mobile / WebView attack surface

PWA install on iOS/Android, embedded WebView in third-party
apps — different security posture than mainstream browsers.

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §9.

**Mitigation in static scope:** `manifest.webmanifest` is
strict (no third-party origins); `apps/web/static/_headers`
sets COOP/COEP to limit cross-origin isolation issues.

---

### #104 — Social-engineering / phishing simulation

Tabletop exercise: a fake-Morphit operator publishes a malicious
instance.  Does the federation directory + verify.json + warrant-
canary catch it?  Does Sally-user notice before sending funds?

**Coverage:** [`AUDIT-OUTSIDE-SCOPE.md`](AUDIT-OUTSIDE-SCOPE.md) §10.

**Mitigation in static scope:** Squatter-defense playbook
documented in OPERATIONS.md §38.  Verify.json + chain-pinned
release metadata documented as the trust-anchor mechanism.
Per Ken's standing rule, "type these into your browser bar —
don't click" warning rendered on every page footer for
suspected-rogue-instance situations.

---

## Epistemic limits (out-of-static-scope)

### #105 — Unknown unknowns

Bugs that exist but neither I nor the dev team have a model
for.  By definition uncatchable until they surface in
operation.

**Mitigation:** `BETA-INCIDENT-RUNBOOK.md` documents the
process for operator-reported issues.  Public bug bounty is
the only practical mechanism for surfacing unknown unknowns
at scale.

---

### #106 — Compiler / runtime trust

Static review assumes Node.js, TypeScript, esbuild, V8 behave
correctly.  A compiler bug, runtime-level memory-safety bug,
or interpreter-level type-confusion could undermine any
verified property.

**Mitigation:** Node.js + V8 are widely-deployed, security-
researched.  Runtime versions pinned in `package.json`
"engines" field.  CVEs tracked via `npm audit` on CI.

---

### #107 — Specification gaps

Where the spec is ambiguous (e.g. ADR-0010 §4 vs ADR-0021
§3 trade-off resolution), static review picks one
interpretation.  A different interpretation by a future
developer could create a bug invisible to me.

**Mitigation:** ADRs cross-reference each other; the cp138
Phase H "ADR-vs-code drift" audit (T-78 in plan) caught
inconsistencies and locked them via finding H8 (the
`create_claimed_account` ACT-consumption alignment).

---

### #108 — Maintainer trust

This audit assumes the maintainer (i.e. Ken) is not
adversarial.  Static review of the diff in front of me
cannot catch a hostile-maintainer scenario where a future
commit silently weakens a defense.

**Mitigation:** AGPL-3.0 license + public Forgejo at
git.agorise.net/agorise/morphit makes every change visible.
Federation prober verifies on-chain operator registration
so an instance can't impersonate `@morphit` from outside
the trust-pinned set.

---

### #109 — Future regression

Properties verified now can regress with future code changes
unless guarded by a smoke.  Static review at point-in-time
doesn't guarantee future code respects the invariants.

**Mitigation:** Standing rule: every HIGH/CRITICAL fix gets
a smoke regression scenario.  Smokes are run triple-pulse
on every meaningful fix batch, every CI run.

---

### #110 — Coverage measurement

I cannot empirically measure my own coverage of the codebase
during a static review.  Areas I didn't think to look at are
invisible to me.

**Mitigation:** The 94-task cp138 plan was structured
categorically (A-K phases) precisely to drive systematic
coverage rather than ad-hoc walking.  External pen-test
(item #95) is the only way to measure remaining unmitigated
exposure.

---

## Status summary

| Range       | Count | Status                                                 |
| :---------- | :---- | :----------------------------------------------------- |
| #1–94       | 94    | All shipped (cp138–cp157, archived in FINAL-REPORT)    |
| #95–104     | 10    | Out-of-static-scope; documented in AUDIT-OUTSIDE-SCOPE |
| #105–110    | 6     | Epistemic limits; documented here                      |
| **Total**   | 110   | **All accounted for**                                  |

No remaining work on items #95–110 within the static-audit campaign.
The pre-launch hardening campaign formally closes the static portion
of the 110-item audit list.  Items #95–104 should be commissioned
from an external security firm before any "soft launch" beyond a
closed-group beta (per AUDIT-OUTSIDE-SCOPE.md §"Concrete
recommendation").
