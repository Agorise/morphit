# Morphit v1.21.10

**Setting up offline notifications, made to work for a real operator.** `sudo morphit-ops
offline-notify` can now **make** your site's XMPP account on a free public server (og.im, openim.nl or
jabber.de, asked live), with every answer checked before anything is sent. The Matrix step explains
that the account must already exist and says exactly why a sign-in was refused. A Matrix test
invitation can now be accepted, and the email step is written in plain words. Also: a contact link,
name or address changed with `morphit-ops edit` now reaches your card on the Instances page,
including on servers installed before v1.12.20.

**Upgrading:** `sudo morphit-ops upgrade` on every server. No database change. The upgrade removes
the install-time copies of your site's name, tagline, contact link and addresses that an older
install still has in `/etc/morphit/indexer.env`, where `morphit.config.env` sets them too, and
restarts the indexer if that changes anything (see below). **Every instance must run v1.21.1 or
later before 2026-11-01 00:00 UTC.**

## Your card on the Instances page shows what you set

- **What happened.** An operator changed the site's contact from a Matrix room to an email address.
  The Operators page (the on-chain registration) showed the email at once; the site's card on other
  instances' Instances pages kept "Contact via Matrix". The card is copied from the site's own
  indexer, which still had the old value.
- **Old copies in a file read last.** The indexer reads `/opt/morphit/morphit.env`, then
  `morphit.config.env`, then `/etc/morphit/indexer.env` — the last one wins. A server installed
  before v1.12.20 still has its install-time name, tagline and contact link in `indexer.env`, and the
  Ansible files carry the operator tag and the Blurt node lists, so an edit was written, the service
  restarted, and nothing changed. Now `morphit-ops edit` and `morphit-ops alt-address` remove an old
  copy of every setting they just saved from `indexer.env` and `relay.env` (a copy of the file is kept
  next to it, `….bak-<number>`), restart, and then read the running services' settings and say
  whether they have the new values. A Blurt node list there that keeps the server off public nodes
  (empty, or hidden `.onion`/`.i2p` nodes only) is kept, and named. Each upgrade does the same for the
  name, tagline, contact link and addresses wherever `morphit.config.env` also sets them.
- **The relay is restarted too** when the site's name, origin, Tor/I2P/Lokinet address or its own
  Blurt node list changes: its offline notes carry the name and the addresses, and it used to keep the
  old ones until its next restart (even an onion just replaced).
- **At once after a restart.** The indexer refreshes your own card at the first check after it starts,
  instead of when it next falls due.
- **Other servers' cards.** A card for another instance changes when that instance's own indexer
  answers with the new value (each instance asks every 10 minutes), so that instance needs this fix
  (or a restart of its indexer) too.

## Offline notifications: setting up the accounts

- **XMPP: a new account in a few answers.** Choose *Make a new one*: the wizard asks og.im, openim.nl
  and jabber.de (or a server you name) whether they take new accounts right now and offers only those
  that do. It checks the name (2–32 of a–z, 0–9, `.` `_` `-`) and the password (12–128 characters, not
  containing the name, three kinds of characters or 20 and more, plain characters, typed twice) before
  anything is sent, or makes a strong 24-character one if you just press Enter. A server that wants a
  picture check shows a web page and you type what it shows (within about half a minute; a late answer
  gets a new picture). A refusal shows the server's own reason. Then it turns the account's message
  archive off (and reads the setting back), sends you a test note and saves. With no test address it
  offers to save the new account untested; a new account you choose not to save stays on its server,
  and the wizard says so. *Use an account that already exists* finds the server from the domain's DNS
  records. On a zero-clearnet site only `.onion` servers, and no DNS lookups. It never logs in or
  registers without encryption.
- **Matrix.** The step now says the account must already exist (the wizard signs in; it does not make
  one) and how to make one on matrix.org. A refused sign-in says why: wrong username or password, no
  such account yet, too many attempts, no password sign-in, not a homeserver, unreachable. An address
  whose `/.well-known` names another (matrix.org → matrix-client.matrix.org) is signed in at, and saved
  as, that one. A homeserver that answers the sign-in with a redirect is refused, so the password is
  never sent on to another address.
- **The Matrix test invitation can be accepted.** The bot used to leave the test chat at once, so the
  invitation could not be accepted ("the person who invited you has already left"). It now waits until
  you have joined, up to about a minute and a half, and the wizard says so; it always finishes within
  the wizard's time limit.
- **Email.** The step explains in plain words that no mail server runs on your server: notes go out
  through a mailbox at a provider, and it names the four answers to have ready.

## Relay hardening (found in the review)

- **XMPP replies are read in one pass.** The relay read a server's replies with patterns that could
  take minutes on crafted input, and a hostile XMPP server could have stalled the whole relay. Replies
  are now split into elements by a scanner that looks at each character once.
- **Passwords as servers keep them.** The relay now logs in with the password prepared the standard way
  (SASLprep): an account whose password has a no-break space, a ligature or an accent typed as a
  separate mark could not be logged in to before.
- **Zero-clearnet read the way the indexer reads it.** Every check that decides from
  `/etc/morphit/indexer.env` whether a server is zero-clearnet (morphit-ops, first-online, the IPFS
  setup, the snapshot pinning) now reads `MORPHIT_INDEXER_RPC_ENDPOINTS` as bash does: an empty list
  written with a comment after it (`…=   # tor-only`), quoted, or with `export` is empty, and the last
  line wins. Before, such a line read as clearnet: first-online could ask public RPC nodes and IPFS
  could join the public network from the server's own address.
- Smaller: a malformed name refused by the server asks for another name; a registration form that also
  needs an email address is reported as such; a character split across two network packets is no
  longer garbled; a server repeating the password in a refusal no longer puts it on the screen; Ctrl+C
  at the picture question stops the wizard like any other prompt; the relay tool ending during a
  question no longer leaves a second prompt or a spinner behind.
