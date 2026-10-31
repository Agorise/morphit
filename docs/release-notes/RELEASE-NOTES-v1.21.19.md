# Morphit v1.21.19

A fix release for what the owner ran into on the first day of v1.21.18. Nothing about fees, trades or the chain
changes.

## For people using the site

**Re-listing an expired order keeps every choice.** "Re-list" opened the post form with step 3, "Which cryptos will
you accept?", empty, or filled with the cryptos of an older saved draft. It now carries over the cryptos the order
accepted, and also the stablecoin network (USDT, USDC, DAI) and the post's language, which were lost too.

**The orderbook's Filter card starts closed.** It opened by itself on every visit once a language filter was stored
in your browser, which happens when you once picked languages in the orderbook or in Settings, even if you never
opened the card. It now opens only when you click it. While a language filter is on, the card's title row says so
(for example "Language: English, Español"), so a filter never hides orders without you seeing it.

**No false "Build integrity check failed" after an upgrade.** A browser that had visited a site shortly before it
upgraded could keep showing the red banner, though the site served the signed release exactly; clearing the site's
data made it go away. The check now asks the site itself for the files whose name stays the same from one release to
the next (the page and the service worker), and the site's service worker no longer answers that question from a
copy it stored earlier. While the previous release's service worker still runs the tab (until "Load it now", or until
every tab of the site is closed), the check judges only the files that worker cannot answer from what it stored (its
own script and the app's code files), so a changed service worker still raises the alarm; the page itself is checked
once the new worker takes over, and "About this instance" says it is waiting for that instead of "Loading…".

**Matrix notifications arrive in one chat.** See "For operators".

**A busy site says so.** If the site is briefly too busy to save a change to your offline notifications, the page now
says so and asks you to try again in a moment, instead of a plain "failed".

## For operators

**The database schema moves to v71** (a new local table and column for the Matrix chats, below; nothing the federation
shares). A node on v1.21.18 or older cannot fast-sync from a snapshot made by a v1.21.19 node: it downloads it and
then refuses it with "snapshot schema v71 is newer than this build's v70 — upgrade this node before restoring". Upgrade
first, then fast-sync. A v1.21.19 node restores older snapshots as before.

**Offline notifications by Matrix use one chat per address, and keep it.** The bot left the chat right after the
test note, and opened a new chat for every message it had no chat on file for (the test note, and each "send me a
code" in Settings). Now:

- the test note, the codes and every notification go into the same direct chat, and the bot never leaves it because
  a message was sent;
- which chat belongs to which Matrix address is kept in the relay's database (a new table,
  `offline_notify_matrix_rooms`: a keyed hash of the address and the sealed room, no account; left out of backups and
  snapshots like the other offline-notice tables), so the bot finds it again after a restart, and two notes sent at
  the same moment end up in one chat. On the upgrade, an address that had several chats keeps its newest one and the
  bot leaves the others;
- someone who left the chat is invited back into the same chat with their next note;
- a new chat is opened only when the bot can no longer write to that person in their chat (it is no longer in it, or
  they cannot be invited back), never because the homeserver was slow, down, limiting the bot or refusing it
  everything (the note is then sent again later);
- new chats are private: only the bot can invite anyone into them, and someone invited later does not see the
  messages before. A chat opened by an older version (where the user could invite others) is used only while nobody
  else is in it, and replaced otherwise;
- the bot leaves a chat only once no saved address of any account is the address of that chat any more (waiting for
  its code, confirmed, or kept while a new one is confirmed). A user asking for a code twice, or another account
  typing the same address, never makes it leave the chat a code is on its way to;
- the address of your latest test note is kept (sealed, like your users' addresses), so its chat stays until you turn
  Matrix off. Turning Matrix off (`sudo morphit-ops offline-notify`, "Turn an app off") leaves every chat the bot has
  for notes, your test note's too. If it stops after deleting the addresses, it now says how many are deleted already,
  never "Nothing was changed";
- a homeserver too slow for the test note now gets a plain "the Matrix server took too long to answer … Please try
  again in a few minutes" instead of an error code, and a test note is no longer sent when the relay's saved addresses
  cannot be opened (the wizard says so), so no chat is left behind that nothing keeps.
- the bot leaves chats one at a time, without holding up anyone's settings or the relay's database;
- right after the upgrade, offline notices may be off for a moment, until the indexer has updated the database. They
  come on by themselves, with no restart needed.

This is the relay's notification bot. The operator alert bot (`sudo morphit-ops matrix`) already kept one chat.

**`upgrade --from-file` reads the path the way you typed it.** `--from-file=~/Downloads/<bundle>` and a path relative
to the folder you are in now work. Before, a `~` right after `=` (which the shell leaves as it is) and any relative
path were looked up inside `/opt/morphit/apps/ops-cli`, so only a full path worked.

## For monitoring scripts: changed JSON

- `GET /v1/orders/:account`, the single-order read and `GET /v1/accounts/:account/trades` now also return each
  order's `asset_network` (`null` unless the asset is a multi-network stablecoin) and `lang` (the post's language, or
  `null`), as `/v1/orderbook` items already did — the shape docs/API.md gives them. Nothing was removed or renamed.
