# Chat UI Design — Phase 5d

**Status:** ✅ Chat surface is fully implemented and wired
into the main nav and surfaces.  The crypto module
(`apps/web/src/lib/chat/crypto.ts`), chat service controller
(`chatService.ts`), indexer endpoints, the on-chain op
(`morphit_chat_v1`), the `/chat` nav link in `+layout.svelte`,
the "Message" CTA on profile pages, and the "Message
seller/buyer" CTA on orderbook rows have all shipped.  This
doc describes the UX constraints that shaped the chat
surfaces; the "Entry points still to wire" and "What's left
to ship" sections below are retained as historical context
but have all closed.

> **Cipher note.** Earlier drafts of this doc referenced a
> heavier forward-secrecy protocol — that was the ADR-0014
> plan.  ADR-0015 replaced it with simpler per-message ECIES
> (X25519 + ChaCha20-Poly1305); docs/CHAT-CRYPTO.md describes the
> envelopes (since v1.21.14 every message is sent in v3, to posting keys;
> the older v2, chat keys, is only read). On chain a
> message is `{ recipient, ciphertext, header, order_permlink? }`, and
> the header's fields are snake_case: `v`, `client_tag`,
> `ephemeral_pub`, `nonce`, the optional self-copy `self_ciphertext` +
> `self_nonce`, for v3 `sk`, `rk`, `wk`, and on a retry `prior_tags`
> (`wirePayload` in `chatService.ts`).
>
> **v1.21.14 note.** This doc was stale in several places (polling
> cadence, virtualization, draft key, read receipts, inbox tabs,
> multi-device, first-use publish). The sections below now describe the
> code; where the original plan differed, it says so.

## The one constraint that shapes every decision

**Blurt blocks are 3 seconds.** Chat messages are on-chain
`morphit_chat_v1` custom_json ops (ADR-0014). The chain-based
send→deliver round-trip is therefore **at least 3 seconds**, and
more realistically 3–6 seconds depending on where in the block cycle
a send lands.

A user who types "hi" and hits Enter cannot wait 3 seconds to see
their own message appear. **The UI must feel instant despite the
chain being slow.** Every architectural decision below exists to
reconcile those two facts.

## Optimistic local rendering

The user's own message is rendered in their chat pane *the instant
they hit Enter*, tagged as `'pending'`. The chain broadcast happens
in the background; the subsequent indexer poll merges the confirmed
record in and upgrades the state to `'confirmed'`.

States a local message can be in:

| State | Rendered as | How it got here |
|---|---|---|
| `pending` | Full opacity text, subtle ⏳ icon or just no time shown | Just submitted, broadcast in flight |
| `broadcast` | Same visual, internal flag only | Broadcast returned a trx_id, waiting for indexer |
| `confirmed` | Timestamp shown, icon removed | Indexer poll returned the record |
| `failed` | Red border, "Tap to retry" | Broadcast error (network, chain rejection) |

The user NEVER sees the difference between `pending` and `broadcast`
— both look identical. The split exists only so the retry path can
distinguish "I haven't even signed this yet" from "I signed it but
the chain hasn't confirmed in 15 seconds, probably a stuck node."

## Client-side deduplication: `client_tag`

The indexer's `chat_messages` table is keyed on `source_trx_id`
(unique). That's fine for server-side replay protection. But the
**client** can't use trx_id for reconciliation because at optimistic-
render time the trx_id doesn't exist yet — the op hasn't been
broadcast.

**Solution:** the client generates a random 16-byte `client_tag`
before broadcast and includes it in the **`header`** field of the
custom_json payload.

Why `header`? Because:
- The indexer already passes `header` through verbatim as opaque
  JSONB — no schema change needed
- The indexer chat-op handler doesn't validate the contents of
  `header` beyond size limits (it's the per-message ECIES
  envelope metadata — `ephemeralPub`, `nonce`, plus the
  `client_tag` — opaque to the chain)
- The client-side chat module already owns every byte of the
  payload it constructs, so adding a field is trivial

Flow:
1. User hits Enter → client generates `client_tag = randomBytes(16).hex()`
2. Client renders message in the pane with state `pending`,
   keyed locally by `client_tag`
3. Client builds payload: `{ recipient, ciphertext, header: { ...dr_header, client_tag } }`
4. Broadcast returns a trx_id. Client flips local state to `broadcast`.
5. Indexer poll (every ~3s) returns messages including the new one.
   Each returned message's `header.client_tag` is checked against
   pending/broadcast messages; on match, merge the server record
   (id, created_at) in and flip state to `confirmed`.
6. Messages received WITHOUT a matching local `client_tag` are
   new incoming messages from the counterparty.

Indexer change required: **none.** The field lives inside the
opaque `header` JSONB. The handler already accepts anything there
up to the size cap.

Shared-types change required: **none.** `header: unknown` stays
unknown; the client module reads `header.client_tag` at its own risk
and tolerates its absence gracefully. There is no trx_id fallback
(the original plan); what the code does:

- **Our own messages** reconcile by tag — the current one, or one a
  retry replaced (`priorTags`) — and only against our own records.
- **Everyone's copies** are matched by SENDER AND ENCRYPTED BYTES
  (ciphertext, ephemeral key, nonce — `wireOf`), whatever their tag: the
  fast copy and the durable one of a message are the same bytes. The tag
  is outside the encryption, so it never decides alone that two records
  are one message, nor that a re-served old message is a new one
  (v1.21.14, W-H3). Durable copies are also deduplicated by id.
- A retry from the peer is folded into the attempt it resends only when
  its declared `prior_tags` name it AND the decrypted text is identical.

## Delivery: live streams, a fallback poll

(The original plan was polling only, every 3 s / 15 s with a delta
cursor. The code differs.)

- **Open conversation**: a live stream, `/v1/chat/:a/:b/stream` (one
  `snapshot` event on connect, then `message_appended`, fast copies
  included), plus a **fallback poll** of the newest 50 messages every
  4–6 s (4 s + up to 2 s jitter), whether the tab is visible or not. The
  poll sends no cursor: the `latestSeenAt` watermark in `chatService.ts`
  is kept but unused. A poll whose answer changes nothing redraws
  nothing (v1.21.14, W-L3).
- **Everywhere, signed in**: ONE account-wide stream,
  `/v1/chat-activity/:me/stream`, whose pings name the thread (peer,
  order, inbound) — the inbox and badges update from it, with a 5 s
  inbox poll as the backstop. One per BROWSER and account, not per tab
  (v1.21.14, C-L5): one tab holds it, elected over the BroadcastChannel
  `morphit-chat-activity-v1:<account>` (heartbeat every second, takeover
  after 2.75 s of silence or at once on the holder's goodbye; no Web
  Locks, which a frozen tab holds forever and plain-http pages lack),
  and relays its events to the others; a new holder's fresh connection
  gets the indexer's replay and `ready`, relayed to every tab. Each
  takeover raises a term, so a holder frozen meanwhile yields when it
  resumes; one whose stream closes three times without `ready` lets
  another tab try. Without BroadcastChannel each tab keeps its own
  stream.
- **Cross-page trade updates** (`tradeEventListener.ts`): no stream of
  their own (v1.21.14, W-H2 — it used to hold one open per recent peer,
  which on a plain-HTTP Tor/I2P instance used up the six connections a
  browser allows per site). On an activity ping the listener reads that
  peer's conversation once (a chat stream closed at its snapshot), one
  peer at a time. So a tab holds at most three long-lived connections
  to its site, and the browser one activity stream for all of them.
- A stream closed by an HTTP error (a 502, a 429) is reopened after a
  pause that doubles from 2 s to 60 s (v1.21.14, W-L2); EventSource
  itself only retries dropped connections.

**Older history (v1.21.6).** The live paths (stream snapshot, fallback
poll) only ever carry the pair's newest 50 messages. Scrolling up past
what is loaded reads the thread further back from `/v1/chat/:a/:b`
with `order=<permlink>` (empty for the thread about no order), 100 a
page, until the first message — automatically when the thread does not
fill the screen. The PDF export reads every thread of the pair to the
first message (all or nothing). Pages read this way never run the trade
side effects (address shared, payment claimed); those run only when the
live path delivers a message, so an old claim can't overwrite a newer
one. See `loadOlder` / `loadWholeConversation` in
`apps/web/src/lib/chat/chatService.ts`.

(The planned "block-align trick" — polls aligned to 3-second block
boundaries — was never built; the jittered fallback poll above is all
there is.)

## Per-message crypto is CPU-bound

Per-message libsodium operations (X25519 ECDH, ChaCha20-Poly1305
AEAD, BLAKE2b) take 1-5ms each on modern hardware, but a chat
load of 50 messages = 50 decrypts. Even at 5ms that's 250ms of
main-thread work if done synchronously, which is enough to
freeze the scroll.

**Rules:**
- Never `await` a chat decrypt inside a Svelte `$derived`.
  The reactivity system would block on each decrypt.
- Decryption happens in a background loop (a `$effect` that
  processes pending ciphertexts one at a time, with `await` so
  the event loop breathes between each).
- **Decision deferred to implementation time**: whether decryption
  moves to a Web Worker. Probably yes for messages >10, because a
  worker lets the UI keep rendering other content (scrolling,
  typing, paging) while the history decrypts. For messages ≤10,
  main-thread with async boundaries is fine.
- Message encryption on send: always main-thread, always in the
  send path (not parallel — we need the ciphertext before
  broadcast). But it's one op, ~50ms worst case, invisible.

## Windowing (not virtualization)

The planned virtualized list (recycled rows, spacers) does not exist.
What `ConversationView.svelte` does: render only the newest 30
messages when a thread opens, reveal 40 older ones each time the
reader scrolls near the top (keeping the reader on the message they
were on), and, past everything loaded, read older pages from the
indexer (see "Older history" above). Rendered messages are never
recycled.

## Draft persistence

If the user closes the tab mid-message, the draft should survive.

**Keyed by thread** (peer + order; v1.21.14, W-L7 — it was the peer
alone, so a draft about one order reappeared in another thread with the
same person): `localStorage['morphit.draft.chat.<peer>']` for the thread
that cites no order, `localStorage['morphit.draft.chat.<peer>#<order>']`
for an order's thread.

**Lifecycle**:
- Typing anywhere in a compose box → debounced 500ms save
- Send → wipe the key at once (the words are in the bubble from then
  on, with Retry if the send fails)
- Explicit lock (user taps "Lock now") → wipe all drafts along
  with the identity (same as the existing Lock Session behavior)
- Auto-lock → **keep** drafts. Auto-lock is an idle timeout; the
  user's intent to send the message is still there. They'll
  unlock and finish typing.

This is more conservative than wiping on every lock, but it
matches user expectation. Locked-state drafts are low-sensitivity
plaintext sitting in localStorage — a lower bar than the keystore
itself, but the user chose to type it somewhere unencrypted, and
the tradeoff for convenience wins.

## Composer behaviors

- **Enter**: send
- **Shift+Enter**: newline
- **Tab**: default focus behavior (escape the textarea)
- After send: the composer clears its value and stays usable AT ONCE —
  it does not wait for the node (v1.21.14, W-M6: it used to stay
  disabled, the text still in it, through the chain-head read and the
  broadcast, seconds per message on Tor/I2P). The send continues in its
  bubble: "sending…", then delivered, or failed with Retry.
- Sending disabled when the text is empty OR trimmed-empty
- Sending disabled while the identity is locked (show unlock hint
  where the Send button would be)
- **Private-key detector (already built)**: the composer uses
  `ProtectedTextarea` + `PrivateKeyWarningModal` exactly like
  the feedback forms. `redactPrivateKeys()` runs on the plaintext
  before it goes into the ECIES encryption step. The
  ciphertext that gets broadcast contains only the redacted form.
- 256-codepoint plaintext cap (fits the indexer's
  `MAX_CIPHERTEXT_CHARS` budget after AEAD tag + base64
  overhead). Live counter next to the input. Structured messages
  (address, mailing address, shipment) are checked against the real
  budget by their forms, and every send by `chatService` before
  anything is signed (v1.21.14, W-M5).

## Mobile viewport

iOS Safari and Android Chrome both reshape the viewport when the
keyboard appears. Old behavior: the visual viewport shrinks but
CSS `100vh` doesn't.

**Rules:**
- The chat container uses `height: 100svh` (small viewport height;
  accounts for the keyboard).
- The message list is the flex-grow child; the composer is
  fixed-height at the bottom.
- Avoid `position: fixed` on the composer — it misbehaves with the
  iOS keyboard. Use the flex layout instead.
- When a new message comes in AND the user is scrolled to the
  bottom, scroll to the new message. When the user is scrolled
  up reading history, show a **"N new messages ↓"** pill that
  scrolls down on tap instead of forcing them.

## What belongs on-chain vs off-chain

**On-chain** (via `morphit_chat_v1`):
- The ciphertext + ECIES envelope header of each sent message
  (`{ ephemeralPub, nonce }`). One op per message.

**Off-chain** (local state only, never sent anywhere):
- Draft text
- Typing indicator ("Alice is typing…")
- Read state on this device (`readState.ts`): the newest message
  seen, as a chain time — never the device clock (v1.21.14, W-M3).

**Also on-chain** (contrary to the original "skip read receipts" plan):
a `morphit_chat_read_v1` read-ack, broadcast once per visit to a
thread, carrying the newest message shown (cross-device read state; not
shown to the peer).
- Presence (online/offline)

Typing indicators and presence could theoretically be done via
WebRTC data channels between peers once both are on the chat
page, but that's significant complexity for a secondary feature.
**Decision: skip for v1.** The 3-second block time makes these
features inherently laggy on-chain anyway.

## What already exists in the codebase

- `apps/web/src/lib/chat/crypto.ts` — full ECIES implementation
  per ADR-0015. Exports `deriveChatIdentity`,
  `encryptToRecipient`, `decryptFromSender`, plus encode/decode
  helpers and a `wipeChatIdentity` zeroing utility. 22 vitest
  scenarios cover the round-trip + AAD binding + tamper
  detection.
- `apps/web/src/lib/chat/chatService.ts` — full state-machine
  controller. Owns the optimistic-render flow, polling cadence,
  client_tag reconciliation, decrypt-on-read pipeline, retry
  ladder. Wired to the real crypto.
- (`ensureChatIdentity.ts`, which published the chat key, was removed in
  v1.21.14: chat relies on the posting key only and nothing publishes a
  chat identity.)
- `apps/web/src/lib/chat/pubPin.ts` — TOFU pinning of the
  peer's chat pubkey + chain re-verification on mismatch.
- `apps/web/src/lib/chat/blocks.ts` — chain-block management.
- `apps/web/src/lib/chat/readState.ts` — local + on-chain
  read-state tracking.
- `apps/web/src/lib/chat/recentPeers.ts` — fallback peer list
  when the indexer hasn't yet seen any conversations.
- `apps/web/src/lib/components/ConversationView.svelte` —
  per-conversation chat UI. Implements the scroll-to-bottom UX
  in this doc, the block/unblock affordance, and the stranger-
  fee admission flow.
- `apps/web/src/routes/[lang]/chat/+page.svelte` — inbox, one card
  per thread (peer + order), with Inbox / Starred / Archived tabs.
- `apps/web/src/routes/[lang]/chat/[peer=account]/+page.svelte` —
  per-conversation route.
- `apps/indexer/src/api/chat.ts` — `/v1/chat/:a/:b` endpoint
  with cursor pagination. Canonicalizes the pair so
  `/chat/alice/bob` and `/chat/bob/alice` hit the same
  conversation.
- `apps/indexer/src/indexer/handlers/chat.ts` —
  `morphit_chat_v1` op handler.
- `apps/indexer/src/indexer/handlers/chatIdentity.ts` —
  `morphit_chat_identity_v1` op handler.
- `apps/indexer/src/indexer/handlers/chatRead.ts` —
  `morphit_chat_read_v1` op handler.
- `packages/indexer-client/src/index.ts` — `ChatMessageRecord`,
  `ChatHistoryResponse`, `ConversationSummary` shared types.

## Routes (implemented)

- `/chat` — inbox: one card per thread, Inbox / Starred / Archived
  tabs, unread badge, hidden + blocked filtering.
- `/chat/[peer]` — conversation view.

## Entry points still to wire

- **Main nav**: `/chat` is not yet linked from the top nav.
  Adding requires the unread-badge surface in the nav itself.
- **Profile page**: a "Message" CTA next to the IdentityLabel
  for any viewer (→ `goto('/chat/' + account)`).
- **Order rows**: a "Message seller/buyer" CTA on order detail
  rows (for non-owners) → `goto('/chat/' + order.account)`.

## Open items deferred

1. **Identity publication**: none. Every message goes to the
   recipient's posting keys (v1.21.14); nothing is published to become
   reachable, or re-published.
2. **Multi-device**: supported (docs/CHAT-CRYPTO.md). Every device
   signed in with a posting key of the account opens posting-key (v3)
   messages and its own self-copies; older chat-key (v2) messages open
   on the devices whose posting key derives the chat key they were
   written to.
3. **Message deletion**: chain entries are permanent. A client-
   side "hide" is possible (local blocklist of trx_ids) but
   confusing UX — probably skip for v1.
4. **Conversation deletion**: same — chain entries are permanent.
   Client-side hide only.
5. **Block/unblock a user**: lands via the chain block op. See
   "Block/unblock — landed" below.

## Block/unblock — landed

Block/unblock rides on `morphit_block_v1` (chain-broadcast).
The chain block prevents the blocked sender's new messages
from being delivered to the blocker by the indexer's
admission gate (Finding H layer 1).  Hidden-accounts is the
local-only equivalent (see ADR-0013 Q1.4) and applies on
orderbook surfaces; chat surfaces honor BOTH stores
(§F.22 ensured the same on orderbook for symmetry).

## What's left to ship (historical — all closed audit)

The core chat infrastructure is implemented.  The remaining
wiring described below has all shipped:

1. ✅ `/chat` is in the main nav (`apps/web/src/routes/+layout.svelte`).
2. ✅ "Message" CTA on profile pages
   (`apps/web/src/routes/[lang]/[x+40][account=account]/+page.svelte`).
3. ✅ "Message seller" CTA on orderbook rows
   (`apps/web/src/routes/[lang]/orderbook/+page.svelte`).
4. i18n key coverage across all 10 locales is verified
   continuously by the locale-parity smoke
   (`apps/web/scripts/i18n-locale-parity-smoke.ts`).
5. End-to-end manual smokes are operator/QA work and continue
   on every release cycle.
