# ADR-0046 — Migrate Blurt transaction signing off `elliptic` (feasibility proven)

**Status:** Proposed (feasibility proven; cutover deferred), 2026-05-29
**Supersedes:** none
**Superseded by:** none

## Context

Morphit's frontend signs every Blurt operation through one chokepoint —
`apps/web/src/lib/blurt/sign.ts` → `signTransactionWithKey()` →
`getSigningClient().broadcast.sign(tx, key)` — which delegates the ECDSA to
`@beblurt/dblurt`. dblurt performs the secp256k1 signing with the `elliptic`
library (via its `ecurve` dependency and the `secp256k1` native package's
pure-JS fallback).

`elliptic` carries two relevant advisory classes (see `docs/SECURITY.md`):

- a long-standing timing-side-channel advisory (GHSA-848j-6mx2-7j84), and
- **CVE-2025-14505** (published 2026-01-08): an ECDSA flaw where the RFC-6979
  nonce `k` may be mis-truncated when it has leading zeros, producing invalid
  signatures, with a paired-signature key-derivation tail.

CVE-2025-14505 affects **all** published versions of `elliptic` (≤ 6.6.1, the
latest), there is **no fix**, and `elliptic` is effectively unmaintained (no
release in ~12 months). Morphit is already pinned to the latest
`@beblurt/dblurt` (0.10.9); no newer dblurt release drops the `elliptic`
chain. Therefore the durable remediation is to stop signing with `elliptic`,
not to wait for a patch that will not come.

`@noble/secp256k1` (constant-time, actively maintained) is **already** a direct
`apps/web` dependency — keygen has used it since ADR-0007. The open gap is the
**signing** path.

## The key insight: recovery, not byte-equality

A first instinct is to replicate dblurt's exact signature bytes with noble so
the swap is "invisible." That is the **wrong** invariant, and chasing it is a
dead end: dblurt's `elliptic`-based RFC-6979 `k`-derivation does not match
noble's byte-for-byte (confirmed empirically — 200/200 vectors differed), and
matching it would mean reverse-engineering an unmaintained library's internal
nonce derivation.

It is also **unnecessary**. Graphene-lineage chains (Blurt / Steem / Hive)
verify a signature by **recovering the public key from it** and checking that
key against the operation's required authority. They do **not** require the
specific deterministic signature any library emits. Any valid **canonical**
ECDSA signature — low-S *and* low-R, in the 65-byte wire format
`[recovery+31] ++ r(32) ++ s(32)` — that recovers to an authorized key is
accepted. dblurt's own verification path confirms this: its `Signature` type
exposes `.recover(digest)` returning the signer's `PublicKey`.

So the migration's correctness question is simply: **does a noble-produced
canonical signature recover to the signer's key?**

## Decision

Adopt a `@noble/secp256k1`-based Blurt signer as the durable replacement for
dblurt's `broadcast.sign`, keeping dblurt for transaction serialization, the
wire types, and RPC. The signer's contract:

1. Sign the 32-byte transaction digest with noble's RFC-6979 ECDSA.
2. Enforce the canonical form: re-derive with a bumped RFC-6979 extra-entropy
   counter until both `r` and `s` have a clear high bit (low-R + low-S).
3. Emit the 65-byte graphene wire format `[recovery+31] ++ r ++ s`.

This is **Proposed**, not yet shipped. The signing path in
`apps/web/src/lib/blurt/sign.ts` is unchanged as of cp173.

## Evidence (what has been proven, in-sandbox)

`scripts/blurt-noble-signer-recovery-proof.ts` (registered in
`scripts/run-smokes.sh`) proves, against dblurt's **own** parser and recovery:

- **300/300** random `(key, digest)` vectors: a noble-produced signature,
  parsed by `dblurt.Signature.fromBuffer()` and recovered via dblurt's
  `.recover(digest)`, recovers to the **correct** signer public key — zero
  mismatches.
- **100/100** vectors satisfy the canonical constraints (65-byte length,
  low-R, low-S, valid recovery byte in 31–34).
- **50/50** noble signatures round-trip-verify under noble itself.

dblurt loads and signs in CI via its pure-JS `elliptic` fallback (the native
`secp256k1` addon is not required), so the proof runs anywhere tsx + node run.

## What is NOT yet done (cutover plan)

This ADR documents a **feasibility spike**. Shipping the migration requires:

1. Wire the noble signer into `apps/web/src/lib/blurt/sign.ts`, replacing the
   `getSigningClient().broadcast.sign(tx, key)` call. Keep dblurt for the
   `Transaction` shape, serialization, and `condenser_api` broadcast.
2. Keep dblurt as the verifier/recovery reference in the proof smoke so the
   recovery-compatibility invariant stays guarded across dependency bumps.
3. **One real Blurt chain broadcast** of each operation class
   (`custom_json`, `transfer`, the order-with-fee two-op transaction) against
   a live node, to confirm the chain accepts noble-signed transactions
   end-to-end. **The sandbox cannot do this — it has no chain access.** This
   step is the gate before the migration is called "shipped."
4. Re-run the full persona walkthrough + smoke suite; triple-pulse.

Until those land, `elliptic` remains in the tree (transitively, via dblurt)
and its advisories remain **accepted risk** per the `docs/SECURITY.md` threat
model — which already shows no reasonable exploitation path for Morphit's
usage (browser signing needs local timing precision; the relay is rate-limited
and network-jitter-dominated; and the CVE-2025-14505 paired-signature
precondition never arises because Morphit never re-signs the same op+key
twice).

## Consequences

- **Positive:** removes Morphit's dependence on an unmaintained, CVE-bearing
  crypto library for the security-critical signing path; consolidates on the
  constant-time `@noble/secp256k1` already used for keygen.
- **Negative / risk:** signing is the single most safety-critical path in a
  non-custodial marketplace. The migration must not ship on the in-sandbox
  proof alone — the live-broadcast confirmation (step 3) is mandatory.
- **Neutral:** byte-level signatures will differ from the current dblurt
  output. This is expected and harmless (the chain accepts any recovering
  canonical signature) but means any test that ever hard-codes a specific
  signature string would need updating — none currently do.

## Tracking

A standing item in `docs/REVISIT-LIST.md` tracks the cutover. Watch
`@beblurt/dblurt` upstream as well: if it ships a `@noble`-based signer first,
that may be a lower-effort path than Morphit maintaining its own signer.
