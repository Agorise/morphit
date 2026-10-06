# Morphit v1.0.0-beta.49

This release adds **Barter** — a way to trade goods and services, not just
cryptocurrency — brings a proper **wallet** to your account, and includes a
batch of interface fixes.

## Barter: trade goods and services, get paid in crypto

You can now list goods and services on Morphit, not only cryptocurrency. A
grandmother selling baskets, a neighbor who fixes bikes, someone with a crate
of oranges: they describe what they're offering, price it in their local
currency (a single price or a range), and pick which cryptocurrencies they'll
accept.

- **One listing, not one per coin.** Tick the coins your town actually uses;
  buyers can only pay you in a coin you accept.
- **Browse the wares.** Barter listings appear in the order book like any other,
  under a single clear "Barter (goods/services)" filter, and read in plain
  language — "worth 100–500 MXN of goods/services" — with the coins you take
  shown alongside.
- **Settle safely.** The goods change hands off Morphit, in person or by post,
  so there's no crypto receive address on the listing itself. When you and your
  counterparty settle, it's always in one of the accepted coins — you're never
  asked to share an address or transaction ID for "barter."
- **Edit anytime.** Change your price, your description, or the coins you accept,
  the same as any listing.

Barter is trade-only: you can't pay Morphit's listing fees with it.

## Your wallet: Send, Power up, Power down

The balance card on your account is now a full **wallet**. Alongside your
balances you can:

- **Send BLURT** to another account — the recipient is checked on-chain before
  you sign, with an optional memo and a privacy reminder. Scan a recipient's QR
  code instead of typing the name.
- **Power up** BLURT into Blurt Power, and **Power down** back to liquid BLURT.

Each of these signs with your active key, which is never stored or logged and is
wiped from memory as soon as the transaction is prepared.

## Interface fixes

- Order Terms with multiple paragraphs and formatting now display cleanly on the
  order detail page.
- Fixed a couple of console errors on the settings and order-book pages.
- The block explorer now names the Blurt blockchain in its page titles, and its
  landing page describes what you can search — with no login or tracking — in
  every language.

## For operators

This release includes one database migration — the new column that stores a
barter listing's accepted coins. It applies automatically the next time the
indexer starts, and is a safe no-op on a fresh database. As always, take a
database snapshot before upgrading.

If you'd like to keep Barter off on your instance, add `BARTER` to
`MORPHIT_INDEXER_DISABLED_ASSETS`.
