# Morphit v1.24.1

The browser tab no longer shows unread messages you have already read.

This release contains everything in v1.24.0. The deadline v1.23.5 set still stands: every site must
run v1.23.5 or later (so this release is fine) before **2026-11-22 00:00 UTC**.

## For people using the site

**A tab left open in the background shows only what is really unread.** A Morphit tab left open
could show "(2)" in its title, with a red dot on its icon, for messages you had already read on your
phone or that were not new at all. The count went away the moment you looked at the tab, and there
was nothing new in your inbox. Three things caused it, and all three are fixed:

- **A message you read on your phone or in another tab stayed counted.** A new message lights
  the badge as soon as it arrives, before the site's records have it. The tab then waits for those
  records to catch up. It dated the message by your computer's clock when the alert arrived, a
  moment after the message's real time on the chain, so the records never seemed to catch up.
  Every alert now carries the message's own time.
- **A tab in the background checked for news only when a new message came in.** Reading a message
  elsewhere isn't news, so the tab never found out. It now also checks about once a minute, and
  drops a message the site's records still don't confirm after 10 minutes.
- **A tab that had locked itself still counted.** When the Start button says "Unlock", the tab
  knows nothing of what you have read, so every new message counted, read or not. A locked tab now
  shows no chat count, as it was meant to, and unlocking brings back the right count at once.

**A message you read on your phone stays read on your computer.** A message often reaches you
before it is written to the chain. If you opened the conversation and read it then, your other
devices showed it as unread once it was written, until you opened it there too. Your site now
recognises that read and counts it for the message, on every device. It never does so when another
message from the same person, which you have not seen, was written alongside it.

**"Mark all read" holds** for a conversation that so far only an alert knows about. It used to show
as unread again once the message was written to the chain. As for every conversation, "Mark all
read" marks it on that device; for such a conversation the mark lasts until the page is reloaded.

A message you haven't read still shows on the tab as soon as it arrives, in the background too.
An alert that reaches a computer late, such as one waking from sleep, no longer lights the tab for a
message you have already read.

Three limits remain:

- If someone sends two messages within the same three seconds and you leave the conversation after
  seeing only the first, the second shows as unread only once it is written to the chain, about a
  minute later. The site keeps your place by time, and the two share it.
- For the same reason, a second alert for a message you have just read, such as one arriving late,
  can show it as unread on that device for a minute or two, until your site's answer about the read
  comes back.
- The alert's timing works once your browser runs this version's background helper. The site
  offers it with its usual "Load it now".

## For operators

Upgrade as usual. The indexer applies migration v74 when it starts: one new column,
`chat_messages.sent_at`, filled for messages indexed from now on. It changes nothing for an older
indexer, so rolling back stays possible.

A Morphit tab left open in the background, signed in and unlocked, now asks your indexer for its
conversations and read state about once a minute (`/v1/conversations/<account>` and
`/v1/chat-read-state/<account>`), besides when a message arrives. A locked or signed-out tab still
asks nothing. Nothing to configure.

## For developers

- **The message's time travels with every alert.** The indexer's live `chat_activity` ping now
  carries `at`: the message's time (`createdAt`, the head block's time or the sender's signed
  time), as the replay always did. The service worker forwards the Web Push's `eventAt` to the
  tabs as `at`, through `chatPushTabMessage` (`notifications/chatThread.ts`), and the tab passes it
  on to the badge.
- **`chatUnread.ts`.**
  - A pending push is `{ at, seen }`: `at` is the newest pushed message's time, `seen` is when
    its push reached this device.
  - The durable row reconciles it once `last_message_at >= at`, and the read cursor judges it by
    `at`, both on the chain's clock. This device's own acknowledgement and the 10-minute TTL use
    `seen`, the device clock.
  - A time that is missing, invalid or far in the future (`sanitizeBlockTime`) counts as now. An
    older message announced late does not replace a newer one.
  - `recount()` uses the same live-session gate as `poll()`.
  - The channel re-polls when the session locks or unlocks.
  - A hidden tab polls about every `HIDDEN_POLL_MS` (60 s). Each poll recounts, which also drops an
    expired push.
- **The read ack of a fast copy (migration v74).** The chat handler stores each message's signed
  time in `chat_messages.sent_at`: the expiration less the client's 60 s lead, capped at the block
  time. It uses `sentAtFromExpiry`, the rule the fast path dates its copy with, now in
  `indexer/chatSentAt.ts` and re-exported by `chatFastFederation.ts`. Rows indexed before v74, and
  messages applied without their transaction, keep `NULL`.
  - `/v1/chat-read-state` gives a thread's ack as a message's block time when all of these hold:
    - a message of the thread was signed at exactly the ack's time and landed within 75 s of it;
    - no message of the thread has the ack's time as its block time;
    - no other message of the peer's landed between the ack and that message's block signed at or
      after the ack, or at an unknown time.
  - The second condition matters because the signed time is a head block's time, so an ack of an
    earlier message's row can carry the same instant.
  - The third matters because a message can miss a block and land with the peer's next message,
    which the reader has not seen. The rule is never to hide a message to cure a phantom.
  - The earliest such message is the one read. Legacy peer-wide acks (`'*'`) are left alone.
  - Every lookup uses `chat_pair_idx`.
  - The mapping applies to acks sent on chain (the thread view's). The relay's offline notices
    still read the raw ack.
- **The fast-copy cover** (`readState.noteThreadActivity`) now ends on a push of the SAME time as
  the message read. Every push carries its time now, and one at the read message's time may be
  another message signed in the same head block. Keeping the cover would hide that message on this
  device for good; ending it can show the read message as unread until the mapped ack arrives.
  `fastCopyAck.test.ts` pins both sides.
- **"Mark all read"** acks a pushed-only thread at the message's own time when its push carried
  one, with this device's fast-copy cover, as the thread view does. It skips threads the badge does
  not count (archived, hidden, blocked), so it never moves their cursor back. The inbox's
  placeholder cards do the same (`timedAt`). `listFastPending` says whether its time is `timed`, and
  `ackThreadRead` takes a `fastCopy` flag. Like the rest of "Mark all read", these are acks on this
  device only, and the cover is in memory.
- **Tests.**
  - `chatUnread.test.ts` has 18 new tests: a read on another device, before and after the durable
    row lands; a hidden tab learning of it; a hidden tab dropping an expired push; an unread
    control; a locked tab; two messages in a row; an older message announced late; a push
    delivered hours late; a device clock running fast; far-future and invalid times; a push before
    the first poll answers; the inbox card's verdict in the same cases; and "Mark all read" on a
    pushed-only thread, an archived one, and one read further already.
  - `test/integration/chat-read-fast-copy.test.ts` is new (10 tests, real Postgres).
  - `fastCopyAck.test.ts`: a push of the same time now ends the cover, one of an older time keeps
    it.
  - `ackWiring.test.ts` pins that a placeholder card's `timedAt` comes from a timed push only.
  - `test/handlers/chat.test.ts` has 2 more, on `sent_at`.
  - `chatThread.test.ts` is new.
  - `globalChatActivityStream.test.ts` delivers a service-worker message.
  - `chatActivityStream.test.ts` requires the live ping's time.
  - Each part of the fix, undone on its own, fails a test or a smoke: 31 mutations. The one
    exception is the inbox card's own reconcile, which is written as the badge's is; no sequence
    of reads makes the two differ.
- **Smokes.**
  - `fastchat-instance-matrix-smoke` now tells a replay by its coming before `ready`, and requires a
    numeric `at`.
  - `fast-badge-push-contract-smoke` and `chat-fast-notification-smoke` follow the service worker's
    message into `chatPushTabMessage`.
  - `chat-bg-notify-v148-smoke` accepts `pollNow()`.
  - `schema-migration-coverage-smoke` pins schema head 74.

## For monitoring scripts: changed JSON

- The `chat_activity` event of `/v1/chat-activity/:account/stream` carries the message's time in
  `at` (milliseconds) on a live ping too; it was `null` there before.
- `/v1/chat-read-state/:account` may give a thread's `last_read_at` up to 75 seconds later than the
  ack written on chain: the block time of the message whose fast copy the ack read.
