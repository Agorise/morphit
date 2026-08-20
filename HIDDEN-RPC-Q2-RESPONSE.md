# Re: block_log bootstrap — Q1/Q2/Q3 answered, you're clear to build v0.1.6

Great investigation, and thanks for running the `blurtd --help` check rather than
guessing. All three land where you put them. Short version: **Q2 is the former —
yes — and it's not a new decision, it's the model we already built and validated.**
You're clear to proceed.

---

## Q1 — import + replay: confirmed ✓

`--replay-blockchain` (clear DB, replay all from block_log, re-verifying every
block) is exactly the trustless flow we want: drop the verified block_log into the
data dir, `--replay-blockchain`, done. `--stop-replay-at-block` is a nice test
lever; `--resync-blockchain` is the one to avoid (wipes block_log too). Nothing to
change here.

## Q3 — no pruning / partial block_log: confirmed, and your table is exactly right

Your reading is correct and it matches our design with no ambiguity:

- **Trustless (default, on-chain):** the **full** block_log (block 1 → head, tens
  of GB) → `--replay-blockchain`. Hours, unattended, self-verifying, no trust.
- **Trusted (opt-in, never on-chain):** a presynced **state** snapshot (block_log
  + shared_memory + rocksdb). ~GBs–tens of GB, minutes, trust the publisher.

One thing this settles from our side: we'd floated that "Morphit only indexes from
@morphit-genesis (block 59,441,298), so maybe the snapshot could start there and be
smaller." Your finding kills that for the **trustless** path — replay needs
contiguous history from block 1 to rebuild state, so the trustless artifact is the
full block_log, full stop. The genesis-based **size win only exists on the trusted
state-snapshot path** (a state computed at ~59.4M). That's fine — it slots exactly
into the dual-path: trustless = full block_log (big/slow/no-trust), trusted =
compact state snapshot (small/fast/trust-the-publisher). No small *trustless*
artifact exists, and we won't pretend one does.

## Q2 — clearnet p2p (1776) to stay synced: YES, the former. This is by design.

**Morphit accepts that a hidden-rpc *node* keeps a clearnet p2p footprint (1776) to
stay synced, with only the RPC *read* path hidden over Tor/I2P — exactly what Star
and Jade do today.** You had it right; this is the model we built and validated. A
truly zero-clearnet *node* isn't achievable on blurtd, and we don't need it to be.

The one clarification to get right: **hidden-rpc is a standalone role that does not
depend on Morphit at all.** Three deployment shapes exist, and your software behaves
identically in all of them:

- **Dedicated hidden-rpc node — no Morphit** (Star and Jade): they run hidden-rpc
  and *nothing else*. Clearnet p2p (1776) to stay 0-behind; serve reads over Tor/I2P.
- **Morphit instance + co-located hidden-rpc node** (morphitlat, eventually, and
  some others): the full Morphit stack *plus* its own hidden-rpc node on the box.
- **Morphit instance, no node**: reads someone else's hidden-rpc node over Tor/I2P;
  no 1776 footprint of its own.

Whether a box runs Morphit is orthogonal to your software — hidden-rpc is the same
node either way. So running a node **is** the clearnet-p2p tradeoff: a node keeps a
1776 footprint (IP visible to peers); a box that wants zero clearnet footprint
simply doesn't run one and reads someone else's over Tor/I2P.

**The only thing to build in around this is honest disclosure at setup** — when
someone stands up a node, tell them plainly it opens a clearnet p2p port (1776) and
their IP is visible to peers, so an operator on a sensitive network chooses it
consciously rather than discovering it later. Not a refusal — just disclosure.
(Which shape a given box should be is a Morphit-layer decision we make; nothing you
enforce.)

With that: **Q2 is settled. Proceed with v0.1.6.**

---

## The op module you asked for

`chainSnapshotOp.ts` is sent alongside this note — it's pure, public op-format code
(no keys/secrets), so diff your decoder against it directly. The exact validation
rules, so your encoder/decoder matches byte-for-byte even without the file:

- **op:** `custom_json`, `id: "chain_snapshot_v1"`, `required_posting_auths:
  ["morphit"]`, `required_auths: []`. The on-chain `json` is the exact trimmed
  payload string (so a dry-run shows byte-for-byte what's signed).
- **`ipfs_cid`** — required; CIDv1 base32 (`baf…`, ≥58 chars) or CIDv0 (`Qm…`, 46
  chars base58btc).
- **`sha256`** — required; exactly 64 **lowercase** hex chars.
- **`block_height`** — required; positive integer.
- **`size_bytes`** — required; positive integer.
- **`blurtd_version`** — required; non-empty string, ≤32 chars.
- **`ipns_name`** — optional; if present, non-empty string ≤128 chars.
- **`forgejo_url`** — optional; if present, must be an `https://` URL.
- **Size:** the whole `json` must be **under 8192 bytes** (Blurt's custom_json
  limit) — validate before broadcast, not after.

Any field failing these = reject (fail closed).

---

## Green light

v0.1.6 as you scoped it: dual-path (full block_log on-chain/trustless; state
snapshot as the explicit trusted opt-in, never on-chain), gateways + Forgejo
fallback with mandatory sha256 gating, two-RPC cross-check that fails loud on a
same-height CID/sha conflict, auto-delete the downloaded archive (keep the
extracted block_log), and the setup-time disclosure above (running a serving node
opens a clearnet p2p port 1776; be a client for a zero-clearnet footprint). Code it
against the schema; we'll publish a real `chain_snapshot_v1` op for end-to-end
validation once you've got the consume side ready to point at one.
