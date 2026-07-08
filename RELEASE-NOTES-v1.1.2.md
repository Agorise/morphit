# Morphit v1.1.2

A small patch release on top of **1.1.1** with a batch of UI fixes people
reported, plus a safeguard when editing barter orders.

## Fixes

- **Order titles no longer cut off the item on phones.** A long title like
  "I'm selling 40–650 MXN worth of goods/services" was dropping the last part
  on narrow screens. Titles now have room to show the whole thing.
- **The two "announce your order" cards on the posting page are cleaner.** The
  blog-syndication card lost a redundant paragraph and now reads "Syndicate my
  order to the Blurt blog"; the one-time first-trade announcement card has
  clearer wording about when it posts. The "(Free)" labels were dropped since
  both are already free.
- **Cancelled orders now clearly look cancelled.** On your Orders page a
  cancelled order shows a tidy **Cancelled** tag, reads **Not visible in
  orderbook** instead of a green "visible" tag, and shows **Cancelled** where
  the expiry date used to be — no more looking half-live.
- **The "editing is free" note is clearer** — it now says editing is free with
  no listing fee when done within 15 minutes.

## Safeguard

- **The cryptos you accept are now locked while editing a barter order.** You
  could previously uncheck (or remove entirely) the coins you'd agreed to
  accept when editing a goods/services listing. Because someone may have
  clicked through on your original offer partly based on which coins you'd take,
  that set is now fixed while editing — the same protection already applied to
  the side, asset, and currency. To change what you accept, post a new order.
