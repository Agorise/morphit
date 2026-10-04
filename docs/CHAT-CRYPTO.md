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

Each Blurt account has a long-term X25519 chat-identity keypair
derived deterministically from the posting private key via
BLAKE2b-256 (`morphit-chat-v1/identity/<account>`
domain-separated label). The public half is published on chain in
a `morphit_chat_identity_v1` op. To send a message (envelope v2,
`v: 2`), the sender generates a fresh X25519 ephemeral keypair and
derives the message key from TWO Diffie-Hellman results:

```
dh1 = X25519(ephemeral, recipient)      — fresh per message
dh2 = X25519(sender, recipient)         — static-static
key = BLAKE2b-256(key = dh1 ‖ dh2,
                  msg = "morphit-chat-msg-v2/" sender 0 recipient 0
                        ‖ sender_pub ‖ recipient_pub ‖ ephemeral_pub)
```

It encrypts under ChaCha20-Poly1305-IETF with a random 12-byte
nonce, the two account names as AAD. The recipient computes `dh2`
from their own private key and the sender's **pinned** chat key.
The sender's optional self-copy uses `X25519(ephemeral, sender)`
with the same `dh2`. All primitives from libsodium-sumo.

Code: `apps/web/src/lib/chat/crypto.ts`. The on-wire envelope
(`ChatEnvelopeWire`) carries the version, the ephemeral public, the
nonce, and the AEAD output (with its 16-byte Poly1305 tag).

**v1 envelopes** (older clients, no `v`) were anonymous ECIES: the
key depended only on the ephemeral and the recipient key. They still
decrypt, so old messages stay readable, but the app marks them
"Sender not verified" and never lets one move a trade forward:
anyone holding the recipient's public key could have written one.

---

## What we claim

1. **Confidentiality.** Without the recipient's chat private key
   (or, for a v2 self-copy, the sender's), the ciphertext is
   opaque. Standard X25519 + ChaCha20-Poly1305 assumptions.

2. **Ciphertext integrity.** The AEAD's MAC catches tampering by
   anyone in the relay path, including stripping or changing the
   version.

3. **Sender authentication (v2).** Because the key mixes in
   `dh2`, only someone holding the sender's or the recipient's
   chat private key can produce a message that opens. A hostile
   indexer, which knows only public keys, cannot write a message
   "from" someone. It is **deniable**: the recipient could have
   computed the same key, so a message proves its origin to the
   recipient, not to third parties. As with any DH-authenticated
   scheme, someone who steals the RECIPIENT's chat private key can
   also forge messages to them.

4. **Recipient binding.** AAD carries both account names, so a
   ciphertext cannot be redirected to another recipient.

5. **Domain-separated key derivation.** Identity, message key and
   AAD use different labels.

6. **Key pinning, with explicit acceptance of changes.** The first
   chat key the app sees for a peer is pinned (trust on first use).
   If a newer identity op later carries a different key, the app no
   longer re-pins silently: the message is held back ("Not sent:
   this person's chat key changed …") until the user compares the
   new safety number and accepts it. The "chain" check behind pins
   reads through the operator's own relay, so it catches a broken
   or stale indexer but **not** a forging operator; only comparing
   the safety number out of band rules out a swapped key at first
   contact. On **Lock** the pins are sealed per account (each account
   has its own encrypted slot that only its key opens) and restored at
   its next unlock. **Sign Out** removes the readable pins but keeps
   the sealed copy, which names nobody; signing back in to the same
   account restores it, and another account signing in and out on the
   same browser cannot remove it. After you
   accept a partner's new key, messages made with their OLD key stay
   readable as history but are marked unverified and never move a
   trade (no "Pay now", no payment check, no trade state).

7. **Safety number.** "Verify peer" shows 60 digits in 12 groups of
   5. Each person's 30 digits are computed from that person's own
   account name and chat key only (SHA-512, 5,200 iterations, the
   shape Signal uses), and both sides show the same 60 digits —
   about 199 bits, so a hostile indexer must find a second preimage
   for each half. It needs no WebCrypto, so it works on I2P.

---

## What we don't claim

1. **Forward secrecy — in either mode.** The recipient's chat
   private key is the same until their posting key changes, and it
   decrypts every message ever sent to them. In the default 'keep'
   mode the sender's own chat key also decrypts the self-copy of
   every message they sent. 'Destroy' mode (no self-copy) only
   removes the sender's own ability to reread; the recipient's key
   still opens everything. A later leak of either posting key
   exposes that side's whole chat history from chain.

2. **Post-compromise security (a.k.a. "self-healing").** If the
   attacker has your chat private key, they decrypt all past *and*
   future messages until you rotate your posting key. No automatic
   recovery.

3. **Metadata privacy.** Sender, recipient, timestamp, ciphertext
   size and — for a message about an order — the order's permlink
   are public on chain, and so are read receipts and blocks. See
   `docs/METADATA-LEAK-CATALOG.md`.

4. **Replay protection beyond what AEAD gives you.** A bit-for-bit
   replay of the same envelope authentication-passes. On chain this
   is not a meaningful attack — replays are de-duplicated by op id at
   the indexer layer — but it's worth being explicit.

5. **Non-repudiation of content.** The broadcast op is signed by the
   sender's posting key, so the chain proves the sender broadcast
   *that ciphertext*; the v2 message authentication itself is
   deniable (above).

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

Morphit's stateless scheme sidesteps the question entirely.
Any ciphertext is decryptable from the recipient's long-term
chat-priv, the sender's pinned chat pub and the envelope's
ephemeral pub — full stop.  No
session state, no skew handling, no recovery flow.

### 2. No "first message" bootstrap

Sender encrypts to anyone whose chat identity is on chain —
immediately.  Look up their `morphit_chat_identity_v1` record,
do the two ECDHs against their pub, send.  No prekey-bundle exchange, no
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

`crypto.ts` is a few hundred lines including comments.  All it
does is libsodium calls.  Any third-party security researcher
can read it end-to-end in under an hour.

Reference implementations of forward-secrecy protocols are
1500+ lines.  The Matrix folks have written publicly about how
many subtle bugs they hit shipping theirs.  More code, more
places for a bug to hide, more surface area for a research
auditor to cover.

We took the properties the use case *needs* (confidentiality +
integrity + sender authentication) and stopped, instead of bundling
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

(They cannot move your BLURT: that needs the active key.)

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

- "Morphit chat has no forward secrecy, in either mode" — true:
  the recipient's chat key opens every message they received, and
  in the default mode the sender's key reopens what they sent.
- "Destroy" mode only removes your own ability to reread.
- We never claim PFS we don't have.
- We name the use cases where Morphit chat is the wrong tool
  (long-horizon activism, state-level surveillance contexts)
  and recommend dedicated secure messengers for those.

---

## If you're editing `crypto.ts`

Read this whole document first.  Specifically:

- **Don't drop the static-static `dh2`.**  It is the sender
  authentication; without it any holder of public keys can write
  a message "from" anyone again (that was v1).

- **Don't change the AAD or the key-derivation message without
  bumping the envelope version.**  Ciphertexts encrypted under the
  old format must not decrypt under the new.

- **Don't drop the `sodium.memzero` calls.**  Even if a
  modern engine eagerly GCs the buffer, we want the explicit
  wipe to be the contract.  Future engines may not be as
  eager.

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
| Sender authentication             | yes (v2, deniable) | yes | yes      |
| Forward secrecy                   | **no**  | yes    | partial         |
| Post-compromise security          | **no**  | yes    | yes             |
| Stateless decryption              | yes     | no     | partial         |
| First-message bootstrap latency   | zero    | high   | medium          |
| Multi-device without pairing      | yes     | no     | no              |
| Per-conversation state to sync    | none    | yes    | yes             |
| Public metadata (sender/timestamp)| yes     | no     | no              |

The Morphit row is intentionally not all "yes."  We're not
trying to win on every column; we're trying to be honest
about which columns matter for a P2P-trade use case and
which don't.
