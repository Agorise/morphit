# Phase 3a — Status at handoff into 3b

**Date**: 2026-04-18

> **2026-05-11 forward note (Part 120 audit):** the
> `/opt/morphit-relay/` paths referenced in §"Shipped"
> below were the Phase 3a deployment convention.  The
> shipped Phase 3+ monorepo layout puts the relay at
> `apps/relay/` inside a single repo clone; production
> operators install at `/opt/morphit/apps/relay/`,
> `/home/morphit/morphit/apps/relay/`, or wherever they
> chose to clone.  See `docs/OPERATIONS.md` and
> `docs/RUN-A-MORPHIT-NODE.md` for the current install
> recipes.  This file is kept as a historical snapshot;
> do not cite it for current deployment paths.

This document is a snapshot of what Phase 3a actually shipped vs what
was planned, and what is explicitly deferred to 3b/3c.

## Shipped

### Relay (Node.js/TypeScript)

Located at `apps/relay/`. 13 source files + 5 test files.

- `GET /v1/health` with background BLURT-balance polling (30s refresh),
  `canAcceptCreation` short-circuit used by `/v1/account/create`
- `POST /v1/account/availability` with two-stage structural + chain
  check, rate-limited (60/min per IP)
- `POST /v1/account/create` with full zod validation, pubkey
  distinctness check, 1-minute dedupe, TOCTOU-safe chain error
  mapping, rate-limited (5/hour per IP)
- Endpoint rotator with exponential cooldown (2s → 10s → 60s → 5min)
- Input validation: zod `.strict()` everywhere, max body 64 KiB
- Middleware: body-size cap → security headers → CORS allowlist →
  JSON content-type enforcement
- nginx vhost with TLS 1.2+, HSTS, denied paths outside `/v1/`
- systemd unit with full hardening (MemoryDenyWriteExecute=no only
  because V8 JIT; every other hardening flag at max)

### Crypto foundation (frontend)

- `deriveKeyForRole` correctly produces secp256k1 keypairs via
  `@noble/secp256k1` (ADR-0007). Retry-on-out-of-range loop for the
  ~2⁻¹²⁸ case. New test `produces secp256k1-shaped keys` pins
  33-byte compressed pubkeys and 32-byte scalars.
- `formatPublicKeyBLT()` produces real Blurt BLT-prefixed keys
  via `@beblurt/dblurt`'s `PublicKey` class
- `fullPublicKey()` in `profile.ts` now produces real paste-
  compatible Blurt keys (was fake `BLT` + hex in Phase 2)

### Frontend onboarding

- `/onboarding/register-name` route (~280 lines Svelte 5 runes)
  wiring the relay's availability and create endpoints
- 42 i18n keys × 10 locales = 420 new strings (en, es, fr, de, it,
  ru, pl, fa, zh-CN, zh-HK)
- All 9 relay error codes mapped to localized messages
- Mid-broadcast navigation guard, debounced availability check,
  skip-for-now escape path, heart identicon reveal

### FAQ addition

- `security_attack_vectors` entry across all 10 locales, addressing
  HPP, SSRF, CSRF, RCE, GuzzleHttp, xmlrpc.php, DDoS, auth
  vulnerabilities. Registered in `faqIndex.ts` after `is_it_safe`.
  Total FAQ entries: 25 (was 24).

### Heart identicon

- Replaced the grid-style identicon with heart-shape design inspired
  by Guillaume Schlipak's IdentiHeart (AGPL reimplementation, no
  code copied). 2 lobes + 4 triangles + accessory shape = 7 color
  slots + 1 shape slot from input bytes. ~180M distinct looks.
  Same public API `identiconSvg()` / `identiconDataUri()`, so no
  caller changes.

### Documentation

- ADR-0005: Phase 3 subphase split
- ADR-0006: Security posture for Phase 3a (attack-class verdicts)
- ADR-0007: Keygen curve fix + dblurt package typo
- `docs/SECURITY.md` Phase-3a addendum with operator
  responsibilities + legal considerations
- `docs/PHASE-3a-DESIGN.md` updated: all Go references replaced
  with Node.js/TypeScript; changelog appendix records the mid-phase
  stack pivot and crypto fix

## Resolved Phase-2 carry-forwards

- P2-12 `broadcastCustomJson` test coverage → **upgraded to Blocker**
  when we discovered it was masking the curve bug. Still open;
  proper integration test lands in 3b when indexer is available
- P2-13 relay account registered on mainnet → done
- P2-14 Matrix admin account → done
- P2-15 BTC/XMR wallets → generated, deferred to Phase 5 consumer
- P2-16 Ed25519/secp256k1 curve migration → **RESOLVED**
- P2-17 `dblurt` package typo → **RESOLVED**

## Deferred to Phase 3b

- **Indexer**: Phase 3b's main deliverable. Required before P2-12
  can be closed because we need a reliable way to read back a
  broadcast op from chain state.
- **True integration test** of `/v1/account/create` against a real
  Blurt testnet or mainnet: depends on 3b indexer infrastructure.
- **Availability handler test + create handler test**: the relay
  tests exist (8 + 10 cases) but use mocked `BlurtClient`. Once
  indexer infrastructure allows, swap the mocks for a staging
  node.
- **Public key import helper** (`parsePublicKeyBLT`): speculative
  API surface, not yet needed. Add when a feature requires it.

## Deferred to Phase 3c

- **Release-discovery indexer contract**. Phase 3a pinned the
  `MORPHIT_OFFICIAL_POSTING_PUBKEY` constant and documented the
  `morphit_release_v1` op shape. Consumer lands in 3c.
- **Hardware-wallet seed export** (BIP-32 xprv). Out of Phase 3
  entirely; Phase 5.

## Operational posture (what the maintainer needs to do)

Before Phase 3a actually goes live on `relay.morphit.io`:

1. DNS A record for `relay.morphit.io`
2. VPS prep: Node 24 LTS, `morphit-relay` system user, `/etc/morphit/`
   + `/opt/morphit-relay/` directory tree
3. Copy `morphit-relay` Blurt account's active key WIF to
   `/etc/morphit/keys/relay-active.key` with 0400 perms
4. Env file at `/etc/morphit/relay.env` with 0600 perms
5. `npm ci --omit=dev` in `/opt/morphit-relay/`
6. Install systemd unit + nginx vhost, get TLS cert via certbot
7. Smoke test: `curl https://relay.morphit.io/v1/health`
8. Update frontend env (`PUBLIC_MORPHIT_RELAY_ORIGIN`) for a real
   deployment; point `morphit.io` at the registration flow

All of this is covered in `apps/relay/README.md`. No additional
runbooks needed.

## Known imperfections (flagged, not fixed)

- `$_(…, { default: $_(…) })` in the register-name template triggers
  the i18n formatter twice per render for the fallback branch.
  Acceptable for now; optimize only if profiling shows it matters.
- `fingerprint()` in `profile.ts` still renders hex-based
  abbreviations (not base58 snippets of the real BLT string). This
  is documented in that file's header as intentional — users who
  learned their hex fingerprint in Phase 1/2 keep the same visual
  anchor. The real BLT string is available via `fullPublicKey()`.
- Relay unit tests are in-memory; no integration test against a
  real Blurt node. Integration comes in 3b with the indexer.

## Entering Phase 3b

Phase 3b is the indexer — a service that reads `morphit_*` ops from
Blurt's chain history and exposes them as queryable state for the
frontend (orderbook, feedback, profile lookups, release discovery).
3a's completion unblocks it: the relay can create accounts, the
crypto can sign ops, the frontend can submit them. 3b makes those
ops readable at scale.

No tarball will be produced until all three Phase 3 subphases are
complete.
