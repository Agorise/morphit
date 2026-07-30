# Morphit v1.4.5

## Sending a chat message is quick again

Sending a message could sit on **"Sending…"** for up to a minute before it went through — and once in a while a second message looked like it never arrived at all. Both came down to the same thing: behind the scenes, a sent message was being fired to two chain nodes at once, and the second copy would stall until it timed out. Messages now go out through a single path and land in a second or two, the way they should.

## Your profile changes show up right away

Change your display name, short bio, links, or avatar in **Settings** and you had to wait — sometimes a minute and a half — before the new details replaced the old ones elsewhere in Morphit. Now the moment your change is confirmed on-chain, it shows immediately everywhere your profile appears: the menu, your own order cards, and every place your name turns up.

Related: right after Morphit updates itself (the "Load it now" refresh), your own orders on the orderbook could briefly show the plain placeholder icon and no name until you refreshed the page by hand. Your avatar and name now fill themselves back in on their own.

## New messages jump to the top of your inbox

When a fresh message comes in, its conversation now slides up to the top of your inbox on its own, without a page refresh. (If you've asked your system to reduce motion, it simply moves without the animation.)

## Also in this release

- The unread badge and the **"Mark all read"** action are back in sync — the badge no longer lingers after you've cleared everything, and "mark all read" clears the conversations it should.
- Short chat bubbles (a quick "hi") no longer stretch across the width of the screen.
- The emoji on the sign-in and register buttons line up evenly on mobile, in every language.
- Inbox cards line their avatar and text up neatly.
- Some background chain lookups were pointed at nodes that answer cleanly, clearing a batch of harmless-but-noisy browser console errors.

## For operators

- **The warrant canary no longer goes dark when one chain node is down.** The daily canary refresh used to ask a single hard-coded node for the current block; when that node's certificate broke, the whole `/canary.txt` went missing site-wide. The refresh now walks the same rotating list of nodes the rest of Morphit uses — the first healthy one wins — so a single bad node is skipped automatically. If you want to pin it to one node anyway, `MORPHIT_CANARY_BLURT_RPC` still does that (it's now optional).
- No database changes ship in this release, and nothing here changes the on-chain release format — a build can be rolled back over it safely.
