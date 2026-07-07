# Morphit v1.0.0-beta.34

This release makes placing an order much friendlier — especially your very first
one — with clearer fields, a plain-language summary of exactly what you're about to
post, and a couple of papercut fixes.

Nothing here changes how trading works or what anything costs, and Morphit still
keeps no data about you. If you're already signed in, your account, keys, and
balances carry over untouched.

## Placing an order

- **The new-order page now eases first-time traders in.** If you've never traded
  before, the page drops the extra explanation, greets you with a simple "Let's
  trade!", and walks you through your first listing instead of presenting the full
  form at once.

- **Your currency choice reads in plain language.** When you pick the currency your
  payment is in, it now shows as something like "MXN — Mexican Peso" rather than a
  removable tag, so it's obvious you've chosen one currency.

- **The minimum and maximum fields are clearer and harder to get wrong.** Each one
  now names the currency you picked (e.g. "Minimum value in MXN"), accepts numbers
  only — letters and stray symbols simply can't be typed — and turns red if what you
  enter doesn't fit, so mistakes are caught as you go. The same applies to the price
  fields.

- **A plain-language summary of your order.** A card near the bottom of the form now
  reads your order back to you in one sentence — for example, *"I will buy up to 20
  MXN worth of BLURT at market price, and pay with PayPal, Cash (in person), or
  Barter (goods/services)."* — and updates live as you fill things in, so you can see
  exactly what you're posting before you confirm. It's available in every supported
  language.

- **The notes field is labelled "Terms / Details / Notes"** so it's clear what kind
  of thing belongs there.

## Fixes

- **Fixed: a "restored draft" message no longer appears on a brand-new order form.**
  Starting your first listing could wrongly look like a saved draft was being
  restored even when you hadn't typed anything yet. The form now only offers to
  restore a draft once you've actually entered something.

- **Fixed: switching your pricing back to market price no longer leaves a stale
  warning behind.** Moving from a fixed price back to market pricing could leave an
  "enter a price" message lingering; that's resolved.

- As with recent betas, **this release changes no third-party dependencies.**

## Under the hood

- The order-form changes ship with a regression test that locks the draft and
  pricing-error behaviour, the plain-language summary, the numbers-only fields, and
  the first-time prompts so they can't quietly regress. A fresh five-persona
  walkthrough and a focused deep-deep review confirmed the new-order and edit-order
  screens end to end, across all supported languages.
