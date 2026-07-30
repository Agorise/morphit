# Morphit v1.0.0-beta.43

Another broad round of polish across placing an order, the order and orderbook pages, your
own orders, chat, and feedback — plus one meaningful trust improvement: the person behind
an order now shows their cryptographic identity, not just a display name. Nothing about how
trades or fees work has changed.

As always, Morphit keeps no data about you, and there's no sign-up or ID check. If you're
already signed in, your account, keys, and balances carry over untouched. This release
changes no third-party dependencies.

## You can see who you're really dealing with

- **A poster's cryptographic identity, shown up front.** An order's detail page now prints
  the poster's shortened public posting key directly under their display name. A display
  name can be changed to imitate someone else; the posting key cannot. So if a would-be
  impersonator picks a look-alike name, the key gives you a durable, on-chain identity to
  check against — and a concrete reference point should a dispute ever arise.

## Placing an order is clearer

- **Selling reads like selling.** When you choose to sell, the questions now match: "Which
  fiat currency will your sale be valued in?", "What will you accept?", and "I will accept"
  — instead of buy-oriented phrasing.
- **Shorter asset explanations.** The plain-language blurb that appears when you hover an
  asset no longer repeats the trade-only note; it's tighter.
- **Clearer action button.** The button that posts your order now reads "Pay and Post this
  order," so it's obvious the listing fee is part of the same step (and it no longer shows
  the fee amount twice).
- **New payment option.** "Cash machine with code" (cardless ATM withdrawal) is now
  available to select.

## Order and orderbook pages

- **Tidier order details.** The terms now sit up under the location, and the "posted on" and
  "expires on" dates sit side by side — a more compact card, including on a phone.
- **Cleaner orderbook cards.** Each card is now a single column with the "Message" button
  centered and the hide control tucked into the bottom-right corner. The "last updated" time
  is no longer a separate line — hover the countdown pill to see it.

## Your orders

- **Consistent "Live" badge.** The Live status now carries the same bright green outline used
  elsewhere.
- **A real answer to "why isn't my order showing?"** Following the "posted an order but don't
  see it?" link now lands on a short explanation, and each order clearly states its listing-fee
  status — verified, underpaid, or not yet received — which is the usual reason an order isn't
  visible in the public orderbook yet.

## Feedback

- **A calmer feedback form.** Leaving feedback now uses a plain card with hover-to-fill stars,
  and the separate "announce your first trade" box has been removed. Announcing your first
  trade still happens automatically (you can turn it off in Settings and on the order form).
- **Clearer "feature your order."** The promote-your-order form shows the cost in your own
  currency, uses a clearer heading, and gives proper feedback when a password is wrong.

## Chat

- **Less clutter on mobile.** The blue first-trade helper box now starts collapsed (tap to
  open) and scrolls properly with the conversation, and the "LIVE" badge no longer crowds a
  long display name.

## Avatars are unique

- **No copying someone else's picture.** Every avatar — including a custom uploaded one — is
  now unique across accounts. You can still remove your own avatar and re-upload the same
  image; you just can't take one that already belongs to another account.

## Plainer wording and smaller fixes

- Footer links now highlight in Morphit green in dark mode too.
- The social-link icons were removed from the more crowded spots (they remain on profiles).

## For node operators

- **Avatar uniqueness runs in the indexer.** Your instance now rejects a profile that tries
  to claim an avatar image already used by another account (a person re-uploading their own
  image is unaffected). This arrives with the usual `morphit-ops upgrade`; no configuration
  or migration steps are required.
- No configuration changes, and no third-party dependencies changed this release.
