# Morphit v1.4.0

## Star the conversations that matter, archive the ones you're done with

Your chat is already an inbox of conversations — one card per order you've discussed. Now those cards live in three tabs.

- **Inbox** is everything active, newest at the top, just as before.
- **Starred** is the handful you want to keep an eye on. Tap the star on any conversation — on the inbox card or at the top of the conversation itself — and it moves here. Tap it again to send it back.
- **Archived** is for discussions you're finished with. Each card has its own **Archive** button; archived conversations drop out of the Inbox but are never deleted, and **Restore** brings any of them back.

Archiving an unread conversation also clears it from your unread count, so a discussion you've decided to set aside stops nagging the little badge in the corner.

Nothing here talks to the blockchain — your folders are private to you, kept on the device you're using, and cleared when you lock your keys.

## Account pages in the explorer open right away

Looking up an account used to mean staring at "Loading account…" until every last piece — balance, keys, avatar, and the full operation history — had arrived. Now the page appears the moment the balance is known, usually after a single round-trip. The keys and avatar fill in as they load, and the operation history streams in underneath behind a small "Loading operations…" note, so the page is useful immediately instead of blank until the slowest part finishes. If the history can't be fetched, you get a short line saying so rather than an empty page.

## Your notification settings now cover push notifications too

The order / chat / feedback switches in **Settings → Notifications** used to govern only the alerts you saw with Morphit open in front of you. Push notifications — the ones that reach you with the tab closed — ignored them and always came through.

They don't anymore. Turn a category off and that kind of push stops arriving on this device; turn it back on and it resumes. The choice syncs the moment you flip the switch, on each device separately. (Chat pings are on by default, so a fast-moving trade still reaches you unless you say otherwise.)

## Notifications arrive faster

Push notifications now go out within a couple of seconds of the event instead of waiting in a queue. Combined with the block time of the chain itself, that keeps a "new message" or "your order" alert comfortably inside a few seconds end to end.

## Fixed: an order message could notify you twice

When a message about one of your orders arrived while Morphit was open in a background tab, you could get **two** notifications for it — one from the open tab, one from the push. Both are now tagged the same way, so your browser shows a single notification for a single message.

## For operators

- **`morphit-ops upgrade` no longer cries wolf about your database.** Every ordinary upgrade used to print "your database may need a reset," even though the numbered migration it ships applies itself automatically. It now says that only when the schema truly changed in a way an existing database won't pick up on its own — so the warning means something the day it finally appears.
- **Two automatic database changes** ship in this release (a per-category push preference on subscriptions, and a shared tag on the push queue). Both are applied for you when the indexer starts, need no action, and are safe to roll a build back over.
- The push-delivery worker's default drain interval is now **2 seconds** (it was 30). If you set `MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS` yourself, your value is kept.

## Also in this release

- Loading text that ends in "…" now types its dots out one at a time (and holds still if you've asked your system to reduce motion).
- Rows in an account's operation list tint the same soft green as the FAQ when you hover them.
- The download-mirror cards show a hand cursor, so it's obvious they're links.
