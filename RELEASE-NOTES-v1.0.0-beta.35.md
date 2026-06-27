# Morphit v1.0.0-beta.35

This release fixes a couple of order-page papercuts — including one that could leave
the new-order form looking broken for first-time traders — shows your balance in your
local currency out of the box, and tidies up sign-out and a few small touches.

Nothing here changes how trading works or what anything costs, and Morphit still keeps
no data about you. If you're already signed in, your account, keys, and balances carry
over untouched.

## Placing an order

- **Fixed: the new-order page no longer goes blank below the first card.** If you had
  a saved draft from an earlier visit, the form could stop showing everything below the
  asset card — leaving a first-time trader stuck with just the opening card and nothing
  to fill in. The form now safely ignores any draft it can't read, so the rest of the
  page always appears. (If you ever want to start over, the "Discard draft" button
  clears a saved draft.)

- **The first-order tips come back when you need them.** The little "Your first order?
  Some safer defaults" card now reappears on a later visit if you still haven't placed
  your first order. Closing it is a "not right now," not a permanent dismissal.

- **A small polish on the walkthrough link.** "Read the full first-trade walkthrough"
  now highlights the whole line — text and arrow together — when you hover it.

## Seeing your balance in your local currency

- **Your balance now shows its value in your currency by default.** The amount of BLURT
  in your wallet is shown with an approximate value next to it (for example, in US
  dollars or whichever currency the instance you're using is set to). This was available
  before but had to be switched on; now it's on out of the box. As always, it's a
  display courtesy — your fees are settled in BLURT — and if the price can't be fetched,
  the figure is simply omitted.

## Signing in and out

- **Fixed: the sign-in button label after you sign out.** After signing out, the menu
  button now correctly reads "Sign in" again straight away, instead of briefly still
  saying "Unlock."

- **Clearer wording on the BLURT explainer** when you're choosing what to trade.

## For operators

- **The BLURT/USD price feed is now on by default.** A fresh instance shows local-
  currency values next to BLURT amounts without any extra configuration. The source is
  the usual external chain (Klingex, then CoinGecko) with a static-floor fallback — a
  server-side call from your box, never anything user-facing. If you want a fully self-
  contained instance that makes no external price calls, set
  `MORPHIT_INDEXER_PRICE_FEED_ENABLED=false` and the UI shows BLURT only.

- **`morphit-ops health` now reports the price feed.** The Node-health view (main menu
  item 13) shows whether the feed is on and serving a live price (with the price and
  which upstream is serving), on but stale (falling back to the static floor), or off —
  so you can tell at a glance whether local-currency values will appear, and diagnose a
  blocked upstream. It's also in the `--json` output.

## Fixes recap

- New-order form no longer disappears below the first card when a saved draft is present.
- First-order tips card reappears until your first order is placed.
- Sign-in button label corrects immediately after sign-out.
- As with recent betas, **this release changes no third-party dependencies.**

## Under the hood

- The order-form fix ships with a regression test that locks the draft-restore safety
  (any unreadable saved field is coerced rather than crashing the form), the first-order
  tips behaviour, and the walkthrough-link hover. The new node-health price line is
  covered by tests on both the indexer endpoint and the `morphit-ops` view. A fresh
  five-persona walkthrough and a focused deep-deep review confirmed the changes end to
  end, across all supported languages.
