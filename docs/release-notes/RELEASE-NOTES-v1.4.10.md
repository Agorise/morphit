# Morphit v1.4.10

## Archived chats speak up when there's something new

If you've tidied a conversation away into **Archived**, it used to stay quiet there — even if the other person sent you a brand-new message. Now, when a fresh message arrives in an archived chat, that conversation quietly comes back to your **Inbox** and lights up your unread badge, so you never miss someone reaching out.

Conversations you've simply read and left archived stay put — it's only genuine new activity that brings one back. And it works even when Morphit is open in another tab or you're off on another page: the little badge still lets you know something's waiting.

## A cleaner look when you're typing

The boxes you type into — search fields, the amounts on an order, your chat message, and more — now show a single, crisp green outline the moment you tap into them. Before, a few of them drew *two* green edges stacked together, which looked a little off. Now every field across Morphit highlights the same clean way.

## Clearer help when notifications won't turn on

Whether notifications will switch on depends a lot on which browser you use, and the old advice wasn't always right for yours. Now, if notifications can't turn on, Morphit recognizes your browser — **Brave**, **Firefox**, or **Safari** — and shows the exact setting to check for *that* browser, step by step, instead of a one-size-fits-all message.

As always, Morphit's notifications carry no message content — only a nudge that something happened.

## A small tidy-up

- **A stray pop-up is gone.** Sending a chat reply used to sometimes flash a little "moved to Messages" note that didn't mean anything — Morphit doesn't have a separate "Messages" area. It's been removed. Sending a message is just sending a message.

## For operators

- **A harmless upgrade warning is fixed.** When upgrading to the previous release, `morphit-ops upgrade` could print a "schema changed in place" warning even though nothing was actually wrong — it was reacting to a blank line in the schema file, not a real change. That's now fixed. You may see it *one* last time on the upgrade to this release (from the older tool still on disk); after that it's gone. Your database was never affected — `morphit-ops doctor` confirms it.
- **The chat tracer is still here, still switched fully off.** If you're ever diagnosing a message-delivery question, you can turn on a detailed, privacy-safe console trace by adding `?chatdebug=1` to the chat URL (or `localStorage.setItem('morphit.debug.chat','1')`). It logs message *metadata only* — never contents — and does nothing unless you switch it on.
