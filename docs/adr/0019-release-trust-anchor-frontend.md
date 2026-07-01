# ADR-0019: Release-trust-anchor frontend wiring (Batch J)

**Status:** Accepted
**Date:** 2026-04-29
**Deciders:** Agorise team (Claude collaborating)
**Supersedes:** —
**Related:**
- ADR-0010 (key custody) — defines the trust-anchor pubkey model;
  this ADR's frontend uses the same configured
  `MORPHIT_OFFICIAL_POSTING_PUBKEY`.
- ADR-0008 (Phase 3b indexer architecture) — the indexer's
  `morphit_release_v1` handler that this ADR's schema reconciles
  with.

## Context

Morphit's release distribution is decentralized in spirit but
single-origin in practice: the user loads `https://morphit.example.com`
and runs whatever JavaScript that origin serves. A compromised CDN,
hijacked DNS, or operator-account takeover could silently substitute
the running code with a malicious build. The user has no easy way to
tell.

The chain has, since Phase 3a, supported a `morphit_release_v1`
custom_json op signed by the operator account. The op carries:

- `version` — semver of the announced release.
- `hash_manifest` — SRI-style SHA-256 hashes of the build's assets.
- `endpoints` — announced relay/indexer/avatar endpoint pools.
- `signature` — optional secondary PGP-style attestation.

The indexer validates these ops at chain replay time, gates them on
the operator's posting key matching the configured trust anchor, and
exposes a `/v1/release` endpoint surfacing the latest verified row.

What was missing through Batch I: **the frontend wasn't using any of
this**. The schema lived in `release.ts`, the trust anchor was pinned
in `config.ts`, but no code fetched the announced release, verified
it independently, or compared the running bundle against the signed
manifest.

The user flagged the gap; Batch J closes it.

## Decision

### Frontend fetches the release op DIRECTLY from chain RPC, not via the indexer

Trusting the indexer's verification means trusting the indexer.
Since the indexer is one of the things a compromised CDN could
substitute (different origin, fine; but the running code that
chooses which indexer to hit is itself the thing we're trying to
verify), this would be circular. The frontend goes to chain RPC
directly via the existing `BlurtClient`'s `getLatestCustomJson`
helper, walking up to 10,000 ops back from the head looking for the
latest `morphit_release_v1` authored by `@morphit`.

Chain consensus already verified the signature when the block was
produced. The frontend's only remaining job is:

1. Confirm the op is in `@morphit`'s account history (already
   filtered by `getLatestCustomJson`).
2. Confirm `@morphit`'s CURRENT posting authority on chain
   contains the pinned `MORPHIT_OFFICIAL_POSTING_PUBKEY` with
   non-zero weight.
3. Validate the payload's structural shape.

### Trust-anchor pubkey check requires NON-ZERO WEIGHT

Audit J-1 (caught during Batch J's mini-audit) closed the
following hole: a naive "is the pinned pubkey present in
key_auths" check would pass even if the pinned key has weight 0
(operationally inert; can't sign anything). An attacker who rotated
the operator account to a hostile key could leave the old pinned
key listed at weight 0 to fool the check. The fix requires the
pinned key with `weight > 0`.

The pure helper `checkPinnedKeyInAuthority` lives in
`@morphit/release-schema` (cp170; formerly
`apps/web/src/lib/net/releaseTrustAnchor.ts` — extracted into the
shared package so the indexer's parity smoke imports it without
reaching into `apps/web` source). Its smoke
(`apps/indexer/scripts/release-validator-smoke.ts`) covers eight
scenarios including the explicit J-1 attack:

> pinned weight-0 alongside hostile weight-1 → REJECT

### Schema reconciliation

The pre-Batch-J `ReleasePayloadV1` had speculative field names
(`release`, `hashes`, `notes`) that didn't match what the indexer
accepted (`version`, `hash_manifest`, `endpoints`). Reconciled in
this batch: the frontend now uses the indexer's canonical names. No
migration needed because the speculative shape was never broadcast
on chain.

### Asset-hash verification

After the verified release is fetched, `checkManifestAgainstRunningBundle`
re-fetches each asset listed in the manifest from the running
origin and computes its SHA-256 + base64 prefix. Mismatch fires
the tamper banner.

Three threat-model decisions:

1. **No `cache: 'no-store'`.** Counter-intuitive: we want to verify
   what's RUNNING (which came from cache), not what's NEWLY
   FETCHED. A `'no-store'` fetch could miss a tamper that filtered
   only the original page-load request. Default cache behavior
   gives us bytes the running scripts came from.
2. **Same-origin enforcement.** The asset path is resolved via
   `new URL(path, location.origin + '/')` and the resolved URL's
   origin compared to `location.origin`. Any escape attempt
   (manifest paths like `//evil.com/x`, `https://evil.com/x`) is
   rejected.
3. **Sophisticated attacker who serves clean copies on verify
   fetches but tampered on initial load is OUT OF SCOPE.** SRI
   attributes set on the original `<script>` tags by the deploy-
   time build pipeline are the actual defense against that. This
   module is the post-hoc detection layer that catches deploy-time
   mismatches and trust-anchor rotation events.

### Three error categories trigger banners

The release fetch can fail in five ways. Two surface as silent
no-ops (no positive evidence of tamper):

- `rpc_failed` — chain RPC unreachable. We can't tell.
- `no_release` — no release op found in @morphit's history yet.
  Pre-launch state.

Three surface as the critical tamper banner:

- `pubkey_mismatch` — chain key doesn't match pin. Either
  legitimate rotation (and the user's bundle is stale) or
  hostile key swap. Either way, refuse to trust the release.
- `invalid_payload` — release op malformed. Shouldn't happen
  with a legitimate release.
- `asset_mismatch` — running bundle's bytes don't match the
  signed manifest. CDN tampering or deploy-time mismatch.

The fourth banner (informational, not critical) fires when the
running version differs from the announced version: the
stale-build banner with a "Reload now" button.

### Banner ordering in the layout

Two banners mounted above the existing `OperatorBlockBanner`:

```
TamperAlertBanner   (red, urgent, non-dismissible)
StaleBuildBanner    (green, informational, "Reload now")
OperatorBlockBanner (advisory, "you're blocked here")
```

Tamper alert FIRST so it visually dominates if both fire.

### Refresh cadence

Once per session at app boot. Releases are infrequent (a handful
per year). Long-lived sessions see the latest at next page reload.
No periodic refresh in the store — the marginal value isn't worth
the marginal chain-RPC traffic.

### Build-time version bake-in

The frontend needs to know its OWN version to compare against the
announced version. Vite's `define` injects `__MORPHIT_VERSION__`
from `apps/web/package.json` at build time. Declared globally in
`apps/web/src/app.d.ts` for TypeScript.

When deploying a new release, the deploy pipeline:
1. Bumps `apps/web/package.json` version field.
2. Runs the build (Vite bakes the new value into the bundle).
3. Generates the SHA-256 manifest of the built assets.
4. Operator broadcasts a `morphit_release_v1` op carrying the
   new version + manifest.
5. Old client visits → sees `running !== announced`, stale banner.

## Consequences

### Positive

- Closed the open trust-anchor gap that has existed since Phase 3a.
- Tamper detection covers the realistic CDN-tampering threat
  model (deploy-time mismatch, hostile mirror substitution).
- Stale-build detection lets users know when their cached bundle
  has aged out.
- Pubkey rotation is detected (pubkey_mismatch banner) — useful
  even for legitimate rotations as a "your bundle is too old to
  trust the new key" signal.
- Audit J-1 closed a real hole that a naive implementation
  would have shipped with.
- Endpoint-list announcement infrastructure is in place but NOT
  auto-applied. Future enhancement: a Settings affordance to
  merge announced endpoints with user-configured ones, with
  user consent.

### Negative

- One extra chain-RPC call (or two — release op fetch + signer
  account fetch) at app boot. Acceptable: the boot path already
  hits the chain for other things, and these calls are cached
  per-session.
- The trust anchor must be rotated coordinately with software
  releases. If `@morphit` rotates their key, every running client
  fires the pubkey_mismatch banner until they reload to a build
  with the new pin. This is by design — old clients SHOULD
  refuse to trust a rotated key — but it requires the operator
  to coordinate the rotation with a software release.
- Sibling instances run the SAME canonical pin. If a sibling
  operator wants to publish their own release-discovery, this
  needs to be configurable (currently a constant). Deferred to
  Batch K or beyond.

### Trade-offs explicitly considered

- **Verify via indexer instead of chain-direct?** Rejected.
  Trusting the indexer is exactly what the trust anchor is meant
  to NOT require.
- **Use existing `/v1/release` endpoint at all?** No. The
  endpoint exists for indexer-internal consumers (e.g. ops-cli
  health checks), not for the trust-establishing frontend.
- **Verify on every page nav vs once per session?** Once per
  session is sufficient — releases are rare. Re-running on every
  navigation would multiply chain-RPC traffic for no real-world
  detection win.
- **Auto-apply announced endpoints?** No. Endpoint adoption is a
  user-trust decision; the announced list is a recommendation,
  not a mandate. The ReleaseEndpoints data is captured but no
  consumer auto-applies it.

## Implementation

- `packages/release-schema/src/release.ts` — schema (reconciled to
  indexer's canonical fields).  Extracted from
  `apps/web/src/lib/net/release.ts` into the shared
  `@morphit/release-schema` package at cp170 so both the frontend
  and the indexer import one canonical copy.
- `packages/release-schema/src/releaseValidate.ts` — pure validator;
  mirrors indexer's rejection reasons.  (Was
  `apps/web/src/lib/net/releaseValidate.ts` pre-cp170.)
- `packages/release-schema/src/releaseTrustAnchor.ts` — pure pubkey-
  authority check (carved out for smoke-testability).  (Was
  `apps/web/src/lib/net/releaseTrustAnchor.ts` pre-cp170; moved into
  the package so the indexer's parity smoke imports it without a
  cross-app reach.)
- `apps/web/src/lib/net/releaseFetch.ts` — chain-direct fetch +
  trust-anchor verification + payload validation.
- `apps/web/src/lib/net/releaseHashCheck.ts` — asset-hash
  verification (browser SubtleCrypto-backed).
- `apps/web/src/lib/stores/release.ts` — orchestration store with
  derived `staleBuild` and `tamperedAssets`.
- `apps/web/src/lib/components/StaleBuildBanner.svelte` —
  informational banner.
- `apps/web/src/lib/components/TamperAlertBanner.svelte` —
  critical banner.
- `apps/web/src/routes/+layout.svelte` — `initRelease()` in
  `onMount`, banners mounted above `OperatorBlockBanner`.
- `apps/web/vite.config.js` — Vite `define` injects
  `__MORPHIT_VERSION__` from package.json.
- `apps/web/src/app.d.ts` — global type declaration for the
  injected constant.
- Smoke: `apps/indexer/scripts/release-validator-smoke.ts` — 47
  scenarios covering the validator (29) + the J-1 pubkey-
  authority check (8) + miscellaneous shape edge cases.
- i18n: 12 banner keys × 10 locales = 120 strings, drift = 0.

## Open questions / future work

- Sibling-instance support: currently `RELEASE_SIGNER_ACCOUNT` and
  `MORPHIT_OFFICIAL_POSTING_PUBKEY` are constants. For a sibling
  operator to publish their own release-discovery, these need to
  be configurable. Deferred.
- Endpoint-list adoption UX: a Settings affordance ("merge
  announced endpoints into your rotator config") with explicit
  user consent. Deferred.
- Release-notes URL: the indexer schema doesn't carry a release
  notes link. The optional `signature` field is opaque; could be
  used as a URL pointer in the future. Deferred.
- Multi-version compatibility: today's frontend treats any
  version mismatch as "stale." A future enhancement could
  distinguish "patch update available" vs "MAJOR update — you
  must reload." Deferred.
