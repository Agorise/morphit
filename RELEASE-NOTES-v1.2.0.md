# Morphit v1.2.0

A feature release on top of **1.1.5**. Chat gets day dividers so you can find an
old conversation, cancelled orders can be re-listed, featured orders finally show
who's behind them, and a handful of the small things that make a wallet feel
trustworthy got fixed — including two ways the Send screen could have sent the
wrong amount.

## New

- **Day dividers in chat.** A thin line with the date sits above the first
  message of each day, so scrolling back through hundreds of messages you can
  land on the day you're looking for instead of reading bubbles to work out
  where you are. Dates appear in your language.
- **Re-list a cancelled order.** Cancelled an order and changed your mind? You
  can re-list it, the same way you already could with an expired one. The form
  is pre-filled with your original terms; the cancelled order stays cancelled.
- **Cancelling an order takes you somewhere.** Confirming a cancel used to leave
  you on the same page, still looking at the red button, with nothing to show it
  had worked. It now takes you to your orders, where the order reads Cancelled.

## Fixes

- **Featured orders now show the trader's reputation.** Featured cards were
  missing the new-trader sprout, the reputation score, the trade count and the
  poster's key — on exactly the cards a stranger is most likely to click. They
  now show the same trust signals as every other order card, drawn from the same
  filtered ratings.
- **Featured USDT, USDC and DAI orders now name their network.** A featured
  order for a multi-network asset didn't say which chain it meant. Sending on
  the wrong chain loses the money, so this was worth fixing carefully.
- **The Send screen can't send more than you typed.** Entering an amount with
  more decimal places than BLURT has (say `1.0006`) would quietly round it up
  before sending. It now tells you instead of guessing. A very small amount
  (`0.0004`) would have been sent as zero.
- **"Send BLURT" stays disabled until your password is filled in.** It was
  possible to click Send with the password field empty and only then be told it
  was required.
- **"Use full balance" fills in an amount you can actually send.**
- **The "Feature this order!" panel tells the truth.** It said there were 5
  featured slots. There are 3. It also now names the duration you picked (6, 24
  or 72 hours) rather than "the selected duration".
- **The warrant canary reads properly.** Odd characters (`â€"`, `â€¢`) appeared
  in the published canary, and its dates were machine timestamps. The file is now
  plain ASCII — it can't be garbled by whatever you open it in — and dates read
  like "8 July, 2026 @ 23:45:18 UTC".
- **Wallet card spacing.** The three columns are evenly spaced, and the value in
  your currency now lines up with your BLURT balance instead of sitting slightly
  low with a double space in front of it.
- **Form fields get a proper focus outline.** Clicking into a field showed a very
  dim green glow in some places and a crisp green border in others. Now it's the
  crisp border everywhere — except on a field with an error, which stays red.
- **The download page cards respond to your mouse**, like the order cards do.
- **The homepage is a little quieter.** The "FEATURED RIGHT NOW" label above the
  featured cards is gone; the cards speak for themselves.
- **Polish translation improvements**, contributed by a native speaker.

## For operators

- `morphit-ops` reads the canary's new date format, and still reads the old one.
  Nothing to do — your existing signed canary keeps verifying.
- Your canary is regenerated weekly by the timer. The new format arrives with the
  next regeneration; run your canary script after upgrading if you'd rather not
  wait.
- `GET /v1/orderbook/featured` now returns a complete order record — the same
  shape as `/v1/orderbook` items, including reputation, `asset_network` and
  `engagement_24h`. Fields were **added**, so existing consumers keep working.

## Under the hood

- The sock-puppet-filtered reputation aggregate (which excludes reciprocal
  ratings, linked accounts, pile-on attacks and review concentration) was written
  out in three separate places. It's now written once and shared, so the number
  on a featured card can't drift from the number on an orderbook card. The
  extraction was verified byte-for-byte identical, and a test fails if any of the
  four exclusions is ever dropped.
- The featured endpoint's new reputation lookup is scoped to the three featured
  bidders rather than scanning every rating in the database — it's polled by every
  homepage visitor.
- Chat day grouping, BLURT amount validation and the network chip are now pure,
  unit-tested modules rather than logic buried in components.
- The canary timestamp is parsed strictly instead of relying on the JavaScript
  engine's lenient date parser, which would silently accept a misspelled month
  and read a timezone-less timestamp as local time.
- 459 test runners, 13,606 assertions, all green.
