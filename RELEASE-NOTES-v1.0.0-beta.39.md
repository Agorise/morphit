# Morphit v1.0.0-beta.39

This release is about staying signed in when you want to, and a round of order-form and
sign-in polish. The headline: if you chose **Remember me**, an ordinary page refresh now
keeps you signed in instead of dropping you back to the password screen. Everything else
here smooths rough edges you'd hit while posting your first order or unlocking your
session.

As always, Morphit keeps no data about you, and there's no sign-up or ID check. If you're
already signed in, your account, keys, and balances carry over untouched. This release
changes no third-party dependencies.

## Staying signed in

- **A normal refresh keeps you signed in.** If you ticked **Remember me** when you
  unlocked, pressing refresh (or F5) no longer logs you out — your session is restored on
  the same tab without re-typing your password. A full hard-reload (the "empty the cache"
  kind) still locks, on purpose, and if you did **not** tick Remember me, any refresh
  still locks. Nothing decrypted ever leaves your device.

## Posting your first order

- **Barter now asks for Terms.** When you offer Barter (goods/services), the Terms box
  becomes required and the Continue button stays off until you've described the deal —
  and the Terms border flashes green the moment you add barter, so it's obvious what's
  needed. A bare "barter" listing with no details is no use to the person on the other
  side.
- **The steps are numbered honestly.** Choosing how to cover the listing fee is its own
  step, so it's now labelled **Step 4 of 4** (and the earlier steps are renumbered to
  match).
- **Pay the fee in BLURT if you already hold some.** Existing Blurt users can now choose
  to pay the listing fee in BLURT on their first order instead of spending the free
  first-order waiver — the choice now sticks instead of snapping back.
- **Tidier first-order screen.** Removed a duplicate "safer defaults" tips card that was
  showing again on the final step, and trimmed a redundant sprout from the
  "Your first order is on us!" title.

## Clearer links and highlights

- **FAQ hover.** Moving the pointer over a FAQ entry now gives it a soft emerald
  highlight that fits the rest of the site.
- **Consistent "Learn more" / "check fee status" links.** These now use the same gentle
  sliding-arrow style as the rest of the app, with no underline. The "Posted an order but
  don't see it?" hint on the orderbook now appears only once you've actually posted an
  order, so it doesn't clutter the view for newcomers.

## Sign-in screen

- **Balanced unlock card.** On the welcome-back screen, the **Unlock** and **Sign out**
  buttons now sit together on one line instead of one floating below the other.

## Documentation

- **Barter, explained better.** The barter FAQ entry is shorter and leads with the
  real-world reason people trade goods directly — being unbanked, capital controls, a
  failing local currency, counter-economics — with one concrete example (orange-tree
  saplings for Monero) and one simple rule: if either side is a listed coin, the on-chain
  side still earns a receipt and portable reputation.
