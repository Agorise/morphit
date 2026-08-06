# Morphit chat crypto — design notes

This document records what Morphit chat does cryptographically,
what it deliberately does not do, and the reasoning behind both
sets of choices.  It exists so that:

- Operators and security researchers reading the code know
  exactly what guarantees we claim and which we don't.
- The next person editing `apps/web/src/lib/chat/crypto.ts`
  knows the design constraints before changing anything.
- Comparisons with other secure-messaging apps can be made
  honestly.

If you only want the user-facing version, see the FAQ entry
"Does Morphit chat have forward secrecy?" — that one is
written for non-experts.  This one is for people who are
going to read the source.

---

## The scheme in one paragraph

Each Blurt account has a long-term X25519 chat-identity
keypair derived deterministically from the posting private key
via BLAKE2b-256 (`morphit-chat-v1/identity/<account>`
domain-separated label).  The public half is published on chain
in a `morphit_chat_identity_v1` op.  To send a message, the
sender generates a fresh X25519 ephemeral keypair, computes
the shared secret with the recipient's long-term pub via
scalarmult, derives a per-message symmetric key by domain-
separated BLAKE2b, generates a random 96-bit nonce, and
encrypts under ChaCha20-Poly1305-IETF.  AAD binds (sender,
recipient) accounts.  All primitives from libsodium-sumo.

Code: `apps/web/src/lib/chat/crypto.ts` (~400 lines including
comments).  The on-wire envelope (`ChatEnvelopeWire`) carries
the ephemeral public, the nonce, and the AEAD output (with
its appended 16-byte Poly1305 tag).

---

## What we claim

1. **Confidentiality.**  Without the recipient's long-term
   chat-priv, the ciphertext is opaque.  Standard X25519 +
   ChaCha20-Poly1305 assumptions.

2. **Ciphertext integrity.**  The AEAD's MAC catches tampering
   by anyone in the relay path.

3. **Sender / recipient binding.**  AAD is
   `morphit-chat-aad-v1/<sender>\0<recipient>`, so a relay-
   attacker cannot redirect a ciphertext to a different
   recipient (auth check fails) or re-attribute it to a
   different sender (also fails).

4. **One-sided forward secrecy on the SENDER side.**  Sender's
   ephemeral private is generated, used once, and wiped
   (`sodium.memzero`) before the function returns.  If the
   sender's posting key leaks later, the attacker cannot
   recover ephemerals from messages already broadcast; those
   ciphertexts are not decryptable from posting key alone.
   *Caveat:* this assumes JS engine actually clears the buffer.
   We can't guarantee no copies exist in deoptimization slots,
   GC nurseries, or paged memory.  Best effort.

5. **Domain-separated key derivation.**  Different purposes
   (identity vs message key vs AAD) use different label
   strings.  No collision between contexts.

---

## What we don't claim

1. **Receiver-side forward secrecy.**  The recipient's long-
   term chat-priv is the same forever, until the underlying
   Blurt posting key is rotated.  Compromise of the chat-priv
   reveals every past ciphertext to the recipient that the
   attacker can fetch from chain.  Per-message-rotation
   protocols protect against this; we don't.

2. **Post-compromise security (a.k.a. "self-healing").**  If
   the attacker has your chat-priv, they decrypt all past
   *and* future messages until you rotate keys.  No automatic
   recovery.

3. **Metadata privacy.**  Sender, recipient, and timestamp
   are op header fields, public on chain.  An observer of the
   chain learns who is talking to whom and when.  We don't
   claim to hide this; metadata privacy on a public ledger is
   a different problem we're not solving.

4. **Replay protection beyond what AEAD gives you.**  AAD-
   binding plus per-message random nonce means a relayed
   ciphertext can't be retargeted, but a bit-for-bit replay
   of the same message authentication-passes (because it's
   the same plaintext under the same nonce/key).  In the
   on-chain context this is not a meaningful attack — replays
   are de-duplicated by op id at the indexer layer — but it's
   worth being explicit.

5. **Deniability.**  We do not employ any deniability
   construction.  A sender's signature on the broadcast op
   binds them to the ciphertext indelibly.

---

## Why we made this choice

The honest answer is that we evaluated heavier
forward-secrecy protocols seriously, and decided the costs
outweighed the benefit *for this specific use case*.  Five
reasons, in descending order of importance:

### 1. Stateless decryption fits chain-anchored chat

Blurt is a public ledger.  Messages are op broadcasts.  They
may arrive out of order (RPC node lag), in batches (you opened
the app after a week away), or on a brand-new device (you
restored your keys on a new phone — from a seed, a Keyfile, or a
posting key).

A per-message-rotation protocol needs synchronized
per-conversation state on both sides.  When state desyncs,
recovery is messy — protocols that try solve this with PreKey
bundles + lots of careful state management.  None of the
primitives Blurt provides make that sync easy.  We'd be
inventing a parallel state-coordination layer just to host
the protocol.

Morphit's stateless ECIES sidesteps the question entirely.
Any ciphertext is decryptable from the recipient's long-term
chat-priv and the envelope's ephemeral pub — full stop.  No
session state, no skew handling, no recovery flow.

### 2. No "first message" bootstrap

Sender encrypts to anyone whose chat identity is on chain —
immediately.  Look up their `morphit_chat_identity_v1` record,
ECDH against their pub, send.  No prekey-bundle exchange, no
out-of-band step, no "X is using Signal" detection moment.

In a P2P trade context, sender and recipient may never have
talked before — the initial DM is part of the trade flow.
The bootstrap-cost-amortization argument that justifies prekey
bundles in regular messengers doesn't apply.

### 3. Multi-device by default

Chat identity is *deterministically derived* from the Blurt
posting key.  Same seed phrase, same chat identity.  Phone +
laptop unlocked from the same seed are interchangeable: same
inbox, same outbox, same identity.

A per-message-rotation protocol's session state would have to
be replicated across devices, with the device-pairing UX that
implies.  Restored from seed on a new phone?  You'd need to
either re-bootstrap every conversation or sync the protocol
state out-of-band.  We chose to not sign up for that
complexity.

### 4. Auditable simplicity

`crypto.ts` is roughly 400 lines including comments.  All it
does is libsodium calls.  Any third-party security researcher
can read it end-to-end in under an hour.

Reference implementations of forward-secrecy protocols are
1500+ lines.  The Matrix folks have written publicly about how
many subtle bugs they hit shipping theirs.  More code, more
places for a bug to hide, more surface area for a research
auditor to cover.

We took the property the use case *needs* (confidentiality +
integrity + sender-binding) and stopped, instead of bundling
properties we can't deliver well.

### 5. The threat model where per-message rotation helps doesn't really
   apply here

Receiver-side per-message rotation defends against silent
compromise: an attacker who steals your chat-priv without you
noticing, preserves your continued use of the app, and
decrypts your archive over time.

On Morphit, your chat-priv is *deterministically derived* from
your Blurt posting key.  An attacker who has your chat-priv
also has — or had momentarily — your posting key.  With your
posting key they can already:

- Broadcast as you (forge orders, leave fake feedback, edit
  your identity record on chain).
- Impersonate you to your existing contacts going forward.
- Drain any BLURT balance via active-key escalation paths.

So the "preserve plausible normalcy while quietly decrypting
old messages" attack is not a meaningful incremental win for
the attacker.  They already have the keys to the kingdom.
Adding receiver-side rotation would protect a small,
less-valuable slice (past chat ciphertexts) while leaving
everything else fully exploitable.

The right defense in this threat model is fast key rotation
(swap posting key, re-derive chat identity) rather than
per-message rotation.

---

## What we say to users

Per the FAQ entry, we say:

- "Morphit chat has partial forward secrecy" — true, sender-
  side, with the ephemeral wipe.
- "Morphit chat does NOT have full per-message receiver-side
  forward secrecy" — true.
- We never claim PFS we don't have.
- We name the use cases where Morphit chat is the wrong tool
  (long-horizon activism, state-level surveillance contexts)
  and recommend dedicated secure messengers for those.

---

## If you're editing `crypto.ts`

Read this whole document first.  Specifically:

- **Don't add a "convenience" function that takes a non-
  ephemeral sender key.**  The sender ephemeral is the only
  PFS property we have; losing it would silently downgrade
  every send.

- **Don't change the AAD format without bumping the protocol
  version.**  AAD binding is the relay-attacker defense;
  ciphertexts encrypted under the old AAD must not decrypt
  under the new.

- **Don't drop the `sodium.memzero` calls.**  Even if a
  modern engine eagerly GCs the buffer, we want the explicit
  wipe to be the contract.  Future engines may not be as
  eager.

- **Don't introduce a long-term sender key.**  We've discussed
  this — it would simplify some code paths but break the
  sender-side PFS we currently have.  Not worth it.

- **Don't try to add receiver-side per-message rotation
  without a full design pass.**  If we ever add receiver-side
  PFS, it will need session state, sync, recovery, and
  migration from existing conversations.  All of that is
  significant work and will involve an ADR, not an in-flight
  PR.

---

## Comparison table

| Property                          | Morphit | Signal | Matrix (Megolm) |
|-----------------------------------|---------|--------|-----------------|
| Confidentiality                   | yes     | yes    | yes             |
| Ciphertext integrity              | yes     | yes    | yes             |
| Sender-side PFS (per message)     | yes     | yes    | yes             |
| Receiver-side PFS (per message)   | **no**  | yes    | yes             |
| Post-compromise security          | **no**  | yes    | yes             |
| Stateless decryption              | yes     | no     | partial         |
| First-message bootstrap latency   | zero    | high   | medium          |
| Multi-device without pairing      | yes     | no     | no              |
| Per-conversation state to sync    | none    | yes    | yes             |
| Public metadata (sender/timestamp)| yes     | no     | no              |
| Lines of crypto code (approx.)    | 400     | 1500+  | 800+            |

The Morphit row is intentionally not all "yes."  We're not
trying to win on every column; we're trying to be honest
about which columns matter for a P2P-trade use case and
which don't.
