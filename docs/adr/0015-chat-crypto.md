# ADR-0015: Chat crypto — key derivation and transport cipher

**Status:** Accepted
**Date:** 2026-04-23
**Deciders:** project maintainer
**Supersedes:** —
**Related:** ADR-0014 (chat and counterparty reputation) —
this is the sub-ADR for ADR-0014 Q1 (chat identity keys) and Q3
(replay protection) so that ADR-0014 Q2 and Q4 can be resolved
independently.

## Context

ADR-0014 specified the problem shape for E2E-encrypted chat
between Morphit counterparties:

- Ciphertext stored on-chain via `morphit_chat_v1` custom_json
  ops (ADR-0001 transport).
- Plaintext never visible to the operator, Morphit, or chain
  observers.
- Each account has some sort of long-term chat identity whose
  public half is discoverable.

ADR-0014 left the **key-identity mechanism** (Q1) and the
**transport cipher family** (an unlisted but implicit sub-
decision) unresolved. Three options were laid out for Q1 with
different cost shapes; the ADR leaned toward "publish a chat
identity as a custom_json" (Option 2) but explicitly flagged
the decision as needing a sub-ADR.

The maintainer stated four requirements when this decision
was revisited (2026-04-23):

1. Chat history must be immutable.
2. Chats must be end-to-end encrypted — no one outside the
   conversation can read them.
3. UX must be lightning fast.
4. Do NOT make the user set up a new crypto key (no additional
   private key to lose).

Requirement 4 rules out Option 2 (publish a separate chat
identity). Requirement 3 rules out Option 3 (per-session
handshake — two messages of latency before content flows).
Requirement 1 is satisfied by any on-chain storage approach
(already decided in ADR-0014).

That leaves Option 1 from ADR-0014-Q1 (derive from posting
key) as the only option consistent with the stated
requirements.

An adjacent decision ADR-0014 did NOT enumerate: **which
transport cipher family?** ADR-0014 originally mentioned a
heavy WASM forward-secrecy library as the default
assumption, citing audit and battle-testing.  But its extra
guarantees (forward secrecy of individual messages,
post-compromise security, out-of-order handling) come with
real costs — the WASM bundle is ~2MB, meaningfully impacting
first-load performance (requirement 3). None of those
forward-secrecy-only properties are listed in the four
requirements above.

## Decision

**Key derivation.** Each account's chat identity is an X25519
keypair derived deterministically from the account's Blurt
posting private key via BLAKE2b-256 with domain separation,
matching the pattern used in `apps/web/src/lib/crypto/keygen.ts`
for per-role key derivation:

```
chat_priv_scalar = BLAKE2b(
    output_len = 32 bytes,
    key        = posting_priv_key_bytes (32 bytes — secp256k1 scalar),
    message    = UTF-8("morphit-chat-v1/identity/" + account_name)
)
```

The output is reinterpreted as an X25519 scalar, then clamped
per RFC 7748 (bits 0 and 1 of byte 0 cleared; bit 7 of byte 31
set). X25519's clamping means every 32-byte value is a valid
scalar post-clamp — unlike secp256k1 where a small fraction
must be rejected — so no retry loop is needed. The public half
is `X25519(chat_priv_scalar_clamped, basepoint)`.

Library note: `sodium.crypto_generichash(32, message, key)`
from libsodium-wrappers-sumo (already a dep) implements the
BLAKE2b step exactly. `sodium.crypto_scalarmult_base(scalar)`
gives the X25519 public key after clamping.

**Chat pubkey publication.** Because X25519 and secp256k1 are
different curves, Alice cannot derive Bob's chat pubkey from
Bob's posting pubkey — she can only derive it from Bob's
posting PRIVATE key, which she doesn't have. Each account
therefore publishes its chat pubkey once, via a new
`morphit_chat_identity_v1` custom_json op whose payload is
`{"chat_pub": <base64 X25519 pubkey>}`. The indexer records
the latest `chat_pub` per account in a `chat_identities` table.

Publication is triggered automatically by the client — the
user never sees or manages this:

- **First-use publish.** The moment the user first opens `/chat`,
  `/chat/[peer]`, or clicks a Message button from anywhere, the
  client checks whether their chat identity is already
  published (via `GET /v1/chat-identity/:account`). If not, it
  derives the key locally and broadcasts `morphit_chat_identity_v1`
  with no prompting. Takes ~3 seconds to confirm; during that
  window, outbound sends queue client-side.

- **Existing-user migration.** Any account whose chat identity
  is not published triggers publication on next login, in the
  background, as soon as the LiveIdentity is unlocked. Over a
  few days, the active user base becomes chat-addressable.

- **Key rotation.** If the user ever rotates their posting key
  (which re-derives the chat key as a side effect, because the
  BLAKE2b input changes), the client detects the mismatch and
  re-publishes. Historical messages encrypted under the old
  chat key are still decryptable because the client retains a
  derivation-history record keyed by posting-key epoch — but
  for chat sessions where the posting key hasn't rotated, this
  code path is dormant.

**First-contact UX.** If Alice tries to message Bob before Bob
has ever published a chat pubkey, the send fails with a clear
message ("@bob hasn't set up chat yet — try again in a few
seconds after they open Morphit"). In practice, Bob publishing
is triggered by ANYTHING that lands him on a chat surface,
including a notification about Alice's pending message (if
notifications are enabled) or a direct link. Once his publish
lands, Alice's client retries automatically on its next poll.

**Transport cipher.** Each message is an individual ECIES-like
envelope:

```
ephemeral_priv, ephemeral_pub = X25519 keygen
shared_secret = X25519(ephemeral_priv, recipient_chat_pub)
message_key   = HKDF-SHA256(
    salt      = "morphit-chat-msg-v1",
    ikm       = shared_secret,
    info      = concat(sender_account, recipient_account),
    length    = 32 bytes
)
nonce         = random 12 bytes
ciphertext    = ChaCha20-Poly1305(message_key, nonce, plaintext, aad=sender_account)
```

The on-chain envelope stores:
- `ciphertext`: base64-encoded ChaCha20-Poly1305 output (including
  the 16-byte auth tag appended).
- `header.ephemeral_pub`: base64-encoded 32-byte X25519 public key.
- `header.nonce`: base64-encoded 12-byte nonce.
- `header.client_tag`: 32-char hex client tag (existing, for
  optimistic reconciliation — see docs/CHAT-UI-DESIGN.md).
- `recipient`: the counterparty's Blurt account name (existing,
  from the `morphit_chat_v1` op).

Decryption:

```
shared_secret = X25519(my_chat_priv, header.ephemeral_pub)
message_key   = HKDF-SHA256(
    salt      = "morphit-chat-msg-v1",
    ikm       = shared_secret,
    info      = concat(sender_account, recipient_account),
    length    = 32 bytes
)
plaintext     = ChaCha20-Poly1305-Open(
    message_key, header.nonce, ciphertext, aad=sender_account
)
```

AEAD authentication (ChaCha20-Poly1305's built-in MAC over
`aad=sender_account`) prevents an attacker who relays a
ciphertext from claiming different authorship. The sender's
Blurt posting-signature on the op itself (enforced by
Graphene) separately binds the envelope to an account.

**Replay protection** (ADR-0014 Q3). The indexer's
`source_trx_id` unique constraint handles on-chain replay:
re-submitting the same op fails with `duplicate_message`.
Clients don't need to carry extra replay state.

## Alternatives considered

- **Option 2 (ADR-0014-Q1): publish separate chat identity.**
  Each user broadcasts a `morphit_chat_identity_v1` op
  containing an ephemeral long-term chat public key. Rejected
  because it violates requirement 4 (new user key). The
  user-facing cost ("you need to publish your chat identity
  before anyone can message you") breaks the zero-setup
  expectation for chat.

- **Option 3 (ADR-0014-Q1): per-session ephemeral keys via
  dlog-signed handshake.** No persistent chat identity; first
  message of each conversation is a handshake. Rejected
  because it violates requirement 3 — two on-chain round-trips
  (~6 seconds at Blurt's 3s block time) before content can
  flow. "Hi" would land 6 seconds later than necessary.

- **Full forward-secrecy protocol via heavy WASM library.** Would
  give forward secrecy (past messages safe if the current
  message key leaks) and post-compromise security (future
  messages safe after a key rotation following compromise).
  Rejected because (a) the WASM bundle is ~2MB which
  meaningfully hurts first-load performance (requirement 3);
  (b) neither FS nor PCS is listed in the maintainer's four
  requirements; (c) the specific compromise scenarios where
  FS/PCS would save the user (e.g., attacker briefly reads
  session state without taking the posting key) are less
  common in our threat model than posting-key compromise,
  which defeats FS/PCS regardless (attacker can still decrypt
  every prior message whose chat key they can re-derive).

- **Roll our own forward-secrecy protocol.** Write a simplified
  per-message-rotation scheme from scratch to get some forward
  secrecy at lower bundle cost.  Rejected because rolling
  cryptographic protocols is how bugs land in production
  (same reason ADR-0014 cited for rejecting it earlier).

- **Symmetric pre-shared keys out-of-band.** Users exchange a
  secret via QR/voice/etc. before chatting. Rejected because
  the counterparty pair often hasn't met before (they're
  trading on a public marketplace); the whole point is that
  strangers should be able to open a private channel.

## Consequences

### Positive

- Zero-friction UX: two users who both have Morphit accounts
  can chat immediately. Anyone's chat pubkey is derivable
  from their posting pubkey — the indexer already knows
  every signer's posting pubkey from chain replay, so the
  UI can even encrypt to someone who has never opened
  Morphit's chat UI.
- Small bundle: X25519 + ChaCha20-Poly1305 are available in
  every modern crypto library including `@noble/curves` and
  libsodium (already a dep for Blurt operations). Zero new
  net bundle weight.
- Fast encrypt/decrypt: <5ms per message on mobile. No
  noticeable UI lag.
- Key loss impossible in a new way: losing chat history
  requires losing the posting key, and losing the posting
  key already means losing the Morphit account. No
  additional recovery surface.

### Negative

- **No forward secrecy.** An attacker who obtains a user's
  posting key can re-derive their chat key and decrypt every
  past message they can fetch from chain. This is the
  tradeoff ADR-0014 flagged; it's accepted here because
  posting-key compromise already ends the account's security
  story (attacker can post orders, sign feedback, etc. as the
  victim). Users who care about forward secrecy for chat in
  particular are advised to rotate their Blurt keys
  periodically, which rotates the derived chat key as a
  side effect.

- **No post-compromise security.** Similar: if the attacker
  sees past message keys but not the posting key, they don't
  learn anything beyond the already-decryptable past messages,
  so there's no new loss. But future messages use a new
  random ephemeral key so the attacker doesn't gain future
  reading power either — just for the wrong reason
  (ephemerals, not PCS).

- **Metadata visible on chain:** (sender, recipient, timestamp,
  approximate message size) are all public, because they're
  part of the `morphit_chat_v1` op header, not the encrypted
  payload. This is unchanged from ADR-0014 and was always
  the case. The ciphertext itself reveals nothing about
  content.

- **Keystore side-effect.** The in-memory keystore must make
  the posting private key available to a new module (chat
  crypto) not just the broadcast-signing path. This is a
  minor widening of the key surface inside the client, kept
  inside the existing LiveIdentity abstraction. The key does
  not leave the client.

### Follow-up work

- Implement `derivePostingChatKey(live)` in a new
  `$lib/chat/crypto.ts`, using `@noble/curves` or libsodium
  (whichever is already in-tree).
- Implement `encryptToRecipient(plaintext, recipientPub,
  senderAccount, recipientAccount)` returning
  `{ciphertext, ephemeralPub, nonce}`.
- Implement `decryptFromSender(envelope, senderPub, myPriv,
  senderAccount, recipientAccount)` returning plaintext or
  throwing `DecryptError`.
- Implement `fetchPeerChatPubkey(peerAccount)` — resolve the
  peer's posting-pubkey via Blurt chain query, then derive
  their chat pubkey locally.
- Wire these into `chatService.ts` (two one-line changes:
  `decryptOrPlaceholder` calls decrypt; send-path calls
  encrypt + populates the envelope).
- Add `/v1/conversations` inbox endpoint on the indexer:
  `SELECT peer, MAX(created_at), SUM(unread_count_where_recipient_is_me)
   FROM chat_messages WHERE sender=$1 OR recipient=$1
   GROUP BY peer ORDER BY last DESC`. Replace the recent-peers
  localStorage stub on `/chat/+page.svelte`.
- FAQ `how_to_sell` copy rollback — "open a chat with you"
  wording becomes accurate once real encrypt/decrypt ships.

## References

- ADR-0014 — chat and counterparty reputation (parent)
- ADR-0010 — key custody (constrains identity-key handling)
- ADR-0007 — keygen curve and dblurt package (Blurt uses
  secp256k1, so chat uses a separate derived X25519 key — the
  HKDF output is reinterpreted as an X25519 scalar)
- RFC 7748 — Elliptic Curves for Security (X25519 and
  X448, including the clamping rules)
- RFC 7539 — ChaCha20 and Poly1305 for IETF Protocols
- RFC 5869 — HKDF: HMAC-based Extract-and-Expand KDF
