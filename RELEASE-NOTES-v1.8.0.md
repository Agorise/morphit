# Morphit v1.8.0

## When you complete a trade, the people you *didn't* pick now hear back

You post an order. Fifteen people message you wanting to trade. You pick one, pay them, and leave feedback — done. But the other fourteen are still sitting there, watching a conversation that has quietly become pointless, waiting for a reply that was never coming.

Now it comes automatically. The moment you complete a trade with someone, everyone else who messaged you about that same order receives a short, friendly note — in their own language — letting them know the order was settled with another trader. You write nothing. You don't reply fourteen times. And their note never names who you traded with.

It reaches everyone who asked, no matter how busy your inbox is.

## "Three different people asked about my order. Is that three conversations or one?"

Three. It was always meant to be, and now it provably is.

Each person who messages you about an order gets their own thread, tagged with that order, that you can answer on its own. If the same trader talks to you about two different orders, that's two threads — because they are two different conversations. Your inbox is organized around discussions, not just people.

## The chat cards on your phone had no room to breathe

On a narrow screen a chat card was trying to show a name, what the conversation was about, a feedback line, a gold star, *and* a timestamp — all crammed into the same strip. Something had to give, and it was readability.

The "2h ago" now lives in a tooltip you can tap for the full timestamp — day, month, and the exact time in UTC. The star moved up to the top corner of the card. And with those two out of the way, the name, subject, and feedback lines finally get the full width of the card, trimming with an ellipsis only when they truly run long.

## The scary red bar after an update is gone

When your Morphit instance got a new version, some of you saw a large red banner across the bottom of the screen — sometimes with a bluish bar and a Refresh button stuck on top of it. It looked like something had broken. Nothing had; it was only telling you a new version was ready.

There was never a reason to alarm you about good news. That whole apparatus is gone. When a new version is ready you get the same calm "Load it now" message you already know — take it or dismiss it, your call.

## The browser tab sometimes showed the wrong page

You would be sitting on the chat page and the tab would announce "Browse Offers." Or you would land somewhere and see "Conversation" for a page that was nothing of the sort. The title is now pinned to the page you are actually on, every time.

## The listing fee floor

BLURT's price has roughly halved since the floor was last set, so the minimum listing fee — which is measured in real-world value, not a fixed number of coins — is now 125 BLURT, to keep it near the same twelve-and-a-half cents it has always been. If BLURT's price climbs, the number comes back down. It tracks the value, never a hardcoded coin count.

## The missing-message mystery, solved

A few of you hit something genuinely maddening: a notification badge would light up saying you had a message, you would open your inbox, and there was nothing there. Refreshing didn't help.

The message was real and it had arrived. What had gone stale was the *website itself* — served to your browser from a cache that never expired, so you were looking at an old copy of Morphit that didn't yet know how to show the new message. A hard refresh fixed it, but you should never have needed to know that.

This release hardens how every Morphit instance serves its own updates, so a stale copy can't get stuck on your device — and it ships a check that warns an operator right away if their server is set up to let it happen. The whole class of problem is closed, not patched around.

## For people who run Blurt RPC nodes

You confirmed you can see `Morphit/<version>` in your access logs now — thank you. On the strength of that, the old workaround that forced the identifier into place is gone, and the relay's own Blurt traffic now identifies itself the same clean way the indexer does.

## For people setting up a node

Generating your instance's alt-network (I2P and Tor) addresses can take a few minutes with nothing obvious happening on screen. There is now a spinner and a plain "Stand by, generating alt-dns addresses (this might take a few minutes)…" so you don't assume it has hung and kill it halfway. The node-setup and operations guides also got shorter and steadier where they safely could.

## Smaller things

- "Cancelled" is now "Canceled" everywhere it appears — it reads the same and takes less room on a crowded card.
- The last-resort fallback prices, used only if live pricing is briefly unreachable, were refreshed to the current market.

## Under the hood

- The auto-reply above is end-to-end encrypted per recipient, carries no text on the wire (each person's app renders the note in their own language), and can only ever reach someone who already messaged you — so it can never be turned into a way to message strangers.
- Removed a pile of dead inbox machinery left over from an older design that the current thread model long ago replaced.
