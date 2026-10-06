# Morphit v1.5.5

## Finishing a trade now actually finishes it

This is the big one, and it explains a whole cluster of oddities in one go.

When you and your counterparty finished a trade — the money sent, the receipt in the chat, both of you leaving reviews — your order **stayed "Live"**. Forever. It kept sitting in the public orderbook waiting for another buyer. It still offered a **Cancel this order** button for a trade that was already done. It still counted under the **Live** pill instead of **Paid**, still appeared under Active orders, and still showed **(Live)** beside its title in your chat inbox.

The cause was small and specific: the button on **My orders** says *"Mark complete / review"*, and the panel in your chat is headed *"Mark this trade complete"* — but both of them only ever posted the **review**. The "mark complete" half was never implemented.

Now it is. Leaving a review on **your own** order also marks that order complete, and the whole cluster corrects itself: the pills count right, the Cancel button goes away, "Expires on" disappears (it's irrelevant once a trade is done), and the order stops showing up in the orderbook.

## Trades and reviews are now two different numbers

Before, your "trades" number was really your **reviews** number wearing a disguise — there was no trade data, so the reviews you'd received stood in for the trades you'd done.

That quietly cost honest traders. Complete a real trade where neither of you got round to leaving stars, and it counted for **nothing**. Take someone else's order rather than post your own, and you'd read **"0 trades"** no matter how many trades you'd completed, because only order posters were ever counted.

Both are fixed:

- **A completed trade counts as a trade** — stars or no stars. If nobody left a review, that's fine; the trade still happened.
- **Both people get credit.** Completing a trade credits the person who posted the order *and* the person they traded with.
- Your order cards now read **"1 trade · ★5.00 (34)"** — the trades you've done, and separately the star average with how many **ratings** back it. The "(34)" means 34 ratings, and now it really does.
- The **🌱 new trader** sprout retires once you've completed 4 trades, rather than once you've collected 4 reviews.

The **Most trades** sort and the **minimum trades** filter now use real trades too, so an experienced trader who's never been reviewed no longer sorts below a chatty newcomer.

None of this weakens the anti-sock-puppet protections. Naming who you traded with requires the same proof of a real, two-way conversation that leaving a review already required — so nobody can mint trade credit for an account they've never actually spoken to, or attach a public claim to a stranger's name. There's a new protection too: if almost all of an account's trades are with one single partner, those trades stop counting toward the number. Two people who genuinely only ever trade with each other will feel that one — you keep your ratings, but heavily concentrated trade credit doesn't count.

## Notifications: no more doubles, and no more waiting

- **The duplicate is gone.** A new chat message could notify you **twice** — once within a few seconds, then again about a minute later. One message, one notification.
- **Your badges keep up.** The avatar and favicon counters used to sit dark for about a minute after the notification had already arrived. They light up with it now.
- **The message is there when you tap.** Tapping a notification could land you in a chat that didn't show the message yet — you'd wait, or refresh. It's there when you arrive.
- **Reviews notify you fast.** Being reviewed sent no timely notification at all. It now arrives in seconds, like a chat message.

If you're an established trading partner, you get all of this at full speed. First contact from a total stranger is still held to the slower, stricter path — that hasn't changed, and it's what keeps notifications from becoming a spam channel.

## The chat, tidied up

- **Payment Receipts** — the **Copy** button now lines up with the Transaction field, the field is labelled **Transaction ID**, and the "verify this yourself" link beside the 🔍 is finally *visible* and actually works (it led to a Not Found page).
- **Green bubbles are dimmer and the text is bolder**, so the thin dark text on them is easier to read.
- **Leaving feedback** shows a brief **"Feedback sent"** message instead of leaving a card pinned to your chat, and the **Cancel** and **Submit feedback** buttons now sit side by side, with Submit in the green outline style.
- Your inbox says **"I rated @someone:"** instead of "Feedback left:", and shows **(Paid)** on a finished order.

## Profile and reviews

- The **Reviews** heading now says who they're for: **"@someone has received reviews from"**.
- Every review card shows the person's **@username** beside their display name, and their **truncated public key** underneath — including for people who haven't set up a profile, whose key simply never appeared before.
- Your own review comments now read **"I said: …"**, and a reply you leave sits **indented** beneath the review it answers.
- **Stars are green everywhere.** A reputation star used to render white when it was based on only a couple of ratings; now it stays green and goes **hollow** instead — same "take this with a grain of salt" signal, but it also works if you can't distinguish the colours.

## Odds and ends

- The stray **green border** around the page is gone (it was a focus outline that fired on every page load).
- The action buttons on **My orders** are sized to match the **Re-list this order** button instead of being stretched wide.
