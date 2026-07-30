# ADR-0051: Head-block fast path generalisation ("fasteverything")

**Status:** Accepted
**Date:** 2026-07-16
**Supersedes:** ADR-0048 (chat head-block fast path) — invariants #2 and the
opt-out only; everything else in ADR-0048 stands.
**Depends on:** ADR-0008 (indexer architecture), ADR-0048

## Context

ADR-0008 made a deliberate trade: the indexer applies only blocks at or below
`last_irreversible_block_num`, because that is *"the price of never needing to
roll back."* On Blurt's 21-witness DPoS, last-irreversible trails head by ~15-21
blocks — **45-63 seconds**.

That one decision is the sole cause of every latency complaint the project has
ever had. Chat badges, order status, folder moves, trade counts, "Order not
found" on a freshly-posted order: all the same 60 seconds, arriving through
different UIs.

ADR-0048 carved out chat: a head-block tailer that reads the chain HEAD, never
writes the database, and emits provisional SSE events. It works, and it hits
~5.5s worst case (≈3s block + ≤2s poll + ~0.5s render). But it drew its boundary
at chat, with this invariant:

> **CHAT ONLY.** Orders, fees, feedback, transfers, and every other op are
> ignored here; they stay irreversible-only, always. A head-block op is not yet
> irreversible and must never drive money or state.

That invariant is doing two jobs at once, and only one of them is load-bearing:

1. *"must never drive money or state"* — **correct, and non-negotiable.** A head
   block can be orphaned. Anything derived from one can be wrong.
2. *"orders et al. stay irreversible-only"* — **too strong.** It conflates
   *driving state* with *being displayed*. Showing a provisional order and
   showing a provisional chat message carry the same risk (it may vanish), and
   we already accepted that risk for chat.

Meanwhile the field grew its own workarounds around the boundary, which is
usually the sign that a boundary is in the wrong place:

- `pendingFeatured.ts` (cp431) is an optimistic display-only store whose header
  says, in effect, "the fast path is chat-only, so I'll do it client-side."
- The order detail page retries for ~24s against a 45-63s wait, with a comment
  claiming that is *"comfortably longer than block time + indexer poll lag"* —
  it reasons about *poll* lag (~3s) and never accounts for *irreversibility*.
  A user who posts an order and clicks "View my order" is told **"Order not
  found."**

## Decision

### 1. One tailer, generalised

`chatHeadTailer.ts` → `headTailer.ts`; `ChatHeadTailer` → `HeadTailer`. One head
scan feeds many consumers.

Explicitly **not** a second tailer per domain. Two tailers would double
head-block RPC, and we added a per-endpoint request pacer in v1.5.7 precisely
because a node operator asked us to slow down. One scan, many consumers.

### 2. ADR-0048's invariant #2 is replaced by a per-entity matrix

ADR-0048's invariant #1 (**never writes the database**) is retained verbatim and
is what makes everything else here safe: a reorg costs us nothing because we have
written nothing to undo. Invariant #2 becomes:

> A head-block op MAY drive **provisional display**. It MUST NOT drive **money
> or reputation**.

| Entity | Fast path | Rationale |
|---|---|---|
| Chat message | Provisional display | ADR-0048. Vanishes on reorg; acceptable. |
| Feedback notification | Provisional display | v1.5.5. The *notification*, not the score. |
| Order **cancelled / completed** | Provisional display | A status transition on an order that already exists and is already fee-verified. No free text, owner-signed, and both transitions only ever REMOVE it from live views. |
| Order **posted** (`morphit_order_v1`) | **Durable only** — see below | The public orderbook gates on `fee_status IN ('verified','verified_by_attestation')`. A head-block order has no verified fee, and verification is money. |
| Order **edited** (`morphit_order_replace_v1`) | **Durable only** | Carries the order's free text; a rejected edit would flash arbitrary content into every open orderbook. |
| Profile / settings | Provisional display | Cosmetic, self-authored. |
| Payment marked sent | Provisional **"confirming"** only | `morphit_funds_sent` is a *claim*, not the money; the real proof is `txProof` on the payment chain. Never render as settled from a head block. |
| Trade counts, review scores, reputation | **Durable only** | A count that reads 5 then drops to 4 is a trust signal that lied, and trust is the product. Numbers move on irreversibility. |
| Fees, balances, treasury | **Durable only** | Money. |

The line is not "how likely is a reorg" — it is **what does a wrong answer
cost**. A chat message that flashes and vanishes is an annoyance. A reputation
score that flashes and vanishes is a lie we told about a person.

### 2a. The fee gate is the money gate — found while implementing

The matrix above says "money is durable-only", and implementing it revealed that
for orders **the fee gate IS that line**, in a way that wasn't obvious when this
ADR was drafted:

`/v1/orderbook` and its SSE twin both filter on
`fee_status IN ('verified', 'verified_by_attestation')`. An order is not public
until its fee is verified. So emitting a head-block `morphit_order_v1`
provisionally would put **unpaid orders in front of every user for ~60 seconds at
a time, repeatably** — a fee bypass with extra steps, dressed as a latency
improvement.

This is not a scope decision to revisit when there's time. It is the same line as
"trade counts are durable-only", arriving through a different door.

The consequence is a property worth stating plainly, because it is what makes
this whole path safe rather than merely careful:

> **The provisional order channel can only ever REMOVE an order from a live view,
> never add one.**

Both admitted ops (cancel, complete) take an order *out* of live views. The
stream's provisional listener is gated on `tracked.has(orderId)` — it can only
remove something it already sent that same subscriber. So the worst a bogus,
malicious, or reorged provisional event can do is make an order blink out and
reappear on the next durable pass. There is nothing to spam *with*.

And nothing is lost: the person who **posted** an order sees it instantly anyway,
client-side, via the `pendingOrders` echo. That was the actual request ("the order
i just placed"), and it costs no such hole. A *stranger* seeing a new order 60s
sooner was never worth a fee bypass — orders live for hours.

### 3. Provisional display must be legible as provisional

Anything shown from a head block is labelled ("confirming…") until its durable
twin lands. This is what makes the whole thing honest rather than a gamble:
the user gets **feedback in ~6s**, not **finality in ~6s**, and is never misled
about which one they have.

### 4. No enable/disable switch

`MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED` is **removed, not renamed**.

Because the tailer never writes the database, the worst a broken fast path can do
is fail to make things fast — the durable poller is untouched. There is nothing
to protect an operator from, and nobody prefers slow. A flag that is always true
is a branch that can be wrong, config that can drift, a second path every smoke
must cover, and (via the old `Fast chat: on` health line) an invitation for an
operator to conclude that slow is a thing they might want.

`MORPHIT_INDEXER_FASTPATH_INTERVAL_MS` survives: an operator whose node is
straining needs a way to *slow the fast path down* without losing it. That is a
real lever; an on/off switch was not.

The health line that reported the always-true boolean is replaced by the number
that actually matters: **how many blocks behind head the tailer is**. "Running"
was never the question; "is it keeping up" is. A tailer running 400 blocks behind
is broken, and the old line called that one "on".

Removal is safe for existing deployments: the env schema is a non-strict
`z.object` parsing `process.env`, so a leftover `..._ENABLED=true` is stripped
rather than rejected, and resolves to the same behaviour. (Verified, not assumed
— a strict schema would have meant an indexer that refuses to start after
upgrade.)

## Consequences

**Good.** One code path, one head scan, no dead config. Every entity gets the
~5.5s budget chat already had. The workarounds that grew around the old boundary
(`pendingFeatured`, the 24s retry) can be generalised or retired rather than
multiplied.

**Cost.** More op types parsed per head block — bounded, since we already fetch
each block. More surfaces must distinguish provisional from durable, which is
real UI complexity and the main place a bug can hide.

**The risk we are accepting.** A provisional item shown and then orphaned. The
per-entity matrix keeps that to things whose disappearance is an annoyance rather
than a lie. **The risk we are NOT accepting** is provisional data reaching money
or reputation; invariant #1 (never writes the DB) is what makes that structural
rather than a promise.

**What would invalidate this ADR.** If the tailer ever needs to write to the
database, every argument here collapses at once: a reorg could corrupt state, the
operator's off switch becomes defensible again, and this decision must be
re-opened rather than patched. `fastpath-always-on-smoke` pins that premise
directly, so the collapse cannot happen quietly.
