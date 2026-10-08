# Federated indexer-DB snapshot — publish / import pipeline spec

> ## ⚠ SUPERSEDED IN PART (v1.17.2) — read this box first
>
> This document is the ORIGINAL design spec. The pipeline shipped in v1.17.2, but
> two of the spec's load-bearing assumptions turned out to be wrong, and the
> design that shipped is simpler as a result. Keep the spec for its reasoning and
> its threat model; do not treat §6, §7 or §12 as a description of the code.
>
> **1. The snapshot is SMALL.** The spec sizes everything around a multi-gigabyte
> tarball (staging inside the kubo repo, `--nocopy`, disk pre-checks, "a big
> file"). The real artifact is **under 600 kB** — e.g.
> `morphit-indexer-snapshot-63503209-2026-09-09.tar.gz`. That single fact changes
> the economics: mirroring is cheap enough for *every* instance to do
> unconditionally, so there is no reason to centralise distribution.
>
> **2. One signer, many mirrors — not many publishers.** §13 asked whether other
> instances should also sign their own snapshots. The answer is no. Only
> `@morphit` exports and anchors (`indexer_snapshot_v1`), so there is exactly one
> signature and **no new trust decision for any operator to make**. Every other
> instance pins that CID and re-serves the bytes over its own clearnet origin,
> `.onion` and `.b32.i2p`. A newcomer proves every byte against the signed
> on-chain SHA-256, so which mirror answered is a SPEED question, never a trust
> question — a hostile mirror is caught by arithmetic rather than by reputation.
>
> **What that makes moot:** most of §7's Tier 0–3 ladder. With one signer, the
> trust surface is identical to running `@morphit`'s software release, which the
> operator already does. Tier 0 (full replay) remains the escape hatch and is
> still reachable; Tier 2/3 background re-verification was designed to hedge
> *many* publishers of varying trustworthiness and is not implemented.
>
> **What the spec got right and shipped as written:** the manifest v2 fields and
> three-way SHA agreement (§4), the frozen `indexer_snapshot_v1` op and its
> fail-closed validation (§5), the caught-up publish guard (§6), the fail-closed
> edge cases (§10), and the no-secret-columns invariant (§2).
>
> **What v1.17.2 added that the spec did not anticipate:** hidden-transport source
> ordering. The spec's import path (§7 step 2) is `IPNS → IPFS gateway →
> forgejo_url`, all of which are clearnet — which would have left fast-sync
> unusable for exactly the zero-clearnet nodes the project most wants. The shipped
> resolver tries the local gateway, then federation peers over Tor/I2P, then
> clearnet, and **omits the clearnet tiers entirely on a hidden-only node**,
> failing closed to a full replay rather than deanonymising the box to finish
> faster.
>
> Current behaviour is documented in **OPERATIONS.md §52**.

**Goal:** a brand-new Morphit node reaches a live, correct orderbook in **well under an
hour** instead of replaying ~3.75M blocks over (often slow / censored) RPC for days.
The frontend is already immediate (static, v1.13.2); this closes the *indexer* gap.

**Status:** design spec. It extends work already in-tree and does **not** replace it.

---

## 1. What already exists (and what this reuses)

Three relevant systems are already built. This spec adds one thing on top of them.

**(a) Own-box indexer-DB snapshot — `cp764`.** The safety core and both operator
scripts exist:
- `apps/indexer/src/db/snapshotManifest.ts` — pure, unit-tested compatibility core.
  `SNAPSHOT_FORMAT_VERSION = 1`; files `manifest.json` + `indexer.sql.gz`;
  `verifyManifestCompatible()` fails **closed** on chain-id mismatch (fatal), a schema
  newer than the target build, or a pg-major newer than the host.
- `apps/indexer/scripts/snapshot-export.ts` — `pg_dump --clean --if-exists | gzip` +
  `manifest.json` → `morphit-indexer-snapshot-<block>-<date>.tar.gz`.
- `apps/indexer/scripts/snapshot-bootstrap.ts` — restores onto a fresh box; gates:
  manifest compatible, `--i-trust-this-source`, and refuses to clobber real data
  without `--force`. Then the indexer catches up the small gap.

Its trust model is deliberately narrow, and `snapshotManifest.ts` says so verbatim:
restoring means **trusting the snapshot's derived state instead of re-deriving it from
chain**, which is safe *only between an operator's own boxes*. A public/federated
snapshot "would need a signature + a trust decision about whose chain-view you accept,
which is a separate, deliberate step (tracked, not built here)."

**This spec is that step.**

**(b) block_log snapshot — trustless, for RPC / hidden-rpc nodes.** A *complete*
pipeline already ships and is the template we mirror:
- `ops/make-snapshot.sh` (package blurtd `block_log` from the volume + sha256 + height),
- `ops/pin-snapshot.sh` (`ipfs add --nocopy`, a **dedicated** IPNS key — never the
  release key — and emits a ready-to-broadcast payload),
- `apps/indexer/src/blurt/chainSnapshotOp.ts` — the **on-chain trust anchor**, a frozen
  `chain_snapshot_v1` custom_json signed by `@morphit`, carrying `ipfs_cid` + `sha256` +
  `block_height` + `size_bytes` + `blurtd_version` + optional `ipns_name`/`forgejo_url`,
- `apps/indexer/scripts/chain-snapshot-broadcast.ts` — broadcasts it.

Crucially, block_log is **trustlessly self-verifying**: blurtd re-checks every block's
witness signature and prev-hash on import, so the on-chain anchor only needs to pin an
*integrity locator* (CID + sha256), not vouch for correctness.

**(c) Release distribution.** IPFS seed + IPNS + on-chain anchor (release op,
`distribution-anchor.env`, `verify.json`, `verify-cid-public.sh`) — the same CID +
sha256 + signer-fingerprint discipline we reuse here.

---

## 2. The one hard problem this spec must solve

The block_log snapshot gets to be trustless because blurtd can cheaply re-derive
correctness. **The indexer DB is derived state, and re-deriving it *is* the multi-day
replay we are trying to avoid.** So a federated indexer snapshot cannot be
"trustless" the same way — trust has to come from three layers instead:

1. **Signed provenance** — the operator accepts a snapshot only if it is anchored
   on-chain by a signer they have chosen to trust (default: `@morphit`, i.e. the same
   party whose software they already run).
2. **Tail re-verification** — after restore, the indexer catches up
   `last_applied_block → head`; that tail is indexed normally, i.e. every op in it is
   signature-checked against the chain. The trusted window is only the snapshot's
   *pre-tail* state.
3. **Self-healing + bounded blast radius** — orders expire, cancels/fills stream in,
   and the user-visible surface (the active orderbook) re-verifies fastest. A stale or
   slightly-wrong snapshot converges to correct quickly.

**Threat model.** A tampered snapshot could inject fake *active* orders, inflated
reputation/loyalty, or wrong operator-earnings/balances. Signed provenance addresses
"who made this"; §7 addresses "and how much do I have to take on faith."

**Non-leak (verified).** The indexer DB has **no** secret-bearing columns (schema
scanned: no wif/private-key/seed/password columns; relay keys live in env/config, never
in the indexed DB). A published snapshot is 100% derived public chain data. The export
MUST assert this invariant (see §9) so it can never regress.

---

## 3. Architecture at a glance

```
 SYNCED FEDERATION NODE (morphit.io / morphitlat)        FRESH NODE (any operator)
 ─────────────────────────────────────────────          ─────────────────────────
 daily cron, only if lag≈0 & healthy:                    morphit-ops → "fast-sync":
   1 snapshot-export.ts        → tar.gz                    1 read newest indexer_snapshot_v1
   2 sha256 + self-hash                                      op from chain (trusted signer)
   3 ipfs add --nocopy         → CID                        2 fetch CID via IPNS/IPFS
   4 name publish (dedicated IPNS key)                        (forgejo mirror fallback)
   5 build indexer_snapshot_v1 payload                      3 verify sha256 + signer + manifest
   6 chain-snapshot-broadcast  → on-chain anchor           4 pg_restore, set cursor
   7 verify-cid-public.sh guard                            5 start indexer → tail catch-up
                                                            6 background tail-verify (§7)
```

Everything above the fold reuses `pin-snapshot.sh` mechanics; everything below reuses
`snapshot-bootstrap.ts` mechanics. The new code is: a second on-chain op, a publish
wrapper, a `--from-chain` import path, and the tail-verify job.

---

## 4. Export format (delta to the existing tarball)

Keep the tarball shape (`indexer.sql.gz` + `manifest.json`). Bump
`SNAPSHOT_FORMAT_VERSION → 2` and extend `SnapshotManifest` with the fields a *stranger*
needs (the own-box case never needed them):

- `indexerVersion: string` — the build that produced it (surfaced to operators; not a
  compat gate on its own — `schemaVersion` remains the gate).
- `dumpSha256: string` — sha256 of `indexer.sql.gz`, so the manifest is self-describing
  and the on-chain `sha256` can be checked against the file *before* trusting the manifest.
- `opCoverage: 'full' | 'orderbook-only'` — reserved for a future recent-only variant;
  `'full'` for now (the DB carries cumulative reputation/loyalty/earnings, so the default
  snapshot must be full-history).

`parseManifest()` stays backward-compatible: a v1 manifest still restores via the
own-box path; only the federated path requires v2. `verifyManifestCompatible()` is
unchanged (chain-id / schema / pg gates already correct).

**Tables (v1.20.0 additions).** Chain-derived tables are exported with their rows;
node-local tables are exported empty. v1.20.0 adds `operator_fee_recipients`
(chain-derived — each operator's registered fees account over time; exported) and
`fee_reverify_done` (local bookkeeping for the one-time fee re-check; exported empty).

---

## 5. On-chain trust anchor: `indexer_snapshot_v1`

A **new** frozen op parallel to `chain_snapshot_v1` (a separate op because the payloads
differ: derived-state snapshots key on schema + last-applied-block, not blurtd version +
block height). New file `apps/indexer/src/blurt/indexerSnapshotOp.ts`, mirroring
`chainSnapshotOp.ts` conventions (same `BLURT_CUSTOM_JSON_MAX_BYTES`, same
`RELEASE_SIGNER_DEFAULT`, same validate-then-build shape, pure + unit-tested).

```jsonc
// custom_json id: "indexer_snapshot_v1"   (frozen)
// required_posting_auths: [ "<publisher>" ]  (default @morphit)
{
  "ipfs_cid":          "bafy…",       // CIDv1 base32 or CIDv0
  "sha256":            "<64 hex>",    // of indexer.sql.gz (== manifest.dumpSha256)
  "chain_id":          "<hex>",       // MUST equal the target's chain — hard gate
  "schema_version":    24,            // == manifest.schemaVersion
  "last_applied_block": 63188071,     // where the target resumes
  "size_bytes":        123456789,     // advisory: progress + disk pre-check
  "indexer_version":   "1.14.0",      // advisory
  "ipns_name":         "k51…",        // OPTIONAL: always-newest pointer
  "forgejo_url":       "https://…"    // OPTIONAL: https mirror fallback
}
```

Validation (fails closed, like `validateChainSnapshotPayload`): CID regex, 64-hex
sha256, non-empty chain_id, positive integer schema_version + last_applied_block, size
within the custom_json byte limit. `chain-snapshot-broadcast.ts` gets a sibling
`indexer-snapshot-broadcast.ts` (or a `--kind indexer` flag).

**Why on-chain and not just IPNS:** the chain gives an *authenticated, timestamped,
censorship-resistant* pointer to the newest snapshot, signed by an account whose
identity is itself on-chain (the operator can check the signer against the published
`morphit` registration). IPNS alone has no signer identity a stranger can anchor trust to.

---

## 6. Publish side (federation auto-publish)

New `ops/pin-indexer-snapshot.sh`, a near-clone of `pin-snapshot.sh` but for the DB
tarball, plus a systemd timer. Sequence on a caught-up node:

1. **Guard**: refuse unless `sync.behind == false` (lag ≈ 0) **and** the node is healthy.
   Never publish a snapshot of a broken/behind DB.
2. `snapshot-export.ts --out <staging>` → tarball; compute sha256.
3. `ipfs add --nocopy` (staged inside the kubo repo root, as pin-snapshot.sh already
   requires) → CID.
4. `ipfs name publish --key=<dedicated-indexer-snapshot-key>` — a **dedicated** IPNS key,
   **never** the release or block_log key (same rule pin-snapshot.sh enforces).
5. Emit the `indexer_snapshot_v1` payload; `indexer-snapshot-broadcast.ts` (signed
   `@morphit` for the canonical federation snapshot).
6. `verify-cid-public.sh <CID>` — optionally confirm public-gateway reachability (the
   release ceremony does not gate on this; it is a manual command there, see Block 5 of
   `scripts/eli5-release.sh`).
7. Rotate: keep last N pins; IPNS + the newest on-chain op are the durable pointers.

**Cadence:** daily. A 1-day-old snapshot leaves only ~28,800 blocks of tail
(~a few minutes to catch up). Tighten later if desired. Only morphit.io / morphitlat
publish the *canonical* (`@morphit`-signed) snapshot; any operator can publish their own
under their own account for their own boxes.

---

## 7. Import side (bootstrap `--from-chain` + verification tiers)

Extend `snapshot-bootstrap.ts` with a `--from-chain` mode that automates discovery +
verification, and replaces the blunt `--i-trust-this-source` with a real trust decision:

1. Read the newest `indexer_snapshot_v1` op **signed by a trusted signer**. Default
   trusted set = `{ @morphit }`; overridable via `MORPHIT_SNAPSHOT_TRUST_SIGNERS`.
   Reject if the only candidates are from untrusted signers.
2. Fetch the CID (IPNS → IPFS gateway → `forgejo_url` fallback). Enforce `size_bytes`
   as a sanity pre-check against local disk.
3. **Verify sha256** of the download against the on-chain `sha256` *before* untarring.
4. `verifyManifestCompatible()` (existing gate): chain-id exact, schema not newer than
   this build, pg not newer than this host. Also assert `manifest.dumpSha256 == on-chain
   sha256 == computed sha256` (the three must agree).
5. Require an explicit `--i-trust-signer <account>` acknowledgement (the federated
   analogue of `--i-trust-this-source`): the operator affirms whose chain-view they
   accept. Default flow shows the signer + registration and asks once.
6. `pg_restore`, set `indexer_state.last_applied_block = manifest.lastAppliedBlock`,
   start the indexer → it catches up the tail (normal, fully-verified indexing).

**Then choose a verification tier (operator-selectable, default = Tier 1):**

- **Tier 0 — Paranoid / trustless:** don't use a snapshot at all;
  `MORPHIT_INDEXER_START_BLOCK=<genesis>` full replay. Always available as the escape hatch.
- **Tier 1 — Trust + tail (default):** trust the `@morphit`-signed pre-tail state;
  the tail is re-verified by normal indexing. This is the same trust surface as running
  the `@morphit` software release itself.
- **Tier 2 — Active-order re-verify (recommended background job):** after restore, a
  non-blocking job re-fetches the backing on-chain op for every *active* (non-expired)
  order in the snapshot and drops any that don't verify. Cheap (active orders are a small
  set), and it hardens the single most user-visible, most-abusable surface. Orders expire
  anyway, so the pre-tail risk window is inherently short.
- **Tier 3 — Full background reconcile:** a slow, non-blocking re-derive from genesis
  that reconciles reputation/loyalty/earnings and corrects any drift, while the node
  serves from the snapshot immediately. Belt-and-suspenders for operators who want
  eventual trustlessness without eating the upfront wait.

Tiers 2/3 are the honest answer to "derived state can't be cheaply re-verified": we
verify the part that matters most, immediately, and optionally everything else in the
background.

---

## 8. Fit onto the existing IPFS infra (no parallel stack)

- **kubo**: morphit.io already runs it for releases; add one dedicated IPNS key.
- **`ipfs add --nocopy`**, staged-in-repo, reused verbatim from `pin-snapshot.sh`.
- **On-chain anchor**: a third op alongside the release op and `chain_snapshot_v1`,
  same signer conventions + byte limit.
- **`verify-cid-public.sh`**: reused as the pre-trust reachability guard.
- **forgejo mirror**: same https fallback pattern the release + block_log anchors already
  carry.
- **`morphit-ops`**: reused as the operator entry point (§10).

The only genuinely new artifacts: `indexerSnapshotOp.ts`, `indexer-snapshot-broadcast.ts`,
`pin-indexer-snapshot.sh` + its timer, the `--from-chain` path + tail-verify job in
`snapshot-bootstrap.ts`, and the manifest v2 fields.

---

## 9. morphit-ops install integration

New-install flow offers, up front:

- **① Fast-sync from federation snapshot (recommended)** → `snapshot-bootstrap --from-chain`,
  then start + tail catch-up. Minutes to a live orderbook.
- **② Full replay from genesis (trustless, slow)** → today's behavior; Tier 0.

Default the prompt to ①, with ② one keystroke away and named honestly. Show the signer,
snapshot age, and last_applied_block before the operator confirms.

---

## 10. Failure modes / edge cases (all fail closed)

- **Chain-id mismatch** → fatal, never restore (existing gate).
- **Snapshot schema newer than build** → refuse; tell operator to upgrade first.
- **Snapshot schema older than build** → run forward migrations after restore (the
  migration system already exists); refuse only if a gap can't be bridged.
- **pg-major newer than host** → refuse (dump portability).
- **sha256 mismatch / partial download** → discard before untar; try next source.
- **CID unreachable** → IPNS → gateway → forgejo; if all fail, fall back to Tier 0 with
  a clear message (never silently serve nothing).
- **No trusted-signer op on chain** → refuse the fast path; offer Tier 0.
- **Export while mid-migration** → the publish guard requires a stable schema +
  lag ≈ 0, so a half-migrated or behind DB is never published.
- **Secret-leak regression** → the export asserts the no-secret-columns invariant and
  aborts if a future schema adds one (see §2); backed by a smoke.

---

## 11. Tests / smokes

- Extend `snapshot-manifest-smoke.ts` for the v2 fields + the three-way sha256 agreement.
- New `indexer-snapshot-op-smoke.ts` mirroring `chain-snapshot-op-smoke.ts`
  (validate/build, byte-limit, signer rules, frozen op id) — canonical
  `✓ all <N> …` pass line.
- New `indexer-snapshot-export-no-secrets-smoke.ts` asserting the export refuses any
  secret-bearing column.
- New bootstrap smoke: `--from-chain` selects the newest *trusted-signer* op, rejects
  untrusted signers, and enforces sha256/manifest/chain gates (fixture-driven, no live
  chain).
- Register all in `run-smokes.sh`; keep the pure op/manifest logic unit-tested (no
  DB/fs/pg) as `snapshotManifest.ts` already is.

---

## 12. Phased rollout

- **P0** — manifest v2 (`indexerVersion`, `dumpSha256`, `opCoverage`) + export self-hash.
- **P1** — `indexerSnapshotOp.ts` + validate + `indexer-snapshot-broadcast.ts` + smokes.
- **P2** — `pin-indexer-snapshot.sh` + dedicated IPNS key + `verify-cid-public.sh` guard.
- **P3** — `snapshot-bootstrap --from-chain` (fetch + verify + restore + `--i-trust-signer`).
- **P4** — Tier 2 active-order re-verify background job.
- **P5** — federation auto-publish timer + `morphit-ops` install option (default fast-sync).
- **P6 (optional)** — Tier 3 full background reconcile; `opCoverage: orderbook-only`
  recent-window variant for ultra-light nodes.

P0–P3 already make "<1 hour for a trusting new node" real. P4–P5 make it the default and
harden it. P6 is the trustless-but-fast endgame.

---

## 13. Decisions for you

1. **Cadence** — daily canonical snapshot okay, or more frequent (smaller tail)?
2. **Default tier** — ship Tier 1 as the install default (my recommendation), with Tier 2
   auto-enabled in the background?
3. **Publishers** — only morphit.io + morphitlat sign the canonical snapshot, or should
   other caught-up instances also publish regional copies so censored-network newcomers
   fetch a local, same-signer-or-regional copy?
4. **Op reuse vs. new op** — new `indexer_snapshot_v1` (my recommendation, clean
   separation), or overload `chain_snapshot_v1` with a `kind` field?
