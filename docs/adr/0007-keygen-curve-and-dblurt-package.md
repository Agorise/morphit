# ADR-0007: Correct the keygen curve (Ed25519 → secp256k1) and the dblurt package

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** project maintainer
**Supersedes / corrects:** `docs/adr/0002-live-keys-policy.md` key-format
language (the policy is unchanged; the format described for "raw
32-byte secret scalar" is now a 32-byte secp256k1 scalar, not an
Ed25519 seed).

## Context

While beginning the Phase 3a frontend registration flow, a review
of `apps/web/src/lib/crypto/keygen.ts` surfaced two latent issues
that have been in the codebase since Phase 2. Both would have
blocked any real on-chain broadcast but went undetected because
Phase 2's `broadcastCustomJson` code path was never exercised
against a live Blurt RPC node. The Phase 2 carry-forward item P2-12
had explicitly flagged the lack of integration testing as a
blocker-adjacent risk; it turns out to have been a blocker outright.

### Issue 1: wrong elliptic curve

The keygen derives per-role keypairs via
`sodium.crypto_sign_seed_keypair(material)`, which produces an
**Ed25519** keypair. Blurt is a Graphene-lineage chain and uses
**secp256k1** for all account authorities. Ed25519 public keys are
32 bytes; secp256k1 compressed points are 33 bytes. These formats
are mutually incompatible — a Blurt node will reject any signature
verified against an Ed25519 public key, and the BLT address-prefix
format itself encodes a 33-byte secp256k1 point with a RIPEMD160
checksum.

The Phase-2 docstring at the top of `keygen.ts` (line 38) explicitly
says `→ ed25519 keypair (sodium.crypto_sign_seed_keypair)`. The
choice was apparently made because libsodium was already a
dependency for `secretbox`/Argon2id/memzero and had a convenient
keypair primitive. But it produces the wrong kind of key for the
chain we target.

### Issue 2: wrong dblurt package

`apps/web/package.json` lists `"dblurt": "^0.2.3"` as a runtime
dependency, and `apps/web/src/lib/blurt/sign.ts` imports from
`'dblurt'`. Investigation reveals:

- The `dblurt` npm package (unscoped) was last published in 2020 by
  a single maintainer (`jacobgadikian`), version 0.1.2 — not 0.2.3.
  The `^0.2.3` version constraint cannot resolve to any published
  version of this package.
- The actively-maintained Blurt client library is
  `@beblurt/dblurt`, version 0.10.9, with the Promise-based API,
  TypeScript types, and `accountCreate` / `sendOperations` /
  `broadcast.send` helpers that the relay already uses.
- The `sign.ts` code reads like it was written against the
  `@beblurt/dblurt` API documentation (references to
  `Client.signTransaction`, `PublicKey`, `PrivateKey`), so the
  import path is a naming slip rather than intent.

Both bugs travelled together: the curve mismatch would have
surfaced the moment a `broadcastCustomJson` call hit the network,
and the wrong package name would have been caught on the first
`npm install` that resolved dependencies. Neither happened in the
Phase 2 deliverable window because the only consumer of the path
(Settings → display name broadcast) was unit-tested with the
library mocked at the module boundary.

## Decision

### Migrate keygen to secp256k1

Replace the `sodium.crypto_sign_seed_keypair` call inside
`deriveKeyForRole` with a secp256k1 keypair constructor. The rest
of the derivation pipeline stays unchanged:

    BIP-39 mnemonic
      → BIP-39 seed  (PBKDF2-HMAC-SHA-512, 2048 rounds)   -- unchanged
      → master seed  (BLAKE2b, "morphit-v1/master")       -- unchanged
      → per-role material  (BLAKE2b, "morphit-v1/<role>") -- unchanged
      → secp256k1 keypair  (NEW)                          -- was Ed25519

Key observations:

- The 32-byte BLAKE2b output remains the per-role "material." For
  secp256k1 it is interpreted as a private-key scalar.
- secp256k1 requires the scalar be in `[1, n-1]` where `n` is the
  curve order. The probability that a uniformly random 32-byte
  value falls outside this range is roughly 2⁻¹²⁸ — astronomically
  rare but not zero. Standard remediation: if the raw bytes don't
  fit, derive a replacement by hashing `material || counter` until
  one does. We adopt this approach.
- Public key serialization is the 33-byte compressed form
  (`secp256k1.getPublicKey(privateKey, true)`), matching Blurt's
  BLT address format.

**Library choice:** `@noble/secp256k1` by paulmillr. Pure
TypeScript, ~250 lines, audited, widely used across the crypto
ecosystem (Bitcoin/Ethereum tooling, Solana clients, MetaMask).
Adds a small direct dependency; it is already in the transitive
tree via `@beblurt/dblurt`.

### Fix the dblurt package

Update `apps/web/package.json`:

```diff
-"dblurt": "^0.2.3",
+"@beblurt/dblurt": "^0.10.9",
```

Update `apps/web/src/lib/blurt/sign.ts`:

```diff
-from 'dblurt'
+from '@beblurt/dblurt'
```

Revalidate the API calls used — the `@beblurt/dblurt` documented
API includes `PrivateKey`, `PublicKey`, `Client`, `Operation`,
`Transaction`, `SignedTransaction`, `Client.sign` (or
`broadcast.sign`), which matches what `sign.ts` imports. The API
shape looks compatible, but the version is newer; small tweaks
may be needed once `npm install` succeeds and TypeScript resolves
real types.

### Add key-format helpers

The client side currently has `formatPublicKey(pk: Uint8Array):
string` that hex-encodes the bytes. This is insufficient for the
relay protocol: we need the BLT-prefixed, RIPEMD160-checksummed,
base58-encoded form. Add two new functions:

- `formatPublicKeyBLT(pk: Uint8Array): string` — 33-byte compressed
  point → `BLT...` string.
- `formatPrivateKeyWIF(sk: Uint8Array): string` — 32-byte scalar →
  `5...` WIF string (for seed-export features in future phases;
  NOT used at registration time, since the user's private keys
  stay local).

Both wrap `@beblurt/dblurt`'s `PublicKey` / `PrivateKey` classes
rather than re-implementing base58check.

### Explicit keystore break

`FullIdentity` and the encrypted keystore envelope both contain
key bytes. After the migration, existing (pre-fix) keystores
cannot be loaded — the bytes inside are Ed25519 and the new code
expects secp256k1.

Because Phase 2 was delivered as a tarball that was never
deployed publicly, **no real user keystore exists**. Any keystore
on disk right now is from a developer's test run. We declare a
hard break: a pre-fix keystore fails to decrypt (or decrypts but
derives nonsense), and the user re-runs onboarding.

Future keystore changes will follow a softer migration path once
there are real users; this specific break is permitted because we
are still pre-launch.

## Alternatives considered

### Keep Ed25519, convert at the chain boundary

Impossible. Blurt/Graphene's signature verification uses ECDSA
over secp256k1 at the consensus layer. An Ed25519 signature cannot
be made to verify as a secp256k1 signature regardless of encoding.
Rejected as non-viable.

### Use libsodium's Ristretto / other curve primitives

Not applicable. Blurt is committed to secp256k1 at the protocol
level; no alternate curve is accepted.

### Fork a Graphene-targeted keygen that uses Ed25519

Would require a Blurt chain fork. Out of scope.

### Use `@beblurt/dblurt`'s internal secp256k1 rather than `@noble`

Tempting (one less direct dependency), but the dblurt library
doesn't expose its internal secp256k1 for direct scalar-from-bytes
usage. We'd be reaching into its internals. `@noble/secp256k1` is
public API and smaller; keep them separate.

## Consequences

### Positive

- On-chain broadcast actually works. Phase 3a registration can
  proceed.
- P2-12 (the `broadcastCustomJson` test-coverage carry-forward)
  now has a meaningful target to hit.
- The `dblurt` package typo is fixed before anyone tries to
  deploy the frontend.
- The docstring at the top of `keygen.ts` is corrected to match
  the code.

### Negative

- Any developer who has a local Morphit keystore from a Phase 2
  tarball test must re-run onboarding. Documented in the release
  notes for this fix.
- `@noble/secp256k1` is a new direct dependency on the frontend.
  One small, well-maintained library, but one more to audit.

### Follow-up work

- Write a real integration test for the broadcast path. P2-12's
  target is now "broadcast a `morphit_profile_v1` op against a
  Blurt testnet (or a mocked RPC with a real signature-verifier),
  observe the signature validates."
- Re-check Phase 2's `sign.ts` against the `@beblurt/dblurt` API
  now that the import resolves. Likely only minor adjustments
  needed; any actual API-shape divergence requires a follow-up
  ADR.
- Audit every other place in the frontend that handles keys to
  confirm no code paths assume 32-byte public keys (e.g.
  identicon generator, IdentityLabel component, backup-export
  rendering).

## References

- `docs/adr/0002-live-keys-policy.md` — live-keys policy (unchanged
  in substance; format language updated).
- `docs/REVIEW-PHASE2.md` — P2-12 carry-forward item (upgraded from
  "blocker-adjacent" to the actual cause of this ADR).
- `apps/web/src/lib/crypto/keygen.ts` — file to be modified.
- `apps/web/src/lib/blurt/sign.ts` — file to be modified.
- `apps/web/package.json` — dependency list to be corrected.
- `https://github.com/paulmillr/noble-secp256k1` — `@noble/secp256k1`.
- `https://www.npmjs.com/package/@beblurt/dblurt` — correct Blurt lib.
