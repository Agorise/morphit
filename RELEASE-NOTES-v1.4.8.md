# Morphit v1.4.8

## Your replies now reach the right conversation

This is the big one. When you're chatting with someone about a **specific order** and you send a message, that message now lands in *that order's conversation* for the other person too — reliably, in a second or two.

Before this, something subtle could go wrong: if you opened a chat one way (say, from your inbox) and then moved into an order discussion with the same person, your messages could quietly file themselves under the *wrong* conversation. Both people were sending fine, but each was looking at a different thread — so it looked like the other person had gone silent, when really their replies were just sitting in another conversation. That's fixed. Messages now always go where you're looking.

## A cleaner sent message

Sending stays fast — the moment your message goes out, the bubble stops looking busy and it's on its way. We've removed the little **✓ Sent** tick that used to appear next to it; a few of you found it more clutter than comfort. Nothing about the speed changed, just the extra checkmark is gone.

## "Mark all as read" where you'd expect it

The **Mark all as read** button now shows up on whichever tab actually has unread messages — your Inbox or your Starred list — instead of only appearing based on your overall total. It stays out of the way on the Archived tab, since there's nothing to mark there.

## A few chat touches

- Opening a conversation now shows a friendly **"…is loading… Say hi!"** while your history comes in, instead of looking empty for a moment and making you wonder if anything's there.
- The action buttons in a trade chat (share address, share mailing address, record shipment, and the pay/funds button) now all share the same clean green outline, so the bar looks tidy on phone and desktop alike.
- The **Contact** link in the footer once again reliably flashes a gentle highlight around the instance you're actually on when it takes you to the instances page.

## Clearing a profile field now sticks

If you emptied your **bio**, your **Nostr link**, or your **blurt.media link** and saved, the old value could stubbornly hang around. Now clearing a field and saving actually clears it — the same way removing your avatar already worked.

## Notifications reach you on other tabs

If a new message arrives while you're off in a different browser tab, the little unread badge on your Morphit tab now updates right away, so you'll notice without having to click back first.

## Also in this release

- Fixed a quiet under-the-hood error during page navigation that could interrupt other things loading. You'd never have seen a message, but it's tidier now and one less thing that can misbehave.

## For operators

- **The message-delivery problem some of you saw was order-thread routing, not the network.** Messages were always being delivered on time; a client-side bug filed order-related messages under the wrong conversation, which looked like slow or missing delivery (and made the live fast-path seem broken when it wasn't). This release fixes the routing so both sides always see the same thread.
- **A built-in chat tracer ships with this release, switched fully off.** If you're diagnosing a delivery question, you can turn on a detailed, privacy-safe console trace by adding `?chatdebug=1` to the chat URL (or `localStorage.setItem('morphit.debug.chat','1')`). It logs message *metadata only* — never message contents — and does nothing at all unless you switch it on.
- No database changes ship in this release, and nothing here changes the on-chain release format — a build can be rolled back over it safely.
