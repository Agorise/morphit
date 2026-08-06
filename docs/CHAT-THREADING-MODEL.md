# Morphit chat threading model — CANONICAL, DO NOT DEVIATE

> This document is the single source of truth for how Morphit threads chat
> conversations. It exists because this exact behavior was broken and re-broken
> across **three** releases (v1.4.7 → v1.4.9). Every one of the invariants below
> is protected by a tamper-tested regression guard (listed per invariant). If you
> are about to change anything in the chat send path, the chat handler, the
> conversations query, or the conversation-view routing — **read this first**,
> and do not weaken a guard to make a change "pass."

## What the operator (Ken) asked for, verbatim

1. **Keep the inbox / starred / archived model.** It is loved. Do not replace it.
2. **Some users just want to chat with each other, not bound to a specific
   order id** — and that is **a thread of its own with that user**.
3. **Some users will click the "Message @username" button on an ordercard**,
   and **that will need its own thread**.
4. Got it.

## The model in one sentence

A conversation thread is identified by the pair **`(peer, order_permlink)`**,
where `order_permlink` is either a specific order or **`null`** (no order). Both
values are legitimate; `null` is a real thread, not a bug.

## The invariants (each has a guard)

### INV-1 — The inbox/starred/archived model is preserved
One card per thread. A thread can be starred or archived. The three tabs
(Inbox / Starred / Archived) stay. Folder state is keyed on `(peer, order)` per
card.
_Guard:_ `chat-inbox-threading-smoke`, `chat-ui-v148-smoke`.

### INV-2 — A no-order chat is a first-class thread of its own
When two people chat without citing an order (e.g. the profile page
"Message @user" button), `order_permlink = null`. That null thread is a
legitimate conversation of its own with that person. It MUST NOT be merged into
an order thread, and it MUST NOT be hidden or treated as an error.
_Guard:_ `conversations.ts` groups a NULL permlink as its own group
(Postgres `GROUP BY` treats NULLs as equal) — pinned by
`chat-thread-model-smoke`; behaviorally exercised by
`test/integration/conversations.test.ts` ("the order-less thread").

### INV-3 — An order chat is its own thread, separate from null and from other orders
When someone opens a chat from an ordercard, `order_permlink = that order`, and
that thread is distinct from the null thread and from every other order's thread.
_Guard:_ `chat-thread-model-smoke` (grouping is by `(peer, order_permlink)`),
`test/integration/conversations.test.ts`.

### INV-4 — The same two people can hold multiple threads at once
One null thread PLUS one thread per order they have discussed. Each is a separate
inbox card.
_Guard:_ `test/integration/conversations.test.ts` (multiple cards, distinct
`order_permlink` per card).

### INV-5 — BOTH parties always converge on the SAME thread
This is the invariant that was broken for three releases. For any single
conversation, both people must tag their messages with the SAME
`order_permlink`, or they land in different threads and cannot see each other.
There are **TWO tag points, and they MUST agree**:

- **Client tag (send path).** Every outgoing message is tagged with
  `deps.orderPermlink`, which must match the `?order=` in the URL the user is
  viewing. `deps` is captured ONCE in `ConversationView`'s `onMount`
  (`runtimeDeps(me, peer, …, orderPermlink ?? null)`), so the conversation view
  MUST remount whenever the `(peer, order)` identity changes — otherwise `deps`
  goes stale and the send tags the wrong (or no) order.
  _Enforced by:_ `{#key \`${peer}\u0000${orderPermlink ?? ''}\`}` around the
  lazily-loaded `<ConversationView>` in
  `apps/web/src/routes/[lang]/chat/[peer=account]/+page.svelte`.
  _Guard:_ `chat-thread-remount-smoke` (tamper-tested).

- **Server tag (stored on chain → indexed).** The indexer's chat handler stores
  the message's `order_permlink` whenever the tag names a real order owned by
  **EITHER party** (the validator's `account IN (recipient, signer)`). It MUST
  NOT gate storage on `orderResponseBypass` (which is true only when the
  *recipient* owns a live order) — doing so strips the ORDER OWNER's own replies
  of their tag, splitting them into a phantom `null` "RE: -" thread the other
  party never sees. `orderResponseBypass` governs ONLY the stranger-fee gate and
  must stay that narrow.
  _Enforced by:_ `orderResponseBypass ? … : null` was replaced with
  `claimedPermlink ?? null` in `apps/indexer/src/indexer/handlers/chat.ts`.
  _Guard:_ `chat-order-tag-storage-smoke` (tamper-tested).

- **Viewer filter (receive path).** A conversation view shows only the messages
  whose `order_permlink` matches the thread it represents
  (`rec.order_permlink !== deps.orderPermlink → skip`). This is correct — it is
  what keeps the order thread and the null thread separate — and it depends
  entirely on `deps.orderPermlink` being correct (see the client tag above).
  _Guard:_ `chat-inbox-threading-smoke` (the order-filter line), plus the
  reconciliation guard in `chat-fastpath-dedup-smoke`.

- **Every delivery path must carry the tag (cp470).** The viewer filter above is
  only as good as the `order_permlink` on each message it sees. A message reaches
  the client by TWO paths — the REST history endpoint (`/v1/chat/:a/:b`) and the
  SSE stream (`/v1/chat/:a/:b/stream`, both the fast-path provisional and the
  durable push). BOTH serialize through code that MUST include `order_permlink`.
  cp470: the SSE serializer `rowToWire` (`apps/indexer/src/api/chatStreamHelpers.ts`)
  omitted it, so every live message shipped an implicit `null` tag; order-thread
  messages were filtered out on the receive path and only surfaced ~one
  main-indexer lag later via the REST fallback poll — the "fast chat is broken in
  order threads" bug. General/order-less threads hid it (their tag is genuinely
  null). The DB query + `ChatStreamRow` already carried the column; only the wire
  dropped it.
  _Guard:_ `chat-sse-order-permlink-smoke` (functional — calls `rowToWire` and
  asserts the tag survives for a real permlink AND for the null order-less case).

## The lesson, so this is never chased again

Chat threading has **two tag points — the client's `deps` and the server's
stored tag — and they must agree.** A bug in either one splits a conversation.
When any chat-threading symptom appears ("replies don't show," "a second card
appeared," "fastchat is slow"), check BOTH:

1. Is the client's `deps.orderPermlink` correct at SEND time? (URL, `{#key}`
   remount, `merge.enter depsOrder` / `send.outgoing` in the `?chatdebug=1`
   trace.)
2. Is the server storing that tag for the sender's role? (the INSERT ternary in
   the chat handler — it must keep the tag for EITHER party.)

## Guard inventory (all registered in `scripts/run-smokes.sh`, all tamper-tested)

| Invariant | Guard(s) |
|---|---|
| INV-1 | `chat-inbox-threading-smoke`, `chat-ui-v148-smoke` |
| INV-2, INV-3, INV-4 | `chat-thread-model-smoke`, `test/integration/conversations.test.ts` |
| INV-5 client tag | `chat-thread-remount-smoke` |
| INV-5 server tag | `chat-order-tag-storage-smoke` |
| INV-5 viewer filter | `chat-inbox-threading-smoke`, `chat-fastpath-dedup-smoke` |
| This document itself | `chat-thread-model-smoke` (asserts the doc exists and the model constant is documented) |

If you add a chat feature that touches threading, add its invariant here AND a
guard, in the same change. Never remove an invariant without the operator's
explicit sign-off.
