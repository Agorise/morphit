# Morphit v1.0.0-beta.36

This release makes prices follow your money. Your required first order is now **$1 worth
in your local currency** — not a fixed amount of BLURT — and listing fees now track the
live BLURT price so they stay around a few cents in dollar terms instead of drifting. The
new-order page is friendlier for a first trade, the edit-order page now matches it, and
there are fixes for the order form and for updating the app on mobile.

As always, Morphit keeps no data about you, and there's no sign-up or ID check. If you're
already signed in, your account, keys, and balances carry over untouched.

## What things cost, in your currency

- **Your first order is $1-equivalent of BLURT.** Morphit asks every new trader to make
  one small first buy. You choose your currency, enter an amount, and Morphit works out
  how much BLURT equals about a dollar — so "one dollar" stays one dollar whatever BLURT
  is worth that day. (A genuine $1 first order is now accepted; in an earlier build it
  could be wrongly rejected.)

- **Listing fees follow the dollar, too.** A listing fee is about **25¢** when paid in
  Bitcoin or Monero, or about **12.5¢** when paid in BLURT. Rather than being a fixed
  amount of coin that quietly drifts in dollar terms, the amount is quoted from the live
  price so its value stays put. You always see the exact amount before you sign, and it
  is settled at that amount on the chain. The price is only ever used to work out that
  amount for you — it is never treated as a source of truth for anything else.

## Placing an order

- **A clearer first-trade experience.** The new-order page now walks you through it in
  steps ("Step 1 of 3"), defaults the amount to about a dollar in your currency, and
  shows a plain-English summary of what you are about to post (for example, "I will buy
  up to 20 MXN worth of BLURT at market price, and pay with PayPal or Cash"). The amount
  and price fields accept numbers and decimals only, and don't flash an error before you
  have typed anything.

- **Small touches.** A required field now tells you so up front, the terms box shows
  rotating example prompts, and hover highlights are consistent across the site.

## Editing an order

- **The edit-order page now matches the new-order page** — the same friendly amount and
  price fields (with a proper decimal keypad on phones) and the same local-currency
  labels.

## Fixes

- **One-tap update on mobile.** When a new version is ready, tapping "Load it now" once
  now reliably loads it, instead of occasionally needing a second tap.
- **A genuine $1 first order is accepted** (it could previously be rejected as too small).
- The new-order form no longer shows premature red borders, no longer lets letters into
  number fields, and never hides the continue button without explanation.
- As with recent betas, **this release changes no third-party dependencies.**

## For operators

- **Listing fees now track the live price automatically.** The fee your instance collects
  stays around its target value (about 25¢ in BTC/XMR, about 12.5¢ in BLURT) as the
  market moves. The amount enforced on-chain is anchored on-chain, so every instance in
  the federation agrees on it, and it is kept aligned with the live price by an
  **optional, key-gated, automated re-pin** — off by default and detect-only until you
  turn it on, with a manual "Plan B" always available. Your existing fee settings are
  respected as a fallback.

- **A local-currency (FX) feed and multi-source price averaging.** Prices for BLURT,
  Bitcoin, and Monero are now drawn from several upstreams and combined with outlier
  rejection, and a currency-rate feed lets the "$1-equivalent" first order be correct in
  any currency, not just US dollars. Both the price feed and the currency feed report
  their health in `morphit-ops health` and `/v1/health`.

- **A public `/v1/fx` endpoint** exposes the (privacy-preserving, whole-table)
  currency rates the first-order minimum uses.

- **Klingex has been removed** (the exchange shut down); CoinGecko is now the sole
  external price source, with the self-sovereign and static-floor fallbacks behind it as
  before.

## Under the hood

- Every change ships with regression tests, and the fee and first-order amounts now come
  from a single hardcoded source of truth shared by the app and the indexer, so the
  displayed cost can't drift between them. A fresh five-persona walkthrough and a focused
  deep-dive review confirmed the changes end to end, across all supported languages.
