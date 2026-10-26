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

**Since v1.21.14 chat relies on the POSTING KEY only.** Every new message
is sent in the posting-key envelope (v3, below); nothing publishes a chat
identity any more; the safety number is made from posting keys. The
chat-key envelope (v2) described first is READ, never written: old
history, and messages from older Morphit versions (on any instance) that
still write it for a while. Its chat key is derived locally, as before,
just to open them.

Each Blurt account has a long-term X25519 chat-identity keypair
derived deterministically from the posting private key via
BLAKE2b-256 (`morphit-chat-v1/identity/<account>`
domain-separated label). Older versions published the public half on
chain in a `morphit_chat_identity_v1` op. To send a message (envelope v2,
`v: 2` — older versions only), the sender generates a fresh X25519
ephemeral keypair and derives the message key from TWO Diffie-Hellman
results:

```
dh1 = X25519(ephemeral, recipient)      — fresh per message
dh2 = X25519(sender, recipient)         — static-static
key = BLAKE2b-256(key = dh1 ‖ dh2,
                  msg = "morphit-chat-msg-v2/" sender 0 recipient 0
                        ‖ sender_pub ‖ recipient_pub ‖ ephemeral_pub)
```

It encrypts under ChaCha20-Poly1305-IETF with a random 12-byte
nonce, the two account names as AAD. The recipient computes `dh2`
from their own private key and the sender's chat key. Since v1.21.14 a v2
message is **proved** only by a chat key pinned here (pinned by a
conversation before v1.21.14 — nothing pins a chat key any more). Opened
with any other key (the one the chain confirms the sender publishes now, a
replaced one), it is readable and shown with a calm "sent from an older
version" note, never as proved, and it moves no trade.
The sender's optional self-copy uses `X25519(ephemeral, sender)`
with the same `dh2`. All primitives from libsodium-sumo.

Code: `apps/web/src/lib/chat/crypto.ts`. The on-wire envelope
(`ChatEnvelopeWire`) carries the version, the ephemeral public, the
nonce, and the AEAD output (with its 16-byte Poly1305 tag).

**v3 envelopes — the posting-key envelope (v1.21.13; the only one sent
since v1.21.14).** v2 needs a
published chat key on BOTH sides, and until v1.21.13 a key was published
only when its owner opened chat, from their own BLURT. A message to anyone
who had not (a new member answering nobody yet; one with no BLURT left)
could not be sent at all, and their replies could not be opened. v3 uses the
accounts' **posting keys** (secp256k1), which every account has on chain from
the moment it exists.

A fresh random 32-byte content key `K` encrypts the message once
(ChaCha20-Poly1305-IETF, random 12-byte nonce, AAD
`"morphit-chat-aad-v3/" sender 0 recipient`). `K` is then wrapped for each
of the recipient's posting keys that can sign on their own (weight at least
the threshold), at most three — a session holds one of them, and the sender
cannot know which:

```
dh1_i  = ECDH(ephemeral, R_i).x                 — fresh per message
dh2_i  = ECDH(sender_posting, R_i).x            — static-static
KEK_i  = BLAKE2b-256(key = dh1_i ‖ dh2_i,
                     msg = "morphit-chat-wrap-v3/" sender 0 recipient 0
                           ‖ S ‖ R_i ‖ E)
C      = BLAKE2b-256("morphit-chat-commit-v3" 0 ‖ nonce ‖ ct ‖ E ‖ S ‖ R_1…R_n)
wrap_i = ChaCha20-Poly1305(KEK_i, nonce = 0, K, aad = names ‖ C)  — each KEK seals one thing
```

`C` ties every wrap to this exact message and header. Without it, whoever
holds any listed recipient key could recover `K` from their own wrap and
write new text under it that every other key — and the sender's own copy —
would show as authenticated.

The sender's self-copy is one more wrap of `K`, under
`ECDH(ephemeral, S) ‖ ECDH(S, R_0)` with a "self" domain, so only the sender
can open it. The header carries `v: 3`, the ephemeral key (33 bytes,
compressed), the nonce, `sk` (the sender's posting key), `rk` (the recipient
keys) and `wk` (their wraps, same order), and the self wrap in
`self_ciphertext`/`self_nonce`. Every key that takes part in an ECDH is
decoded by `getSharedSecret`, which refuses a point off the curve; keys read
from chain (`BLT…`) are checksum- and curve-checked when decoded.

The sender is proved when `sk` is one of the posting keys **pinned** for
them. A posting pin is the SET of the peer's keys that can sign alone:
first contact pins the set read from chain; a key removed from the account
narrows the pin; a key added is refused as a changed key
(`pub_pin_posting_key_changed`) until the user compares the new safety number
in Verify peer and accepts it — Accept pins exactly the set the number was
made from (v1.21.14). First contact pins the set whatever chat key of the
peer's is pinned here (v1.21.14: until then a pinned chat key held a first
set back as a "change" — and since opening a conversation pinned the peer's
chat key, a normal first conversation with someone an older version had
published a key for showed every message from them as "Sender not
verified" and refused every reply until the user accepted the "new key").
Verify peer pins a first set when the user says the numbers matched. A
message from a pinned sender opens and is proved without any lookup.

**Which envelope a send uses.** Always v3, to the peer's pinned posting
keys (v1.21.14) — every message, retry and structured payload, the
"settled with someone else" auto-reply included. Nothing about chat keys
is looked up to send. (v1.21.13 chose per pair: v2 when our published chat
key was current and the peer had one, unless the peer's last proved message
was v3; the Verify-peer panel had to apply the same rule. Two formats meant
two sets of keys to pin per person, a format memory that scrolling back
could corrupt, and the first-conversation failure above.) No chat identity
is published or re-published any more, so the re-publication rules of
v1.21.13/v1.21.14 (ADR-0015's amendment) are gone with it.

Same claims as v2 (confidentiality, deniable sender authentication, no
forward secrecy): the posting key itself takes part instead of a key derived
from it, and ADR-0015 already accepted that the posting key opens every
message. Cost on a server CPU: about 11 ms to encrypt, 6 ms to open the first
message from a sender, 3 ms for later ones (they reuse its static secret). Clients older
than v1.21.13 cannot open v3 (they show "couldn't be decrypted") and cannot
send to an account without a published chat key, so every instance has to
upgrade.

**v4 envelopes — v3 bound to its order and its send time (v1.21.14
reads them; a later release sends them).** v3 authenticates the words, not
where or when they were said: the order a message is about travels beside
the ciphertext (the record's `order_permlink`) and its time is the indexer's
`created_at`. An indexer, or anyone rebroadcasting the same bytes, could show
an authenticated "funds sent" under another order between the same two
people, or at another time (review C-M2). v4 is v3 with three more inputs the
sender binds:

- the thread's order permlink (`''` for a direct message; the record's own
  field);
- that order's owner, `o` in the header — one of the two people (`''` for a
  direct message). A permlink is unique per owner only, and either person may
  have an order by the same permlink;
- `t`, the chain's head time when it was sealed, in whole seconds (header).

All three go into the content AAD (`"morphit-chat-aad-v4/" sender 0
recipient 0 owner 0 order 0 t`) and the commit, and every label says v4, so
a v4 message opens only under that order, owner and time — for the
recipient and for the sender's own copy. A trade message moves a trade only
when the order's owner as looked up is the one it names. The time shown is
the indexer's while it lies within 2 minutes before and 5 minutes after `t`
(a head read, a 60-second transaction expiry and a block fit inside), and `t`
otherwise. The head time is read through the sender's own instance, so the
sender's device checks it against its own clock: more than 2 minutes apart,
or the head or the order's owner not known, and the message is sealed as v3
(its words still authenticated; its order and time then the indexer's word).
A retry is sealed afresh, with its own `t`.

Read first: a client that does not know v4 shows a v4 message as
"couldn't be decrypted", so v1.21.14 reads v4 — in a conversation and in
the trade listener that works across pages — and still sends v3
(`WRITE_ENVELOPE_V4` in `crypto.ts`). The release after it — once every
instance runs a v1.21.14 reader — turns sending v4 on. Until then the order
and time of a v3 message are as trustworthy as the indexer that serves it;
v3 stays readable with no end date (old history).

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
   set of posting keys the app sees for a peer is pinned (trust on first
   use). If their account later lists a key that is not pinned, the app
   does not re-pin silently: the message is held back ("Not sent: this
   person's account keys have changed …") until the user opens Verify
   peer, compares the new safety number and accepts it there. Accept
   pins exactly the keys that number was made from: if the account
   changed again meanwhile, those are still the keys pinned, and the
   panel then shows the number for what the account lists now (v1.21.14 —
   it used to pin whatever was pending at the tap, and the refused message
   offered a one-tap "accept the new key" with no number shown at all;
   that button now opens Verify peer, and the message is sent again once
   accepted). Chat keys pinned before v1.21.14 stay, and prove that
   peer's older-format (v2) messages; none is pinned any more.
   The "chain" check behind pins
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
   trade (no "Send …" button, no payment check, no trade state).

7. **Safety number.** "Verify peer" shows 60 digits in 12 groups of
   5. Each person's 30 digits are computed from that person's own
   account name and posting keys only — the keys every message is sent
   to since v1.21.14; chat keys are not compared any more (SHA-512,
   5,200 iterations, the shape Signal uses), and both sides show the
   same 60 digits —
   about 199 bits, so a hostile indexer must find a second preimage
   for each half. It needs no WebCrypto, so it works on I2P.
   Your own half is made from the posting keys this instance lists for
   your account — the same list your partner's app pinned for you — and
   the panel checks that list against the key you signed in with
   (v1.21.14 review): if your key is not listed it shows no number, and
   any OTHER key listed for you is named above the number, because
   messages to you are encrypted to it too. Without that check an
   instance serving both of you could add a key of its own to your list:
   both halves were built from the same doctored list, the numbers
   matched, and the operator read your messages and could write
   "proved" ones in your name. (A paired read-only desktop holds no key,
   so it cannot make this check; compare on the phone.)

---

## What we don't claim

1. **Forward secrecy — in either mode.** The recipient's posting
   key (and, for older-format messages, the chat key derived from it)
   is the same until they change it, and it decrypts every message
   ever sent to them. In the default 'keep' mode the sender's own key
   also decrypts the self-copy of every message they sent. 'Destroy' mode (no self-copy) only
   removes the sender's own ability to reread; the recipient's key
   still opens everything. A later leak of either posting key
   exposes that side's whole chat history from chain.

2. **Post-compromise security (a.k.a. "self-healing").** If the
   attacker has your posting key, they decrypt all past *and*
   future messages until you rotate it. No automatic
   recovery.

3. **Metadata privacy.** Sender, recipient, timestamp, ciphertext
   size and — for a message about an order — the order's permlink
   are public on chain, and so are read receipts and blocks. See
   `docs/METADATA-LEAK-CATALOG.md`.

4. **Replay protection beyond what AEAD gives you.** A bit-for-bit
   replay of the same envelope authentication-passes. On chain this
   is not a meaningful attack — replays are de-duplicated by op id at
   the indexer layer — but it's worth being explicit. A v4 message
   cannot be replayed into another order's thread or shown at another
   time (above); a v3 one can, and the app shows the same bytes from the
   same sender as one message, never two (v1.21.14).

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
  the recipient's posting key opens every message they received, and
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
