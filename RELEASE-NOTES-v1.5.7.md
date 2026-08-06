# Morphit v1.5.7

## Chat notifications now land in seconds, not a minute

If someone replied to a conversation you'd **archived**, Morphit did the hard part right: the notification reached you in about six seconds. Then nothing else happened for a minute. No badge. No message in your inbox. If you went looking, you'd eventually find it sitting in your Archived folder.

Two symptoms, one cause. Morphit has a fast path that tells your browser "a message just arrived", and a slower path that writes it into the searchable history about a minute later. The badge was being lit off the *slow* one — because an archived conversation doesn't count toward your badge until something pulls it back into your inbox, and the only thing that did that was the slow path.

So the fast message arrived, was quietly set aside for being archived, and waited a minute for the slow path to catch up and give it permission to matter.

Now the arriving message does that job itself: a reply to an archived conversation pulls it back into your inbox and lights the badge straight away — whether you're on the chat page, somewhere else on Morphit, or looking at another tab entirely. Same six seconds as the notification.

**Starred conversations are deliberately left alone.** A message in a starred conversation already lit your badge correctly, and moving it to your inbox would have thrown away the star you put there on purpose.

## Moving a conversation to a folder sticks now

Star or archive a conversation, refresh the page straight away, and your change would undo itself — reappearing about a minute later.

It wasn't slow. It was being **reversed**. Your change saves instantly on your device and then takes about a minute to travel to the blockchain and come back. Refreshing inside that window asked the blockchain what your folders looked like, got an answer from *before* your change, and believed it over you.

Morphit now checks which one is actually newer. Your change wins until the blockchain has caught up; a change you made on your phone still wins on your laptop. Nothing about how folders are stored changed, so other Morphit instances are unaffected either way.

While fixing this we found something related: a reply that arrived while you were away could get permanently buried in Archived, because every page load quietly reset each conversation's "archived on" date to *right now* — making every real message look older than the archive. That's fixed too.

## The chat now opens on your newest message

Opening a conversation was still sometimes dropping you into the middle of it. There was already code meant to hold you at the bottom while the page finished drawing — it just never got the chance to run. Setting the scroll position makes the browser announce that the page scrolled, and Morphit was treating its own announcement as "the user grabbed the scrollbar" and standing down immediately.

So it jumped to the bottom once and let go, and anything that loaded a moment later — a font, a payment receipt, a message still being decrypted — pushed your newest message back under the fold.

It now waits until the conversation has actually stopped growing before letting go, and it still gets out of your way the instant *you* scroll.

## "Pay now" no longer appears on a finished trade

A conversation about a **completed** trade was still offering the "Pay now" and "Share crypto address" buttons across the bottom — on a trade that was already paid, closed, and receipted by both sides. That's not just clutter; it's an invitation to pay twice.

The same was true of **cancelled** and **expired** orders. Those buttons now disappear as soon as an order is finished, whatever finished it.

## Payment Receipts read like receipts

- The date and time now appear **on the receipt itself**, on the "BLURT SENT" / "BLURT RECEIVED" line: *"BLURT SENT on 14 May, 2026 @ 05:03:22 UTC"*. That's where a receipt should say when it happened.
- The pop-up date that used to follow your mouse anywhere over the receipt is **gone**. It was showing you something now printed on the card.
- The receipt is no longer **clickable-looking**. It behaved like a link that went nowhere.
- The **"Verify on block explorer"** link is no longer permanently underlined. The underline appears — as dots — when you hover or tab to it.

Ordinary chat messages still reveal their timestamp when you tap them; that's the only place to see it for those.

## Order terms: markdown fixes

- **The markdown help tooltip wouldn't go away.** If your mouse happened to rest on the little markdown icon while you typed, its help bubble sat over the text you were writing until you jiggled the mouse — because a hover bubble can only be dismissed by *moving*, and your hand was on the keyboard. It now disappears the moment you start typing, and you can dismiss it with the Escape key.
- **Blockquotes are now indented.** A `> quoted line` in your order terms had a green bar beside it but sat at the same margin as everything else, so it didn't read as a quote. It's now properly set in from the surrounding text.

Quotes and lists also now sit on the correct side for right-to-left readers (Persian), where they'd been indenting off the wrong edge.

## For operators

- **No database migration. No on-chain format change.** v1.5.7 is backward-compatible in both directions; a federated instance still on an older version keeps working.
- **Morphit is politer to Blurt RPC nodes now.** A node operator asked us for four things: slow down, batch requests, back off when refused, and add jitter. Backing off was already in place. The other two we could do, we did:
  - **A request-rate ceiling (10/second per node).** Normal running is well under one request a second, so you won't notice — but when an indexer catches up after downtime it used to fetch blocks back-to-back as fast as a single node would answer them. That burst is what looks like abuse from the node's side. Catch-up is still roughly thirty times faster than Blurt produces blocks, so a day of downtime still recovers in well under an hour.
  - **Jitter on the back-off timers.** Every Morphit instance a node turned away was being told to wait the same 30 seconds, so they all came back at the same moment and set the limit off again. The wait is now spread ±25%. The average wait is unchanged — they just stop arriving in lockstep.
  - **Batching is not in this release.** It needs testing against a live Blurt node, and we won't ship untested code into the part of the indexer that would stop your instance syncing if it were wrong.
- **Nothing in this release changes what `/v1/health` or `/v1/rpc-endpoints` return.** The rate-limiter's internal state is deliberately not published.
