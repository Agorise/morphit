# Morphit v1.5.0

## Your reputation now counts every review you've earned

This is the big one. A real, verified review could fail to count toward your reputation — your profile would say **"No feedback yet"** and your orders would show **"0 trades"** even though a counterparty had already reviewed you and the review was sitting right there on the page.

It happened whenever the review pointed at an order **you didn't post** — for example, when the person who listed the order reviewed the person who took it. That's an ordinary, everyday trade, so this was quietly costing honest traders the reputation they had actually earned.

Reviews like that now count, your score reflects them, and the "new trader" sprout retires when it should. Nothing about the anti-sock-puppet protections changed — genuine reviews were simply being dropped alongside the fake ones, and only the genuine ones came back.

## Leave feedback right where the trade happened

Feedback now works in both directions, from the conversation itself:

- A **Leave Feedback** panel appears in your chat once you've actually traded — stars, a comment, and send.
- Your chat inbox shows **"Leave Feedback:"** on threads that are ready for it, and **"Feedback left: ★★★★★"** with your comment once you've done it.
- On **My orders**, if a trade had one counterparty the form locks to them; if it had several, you pick the right person from a short list with their avatar, so look-alike names can't be confused.

## Your settings now follow you to a new device

Your preferences — notifications, quiet hours, privacy choices, syndication, hidden and blocked accounts — are now mirrored to the chain, **encrypted with your own key**. Sign in on a new phone or laptop with your seed and they come back with you. Morphit's operators only ever store an opaque blob; nobody but you can read what's in it.

## Completed trades look completed

- When a trade is done, the order is marked **completed** on-chain and the order page shows a clear green **Completed & paid**.
- **My orders** shows a green **"Paid by @someone"** pill, drops the buttons that no longer make sense on a settled order, and adds a **Paid** filter alongside All, Live, Cancelled and Expired.
- **View the order** from a review now opens the actual order — previously it could land on a "your order is being posted…" screen that never resolved.
- The **Payment Receipt** in chat has been redesigned, and reads **"BLURT RECEIVED"** when you're the one who got paid.

## A clearer profile

- The card showing who reviewed you now includes their **truncated posting key** under their name, so a look-alike display name can't impersonate someone.
- **"@someone has left a review for"** now lists who they reviewed, with that person's avatar, name, key, and **current reputation score** — and reads properly on a phone.
- Replying to a review is clearer: it now says plainly that you're replying to the review above, and notes that a reply **isn't a rating** (to rate someone, leave feedback from your chat with them). The reply box lost its odd blue tint, and **Cancel** now sits below **Post reply** where you'd expect.

## Sharing a crypto address on your phone

The **Share crypto address** window used to list every coin as a separate block — sixteen of them — which on a phone pushed the window past the edge of the screen with no way to scroll to the Send button. It's now a single **coin picker with logos**, and the window fits and scrolls properly. The same fix applies to the window where you report funds sent.

Your address is checked **as you type**, with a red outline and a plain explanation when something's off.

## When an RPC node has a problem, we now say what it is

Settings → **RPC endpoints** used to mark a node with a flat red **"unreachable"** no matter what went wrong — which could point the finger at a node that was perfectly healthy. Now you get the actual reason in one line: a **TLS certificate problem**, **blocked by a security policy (HTTP 403)**, **rate-limited**, **DNS lookup failed**, or **answered, but the RPC call failed**. Plain "Unreachable" is now reserved for a node that genuinely isn't answering.

## Tidier throughout

- The oversized **Post an order** button is now half the size, everywhere it appears.
- The big buttons on **Settings** are sized sensibly, and the **Mute** buttons pick up the same gentle hover as everything else.
- **Clear** on your display name or short bio now simply empties the field and lights up **Save** — no more red "are you sure" panel, and no more Save button that refused to do anything.
- If you have no display name, you now show up as **@yourname** everywhere, consistently.
- Reviews you've left now show your **comment** next to the stars, not just the stars.
- In chat: your cursor stays in the message box after you send, the action row is easier on the eye, hovering a date divider tells you it's **midnight UTC**, and the view lands on the newest message.
- The footer now reads **#noaggression #countereconomics**.

## For operators

- **No configuration changes.** The upgrade delivers everything; there are no new environment variables to set.
- The RPC-endpoint reasons above are measured **by your indexer**, server-side — your users' browsers still never contact a Blurt node directly, so their IP addresses are never exposed to third-party node operators. The card publishes only a short reason code and, where relevant, an HTTP status — never raw error text.

As always: your chats (and every crypto address shared in them) are end-to-end encrypted, your settings are encrypted with your own key before they ever touch the chain, and Morphit still keeps nothing about you.
