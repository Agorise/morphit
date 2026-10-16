# Morphit v1.21.9

**Offline notifications.** A user can now ask for a short note on an app she already uses — Matrix,
Session, XMPP, Telegram or email — when someone sends her a chat message while she is away. The note
says only "Someone just sent you a chat message on *your site*", with a link that opens that
conversation for her alone; never who wrote or what. It is off until she turns it on, on the apps you
choose to offer, and her address is kept encrypted under a key outside the database, never shown to
anyone and left out of backups. Also: script files no longer fail to load with "429 Too Many
Requests" behind BunkerWeb, and a small fix that lets the W3C validator accept every page.

**Upgrading:** `sudo morphit-ops upgrade` on every server. One database change (migration v69, seven
new tables, all local: never published in snapshots, never in backups), applied by the upgrade.
Offline notifications stay off until you set up at least one app with
`sudo morphit-ops offline-notify` (also in the `sudo morphit-ops` menu); see
[OPERATIONS.md §54](../OPERATIONS.md). The 429 fix reaches BunkerWeb boxes on this upgrade (see
below). **Every instance must run v1.21.1 or later before 2026-11-01 00:00 UTC.**

## Offline notifications

- **For your users.** *Settings → Offline Notifications*: she picks an app you offer, types her
  address, and confirms it with a code sent there (Telegram the other way round: she sends your bot a
  code, and a button does it for her). From then on, a chat message that reaches her while she is away
  earns her a note there, in her language: "Someone just sent you a chat message on Vigilante Trading.
  Open it here to read it and reply: …". She can change an address (the old one keeps working until
  the new one is confirmed — cancel, a code that never arrives, expires or is typed wrong five times
  gives her the old one back, and it keeps getting her notes meanwhile), turn one app off, or delete
  every address at once.
- **When a note goes.** A random 10 to 60 minutes after the message, and only on a quarter hour
  (:00, :15, :30, :45 UTC) — the same moments for everyone — so a note's arrival does not point at one
  message on the public chain. None while she has the site open (her browser tells the relay once a
  minute, kept in memory only), none once she has read the conversation or replied, one per
  conversation until she looks, at most one a day from someone she has never written to, none from
  someone she has blocked since, at most 20 a day. A note that reached none of her apps is tried again
  twice, and does not count as one she was given.
- **How her address is kept.** Sealed with AES-256-GCM under a key in the relay's own state folder
  (`/var/lib/morphit-relay/offline-notify.key`), never in the database, and padded to one size, so a
  copy of the database opens none of them. Nothing sends an address back to a browser, not even to
  her: once saved, the card shows only "On". It is never in a log, a backup or a snapshot. A relay
  that finds its key missing or replaced turns notices off rather than make a new key over the saved
  addresses; *Start over* in the wizard (offered only then) deletes them and makes a new one.
- **Signed, once, for your site.** Every request is signed with her posting key — the key as two of
  your RPC operators agree it is, and one that signs for her on its own — for your relay only, and
  each signature works once, within five minutes. A link in a note opens the conversation only for
  her account.
- **Not a spam cannon.** At most 6 codes a day per user, 3 of them to one address, and 5 a day to one
  address whoever asks. Past those 5 the card still says the code was sent (nothing is), and every
  "send me a code" is answered eight seconds after it arrived whatever happened, so neither the answer
  nor its timing tells anyone whether an address was used today. On a hidden site every visitor
  reaches your relay from the same address, so only failed requests that cost the relay something
  count against an address's limit, and a user whose key was seen within a day is still let through
  (within a small shared budget per second) while that address is being flooded.
- **Honest about the apps in between.** Apart from Session (end-to-end encrypted), the servers that
  carry a note can read it: they learn that she uses your site and when a note came — never who wrote
  or what. And to deliver anything, her address goes to the provider of the account your notes come
  from. The card and a new FAQ answer ("How do offline notifications work, and how is my address
  kept private?") say so plainly, and "What data does it collect about me?" now lists the address she
  gives for them.
- **Matrix rooms are left.** The bot leaves and forgets every chat no saved address holds any more —
  a removed or changed address, a code nobody confirmed, a first message that failed — retrying for
  about two days when your homeserver does not answer.
- **Setting it up.** `sudo morphit-ops offline-notify` asks for the account your site sends from for
  each app, tests it (a real note to an address you type, or for Telegram the token checked with
  Telegram), saves it to `/etc/morphit/relay-notify.env` (`root:morphit-relay 0640`; the wizard
  changes only its own lines), restarts the relay and checks the app is offered. *Turn an app off*
  deletes every address saved for it first. On a Tor-only site only `.onion` servers can be used, and
  Telegram and Session are not offered.
- **What your WAF records.** BunkerWeb's ModSecurity rule for the relay's paths now turns ModSecurity's
  rules off there and, belt and braces, its audit log and request-body reading too, so the WAF never
  records what she typed (the upgrade brings the older rule up to date).

## Script files no longer fail with 429 behind BunkerWeb

- **What happened.** Some visitors' browsers logged "Failed to fetch dynamically imported module" on
  first visit: BunkerWeb's own catch-all request limit (2 per second, counted per visitor and per
  file) answered 429 when the browser fetched the same script file three times within a second (the
  page, the offline cache, the tamper check).
- **Now.** The site's own files are not limited; the 2-per-second limit stays only on IPFS, RSS and
  MCP. BunkerWeb also allows 256 parallel streams per connection (it allowed 100, fewer than nginx's
  128). The upgrade fixes boxes that still have BunkerWeb's defaults (your own values are kept),
  recreates BunkerWeb and checks the home page three times in a second; if it still gets a 429 it
  tries once more, then tells you the command to run. Bare-metal nginx's connection limit per visitor
  is raised from 40 to 256 likewise.

## Smaller changes

- The no-JavaScript style moved from the page body into its head, where the W3C validator accepts it;
  pages look and behave the same with and without JavaScript.
- The FAQ search finds "notify me by email" and similar questions (new words: notify, notified,
  writes; filler words by, me, am, at).
