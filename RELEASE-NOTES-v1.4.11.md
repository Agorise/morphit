# Morphit v1.4.11

## Messages in a trade conversation show up right away

When you're chatting about a specific order, new messages from the other person now appear almost instantly — the moment they're sent. Before, a reply inside an order conversation could take up to a minute to show, long enough to wonder whether it had arrived at all. That lag is gone: order conversations now keep pace with the rest of your chats.

## Paying in BLURT is clearer — and works for everyone

The **Pay now** button for BLURT payments got a proper tune-up:

- The amount now **starts filled in** with the order's minimum, so you're not guessing — nudge it higher if you'd like.
- The box accepts **only a valid number**, and shows a clear **red outline** the moment what you've typed is empty, malformed, or below the order's minimum.
- The **Send** button now appears reliably — a display quirk could previously hide it.
- You can now **pay even if you signed in with only your posting key**. Morphit asks for your active key just for that one payment, uses it, and immediately forgets it.

## Tapping a notification takes you to the right place

When you tapped a notification — a new message, a review, an outbid — it could sometimes land on a "page not found." Now every notification opens exactly where it should: the right conversation, profile, order, or review.

## The listing fee, shown in your currency

When you post an order, the small listing fee is now also shown as an approximate amount in **your preferred currency**, right beside the coin amount — so you can see at a glance what it's worth to you, instead of only a dollar figure.

## A small convenience

- When you unlock to post an order, your cursor now lands **right in the password box**, so you can start typing straight away.

## For operators

- **The chat tracer is still here, still switched fully off.** As before, if you're ever diagnosing a message-delivery question you can turn on a detailed, privacy-safe console trace by adding `?chatdebug=1` to a chat URL (or `localStorage.setItem('morphit.debug.chat','1')`). It logs message *metadata only* — never contents — and does nothing unless you switch it on. It's what pinned down this release's message-timing fix.

As always, Morphit's notifications carry no message content — only a nudge that something happened — and none of this changes what Morphit keeps about you: nothing.
