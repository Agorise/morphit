# Morphit v1.21.17

**Operators: install this release before 1 November 2026, 00:00 UTC.** It adds a consensus rule that starts at that
time (by block time): an instance still on an older release would refuse reviews every other instance accepts, and
would need `sudo morphit-ops fast-sync` afterwards. There is nothing else to do: the indexer records the transfers the
rule needs as it applies each block and reads nothing older back from the chain. If an instance does apply blocks from
that time with an older release (a late upgrade, a rollback, an older snapshot), v1.21.17 notices at start, stops before
applying anything more, and its log (`waiver_evidence_gap`) says to run `sudo morphit-ops fast-sync`. `GET /v1/feedback/status` says
whether a refused review can be sent again (`resend_from`) or is waiting for the partner's transfer
(`waiting_for_transfer`); see docs/API.md.

**How old an order is reads right, and the exact day is one hover away.** On My Orders, an order posted 89 days
ago, on the day its 90-day life ran out, read "Posted 2mo ago": the age was rounded down to whole months. Ages
of a month or more are now rounded to the nearest month (and a year or more to the nearest year), so it reads
"Posted 3mo ago". The same rule is used everywhere the app shows an age: My Orders, profiles, the orderbook's
expiry badge and the chat inbox.

Hover over "Posted … ago" to see the day it was posted, for example "Posted on 28 July, 2026".
Screen readers read that date.

An expired order now says when it expired, "Expired on: 26 October, 2026", instead of "Expires on: Expired".

**Trading one coin for another goes step by step.** On an order paid in another coin — "I'm buying at least 25 BRL
of BLURT with XMR or BTC" — the chat now leads both people through the trade in the right order:

1. The BLURT seller taps **Share your XMR or BTC address**, picks the coin he wants to be paid in, and says how much
   (the amount is now required here: the check compares what arrives with it). The address must be one he has never
   shared from this device before: a payment to a reused address cannot be told apart from an earlier one.
2. The buyer sees that address in the chat (copy it, or scan its QR code), pays it from his wallet, and records the
   payment: its transaction id and, for Monero, its transaction key, which every Monero wallet shows for a sent
   payment.
3. The seller's screen shows that payment arriving, live: how much reached his address and how far it has confirmed
   (0/3, 1/3, 2/3, confirmed). The check runs through his own instance, which asks block explorers (only over Tor or
   I2P on a hidden-only instance).
4. As soon as the payment is seen in full, even at 0 confirmations, his **Send BLURT** button appears (for Bitcoin at
   0 confirmations, with a word that it can still be replaced until it confirms). Before that it does not: you can no
   longer send your side before you have been paid, from the toolbar or from an address card in the chat. If a
   payment was made before the address was first shared (someone else's earlier payment to it), the button stays
   hidden and he is told why. If it is short or went to another address, he is told so, and only if his own wallet
   shows the right payment (paid in two parts, say) does **I see it in my wallet** bring up the button. The same
   button is offered when the payment cannot be confirmed here (the explorers cannot be reached for a few minutes, do
   not know the transaction for several minutes, or a Monero payment was recorded without its transaction key). His
   word covers what he was shown then: if the check later finds the payment short, he is told so and must look again.
   Once he has sent his side, **Send BLURT** does not come back, even if the chat message saying so could not be
   posted. A buyer who recorded a wrong transaction id, or left out the Monero key, records it again from the seller's
   address card (**Mark sent**).

The BLURT buyer is no longer asked to "Share your Blurt account": BLURT goes to the account he is chatting from. The
same steps work the other way round, buying XMR with BLURT: the XMR seller taps **Ask for BLURT** (his account and
the amount), the buyer pays it with **Send BLURT** and shares where to receive his XMR, and the seller's **Send XMR**
appears once that BLURT has arrived in full — checked on the chain against his own ask in that chat, from that
buyer — and the buyer has said where to send the XMR.
Orders paid any other way (PayPal, cash, …) work as before.

**The inbox says whose order it is.** A conversation about your own order reads "Regarding my buy order of at least 25
BRL of BLURT with XMR or BTC"; one about the other person's reads, under their name, "Who is buying at least 25 BRL of
BLURT with XMR or BTC". The "RE:" is gone, and the line now says what the order is paid in (it used to stop at
"…with").
A conversation not about any order says so.

**Your trades show on your profile, both sides.** "Trade history" now lists the trades you made on other people's
orders too ("Regarding @alice's order: Buying …, with @alice"), and "Last trade" is the day you last
completed a trade, not the day you last posted an order. Both go by the day the trade was completed: a fee checked
again later, or the partner named afterwards, no longer makes an old trade read as new (from 1 November the indexer's
trade-concentration check counts trades the same way). Empty lists name the account: "Nothing yet. @bob has not
left feedback on any counterparties."

**Reviews of a first trade count from 1 November, and the app says when a review did not count.** A first order
posted free of charge (the first-buy waiver) could not be cited by a review, so both reviews of such a trade were
refused by every indexer, and nothing on screen said so: the stars showed until the next reload, and then the chat
asked for a review again, every visit.

From 1 November 2026, 00:00 UTC (by block time) a review may cite such an order when the trade is proven: the order
was marked complete naming the other person, and that person sent the order's owner at least 50.000 BLURT in one
transfer made on or after 1 November, in a block from the one that posted the order up to and including the review's
block (a review in the very block that posted the order is refused). Transfers before 1 November do not count: an
older trade counts once the partner sends the owner at least 50.000 BLURT again from then on. 50 BLURT is more than
any new account is given for free, so free accounts cannot vouch for each other with gifted BLURT. Such a review never
earns the welcome bonus; reviews citing paid orders are unchanged.

What you send is now kept on your device (until you sign out, like your chats), and your instance is asked what
became of it:

- A review on its way shows its stars, and the chat no longer asks for it again. If an hour after it was sent your
  instance has still not seen it (it never made it into the chain), the chat asks for it again, filled in.
- A first trade's review that is not counted yet says "Not counted yet" in the inbox, and the chat (and, for a review
  sent from this device, your profile's "Reviews given") names who still has to send whom 50 BLURT.
- Whenever a review that was not counted would now count (that transfer made, the order marked complete, its fee
  verified), the chat asks you to send it again, with your stars and words already filled in.
- A review refused for any other reason says "Not counted".

**No more "new message" notices for messages you have already read.** While a conversation is open, the app now
tells the network what you have read as you read it (at most once every five minutes, and at once when you leave).
Before, it did so only when you opened the conversation, so the offline notice (email, Matrix, …) could arrive for
messages you had already seen. Each of these is a small Blurt operation from your account, so it is only sent when the
other person wrote something new: never for your own messages, and not again when you open the same conversation.

**Block explorers.** Two addresses of one explorer operator (its .onion and its I2P or clearnet address) now count as
one source: before, one operator could make a two-source agreement on its own, for listing fees as well. A payment's
confirmations are the fewest any agreeing explorer reports, and its time is used only when the explorers agree on it:
one explorer giving a made-up time can no longer mark an honest payment as "older than the address" (the seller is
told it cannot be checked here instead, and may confirm from his own wallet). Checking a Monero trade payment sends
the explorers the transaction ID only — the payment's key and the seller's address stay on the instance. One client
can no longer keep every payment check busy. An explorer that cannot be reached is now rested before it is asked
again, as was always intended; before, every check asked it again and waited out its timeout.

**Posting an order no longer fails with "…/keys timed out".** Before anything is signed, the app checks the
account's keys through its instance, which asks several Blurt nodes and waits for them to agree. One slow node
made that check outlast the browser, and posting failed with "Couldn't broadcast: indexer /v1/account/:name/keys
timed out" until it was tried again. The instance now answers in time (or says it could not, and the browser asks
once more), and the keys read a moment earlier, when you typed your Active key, are used again rather than asked
for a second time.

**Each step of posting starts at its top.** Pressing Continue at the bottom of the form opened the review step
already scrolled down, and the password, posting and done steps did the same. Every step now opens at its top,
as do the steps of editing an order and of setting up two-factor sign-in.

**Featuring an order takes fewer steps.**

- "Set up a featured bid", after posting, now opens My Orders with that order's Feature form already open. While
  the order is still "Posting…", or its BTC or XMR listing fee is still confirming, the order says so and the
  form opens by itself as soon as it can.
- The form shows your wallet's BLURT, and its value in your currency, next to the total cost, kept up to date.
  You are asked for your password (or Active key) only once the balance covers the cost and the network fee;
  until then the form says how much is missing. Before, it took the password first and then failed with
  "insufficient funds".
- Once you press **Pay and Feature**, the password field and the buttons go away while the bid is sent and
  recorded.

**A featured order shows once on the orderbook.** It used to appear twice: in the Featured card and again in the
list under it. It now stays in the Featured card only, whatever the filters, and the "No featured-slot price
history" note no longer shows under it. When a filter you set finds the featured order, its border flashes twice
so you see it (and if it is the only match, the list says so). Opening or closing the Filter card no longer
moves its title and +/− button, so the button stays under your pointer.

**Small things.** A branded instance's wallet card (and the address card in chat) now takes the instance's own
colour instead of Morphit green. For developers: `GET /v1/chain-fee` also returns the chain's network fee
(`operation_flat_fee_blurt`, `bandwidth_kbytes_fee_blurt`); see docs/API.md. The profile's tabs no longer draw a cut-off box around the selected tab on a Mac (a tab reached
with the keyboard is tinted and underlined instead). A barter trade in "Trade history" names what was traded, not "BARTER".
