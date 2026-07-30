# ADR-0048 — Chat head-block fast path (sub-6s message delivery)

**Status:** Accepted — **partially superseded by ADR-0051 (2026-07-16)**

> **Superseded in part.** ADR-0051 keeps this ADR's load-bearing invariant —
> the tailer NEVER writes the database — and its latency budget, but replaces:
>
> - **Invariant #2 ("CHAT ONLY … orders et al. stay irreversible-only,
>   always")** with a per-entity matrix: a head-block op may drive *provisional
>   display*, but never money or reputation. The half of #2 that still holds is
>   *"must never drive money or state"*.
> - **The `MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED` opt-out**, which was removed
>   rather than renamed — the tailer cannot corrupt anything, so there was
>   nothing for the switch to protect.
>
> Read ADR-0051 before relying on anything below about scope or configuration. (implemented), 2026-07-02
**Supersedes:** none
**Superseded by:** none
**Related:** ADR-0008 (irreversible-only indexing), ADR-0015 (chat E2EE envelope)

## Context

Chat felt slow. A message a user sent took ~45–60 seconds to appear in the
recipient's open conversation, even though the frontend already streams
messages over SSE (no polling on the client). The delay was entirely
server-side and structural:

- Per **ADR-0008**, the indexer's poller only applies blocks up to
  `last_irreversible_block_num`, so the database never holds an op that a
  fork could still roll back. Reorg handling becomes a non-concern.
- The chat SSE stream (`/v1/chat/:a/:b/stream`) fires `message_appended`
  from `chatEventBus`, which the durable chat handler emits **after** the
  block's transaction commits — i.e. only once the message is irreversible.
- On Blurt (Graphene/DPoS) the last-irreversible block trails the head by
  ~15–20 blocks. At ~3s block time that's ~45–60s.

So the push pipeline was fine; the push just waited for irreversibility.
`MORPHIT_INDEXER_BLOCK_INTERVAL_MS` (3000) is not the lever — irreversibility
is. We want new chat messages visible within a few seconds while keeping the
ADR-0008 guarantee intact for everything that matters.

## Decision

Add a **separate head-block tailer** (`apps/indexer/src/indexer/chatHeadTailer.ts`)
that polls the chain **head** (not the irreversible point), extracts
`morphit_chat_v1` ops from new head blocks, and emits each over SSE as a
**provisional** message within a couple of seconds. The durable, irreversible
poller is unchanged and remains the sole source of truth. The client dedupes a
provisional against its later durable copy by the on-chain `client_tag`.

**On by default** (`MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=true`), interval
`MORPHIT_INDEXER_CHAT_FASTPATH_INTERVAL_MS=2000`.

### Six hard invariants (the safety contract)

1. **Never writes the database.** The tailer only reads (the block feed + a
   block-list lookup) and emits in-process events. The durable poller stays
   the only writer, so the ADR-0008 guarantee is untouched for chat history
   and for every other op type.
2. **Chat only.** It extracts exactly `morphit_chat_v1`. Orders, fees,
   feedback, transfers — everything with money or durable state at stake —
   stay irreversible-only, always. A head-block op is not yet irreversible and
   must never drive money or state.
3. **Reorg is acceptable.** A head block can be orphaned by a fork. If a
   message shown via the fast path is orphaned, it simply never reaches
   durable history — the user saw it briefly and it's gone. That trade-off is
   fine for chat and is exactly why orders et al. are excluded. The tailer
   tracks no block hashes and performs no rollback.
4. **Block list is enforced.** Before emitting, the tailer runs the SAME
   block check the durable handler runs (recipient has blocked sender → drop),
   and it FAILS CLOSED — if the block-list query errors, it does not emit.
   Skipping this would let a blocked sender's message flash up live even
   though the recipient blocked them: a real block bypass. This is the one
   gate we must replicate. The anti-spam gates (stranger-fee admission + rate
   limits) are deliberately NOT replicated: the durable pass still enforces
   them for persistent history, and a spammer's message being briefly visible
   before it fails to persist is a bounded, acceptable degradation. The block
   check is the only gate whose bypass would be a genuine safety hole.
5. **Client-tag gated.** The tailer only emits messages whose header carries a
   non-empty `client_tag` — the key the client uses to dedupe the provisional
   against its durable twin. A message with no `client_tag` can't be deduped,
   so it is left to arrive via the durable path only (≈60s, but never
   doubled). Every Morphit-composed message has a `client_tag`, so this
   affects nothing in practice.
6. **Never crashes the process.** Every tick is wrapped; RPC/parse errors are
   logged and the loop retries next interval. Unlike the durable poller (whose
   fatal errors exit the process for a clean systemd restart), a fatal in the
   tailer only logs — the durable poller must stay unaffected by a broken fast
   path.

### Emission + dedup mechanics

- The tailer emits a `ChatFastEvent` (full payload: sender, recipient,
  ciphertext, header, block timestamp, client_tag) on a **separate** channel
  of `chatEventBus` (`emitFast`/`onFast`), distinct from the durable
  `emit`/`on`. The durable event carries only a DB row id (the SSE handler
  re-fetches the row); the fast event carries the full payload because there
  is no DB row yet.
- The SSE handler forwards a fast event to matching subscribers as a
  `message_appended` with **wire id `0`** — the provisional sentinel. It
  deliberately does not advance the fallback-poll watermark (`id 0` is not a
  real id).
- The client (`chatService.ts` merge) treats `id 0` as provisional:
  - **Our own** messages: `reconcileByClientTag` matches the local optimistic
    echo (or an already-reconciled provisional) by `client_tag`, marks it
    confirmed, and adopts the durable id the first time it lands — a
    provisional `id 0` never overwrites a real id.
  - **Incoming** messages: a twin is found by `(sender, client_tag)`; if the
    durable copy arrives after a provisional, its real id is adopted in place;
    the decode/record side effects (`recordAddressShared`/`recordFundsSent`)
    run once, when the message first arrives, and are NOT re-run on the twin —
    so an address/funds-sent payload is never double-recorded.
  - A provisional is stored with a `null` id, so it never collides in the
    id-based `seenIds` dedup set (all provisionals would otherwise share
    `id 0`).

### Latency budget (the "≤6s" target)

```
broadcast → in head block:   0 – 3s   (inherent Blurt block time)
head block → tailer emit:    0 – 2s   (poll interval) + ~0.3s (block fetch)
emit → client render:        ~0.1s
                             ─────────
worst case ≈ 3 + 2 + 0.4 ≈ 5.5s
```

The block-production time is inherent and unavoidable; the fast path removes
the ~45–60s irreversibility wait. The 2000ms interval keeps the worst case
under ~6s; lowering it tightens latency at the cost of more head polls,
raising it reduces RPC load.

### RPC load

The tailer adds one `getDynamicGlobalProperties` per interval (~30/min at
2s) plus a `getBlock` per new head block (~20/min, bounded by block
production — the same rate the poller fetches irreversible blocks). Roughly a
2× increase in block-feed calls versus the poller alone. The RPC pool
(`@morphit/rpc-pool`) handles the extra load; a far-behind tailer skips ahead
(`MAX_CATCHUP_BLOCKS = 120`) rather than bursting.

## Rollout: on by default, ship together

The fast path is **on by default** so every instance — including existing
operators on their next `morphit-ops upgrade` — gets sub-6s chat with no
action required. This is safe because the **client-side dedupe ships in the
same release** as the indexer fast path: a standard upgrade rebuilds the web
frontend and restarts the indexer (which runs from TS source), so both halves
go live together. There is no partial-deploy window on a normal upgrade.

The one edge case: a browser tab still running a pre-release frontend against
a freshly-upgraded indexer would briefly double a message (the old client
doesn't dedupe by `client_tag`) until the tab reloads and picks up the new
build — self-healing, and SSE connections typically reconnect on deploy
anyway.

Operators who want a message not shown until it is irreversible can set
`MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED=false`.

## Alternatives considered

- **Write head-block messages to the DB with a `provisional` flag, reconcile
  on irreversibility.** Rejected: reintroduces reorg complexity (orphaned
  provisional rows need cleanup) and violates invariant 1. The DB must only
  ever hold irreversible data.
- **Share a stable on-chain id (trx_id) end-to-end and dedupe on it instead of
  `client_tag`.** Rejected as unnecessary: the DB id is `BIGSERIAL` (not
  derivable at head time), but `client_tag` is already present in every
  message header and already used for our-own reconciliation, so no wire
  change is needed.
- **Run the full durable handler in a rolled-back transaction to reuse all
  gates.** Rejected: it would burn the `chat_messages` id sequence, waste the
  push-enqueue work, and couple the fast path to the handler's write
  machinery. A focused validator (shape + block check) with a parity smoke is
  cleaner and keeps the tailer decoupled.
- **Lower the block interval / tune irreversibility.** Not a lever —
  irreversibility depends on chain consensus, not indexer polling.

## Consequences

- New chat messages appear in an open conversation in ~3–6s instead of
  ~45–60s, on every instance by default.
- The indexer makes roughly 2× the block-feed RPC calls it did before (opt
  out to restore the old load profile).
- A message shown via the fast path can, rarely, be orphaned by a reorg and
  then not appear in durable history — acceptable for chat, never for money.
- Validation logic is duplicated between the durable handler and the tailer;
  `chat-head-tailer-validation-parity-smoke` pins them together (constants,
  op id, block predicate) and asserts the tailer is DB-read-only, fast-channel
  only, and chat-only. `chat-fastpath-dedup-smoke` pins the client-side
  collapse and the no-double-record safety property.

## Verification

- Indexer `tsc --noEmit`: clean.
- `chat-head-tailer-validation-parity-smoke` (8): op-id/constant parity +
  DB-read-only + fast-channel-only + chat-only + client-tag-gate.
- `chat-fastpath-dedup-smoke` (8): provisional-aware reconcile, twin collapse,
  never-overwrite-real-id, and the money-flow no-re-record invariant.
- Existing chat suites unchanged: `chat-handler` (26), `chat-stream` (18),
  `chat-payload` (103), `chat-blurt-verify` (55); frontend `chat-pay-now-flow`
  (10), `chat-own-sent-plaintext-cache` (7), `chat-blocks-race-guard` (9),
  `cross-tab-signout-propagation` (11), `chat-immersive-layout` (7).
- `env-example-schema-parity` green after documenting the two new vars in
  `ops/env/indexer.env.example`.
