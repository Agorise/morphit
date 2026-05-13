# ADR-0006: Security posture for Phase 3a

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** project maintainer
**Supersedes:** none (complements ADR-0002 live-keys policy and
`docs/SECURITY.md`)

## Context

At the Phase-3a midpoint the maintainer raised specific concerns
from a security advisor — HTTP Parameter Pollution, SSRF, CSRF,
OAuth/nOAuth vulnerabilities, RCE, GuzzleHttp CVEs, xmlrpc.php
exploits, DDoS, maxlength enforcement, and related classes of
attack. Morphit is entering a phase where it begins accepting
untrusted HTTP input (the posting relay) and will soon host
large public-facing endpoints (indexer, orderbook). Formally
documenting which attack classes apply, which do not, and why
removes ambiguity for contributors, auditors, and future
phases.

This ADR classifies each attack vector into one of four verdicts:

- **Covered**: already mitigated in code or infrastructure.
- **Not-applicable**: structurally prevented by a design decision
  elsewhere (e.g. no PHP means no PHP-specific CVEs).
- **Deferred**: tracked for a later phase with a specific trigger
  for revisiting.
- **Out-of-scope**: cannot be solved in application code alone
  and belongs to the operator's deployment posture.

## Decision

The verdicts below are binding for Phase 3a. Any future change to
a verdict requires either a subsequent ADR or a note in the review
document of the phase where it is revisited.

### Architectural defense

Before listing specific attack classes, the following design
decisions eliminate large swathes of common vulnerability. These
are the load-bearing non-code defenses:

- **Non-custodial.** Morphit never holds user funds. There is no
  hot wallet to drain, no withdrawal mechanism to exploit, no
  custody contract to misconfigure. The worst outcome of a full
  relay compromise is that the operator loses the BLURT balance
  the relay itself holds for account-creation fees (tens to low
  hundreds of BLURT in practice).
- **No authentication layer.** There are no accounts on Morphit,
  no sessions, no passwords, no cookies, no JWTs, no OAuth.
  Every request is stateless. Entire vulnerability classes
  (session hijacking, credential stuffing, OAuth misconfiguration,
  nOAuth, CSRF-as-commonly-understood) do not exist here.
- **No user database.** Morphit does not collect KYC and does not
  log IP addresses. There is no user database to breach, no
  personal information to leak, and no data that could be
  compelled by subpoena.
- **No server-side dynamic code.** The relay has no `eval`, no
  `new Function`, no dynamic `require`, no template engines
  evaluating user input, and no server-side rendering of user
  input. Command-injection, template-injection, deserialization,
  and RCE via string-to-code paths are structurally impossible.
- **Chain-native orderbook.** Orders live on Blurt itself. The
  Morphit frontend is a reader; an indexer is a reader-with-cache.
  Takedown of any specific frontend does not delete orders —
  another frontend, self-hosted or community-run, can index the
  same chain data.

### Attack-class verdicts

#### HTTP Parameter Pollution

**Verdict: Covered.**

Every relay endpoint uses `zod` schemas with `.strict()` (rejecting
unknown keys) and explicit `.max()` bounds on every field. Arrays
have explicit length bounds. We do not read query parameters for
business logic; all input comes through parsed JSON bodies. Hono
gives exact header values, not arrays, so duplicate-header injection
produces a deterministic first-value-wins behavior we explicitly
control.

#### SSRF (Server-Side Request Forgery)

**Verdict: Covered.**

The relay only makes outbound HTTP calls to a pre-configured
allowlist of Blurt RPC endpoints parsed from environment variables
at boot. No handler accepts a URL from a request body. No
redirect-following is enabled. No arbitrary-fetch feature exists
anywhere in the codebase.

**Phase 3b update (Audit 2026-05 Finding 5-5):** the indexer
introduced the `morphit_operator_register_v1` op and federation
probe, which accepts an operator-supplied `origin` URL and fires
GETs against `${origin}/v1/health` to verify reachability. This
extended the SSRF surface beyond what was true in Phase 3a. The
defenses applied:

- The `operatorRegister` handler rejects loopback / RFC1918 /
  link-local / metadata-service / `*.local` / `*.internal`
  origins at registration.
- The `federationProbe.fetchJson` re-validates hostname at
  request time (defense in depth: a row that slipped past
  registration via direct DB write or a future regex-bypass
  is still refused).
- `redirect: 'manual'` on the fetch so a hostile server can't
  redirect the probe to localhost or a public IMDS.
- Response body is capped at 256KB (Audit 2026-05 NEW-9-11)
  with both Content-Length pre-check and streaming-with-abort.

The verdict remains **Covered**, but the structural argument
("no URL ever comes from a request body") no longer holds —
SSRF is now defended by explicit hostname allowlisting plus the
response-handling caps above.

#### CSRF (Cross-Site Request Forgery)

**Verdict: Not-applicable.**

CSRF is a vulnerability against cookie-based sessions: an attacker's
page causes the victim's browser to make an authenticated request
because the browser attaches cookies automatically. Morphit has
zero cookies, zero sessions, and zero server-side authentication
state. There is nothing the browser can "attach" that would
authenticate a third-party request.

Additionally, state-changing endpoints require inputs an attacker
cannot forge: the account-create endpoint needs the user's four
new public keys, which the user generates locally and which are not
available to any other origin.

An exact-match CORS allowlist provides defense-in-depth — the
browser blocks `fetch()` from any origin not on the list — but the
fundamental reason CSRF does not apply is structural.

#### Authentication vulnerabilities (AUTH-VULN-n, nOAuth)

**Verdict: Not-applicable.**

Morphit has no authentication. No login flow, no OAuth provider,
no password reset, no magic links, no SAML, no JWT, no API keys.
Classes of vulnerability that target these mechanisms cannot
apply to a system that does not implement them.

User identity on Blurt is cryptographic: transactions are signed
by the user's own keys on their own device. That authentication
belongs to Blurt; if it fails, the entire chain fails, not
Morphit specifically.

#### Remote Code Execution (RCE)

**Verdict: Covered, with caveats.**

- No dynamic code evaluation paths exist in relay or frontend source.
- No deserialization of untrusted binary formats. JSON is parsed
  through zod, which cannot produce prototypes or functions.
- Supply-chain CVEs remain a concern. `npm audit` must be run at
  deploy time and on every dependency bump (added to relay README).
  Lockfile (`package-lock.json`) pins exact versions.
- Node and nginx CVEs on the VPS are the operator's patching
  responsibility. Document this in the deployment guide.

#### GuzzleHttp CVEs

**Verdict: Not-applicable.**

Guzzle is a PHP HTTP client. Morphit has no PHP anywhere in the
stack. The relay is Node.js; the frontend is SvelteKit (also
JavaScript); the indexer (Phase 3b) will be Node.js; nginx
proxies without any PHP handler enabled. Guzzle CVEs cannot
apply.

#### xmlrpc.php exploits

**Verdict: Not-applicable.**

`xmlrpc.php` is a WordPress-specific endpoint. Morphit runs no
WordPress. No `xmlrpc.php` exists anywhere. nginx configuration
denies any request path outside `/v1/` on the relay, returning
404 without hitting the relay process.

#### Request-size / `maxlength`

**Verdict: Covered.**

- Relay-level: `maxRequestBodyBytes: 65536` (64 KiB hard cap).
  Oversized `Content-Length` is rejected before any body is read.
- Schema-level: every `z.string()` in every request schema has a
  specific `.max()` bound tuned to Blurt's on-chain constraints
  (name ≤ 16, json_metadata ≤ 1024, etc.).
- nginx-level: `client_max_body_size 64k` matches the relay.
- Frontend-level: HTML `maxlength` attributes on form inputs are a
  UX nicety, not a security boundary.

#### Volumetric / network-level DDoS

**Verdict: Out-of-scope.**

A single application cannot defend against a flood of 10 Gbps of
packets aimed at its network interface. This must be addressed at
the infrastructure layer: upstream DDoS scrubbing by the VPS
provider, a CDN (Cloudflare is the common choice), or a dedicated
mitigation service. Morphit's codebase explicitly does not try to
solve this.

Operators are encouraged to document their DDoS response plan
separately. Morphit mirrors that run behind Tor / I2P / Lokinet
naturally benefit from those networks' own DDoS properties.

#### Application-layer abuse / volumetric DDoS at L7

**Verdict: Covered.**

- Per-IP rate limits: 60 availability checks/min, 5 account
  creates/hour, enforced as sliding-window buckets in relay memory.
- nginx-level timeouts: 10s client-body-timeout, 15s send-timeout,
  30s keepalive-timeout.
- Resource ceilings in systemd: `MemoryMax=512M`, `TasksMax=256`.
- Relay is stateless beyond the in-memory rate limiters and a
  one-minute dedupe cache. A restart clears everything; no file
  or database grows unbounded.
- fail2ban integration is documented in the README: systemd
  journal entries of rate-limit rejections can be consumed by
  fail2ban to install temporary iptables bans without the relay
  itself logging or persisting IPs.

#### XSS (Cross-Site Scripting)

**Verdict: Covered at the frontend.**

- Strict Content Security Policy with `script-src 'self'` and
  hash-based inline-script allowlisting (configured in
  `svelte.config.js`).
- Svelte auto-escapes all dynamic content; `{@html}` is not used
  anywhere in the project (grep-verified in Phase 2 review).
- FAQ content is loaded from typed locale files, not user input.
- Relay never returns HTML — only JSON with `Content-Type:
  application/json; charset=utf-8` and `X-Content-Type-Options:
  nosniff`, so even if it somehow returned an XSS payload, no
  browser would render it.

#### SQL Injection

**Verdict: Not-applicable in Phase 3a; covered in 3b plan.**

The relay has no database. The Phase-3b indexer will use Postgres
with `sqlc`-generated parameterized queries only; no string
concatenation into SQL. Documented in `docs/PHASE-3a-DESIGN.md`
ahead of 3b.

#### Prototype pollution

**Verdict: Covered.**

Zod's `.strict()` rejects unknown keys including `__proto__`,
`constructor`, and `prototype`. We never use dynamic property
access (`obj[userKey]`) on user-supplied keys. No `Object.assign`
or spread-merge of user input into trusted objects.

#### Log injection

**Verdict: Covered, documented in SECURITY.md.**

The relay's `log()` function interpolates config values (relay
account name, endpoint URLs) which are schema-validated at boot
with no newline characters. No user-supplied string is ever
interpolated into a log line. Switching to structured logging
(e.g. Pino) is a Phase-4 improvement but not required for safety.

#### Timing attacks

**Verdict: Documented as minor, not fixed in 3a.**

The dedupe-check in the create endpoint uses linear scan and
string equality. The compared fingerprints are SHA-256 of
public data (the user's own new pubkeys, which are going on
chain), so any timing leak reveals only information the attacker
already has. The scan is bounded to the one-minute dedupe window
(at most ~5 entries given the 5/hr create limit). Documented in
SECURITY.md; not a fix candidate for 3a.

#### TOCTOU on availability check

**Verdict: Covered.**

Between the relay's `blurt.getAccount(name)` check and its
`broadcastAccountCreate`, another user could theoretically claim
the same name. If they do, the chain rejects the broadcast with
an `account_already_exists` error, which the relay catches and
maps to the `already_registered` error code (the same code
returned by the pre-broadcast check). The user sees one
consistent error message either way, and no funds are spent on
the failed broadcast (Blurt rejects it before the fee is
collected).

#### ReDoS (Regex Denial-of-Service)

**Verdict: Covered.**

The only regex in relay code (`/^(-?\d+(?:\.\d+)?)\s+\w+$/` for
asset amount parsing) runs on chain responses, not user input,
and has no nested quantifiers. Linear time in input length.

#### Dependency confusion

**Verdict: Covered.**

All dependencies (`@beblurt/dblurt`, `hono`, `@hono/node-server`,
`zod`) are on the public npm registry. No private-registry names
that could be shadowed.

#### Supply-chain / typosquatting

**Verdict: Mitigated; deferred for deeper work.**

- Lockfile pins exact versions and hashes.
- `npm ci --omit=dev` in deployment installs only what the
  lockfile specifies.
- Dependency count is deliberately small (4 runtime dependencies
  for the relay) so a compromise is bounded in blast radius.
- Full npm package signing is an open industry problem; we use
  what npm offers and accept the residual risk. Phase 5 can
  evaluate `npm-audit-resolver`, `socket.dev`, or similar.

#### Key exposure

**Verdict: Covered by ADR-0002.**

See ADR-0002 for the live-keys policy. The relay's own active
key is read once at startup from a file with `0400`
permissions; the relay refuses to boot if the file is
world-readable. The WIF string is never logged, never returned
in responses, never transmitted to any external service.

#### Legal/operator exposure

**Verdict: Policy, not code; documented in SECURITY.md.**

Operator considerations (sanctioned-country trades, takedown
requests, DMCA) are addressed by the project's structural
choices: the frontend never facilitates the actual trade, the
orderbook is chain-native and not controlled by any frontend,
and `@morphit` release-discovery ops are pinned to a specific
public key to resist impersonation.

### What this ADR deliberately does not address

- Threats to the Blurt chain itself. If Blurt's consensus breaks,
  Morphit breaks. That risk is inherent to the chain choice and
  is addressed in SECURITY.md.
- Threats from the user's own device (malware on the client,
  extension compromises, clipboard sniffers). Morphit minimizes
  its attack surface (live keys only, no owner/active in memory)
  but cannot defend against full local compromise.
- Physical access to the VPS. If the operator's server is
  physically compromised, the relay's active key is readable.
  Mitigation is the standard VPS-provider choice + disk
  encryption + quarterly key rotation; none of these are code.

## Consequences

### Positive

- Contributors and auditors have a single source of truth for
  "why isn't X a problem?" questions.
- Future phases can extend this ADR rather than argue each case
  anew.
- Unambiguous separation between code-level defense and
  operator-level responsibility.

### Negative

- ADRs tend to drift from reality. This one must be revisited at
  the start of every phase (noted in the phase review template).
- Some verdicts ("Not-applicable") rely on current design
  decisions (no PHP, no OAuth) that a future contributor might
  reverse without realizing the impact. The ADR is the warning.

### Follow-up work

- The relay README adds operator-level security guidance: npm
  audit, fail2ban, key rotation, BLURT balance monitoring.
- `docs/SECURITY.md` adds a user-facing threat-model section
  referencing this ADR.
- A Phase-3a FAQ entry (`security_attack_vectors`) in all 10
  locales points users at this material without requiring them
  to read the ADR directly.

## References

- ADR-0001: `custom_json` replacement ops
- ADR-0002: live-keys policy
- ADR-0005: Phase 3 subphase split
- `docs/SECURITY.md`: user-facing threat model
- `docs/PHASE-3a-DESIGN.md`: relay-specific design + security review
