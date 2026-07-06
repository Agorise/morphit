# Morphit v1.0.0-beta.50

This release fixes **Power Up / Power Down**, gives the **Featured** section a
proper redesign, makes wallet numbers read correctly in every language, and
lands a batch of interface fixes from beta testing.

## Power Up and Power Down now work

Powering BLURT up into Blurt Power — and back down to liquid BLURT — was failing
with a generic on-chain error. The cause was on our side: the two operations
weren't on the list of transactions the indexer would relay to the network, so
perfectly valid, signed requests were being turned away. Both now go through,
and if the network ever does reject one, you'll see the real reason instead of a
generic message.

A note on how Blurt works, since it trips people up: Blurt charges a tiny fee in
**liquid BLURT** for each transaction — it does **not** use "mana" or resource
credits to gate transfers the way some other chains do. So the fix is simply to
keep a little liquid BLURT on hand; you never need to power up to send or stake.

## Featured, redesigned

The Featured section on the order book used to sit in two separate blocks that
didn't quite line up. Now the orders someone has paid to promote appear as
**full order cards** — the same layout as every other card, with the poster, the
amounts, the accepted payment methods and the expiry — gathered **inside** the
one "🎉 Featured" panel, above the price history. New featured orders also show
up faster after a bid is placed.

## Wallet numbers in your language

Your balances and their exact values now format for the **language you've picked
in Morphit**, not your browser's. If you use Morphit in German, for example,
you'll see `1.234,567` rather than `1,234.567`.

## Interface fixes

- Expired listings on **My Orders** now clearly read as expired — no more "Live"
  pill or future expiry date on an order that's already closed.
- The order-card tooltips now sit cleanly on top of everything and never run off
  the edge of the screen.
- The **Featured** and **Power up / Power down** links, the modal **Cancel** and
  **Close** buttons, and several select menus all got their hover states
  cleaned up.
- The payment-method picker now shows a small **coin icon** next to each
  cryptocurrency.
- The **post** form has a short hint that Terms support basic Markdown, and the
  Barter step reads more clearly. A Barter listing with no set value now reads
  as plain language rather than a bare currency code.
- The **language switcher** in the footer now lines up neatly with the license
  line.
- The wordmark carries a small **BETA** marker for now, so it's always clear
  you're on a pre-release build.

## For merchants

A small, dependency-free **merchant QR kit** now lives in the repository: a
storefront QR that opens your Morphit page in any phone camera, and a payment QR
that a Blurt/Morphit scanner reads to pre-fill you as the recipient — plus a
copy-paste badge for your own site.

## For operators

There are no new database migrations in this release. The operator
command-line's on-chain error guidance was corrected to reflect Blurt's fee
model (keep liquid BLURT for the per-transaction fee — don't power up), and the
operator docs were updated to match. As always, take a database snapshot before
upgrading.
