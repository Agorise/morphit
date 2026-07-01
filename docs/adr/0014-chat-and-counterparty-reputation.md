# ADR-0014 — Chat and counterparty reputation

**Status:** Partially superseded. The cipher and key-exchange
decision (Component A below) was REPLACED by ADR-0015 — see
"Cipher decision superseded" call-out below.  Component B
(message transport via on-chain `morphit_chat_v1` ops) and the
chat-reputation framing in Component C remain in effect.
**Date:** 2026-04-19 (updated 2026-04-23 with ADR-0015 cross-ref)
**Deciders:** project maintainer
**Superseded by:** ADR-0015 (cipher + key derivation only)
**Related:** ADR-0010 (key custody), ADR-0009 (order posting),
ADR-0011 (dynamic fee model), ADR-0001 (custom_json replacement)

> **Cipher decision superseded.** ADR-0014 originally proposed
> a forward-secrecy protocol using a heavy WASM library.
> ADR-0015 (2026-04-23) reviewed that decision and chose
> simpler per-message ECIES instead: X25519 ECDH for key
> agreement + ChaCha20-Poly1305-IETF for the AEAD, with
> message keys derived per-message via BLAKE2b.  Rationale:
> the project's threat model didn't actually require forward
> secrecy or post-compromise security (a posting-key
> compromise already ends the account's security story), and
> the WASM library's ~2MB bundle weight was a real cost
> against the "fast first paint" requirement.  The
> implementation lives in `apps/web/src/lib/chat/crypto.ts`.
> Read ADR-0015 for the full derivation, security
> properties, and the four requirements that drove the
> choice.
>
> Everything below this call-out predates ADR-0015 and is kept
> for historical context.  All references to specific
> forward-secrecy protocols are obsolete — the implementation
> uses the ADR-0015 ECIES design.

## Context

Current state: counterparties in a trade communicate via an
in-memory chat in the Morphit frontend, routed through a
websocket bridge. This has three serious problems:

1. **No persistence.** If a user reloads the page, chat
   history is lost. Users report this as a major friction
   point ("I lost my counterparty's bank details because I
   refreshed").
2. **No authenticity.** The websocket bridge is operator-
   run. A compromised operator could impersonate either
   counterparty or man-in-the-middle the conversation. We
   don't rely on this for anything critical (addresses should
   be shared out-of-band), but the attack surface is real.
3. **No reputation carry-over.** A counterparty who has had
   many successful trades has feedback on-chain, but their
   chat style and responsiveness — real trust signals — don't
   inform future interactions.

Phase 5 proposes to fix all three with an on-chain message
protocol: ciphertexts stored as `custom_json` ops, keys
derived from Blurt keys, rendering via authenticated
encryption with key derivation per-message (see ADR-0015 for
the resolved cipher choice).

### Constraints from Morphit principles

- **No custody of plaintext messages.** Messages must be
  end-to-end encrypted between counterparties. No operator,
  not even Agorise, should be able to read them.
- **Forward secrecy.** Compromise of long-term keys (a user's
  posting key, say) must not reveal past messages.
- **Post-compromise security.** After a compromise event, future
  messages should recover to being private once keys rotate.
- **Counterparty verifiability.** Each message must be
  provably from the account it claims (via signature), so a
  malicious operator can't inject messages.
- **Non-custody stays non-custody.** Chat must be signed with
  the user's own keys, not a Morphit-held key.
- **No dispute resolution via chat.** Per PHASE-5-BACKLOG:
  Morphit does not arbitrate disputes. Chat is a
  communication tool; it is not evidence in a Morphit-run
  dispute process, because there is no Morphit-run dispute
  process.

### Technical state of play

- Each Morphit account has a Blurt posting key and active key.
  Posting keys are used on every Morphit op; active keys for
  transfers only. Both are long-term; neither is suitable
  for ephemeral chat session keys.
- `custom_json` ops are the transport for all Morphit activity.
  The chain enforces signature validity per op; our indexer
  enforces payload shape.
- An order has a permlink. This is a natural "channel
  identifier" — two users are in a chat scoped to an order.

## Decision

**Component A — Cipher and key exchange.**

**SUPERSEDED by ADR-0015.** The original ADR-0014 proposal
named a heavy WASM forward-secrecy library; ADR-0015
replaced this with per-message ECIES (X25519 ECDH +
ChaCha20-Poly1305-IETF, keys derived per-message via
BLAKE2b).  Read ADR-0015 for the chosen design.  The
implementation lives in `apps/web/src/lib/chat/crypto.ts`.

**Component B — Message transport.**

Encrypted messages flow as `morphit_chat_v1` custom_json
ops on the Blurt chain. The op payload contains:

- `order_permlink`: the order this chat is scoped to
- `recipient`: the counterparty account name
- `ciphertext`: base64-encoded encrypted message body
- `header`: a JSONB object carrying envelope fields the
  indexer / frontend may need to read without decrypting
  the body — including the ephemeral pubkey for the
  per-message ECDH (the part of the message not encrypted
  under the derived message key) and a `client_tag` for
  client-side replay deduplication.  Indexer treats the
  header as opaque JSONB (size-bounded), narrowing only
  defensively at read sites.

The indexer records these ops into a `chat_messages` table
indexed by `(order_permlink, recipient, block_num)`. Ciphertext
is stored; plaintext never lands in the indexer.

**UNDECIDED 1:** Per-account chat identity keys — how are
they generated, stored, rotated? See Open Q1.
**RESOLVED 2026-04-23 by ADR-0015:** derive from posting key
via HKDF-SHA256; no separate chat identity published.

**UNDECIDED 2:** On-chain vs. hybrid storage. See Open Q2.

**UNDECIDED 3:** Replay / relay logic. See Open Q3.
**RESOLVED 2026-04-23 by ADR-0015:** source_trx_id unique
constraint handles replay; no extra client state needed.

**Component C — Reputation integration (SEPARABLE).**

After a trade completes (feedback signed by both parties), the
following signals become available for display in the UI:

- Number of chat messages exchanged before trade close
- Response time statistics (first response, average turn-
  around)
- Whether the chat hit a lull > N hours before trade close
  (often an indicator of trouble)

Reputation signals are DISPLAYED in the UI (on an order-
detail page and a counterparty profile page) and optionally
included in the chain-visible feedback op as additional
context. Display-only use is cheap; chain-included signals
require an additive extension to `morphit_feedback_v1`.

**UNDECIDED 4:** Reputation chain-inclusion depth. See Open Q4.

**What Morphit does NOT provide:**

- Arbitration. Chat is communication, not evidence for a
  Morphit-run dispute process.
- Automated moderation. No content scanning, no auto-summarization,
  no auto-flagging. End-to-end encryption means even the operator
  can't read the messages.
- Analytics. No aggregated "average response time across
  all trades" metrics visible to anyone but the participants.
- Chat across multiple orders. Each chat is scoped to one
  order's permlink. Counterparties who trade repeatedly
  establish new chat sessions per order.

## Alternatives considered

- **Keep in-memory chat.** The current state. Rejected
  because the friction and security concerns above are
  real and increasing as user count grows.

- **Hosted chat server (Matrix, XMPP).** Morphit runs a
  Matrix homeserver; users authenticate via their Blurt
  keys. Rejected because it imports operational complexity
  (running a mature chat service), creates a single
  point-of-failure outside Morphit's control, and
  centralizes a component that the current architecture
  keeps distributed.

- **Roll our own crypto.** Write a forward-secrecy
  protocol from scratch for better library ergonomics and
  smaller bundle size. Rejected because rolling
  cryptographic protocols is how bugs land in production.
  Audited libraries are the only safe option for this layer.
  Note: ADR-0015 ultimately landed on a much simpler
  per-message ECIES design, which avoids both this
  alternative AND the heavy WASM library that the
  superseded Component A originally proposed.

- **Use Blurt's "private message" custom_json convention
  (if one exists).** Checked: it doesn't. No Blurt app uses
  a standard encrypted-messaging format we could adopt.

- **Peer-to-peer chat (libp2p, nostr).** Users' browsers
  establish direct connections and skip the Blurt chain
  entirely. Rejected because (a) browsers can't NAT-punch
  reliably; (b) users typically aren't online simultaneously
  during a trade window; (c) we'd lose the audit property
  that every message is chain-addressable.

## Consequences

### Positive

- End-to-end encrypted chat: operators can't read messages.
  Morphit can't read messages. Only the counterparties can.
- Cryptographically-authenticated senders: a hostile
  operator cannot impersonate a counterparty. (Protection
  that the current websocket-based chat lacks entirely.)
- Persistence: chat history survives page reloads and
  device swaps (if key material is preserved).
- Reputation signals from chat data: in-UI display makes
  response time and engagement visible to prospective
  counterparties.
- Defensible as privacy-preserving: a subpoena request
  for "the chat between alice and bob about order
  sell-btc-usd-xxxx" returns only ciphertexts; the
  operator can't decrypt them.

### Negative

- On-chain storage bloat. Every message is a Blurt op,
  and the chain grows forever. For chatty counterparties
  this could add up. (Quantify in Q2.)
- Blurt op throughput is finite. Can the chain support a
  trade that sends 50 messages in a minute? Probably yes
  (Blurt's fee_status allows many ops), but worth testing.
- Keystone for Blurt-network-dependent: if Blurt goes
  down or forks disruptively, chat goes down.
- Implementation complexity: cipher port, session
  management, key rotation, replay protection, message
  ordering. This is the largest feature in Phase 5.
- Key-loss consequences. If a user loses their chat
  identity key, all past chats on that account are
  permanently unreadable. Must be communicated clearly.

### Follow-up work

- Sub-ADR: chat identity-key management (Open Q1 is
  big enough to deserve its own ADR — RESOLVED by
  ADR-0015).
- Sub-ADR: message storage model (Open Q2 is the other
  big decision).
- `morphit_chat_v1` payload spec.
- Indexer handler for the new op.
- Frontend chat UI replacement.
- Key backup flow for users (posting key backup already
  exists; chat keys are new material).
- 10-locale copy for chat error states, key-loss warnings,
  "older messages may be unreadable" prompts.

## Open questions

**Q1 — Per-account chat identity keys.** Each account needs
a long-term keypair to seed encrypted-chat sessions. Two
options:

- **Derive from posting key.** A deterministic derivation
  (HKDF, domain-separated) gives every account a chat key
  without new user action. Pros: no new key material to
  lose. Cons: posting-key compromise compromises past chats;
  derivation exposes the chat key's address space to
  anyone who knows the posting pubkey.

- **Publish a chat identity as a custom_json.** User
  generates an ephemeral long-term chat keypair, publishes
  the pubkey via `morphit_chat_identity_v1`. Pros: chat
  compromise doesn't follow from posting-key compromise.
  Cons: new key material to lose; UI complexity around
  "publish your chat identity" (users who don't publish
  can't chat); key rotation needs a separate op.

- **Per-session ephemeral keys via dlog-signed handshake.**
  No persistent chat identity; each order's chat starts
  with a fresh handshake signed by posting keys. Pros:
  minimal additional infrastructure. Cons: handshake is
  a full round-trip (two messages) before content flows,
  costing latency and an extra on-chain op.

Leaning toward option 2 (published long-term chat identity)
but this deserves its own sub-ADR.

**Q2 — Storage model.** Three options, each with real
tradeoffs:

- **On-chain only.** Every message is a Blurt op. Storage
  is forever; retrieval is chain-scan. Works if message
  volume stays modest (~100 msgs/order avg). But a
  counterparty pair who trades actively for years could
  accumulate thousands of on-chain messages, contributing
  meaningfully to chain size. Blurt community reaction to
  this depends on scale.

- **Off-chain + on-chain integrity hash.** Ciphertext is
  stored on operator-run servers; a commitment hash goes
  on-chain. Retrieval is from any operator; integrity
  checked against on-chain hash. Pros: minimal chain load.
  Cons: operator-liveness-dependent for retrieval; new
  infrastructure to run.

- **Hybrid: recent on-chain, historic on cold storage.**
  Last N days on-chain (fast, always available), older
  messages archived to operator storage with on-chain
  pointers. Pros: best of both. Cons: implementation
  complexity, chat UX shows "archived — loading" delays.

Leaning toward on-chain-only for Phase 5 MVP, with explicit
plan to revisit if chain-load becomes problematic.

**Q3 — Replay protection.** Blurt ops are eventually-final;
an op submitted twice should be idempotent at the chat
layer. How do we detect replays?

- Per-message counter: each message embeds a counter
  derivable from session state. Replays are detected
  because the counter doesn't match current state.
- Timestamp window: reject messages with timestamps > N
  seconds in the past. Simple but crude.

**RESOLVED 2026-04-23 by ADR-0015.** ADR-0015's per-message
ECIES design uses the chain transaction id as a natural
nonce; replay detection is handled at the indexer layer by
the `(trx_id, op_index)` uniqueness already enforced by
Blurt + the indexer's own dedup on `source_trx_id`.

**Q4 — Reputation chain-inclusion.** The display-only
reputation signals (Component C) are cheap. If we want any
of them to be chain-visible (i.e., included in the
`morphit_feedback_v1` payload or a new companion op),
which should it be?

- Nothing: keep all reputation display-only based on
  client-side counting of on-chain messages.
- Message count: an integer field in feedback.
- Response time: aggregated metric in feedback.
- Boolean "was responsive": user-judged, bool in feedback.

The question is whether cross-client consistency matters
(i.e., does Alice see the same stats as Bob does?). If yes,
chain-include. If clients can compute independently from the
same on-chain data, don't chain-include.

Leaning toward nothing in chain — let clients compute from
ciphertext-counts (knowable without decryption) and the
feedback op itself.

## References

- PHASE-5-BACKLOG.md item 6
- ADR-0010 — key custody (constrains identity-key handling)
- ADR-0001 — custom_json replacement (transport foundation)
- ADR-0015 — chat crypto (resolved Component A)
- X3DH Key Agreement: https://signal.org/docs/specifications/x3dh/
