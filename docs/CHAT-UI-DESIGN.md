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
> (X25519 + ChaCha20-Poly1305).  Anywhere this doc still
> describes session/envelope shape, the actual on-chain
> envelope is `{ ciphertext, header: { ephemeralPub, nonce } }`
> per ADR-0015.

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
and tolerates its absence gracefully (messages from older clients
wouldn't have one; they're matched against trx_id as a fallback).

## Poll cadence

Messages are delivered by polling `/v1/chat/:a/:b` — there's no
websocket or push channel.

Since blocks are 3s, polling faster than that is pure waste. Cadence:

- **Active chat view, tab in foreground**: poll every **3s**,
  aligned to block-timestamp boundaries with ±500ms jitter to
  spread load across users
- **Active chat view, tab in background**: poll every **15s**
  (document.visibilityState === 'hidden' triggers the backoff)
- **Inbox view (not in a specific chat)**: poll the per-
  conversation-count endpoint every **10s**; this is lighter
  than per-conversation polling

Each poll uses the **latest `created_at` cursor** we've seen, so
we only fetch the delta since last poll. A fresh page load does
one full fetch of the most recent 50 messages to populate history.

**Block-align trick**: a Blurt block lands roughly on the integer
3-second second. Aligning our polls to `(Date.now() % 3000)`
boundaries with jitter maximizes the chance a freshly-mined
block's messages are in the response. Less than ideal worst case
is we miss a block and catch it on the next poll (≤3s extra
latency). Acceptable.

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

## Virtualization

A conversation of 500 messages with identicons and timestamps is
~15MB of DOM. Mobile Safari chokes at around 2000 nodes in a
scrollable container.

Threshold: **virtualize when `items.length > 50`**. Below that,
static `{#each}` is fine and avoids the flicker of virtualizer
warm-up.

Above 50, use a windowed list: render 20 messages above and below
the viewport; recycle as the user scrolls.

Any library? No need to bundle one — the pattern is small enough
to write inline:
- Track `scrollTop`, `viewportHeight`
- Maintain an estimated message height (updates as real messages
  render)
- Render only the window; spacers above/below with `height`
  equal to `(first-visible-index) * avgHeight`

## Draft persistence

If the user closes the tab mid-message, the draft should survive.

**Keyed by conversation**: `localStorage['morphit.chat.draft.<peer-account>']`.

**Lifecycle**:
- Typing anywhere in a compose box → debounced 500ms save
- Successful send → wipe the key
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
- After send: the composer retains focus but clears its value
- Sending disabled when the text is empty OR trimmed-empty
- Sending disabled while the identity is locked (show unlock hint
  where the Send button would be)
- **Private-key detector (already built)**: the composer uses
  `ProtectedTextarea` + `PrivateKeyWarningModal` exactly like
  the feedback forms. `redactPrivateKeys()` runs on the plaintext
  before it goes into the ECIES encryption step. The
  ciphertext that gets broadcast contains only the redacted form.
- 256-codepoint plaintext cap (matches the indexer's
  `MAX_CIPHERTEXT_CHARS` budget after AEAD tag + base64
  overhead). Live counter next to the input.

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
- Read receipts (contentious — skip for now; a "read" event
  taking 3+ seconds to deliver is worse than no read receipts)
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
- `apps/web/src/lib/chat/ensureChatIdentity.ts` — one-time
  publish-on-first-need flow for the chat identity key.
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
- `apps/web/src/routes/[lang]/chat/+page.svelte` — inbox with tabbed
  Messages / Requests partitioning.
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

- `/chat` — inbox: list of conversations with Messages /
  Requests tabs, unread badge, hidden + blocked filtering.
- `/chat/[peer]` — conversation view.

## Entry points still to wire

- **Main nav**: `/chat` is not yet linked from the top nav.
  Adding requires the unread-badge surface in the nav itself.
- **Profile page**: a "Message" CTA next to the IdentityLabel
  for any viewer (→ `goto('/chat/' + account)`).
- **Order rows**: a "Message seller/buyer" CTA on order detail
  rows (for non-owners) → `goto('/chat/' + order.account)`.

## Open items deferred

1. **Identity publication**: when and how the user publishes their
   chat identity key via `morphit_chat_identity_v1`. Implemented
   as auto-publish on first compose attempt, idempotent (skipped
   if a key is already on chain). See `ensureChatIdentity.ts`.
2. **Multi-device**: out of scope for v1. A single device per
   account. Multi-device requires key-server or linked-device
   flows — defer to Phase 6.
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

## What's left to ship (historical — all closed as of Part 120 audit)

The core chat infrastructure is implemented.  The remaining
wiring described below has all shipped:

1. ✅ `/chat` is in the main nav (`apps/web/src/routes/+layout.svelte:178`).
2. ✅ "Message" CTA on profile pages
   (`apps/web/src/routes/[lang]/[x+40][account=account]/+page.svelte:450`).
3. ✅ "Message seller" CTA on orderbook rows
   (`apps/web/src/routes/[lang]/orderbook/+page.svelte:956`).
4. i18n key coverage across all 10 locales is verified
   continuously by the locale-parity smoke
   (`apps/web/scripts/i18n-locale-parity-smoke.ts`).
5. End-to-end manual smokes are operator/QA work and continue
   on every release cycle.
