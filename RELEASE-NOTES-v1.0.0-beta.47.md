# Morphit v1.0.0-beta.47

A reputation-integrity and polish release on top of beta.46. The change that
stands out: **reviews are now tied to people you actually traded with.** You can
only leave feedback for a counterparty you had a real conversation with about
the order, and the review form fills in and locks to that person — so stars
can't be pointed at the wrong account, and they can't be fabricated for someone
you never dealt with. Alongside that, order cards are cleaner on phones,
off-peg warnings now cover USDC and DAI (not just USDT), forms recover
gracefully when a piece fails to load, and a handful of form and layout issues
are fixed. **Recommended for all operators.**

## Added

- **Off-peg warnings for USDC and DAI.** The small "this price is off its $1
  peg" note that can appear under a stablecoin's price now shows for USDC and
  DAI as well, not just USDT — so if a dollar stablecoin slips from its peg,
  you'll see it whichever one you're trading. It only appears when the price
  actually drifts.

## Changed

- **Feedback is tied to a real trade partner.** Two parts to this:
  - You can now only leave a review for someone you **provably traded with** —
    specifically, someone you had a genuine back-and-forth conversation with
    about the order. This closes the door on reviews invented for people you
    never dealt with, and on inflating your own score through throwaway
    accounts.
  - When you mark a trade complete on **My Orders**, the review form now fills
    in the counterparty for you and **locks to them**, shown as a clear
    `@name`, so there's no question who you're rating and no way to point the
    stars at a different account. If more than one person traded with you on a
    single order, you choose which. If nobody has provably traded on an order
    yet, the review button simply isn't shown for it.

- **Cleaner order cards on phones.** On a narrow screen, each listing now trims
  to the essentials: the title caps at two lines, the pricing-model line and
  the expiry pill are tucked away, and there's a single full-width
  "Message the seller" button at the bottom (it shows the offer's expiry date
  when there's room). The seller's avatar no longer overlaps the title.

- **The boost-a-listing password prompt names your account.** When you place a
  feature bid to boost one of your listings, the password prompt now names the
  account you're signed in as, matching the rest of the app.

## Fixed

- **Leaving a review from My Orders no longer silently fails.** Reviewing the
  person who took your order was being quietly rejected behind the scenes; it
  now goes through.

- **Boost-a-listing errors appear where you're looking.** If a feature bid
  can't be placed, the reason now shows in red directly under the password
  field instead of at the bottom of the card.

- **Forms recover when a piece fails to load.** If a form, picker, or dialog
  can't load — on a flaky connection, or right after an update — it now shows a
  clear "Couldn't load — Try again" instead of appearing to do nothing.

- **The "posted an order but don't see it?" fee-status link moved.** It now
  sits at the bottom of the orderbook's filter panel rather than at the top of
  the page.

---

*Morphit is non-custodial and no-KYC: it never holds your funds and never asks
for identity documents. This is beta software under active development — please
report anything that looks wrong.*
