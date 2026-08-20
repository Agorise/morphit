# Morphit ↔ hidden-rpc: block_log snapshot bootstrap

Complete spec + decisions for consuming (and helping publish) the canonical Blurt
`block_log` snapshot. Everything you need to implement the consume side is here;
the open questions we need answered before anyone publishes are at the end.

---

## 1. The on-chain pointer: `chain_snapshot_v1`

The source of truth is a Blurt `custom_json` op, **not** a hardcoded URL — so we
can rotate seeders without a client update. Always read the **latest** one from
account **`@morphit`**.

```
id: "chain_snapshot_v1"      (custom_json, required_posting_auths: ["morphit"])
json:
{
  "ipfs_cid":       "bafy…",             // CIDv1 base32 (or Qm… v0) of the block_log archive
  "sha256":         "<64 lowercase hex>", // sha256 of the archive — the integrity gate
  "block_height":   62874615,            // advisory; blurtd re-derives on import
  "size_bytes":     27000000000,         // advisory; for progress + disk pre-check
  "blurtd_version": "0.1.5",             // producer version (import-compat hint)
  "ipns_name":      "k51q…",             // OPTIONAL: resolves to the always-newest snapshot
  "forgejo_url":    "https://…"          // OPTIONAL: plain-HTTP mirror (see §4)
}
```

We can hand you our validator module (`chainSnapshotOp.ts`) so your encoder/decoder
matches ours byte-for-byte and you can unit-test against the real contract with no
live op. It's pure public op-format code (no keys/secrets).

---

## 2. KEY FACT: Morphit only indexes from `@morphit`-genesis forward

Morphit's indexer does **not** index the whole chain. It starts at
**block 59,441,298** — the block where `@morphit` was created
(2026-04-18T23:19:03) — and never requests a block older than that.

- `MORPHIT_GENESIS_BLOCK = 59441298`
- Chain head today ≈ 62.8M, so Morphit's indexing window is only ~3.4M blocks,
  not the full ~62.8M-block chain.

**What this means for your node:** a hidden-rpc node exists to serve the Morphit
indexer's backfill. That backfill only ever asks for:
- **raw blocks** from 59,441,298 → head (`get_block` / `get_block_range`), and
- a little **current-head state** (`get_dynamic_global_properties`, some
  `get_accounts`) — which any node synced to head already has.

It **never** asks for blocks before 59,441,298.

**The opportunity (your call — depends on blurtd):** because Morphit never reads
pre-genesis blocks, your node in principle only needs to *serve* block_log from
~59.4M forward. If blurtd can run with a **pruned / partial block_log** (or a
state snapshot at ~59.4M plus blocks from there), the published snapshot could be
a *fraction* of a full-chain block_log — potentially GBs instead of tens of GBs,
and minutes to sync. If blurtd instead requires the full block_log from block 1,
that's fine too — publish the full block_log; Morphit still only backfills its
~3.4M-block window from it. **Tell us which blurtd supports** (see §8) — it
decides the snapshot size and therefore the whole UX.

---

## 3. Decision — trustless block_log (default) vs trusted state snapshot (opt-in)

These are **different trust artifacts**; don't conflate them behind one "fast"
flag.

- **block_log** is **self-verifying**: blurtd re-checks every block's witness
  signature + prev-hash on import, so a tampered file fails on replay. This is the
  trust anchor, and it is the **only** thing `chain_snapshot_v1` points at.
  (An unattended replay of an already-downloaded block_log is a "start it before
  bed" job — an acceptable one-time cost for trustlessness.)
- **A presynced *state* snapshot** (block_log + shared_memory/rocksdb) is blurtd's
  **derived** state — using it means **trusting whoever computed it**. Same line we
  drew for our indexer DB.

Rules:
- block_log-replay is the **default**, and the only artifact advertised on-chain.
- A state-snapshot fast path may exist as an **explicit opt-in** for operators who
  knowingly trust the publisher (e.g. their own other box). It must **not** be
  advertised via `chain_snapshot_v1` — that would make `@morphit` the network's
  trusted source of derived chain state, exactly what we avoid everywhere.
- If we ever want an on-chain pointer for state snapshots, it'll be a **separate,
  clearly-labeled "trusted" op** — never folded into this one.
- Present the two paths as **"trustless (default) vs trusted (opt-in)"**, not as a
  free `--fast` speedup.

---

## 4. Decision — IPFS access: gateways + Forgejo fallback, sha256-gated

Don't make a full IPFS daemon a prerequisite (kills the grandma-friendly install).

- Try a couple of **public gateways** for the CID, then fall back to `forgejo_url`.
- `forgejo_url` is a **plain static file** on our web host — **not** a git release
  asset (a multi-GB blob doesn't belong in git). IPFS is primary; this is the mirror.
- **MANDATORY:** verify the op's `sha256` after download, regardless of which path
  served the bytes. Untrusted transport is fine precisely because the CID +
  on-chain sha256 catch tampering.
- Offer "use my own IPFS daemon" as an **option**, not a requirement.

---

## 5. Decision — reading the pointer: two-RPC cross-check, fail LOUD on conflict

Reading through one RPC that could withhold the newest op or serve a stale one is
a real downgrade vector.

- Read the latest `chain_snapshot_v1` from `@morphit` across **≥2 independent
  public RPCs**; take the highest `block_height`.
- If the RPCs **disagree beyond staleness** — same account + op id, same height,
  but conflicting CID/sha — do **not** silently pick one. Stop and surface it;
  that's a fork or a lying node. Cross-check yes; on genuine conflict, **fail loud**
  rather than guess.

---

## 6. Bootstrap flow (put together)

1. Read the latest `chain_snapshot_v1` from `@morphit` (two-RPC cross-check, §5).
2. Pre-check free disk against `size_bytes` (+ headroom for extraction — see §7).
3. Fetch the archive: IPFS by `ipfs_cid` (or resolve `ipns_name` for newest) →
   fall back to `forgejo_url` (§4).
4. **Verify `sha256`** before touching it (§4).
5. Extract the block_log and place it into blurtd's data dir.
6. **Delete the downloaded archive** (§7) — free the space immediately.
7. Start blurtd; let it replay + verify the block_log, then stay current.

---

## 7. Disk: what to delete vs keep (answers "can it auto-delete after sync?")

- **The downloaded archive** (`block_log.tar`, the transfer container): **delete
  it automatically** right after extract + verify + place (step 6 above). This is
  the real space win. It's also why peak disk need (your `MIN_FREE_GB=90`) is a
  *transient* requirement — archive + extracted copy coexist only during setup;
  after the archive is deleted you drop well below that.
- **The extracted `block_log`** (now in blurtd's `blockchain/` dir): **keep it —
  do NOT delete.** This is a common misconception: the block_log is **not** a
  bootstrap file you discard after syncing. It **is** the blockchain store —
  blurtd reads from it and **appends every new block to it forever** (like
  Bitcoin's `blocks/` dir). Delete it and the node breaks / must re-download. It
  only grows over time; today's size is just today's.
- The only lever to shrink the *kept* footprint is the **pruned/partial block_log**
  question in §2 — which is your call and depends on blurtd. A pruned node that
  can't serve deep history is fine for Morphit (we only read from 59.4M), but
  confirm it can still serve that window.

---

## 8. Open questions we need answered BEFORE anyone publishes

Publishing is gated on these — we won't ship a flow that doesn't work end-to-end.

1. **Import:** can blurtd import a block_log dropped into a **fresh** node's data
   dir and replay it cleanly?
2. **Stay-current over hidden RPC:** after import, can the node **stay current
   over hidden RPC only, with clearnet p2p gossip DISABLED**? This is the make-or-
   break for a tor-only box. If blurtd needs p2p gossip to stay live, we need a
   different plan — flag it early.
3. **Pruned/partial block_log (§2):** does blurtd support running with a block_log
   that starts at / is pruned to ~block 59.4M (Morphit's genesis) rather than
   block 1, while still serving that window and current-head state? This decides
   whether the snapshot is ~GBs or ~tens of GBs.

---

## 9. Status & shipping v0.1.6

- **No live op / pinned CID exists yet.** The `@morphit` broadcaster is built but
  hasn't been run, and no block_log is pinned — publishing is gated on the §8
  answers. For now, code against the op schema and unit-test with our validator
  module; that exercises your read → cross-check → gateway-fetch → sha256 pipeline
  against the real contract. We'll publish a real op once §8 is settled.
- **Defaults for v0.1.6 are:** dual-path (block_log-only on-chain; state snapshot
  as explicit-trust opt-in), gateways + Forgejo fallback with mandatory sha256
  gating, two-RPC cross-check that fails loud on conflict, and auto-delete of the
  downloaded archive (keep the extracted block_log). Write it against those — just
  don't call it validated end-to-end until §8 is answered and we've published a
  real op for you to run against.
