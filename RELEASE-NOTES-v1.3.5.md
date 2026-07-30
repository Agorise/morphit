# Morphit v1.3.5

## Your chat inbox is now an inbox of conversations, not of people

If you and the same trader have talked about three different orders, that is three different discussions — and now three different cards, newest at the top, each with its own `RE:` line and its own transcript. Open one and you see only the messages about that order. Messages that aren't about any order get their own card, with no `RE:` line at all.

Each `RE:` line also tells you what the order is doing right now — **(Live)**, **(Cancelled)** or **(Expired)** — on the inbox card and at the top of the conversation. A discussion about an order that no longer exists says so before you open it.

Reading one of them marks **only that one** read. Three unread conversations with the same person stay three unread conversations, exactly as they would in an email client — on this device and on every other device you sign in from.

Avatars on the inbox are larger, sized to the text beside them.

Threads about an order that was cancelled or expired stay open: you and the person you were dealing with can keep talking. (Strangers still can't start a new conversation by pointing at a dead listing.)

> **Note:** conversations you already have will split into several cards, one per order you've discussed. Nothing is lost — your messages are on the blockchain, exactly where they were.

## Fixed: "Missing Posting Authority"

Signing into two accounts in two browser tabs could leave one tab holding the first account's keys while believing it was the second. Everything it broadcast — display name, short bio — was rejected by the blockchain, which answered with three key authorities in a red box.

Morphit now stores your account name against the key that owns it, so two tabs can never trade places. Before anything is signed, it checks that the account it's about to speak for really lists the key it's about to sign with. If that ever fails, nothing is broadcast and you get a sentence you can act on instead of a chain dump.

## Fixed: the avatar menu

The menu could get stuck open, with the page dimmed behind it and clicks going nowhere. That's fixed. The blur now covers the whole page, including the bar at the top.

## Also in this release

- On the chat page, the "Read the full walkthrough" link turns green on hover, like every other arrow link on the site.
- The chat header now sits on the same soft green used by the FAQ, so it reads as its own band between the toolbar and the conversation.
