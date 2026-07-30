# Morphit v1.4.9

## Your chat folders now follow you everywhere

This is the big one. However you like to keep your messages organized — a tidy **Inbox**, a few important chats kept in **Starred**, and the rest tucked into **Archived** — that arrangement now travels with you. Star a conversation on your laptop and it's already starred when you open Morphit on your phone. Archive something on your phone and it stays archived on your desktop.

It works quietly in the background, and it's built the private way you'd expect from Morphit: your organization is **encrypted before it ever leaves your device**, using a key only you hold. Nobody else — not the people running a Morphit instance, not anyone watching the network — can see which conversations you keep or with whom. They'd only ever see a scrambled blur.

And nothing hides on you. A brand-new message from someone always lands in your **Inbox** where you'll see it — even the very first time you sign in. Archiving and starring are choices *you* make; a conversation you've never touched simply waits in your Inbox.

## A quick guide to formatting your Terms

When you write the **Terms** for an order, you can use a little Markdown to make them clearer — a heading here, some **bold** there, a bulleted list. Now there's a small **?** next to the Terms box that opens a friendly one-look guide showing exactly what to type for each: headings, bold, italic, quotes, numbered and bulleted lists, a divider line, and links. No need to remember the symbols — just peek at the guide.

## Your orders, tidier

- **My Orders opens on your Live orders.** The page now starts by showing the orders that are actually active, which is almost always what you came to check — instead of everything at once.
- **Smaller, neater action buttons.** The buttons on each of your orders (feature it, review feedback, cancel, re-list) are a touch smaller now, so a busy list looks calmer and fits better on a phone.
- **A gentle note when a filter is empty.** If you tap a filter — say **Completed** — and there's nothing there yet, you'll now see a quiet little "No orders are in this category" note, instead of a blank space that leaves you wondering.

## Cancelling an order feels instant now

When you cancel one of your orders, it now updates **right away** — the order shows as cancelled the moment you confirm, and you land back on your orders list without any awkward pause where it still looks live. Behind the scenes it's still recorded properly on the chain; you just don't have to wait around to see it happen.

## A couple of little touches

- **New orders arrive with a gentle slide.** When a fresh order appears at the top of the order book while you're looking, it now slides smoothly into place, so you can tell something new just showed up.
- **The Contact highlight lands on the right instance.** When you use the **Contact** link in the footer, the soft highlight now reliably settles on the instance you're actually using — a warm amber flash so it's easy to spot.

## For operators

- **This release includes a small database update.** On upgrade, your indexer adds one new table (`chat_folders`) that stores each user's *encrypted* folder organization for the new cross-device sync. It's opaque ciphertext — your node never learns what any user has filed. The migration is automatic and additive; no manual steps.
- **A new on-chain action, `morphit_chat_folders_v1`, carries that encrypted organization.** It's per-user and opt-in (it only appears when someone stars or archives a chat), fully backward-compatible, and doesn't change the on-chain release format — a build can still be rolled back safely.
- **The chat tracer from the previous release is still here, still switched fully off.** If you're diagnosing a delivery question, you can turn on a detailed, privacy-safe console trace by adding `?chatdebug=1` to the chat URL (or `localStorage.setItem('morphit.debug.chat','1')`). It logs message *metadata only* — never contents — and does nothing unless you switch it on.
