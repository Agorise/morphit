# Audit — Batch J: release-trust-anchor frontend wiring

**Date:** 2026-04-29
**Scope:** Code introduced for ADR-0019. Builds on the same hostile-
input methodology used in the Batch I audit and the post-Batch-I
follow-up audit.

| Surface | Files |
|---|---|
| Schema | `apps/web/src/lib/net/release.ts` |
| Validator | `apps/web/src/lib/net/releaseValidate.ts` |
| Trust-anchor pure helper | `apps/web/src/lib/net/releaseTrustAnchor.ts` |
| Chain-direct fetch | `apps/web/src/lib/net/releaseFetch.ts` |
| Asset-hash verification | `apps/web/src/lib/net/releaseHashCheck.ts` |
| Store | `apps/web/src/lib/stores/release.ts` |
| Banners | `StaleBuildBanner.svelte`, `TamperAlertBanner.svelte` |
| Layout wiring | `+layout.svelte` |
| Build config | `vite.config.js`, `app.d.ts` |

## Methodology

Same as the Batch I and post-Batch-I-follow-up audits:

- STRIDE per surface: spoofing, tampering, repudiation, info
  disclosure, denial of service, elevation of privilege.
- Hostile-input sweep on every parser / consumer.
- Chain-direct re-pass: assume RPC nodes are attacker-controlled.
- Cross-tab race-condition review.

The "experienced black hat hacker" lens is the active framing.

Severity: HIGH / MEDIUM / LOW / INFO / NOTED.

---

## Findings — applied during this audit

### J-1 (MEDIUM, releaseFetch) — pubkey-match ignored key weight

**Surface:** `fetchVerifiedRelease`'s trust-anchor check walked
@morphit's posting `key_auths` and reported success if the pinned
pubkey was *present*, regardless of its weight.

**Issue:** Blurt's `key_auths` is `Array<[pubkey, weight]>`. A
weight-0 entry is operationally inert — it can't sign anything
because Blurt's authority threshold is computed by summing the
weights of signing keys, and a 0-weight key contributes nothing.

The attack: someone steals @morphit's posting key, rotates the
authority to:

```json
[ ["BLT...attacker", 1], ["BLT...pinned", 0] ]
```

The pinned key is "present" (a naive implementation passes), but it
can't actually sign anything; the attacker's key signed the release
op the chain delivered. Trust anchor compromised, banner doesn't
fire.

**Severity rationale:** MEDIUM rather than HIGH because the attack
requires the operator's posting key already being compromised — at
which point the attacker has bigger leverage than fooling our
trust check. But fooling the trust check would let them push
arbitrary code via the `endpoints` rewrite and `hash_manifest`
fakes, lengthening the period before users notice. Closing the
hole is cheap.

**Fix:** `checkPinnedKeyInAuthority` now requires `weight > 0`.
Extracted to a pure module (`releaseTrustAnchor.ts`) for smoke-
testability.

**Smokes:** Eight scenarios in `release-validator-smoke.ts`
including the explicit attack:

> "checkPinnedKeyInAuthority: pinned weight-0 alongside hostile
> weight-1 → REJECT"

**Severity post-fix:** N/A — closed.

---

## Findings — accepted as-is

### J-2 (LOW, store) — `initStarted` flag races with concurrent calls

**Surface:** `initRelease()`'s `let initStarted = false; if
(initStarted) return; initStarted = true;` pattern.

**Issue:** Concurrent invocations from different code paths could
both observe `initStarted === false` before either sets it,
resulting in two parallel fetches.

**Why accepted:** In practice only `+layout.svelte`'s onMount calls
this. SvelteKit guarantees a single `onMount` per layout instance
per page load. The "concurrent caller" scenario is theoretical.
Even if it occurred, the second fetch would be a wasteful but
harmless duplicate — the store writes are idempotent (last-writer-
wins on identical data).

**Mitigation if needed later:** Replace with a Promise-cache
pattern: `let pending: Promise<void> | null = null; if (pending)
return pending; pending = doInit(); return pending;`. Cheap to
add if races become a real problem.

### J-3 (NOTED, fetch path) — release fetch on every page-load session

Reviewed. SvelteKit SPA navigation does not re-trigger
`+layout.svelte`'s `onMount`, so the fetch runs once per full page
reload, not once per route change. Acceptable boot cost. Confirmed
safe and reasonable.

### J-4 (NOTED, banner) — pubkey_mismatch banner during legitimate key rotation

When `@morphit` legitimately rotates their key, old clients fire
the tamper banner until they reload to a build with the updated
pin. This IS the intended behavior — old clients SHOULD refuse to
trust a rotated key — but it puts a coordination burden on the
operator: they must ship a new build with the new pin BEFORE
broadcasting from the new key in a way users would see.

The banner copy is honest about the ambiguity ("either the
official key was rotated and your bundle is out of date, or
someone is trying to forge release announcements"). Confirmed
appropriate handling.

### J-5 (NOTED, validator) — endpoint URL regex narrow on purpose

The `ORIGIN_RE` accepts only `https://hostname[:port][/path]` with
ASCII subdomain-safe characters. It rejects:

- IDN / Punycode hostnames.
- IPv6 literals.
- Endpoints with query strings or fragments.

These rejections are deliberate. Endpoints are server identifiers,
not arbitrary URLs; the narrow shape blocks a class of footguns
(IDN homograph attacks, query-string-based path traversal). If
future operator practice needs IDN endpoints, the regex widens
deliberately — not via a "looser is better" instinct.

### J-6 (NOTED, hash check) — `cache: 'no-store'` deliberately omitted

Reviewed. The previous-session reasoning (in the file's doc-
comment) is correct: `'no-store'` would actively WEAKEN detection
in the case where an attacker filters initial-load requests. The
default cache behavior gives us bytes the running scripts came
from, which is the correct semantic.

### J-7 (NOTED, hash check) — same-origin enforcement via URL parsing

`new URL(path, location.origin + '/')` resolves the path against
our origin's root. The `resolved.origin !== ourOrigin` check
catches all forms of escape:

- `//evil.com/x` → resolves to `https://evil.com/x`, origin
  differs.
- `https://evil.com/x` → absolute, origin differs.
- `..//../foo` → resolves within our origin's path, no escape.

Confirmed safe.

### J-8 (NOTED, manifest paths) — paths from chain are rendered as text

`<li>{p}</li>` in `TamperAlertBanner.svelte` HTML-escapes `p` via
Svelte's default text interpolation. Even a hostile manifest with
HTML-shaped paths can't inject markup. Confirmed safe.

### J-9 (NOTED, version comparison) — string compare, not semver compare

The store's `staleBuild` derived value compares `payload.version
!== RUNNING_VERSION` — string equality, not semver ordering.
Consequences:

- Pre-release suffixes treated as different versions: `1.2.3` vs
  `1.2.3-rc.1` are both "stale" relative to each other.
- A user running an unreleased dev build (`0.2.0-phase2a`)
  shows as stale relative to any released `0.2.x`.

Both are acceptable: the banner just suggests "reload to update,"
which is the right action regardless of which direction the
mismatch goes. A pure string compare also avoids the surprising
behavior of "1.10.0 is older than 1.2.0" if we used naive
lexicographic sort. Future enhancement: distinguish
"patch / minor / major" gaps for tone differentiation.

### J-10 (NOTED, dependencies) — SubtleCrypto availability

The hash-check path requires `globalThis.crypto.subtle`. Available
in:

- All modern browsers (Firefox 34+, Chrome 37+, Safari 11+).
- Node 18+ (where `globalThis.crypto.subtle` is auto-injected).

Older / unusual environments throw a clear error message. The
catch in the store maps this to `assetCheck = 'fetch_failed'`,
which doesn't fire the tamper banner — silent degradation.
Confirmed appropriate handling.

---

## Cross-surface findings

### CS-J-1 (NOTED) — interaction with operator-block banner

Three banners potentially fire above the main content:
`TamperAlertBanner`, `StaleBuildBanner`, `OperatorBlockBanner`.
Worst case all three render simultaneously (operator-blocked user
on a tampered build that's also stale). Layout review:

- TamperAlert is red and visually dominant (correct tier order).
- StaleBuild's reload button is the single CTA per banner; no
  conflict.
- OperatorBlock has its own contact-operator action.
- Total height: ~150–250px depending on expanded state. The
  main content area scrolls; no layout collapse.

Confirmed acceptable.

### CS-J-2 (NOTED) — release fetch latency vs operator-block fetch

Both fire from `+layout.svelte`'s `onMount`. They run in parallel
(`void initRelease(); void loadOperatorBlocks(...)`). Neither
blocks the other. First-paint of the page renders immediately;
banners appear when their respective fetches resolve. Acceptable
UX.

---

## Smoke regression posture

- 907 total scenarios passing (was 860 pre-Batch-J).
  - +30 release validator scenarios
  - +8 trust-anchor pubkey-authority scenarios (including J-1)
  - +9 prior session scenarios already counted by run-smokes.sh
- Typecheck clean, no new errors beyond the pre-existing baseline.
- i18n drift = 0 across 1701 keys × 10 locales.

---

## Outstanding (not in this audit's scope)

- **Batch I H2** — WebHID transport hardware probe (independent).
- **External pre-launch audit** by a security firm. Recommended
  before production launch.
- **Phase G mobile PWA polish** — gated on this campaign.
- **Sibling-instance release configurability** — deferred per
  ADR-0019.
- **Endpoint-list auto-application UX** — deferred per ADR-0019.

---

## Sign-off

This audit closes 1 finding (1 MEDIUM). 9 findings reviewed and
accepted as-is (5 NOTED-safe, 4 NOTED-acceptable-handling). No
findings remain open on Batch J surfaces.

Batch J considered shippable.
