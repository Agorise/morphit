# Morphit v1.21.13

**Chat reaches anyone, including someone who has never opened chat.** A buyer pressed "Message" on a new
member's order. They got a red "This recipient hasn't opened Morphit chat yet", nothing was stored for the
recipient, and the message was gone after leaving the chat and coming back.

The cause was not that member: every message was encrypted to a key the recipient had to publish on chain
first. The app published it silently, from the recipient's own BLURT, the first time they opened chat, and a
member with no BLURT left could never be reached at all. Messages to an account without that key now go to
its **posting keys**, which every Blurt account has on chain from the moment it exists. The message goes on
chain at once, the recipient is notified as usual, and they read it whenever they sign in. The sender pays
the network fee; the recipient needs no BLURT to receive or read it. Replying is sending: the replier pays the
fee for their reply.

**New accounts now start with 4 BLURT instead of 2**, enough to fill in the whole profile, post a first order
and send a few messages (details below).

**Upgrading:** `sudo morphit-ops upgrade` on every server. No database change. **Upgrade every instance,
including federated ones you chat with.** A version older than this one:

- cannot open a message sent in the new format. It shows "This message couldn't be decrypted on this
  device. It may be damaged…" — the message is fine; that version cannot read it;
- cannot send to a member who never opened chat (it still says "This recipient hasn't opened Morphit chat
  yet").

New members never publish a chat key, so everything they send is in the new format, to everyone. **Every
instance must run v1.21.1 or later before 2026-11-01 00:00 UTC.**

## Chat to someone who never opened it

- **What happened.** Each message was encrypted to the recipient's published chat key, a key made from their
  posting key and put on chain by the app the first time they opened chat, paid from their own BLURT. Until
  then nobody could write to them, and their replies could not be proved on the other side.
- **Now.** When the chat-key format can't be used, the message is encrypted to the recipient's posting keys,
  read from their account on chain. One random key encrypts the message; it is sealed separately for each of
  the recipient's posting keys that can sign on its own (up to three — whichever one their session holds
  opens it), and once more for your own copy. Each seal uses the same construction as before (a fresh
  one-time key for every message, mixed with both parties' keys, then ChaCha20-Poly1305), and each is tied to
  this exact message, so nobody holding one of those keys can reuse it to write something else in your name.
  Only the recipient can open it, and it proves who sent it.
- **Pairs that already chatted keep their format.** When your published chat key is current and the other
  person has one, nothing changes.
- **No fee for opening chat.** Opening chat no longer broadcasts anything. A key published earlier is still
  re-published after its owner changes their posting key (a small network fee), so people writing to them
  keep reaching the right key.
- **Never moved off keys you checked.**
  - The posting keys first seen for someone are pinned on your device, as a set. A key removed from their
    account narrows the pin. A key ADDED stops sending with "this person's account has a key it didn't have
    when you last wrote to them" until you compare the new safety number and accept it. Accepting a changed
    posting key never accepts a changed chat key, and the reverse.
  - If your server suddenly says that someone whose chat key you pinned has none, sending stops ("a key
    recorded on the blockchain can't disappear"); it is not moved to their posting keys.
  - Someone whose chat key you already trust gets no posting keys on first use: sending to them in the new
    format stops with "these are not keys you have checked" until you compare the safety number in Verify
    peer and accept, and their messages in the new format read "Sender not verified" until then.
  - If your server can't say whether your own chat key is published, sending stops with "try again"; nothing
    is guessed. Once your key has been seen published on this device, a later "none" from a server changes
    nothing.
  - A message made with a key that isn't pinned reads "Sender not verified" and never moves a trade.
  - The pins and that record are encrypted when you lock and removed when you sign out, as before.
- **Safety number.** Verify peer uses the same rule as sending, so both sides compare numbers made from the
  same keys — every posting key of each account, in any order. Opening it pins no posting keys: "The numbers
  match — use these keys" (or "accept" for a changed set) pins exactly the keys whose number you compared.
  (A chat key is still remembered the first time the panel or a message looks it up, as before.) It now says plainly when an account doesn't exist, when it has no
  posting key of its own, when the chain couldn't be reached, and when your own key on chain is an old one
  (the other person may see a different number until it is replaced).
- **Accounts with no posting key of their own** (managed by other accounts) are named as such, instead of "no
  account by this name". A message made for another posting key of your account (an account can list
  several, and only one is in your session) says so, instead of "may be damaged".
- **Answering in the same format.** When someone writes to you in the new format although you hold their
  chat key — their own published key is out of date, for example — your replies go in the new format too, so
  they can read them. Messages already sent in the older format to a key that has since gone out of date
  stay unreadable until its owner opens chat with enough BLURT to re-publish it (a small fee).
- **Settled with someone else.** The automatic "this order was settled with someone else" note follows the
  same rules and pins, and reaches every posting key of people who never published a chat key.

## Chat stays fast

- The keys a first message needs are looked up side by side as the conversation opens, while you type, so
  the first Send waits on nothing (on Tor/I2P each lookup is a slow round trip).
- A person without a chat key is looked up once per conversation, not once per message; a failed lookup is
  asked again after 30 seconds (or at once on Retry), so a long history costs one lookup, not one per message.
  Opening a conversation no longer asks the server for the same key twice.
- A long history is opened a few messages at a time, so the page stays responsive while it fills.
- A message from someone whose keys are pinned opens with no lookup at all. On a server CPU the first message
  from a person takes about 6 ms of crypto to open, later ones about 3 ms (they reuse part of the work);
  sending takes about 11 ms.
- The account-keys lookup now has a deadline (15 s, longer through Tor/I2P), so a server that stalls can't
  hold a send open forever.
- A long message costs less in the new format than before: your own copy is a 48-byte key, not a second copy
  of the text.

## A message that could not be sent stays in the chat

- A message that failed before the network took it lived only on the open chat page: leaving and coming back
  showed nothing where it had been. It now stays in the conversation, marked failed, with the reason and
  **Retry**, until it is sent.
- Like your other unsent words, it is kept in memory only, never on disk. It is forgotten when you lock or
  sign out, and not kept at all in "destroy after you leave this chat" mode — including when you switch to
  that mode after the send failed.

## Out of BLURT, in chat too

- v1.21.12 said the out-of-funds message showed on every screen that writes to the chain. In chat it did not:
  a send refused for lack of BLURT showed the chain's own text ("Assert Exception: acnt.balance >= fee …").
  A failed chat send now reads like every other screen: **"Broadcast rejected due to insufficient funds. Buy
  BLURT to save more data to the chain."**, and the other refusals (clock off, wrong key, too large, the
  server unreachable) say what to do.
- A message to an account that does not exist on the chain says so instead of failing without a reason.

## New accounts start with 4 BLURT

Blurt takes a fee for every operation from the sender's liquid BLURT: 0.050 per operation plus 0.200 per
1,024 bytes of the signed transaction. Every Save on the settings page is its own operation. Measured with the
real builders:

| Operation | Fee (BLURT) |
|---|---|
| Display name | 0.084 |
| Short bio (128 characters) | 0.111 |
| Website, streaming or Nostr link | about 0.09–0.10 each (0.187 at the 512-character limit) |
| Preferred languages | 0.090 |
| Avatar | about 0.89 for 4 KB, 1.29 at the 6 KB limit |
| Settings sync (one per batch of changes) | 0.223 |
| First order | about 0.18 |
| Chat message | about 0.20 (short), 0.31 (500 characters) |

2 BLURT ran out after an avatar, one order and a few saves; the next field was refused. 4 BLURT pays for every
profile field once (avatar at the limit), two settings saves, the first order and about seven short
messages. It adds 2 BLURT to the ~100 BLURT the chain already charges for each new account (~104 per signup;
about 2,100 BLURT still covers the first 20). The relay now needs the account fee plus 5 BLURT on hand before
it starts a signup.

## OpenMonero: what it still owes

The FAQ ("How is Morphit different from OpenMonero?"), the brag list and the media kit now give its full
record: about 77.85 XMR drained in June 2025; an exploit alert in May 2026; about 200 XMR taken in June 2026
and about 112 XMR in July 2026 (122 in his later count; 399 XMR across the three drains, by his own count); and on 20
October 2026 its operator told his community that 150–200 XMR of refunds are still pending, owed to four
vendors, and that he needs more fees to pay them back. An unverified "~40 XMR" figure for May 2026 was
removed.
