# Morphit v1.21.14

**Chat is fast again.** Two people on morphit.io saw every message about a minute late. The server had each
message within a second; BunkerWeb, which buffers what it relays, held the live chat stream until later traffic
pushed it out. The indexer marks every live stream "do not buffer", but the frontend container in front of it
dropped that mark (nginx never passes it on by itself), so BunkerWeb never saw it. The frontend now passes it
on, and a message reaches the other person's browser in under a second. Tor and I2P visitors, who do not go
through BunkerWeb, were not affected by this part.

A full audit of chat and the inbox followed, measured end to end on a private Tor network with three instances
(clearnet, clearnet with an onion, and Tor-only): every combination of sender and recipient arrived in under four
seconds, a paid first message in about one, and a message still arrived in under four seconds with a peer's
onion down. Messages from accounts this server had never stored a key for (most accounts older than Morphit)
used to wait for the chain too; they are now checked at once.

**No more "Sender not verified" or "Not sent: these are not keys you have checked" on a first chat.** Chat now
uses one key per account, its posting key, so a conversation never starts with a key warning. Messages from
older versions stay readable, with a calm grey note.

**Your browser now talks to this site only.** The once-a-day release check used to ask public Blurt RPC nodes
directly from your browser, so those nodes saw your IP address, even on a Tor or I2P site. It now asks this site,
which answers only with what two Blurt RPC operators agree on; your browser still checks the release's signature
itself, so a site cannot fake a release. Every page's Content-Security-Policy now lets the browser connect to
this site and nothing else (`connect-src 'self'`). See the FAQ "Does anything see or leak my IP address?".

## Chat and inbox

- **Every message is pushed to every instance at once, one push per sender.** People writing to users of the
  same instance at the same moment no longer wait in line behind each other. Each push still travels on its
  own fresh Tor circuit; a peer whose onion does not answer within two seconds is also tried at its web
  address through Tor.
- **A paid first message reaches the inbox in about a second**, also when the message arrives before its fee.
- **Blocking someone takes effect at once**, not when the block reaches a final block.
- **A message from someone you blocked, or a first message that never reaches the chain, sends no notice.**
- **Trade buttons only for the trade they belong to.** "Pay now" and "Mark sent" act only on this
  conversation's own order, and only on what its two parties said.
- **Fewer connections per tab** (three at most), so sending and reading never wait behind live streams on Tor
  and I2P; live streams come back by themselves after an error.
- **One live inbox stream per browser, not one per tab.** One tab keeps it and passes its news to your other tabs;
  when that tab closes, another takes over and catches up. On Tor and I2P, where a browser allows only a few
  connections per site, ten open tabs no longer use them all up.
- **Two orders with the same name are two trades.** Two people can each post an order whose link name is the
  same; a payment or an address on one of them no longer shows on the other, in chat, the inbox or My orders.
- **"Leave feedback" in the inbox only on the card of the person you traded with**, not on every card about the
  same order.
- **Ready for messages bound to their order and time.** This version reads a new message format that cannot be
  shown under another order than the one it was sent about, or more than a few minutes away from when it was
  sent. It still sends the current format; the next version sends the new one, once every instance can read it.
- **The composer is free again at once** after you press Send, a failed send says so, and drafts are kept per
  conversation.
- **Live chat needs a ticket signed by your posting key.** Before, anyone could watch an account's chat streams
  on every instance and tell from which one showed a message first which instance that account uses. The browser
  signs the ticket for you, for seven days at a time, so a device whose clock is hours or days off still gets live
  chat; a paired desktop's ticket lasts as long as the pairing. (The person you are writing with can still tell,
  by timing; see the leak catalogue.)
- Chat records on the chain (messages, read receipts, folders, blocks, fees) are applied once two RPC operators
  serve the same block. If your instance can reach only one operator for ten minutes, chat blocks are applied on
  that operator's word until two answer again — so a hostile node can write chat history only while it is the
  only one your instance reaches.
- **The safety number now checks your own half.** Verify peer compares the keys this site lists for your account
  with the key you signed in with: if yours is missing it shows no number, and any other key listed for you is
  named above the number (messages to you are encrypted to it too). Before, a site serving both of you could add
  a key of its own to your account, and both of you still saw the same number.
- **Signing out keeps what you have checked.** The keys you have pinned for your partners are sealed under your
  own key at Sign Out and come back when you sign in again, as the docs said they did. Before, every partner was a
  first contact again after a sign-out.
- **A message you read stays read.** Reading a message the moment it arrived, then leaving, no longer lights the
  thread up again a few seconds later when its copy reaches the chain.
- **After you accept a partner's new key**, their earlier messages show the calm grey note, not a request to compare
  the number you have just compared.
- **One busy sender cannot crowd out the others** on the way to another instance; a slow onion is no longer cut
  off by a refusal from the same instance's web address; a notification whose first try hit a database hiccup is
  sent on the next pass, not five minutes later.

## For operators

- **Upgrade every instance** (`sudo morphit-ops`, option 2). The upgrade rebuilds the frontend container, which
  carries the stream fix above, and replaces the page Content-Security-Policy (BunkerWeb, the frontend
  container, or the bare-metal nginx site) with this release's, in which visitors' browsers connect to this site
  only. A policy you wrote yourself is left alone and reported.
- **New endpoint: `POST /v1/chain/agreed`.** It answers only the release check's two reads (@morphit's newest
  release record, and that release's transaction from the block a checked history named), and only with what two
  RPC operators of your pool agree on; it says 502 when they do not, and logs `chain_agreed_no_quorum` at most
  every ten minutes. One read serves every visitor and is kept a minute (a block ten, a failure 30 s), so a
  flood costs your pool nothing more. Two reachable RPC operators are needed for the release banner.
- **A browser from before this version** gets no live chat from an upgraded instance until it reloads (the
  streams need a ticket).
- **Instances older than v1.21.13 cannot read chat from this version** (every message is now sent the
  posting-key way, which v1.21.13 introduced), and cannot write to accounts created from now on. Upgrade them.
- Fan-out to other instances is Tor-only: every installer configuration runs Tor and publishes an onion.
- The head tailer polls every second by default (`MORPHIT_INDEXER_FASTPATH_INTERVAL_MS`, now 1000).
- New limits, all in OPERATIONS §24 and ADR-0052: stream tickets (new tickets checked at 100 a second for members whose key the instance holds, 40 for
  others; their chain reads have their own ceiling), hidden-service streams (1,500, of which 1,000 without a ticket; 12 per account),
  pushes in flight (8 per peer, 96 in all), relay push passes (4 at once).
- When only one RPC operator answers, a block with chat or inbox ops waits up to 10 minutes **once per outage**,
  then such blocks are applied on that operator's word (`chat_block_single_source_after_wait` in the log) until
  two operators answer again; the pool is asked again once a minute. If you see that line, check that your RPC
  operators are reachable. Blocks with a release, RPC-directory or BTC-order op still wait for two operators.
  The second operator's copy of each chat block is fetched ahead, eight at a time, so catching up stays fast.
- A refused live-chat stream answers **403** (not 401, which BunkerWeb's bad-behaviour ban counts: many visitors
  behind one address would otherwise get it banned for an hour). A stream whose visitor leaves while its ticket
  is checked no longer keeps its slot.
- The sign-in pairing wait (`/v1/login-pairing/<id>/wait`) is relayed unbuffered too.
- A desktop paired before this version gets live chat back after pairing again; until then it still updates
  every few seconds.

## Also in this version: password fields

**The settings page no longer stays blurred.** Opening Settings from the avatar menu in Firefox left the whole
page grey and blurred until the next click. The browser's password manager had written the saved user name
(for example "morphit") into the "Also show orders in" language field as the page loaded; that opened the
field's list, and the open list blurs the page behind it.

The same mistake happened elsewhere, found while fixing it and seen in Firefox: the saved user name went into
the **memo of a BLURT transfer** (a memo is public on chain) and into the **amount to power up**, and the saved
Morphit password went into the **Active key** box of "unlock with your Active key".

**Upgrading:** `sudo morphit-ops upgrade` on every server. No database change.

### What changed

- **Every Morphit password field is a form of its own**, with your account name as its user name (hidden,
  read-only). Firefox's password manager now keeps to that form: it never writes into another field of the page,
  and it offers the password saved for the account you are signed in with — not the password of another account
  saved in the same browser. This covers Settings (change password, hardware key), sending BLURT, power up/down,
  paying in chat, the chat fee, featuring an order, posting an order, backing up keys, sign-in, two-factor
  setup, creating an account and importing one.
- **A box for a key (an Active key, a secret) starts read-only** and becomes writable the moment you touch it or
  move to it with the keyboard. Firefox does not fill a saved password into a read-only field. Pasting and typing
  work as before.
- **A search-and-pick field (language, currency, payment method) opens its list only for your own typing.** If a
  browser or an extension writes into it, the text is cleared and nothing opens.
- A new password set in Settings, or while importing an account with its posting key, is now offered for saving
  under your account name.

### Good to know

- If Firefox saved your Morphit password **without your account name**, it no longer fills it into these boxes.
  Type it once; Firefox offers to save it under your account name.
- Firefox still offers to save anything typed into a box that shows dots — the key icon in the address bar —
  including an Active key typed into "unlock with your Active key". Websites cannot switch that off. For a key,
  choose "Not now" ("Never save" would also stop it saving your Morphit password): Morphit uses the key once and
  forgets it, and it should not sit in a password list.

### For operators and contributors

- A new check runs with the other smoke tests (`password-field-scope-smoke`): every password field in the web
  app must be a Morphit-password field inside `<PasswordScope>` (or a `<form>` with a `<LoginNameField>` right
  before it), or a key field that starts read-only and unlocks on touch or focus.
- Another new smoke (`ops-harness-anchors-smoke`) runs every mutation harness in `ops/test` with its slow test
  runs skipped, and fails when a planted bug no longer lands on the code it names. 37 of them had stopped
  landing (the code had moved), so the bugs they stood for were guarded by nothing; all are re-anchored (or
  retired with the reason, where the code they named no longer exists). Nine more landed but were no longer
  caught: seven are caught again, and two are retired because they change nothing on any path that still exists.
- The smoke runners keep a failing smoke's whole output (`MORPHIT_SMOKE_FAIL_DIR`, default the temp folder) and
  print where. A test in one workspace no longer imports another workspace's source
  (`noWebSourceImports.test.ts`): the web app's needs a generated folder that a fresh checkout lacks.
- Dependencies: sanitize-html 2.18.0 → 2.18.1 (used by the Matrix bot; GHSA-c9rx-x947-fp3h, unbounded recursion);
  dompurify 3.4.16 → 3.4.17 (used by the PDF export library; GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr,
  GHSA-c6gr-qvv4-5v3f); ip-address 10.7.2 → 10.7.4 (used by the MCP server's rate limiter; GHSA-rxp7-6hxx-x8q5).
  A new Vite advisory (GHSA-rq7h-c2jc-7f22, `server.fs.allow`) concerns only the Vite dev server, which no node
  runs; triaged in `scripts/audit-allowlist.json` (the fix is in Vite 6, a major upgrade).
