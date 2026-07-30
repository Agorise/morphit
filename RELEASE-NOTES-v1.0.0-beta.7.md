# Morphit v1.0.0-beta.7

A front-end and operator-tooling release on top of beta.6, capped by
a full pre-release security and quality audit. The orderbook is much
easier to filter — search coins, currencies, and payment methods as
you type, and narrow to barter (products & services) listings. Operators
get a new control to enable or disable individual payment methods, a
single-host deploy recipe that is now correct out of the box, and a
moderation fix so a seller you've blocked can no longer sway the price
your instance computes. This release is recommended for all operators.

## Added

- **A much richer orderbook filter row.** The asset picker now shows
  each coin's icon and lets you pick "Barter (products & services)";
  the currency filter is a type-ahead that accepts one or more
  currencies by name or ISO code (and the indexer matches any of
  them); and the payment-method filter is a type-ahead too. All three
  behave like the FAQ search — type, pick, and your choices become
  removable chips. The currency list loads only when you tap the
  field, so it costs nothing for visitors who never use it.

- **Operators can enable or disable specific payment methods.** A new
  `MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS` setting (mirroring the
  existing disabled-assets control) lets you turn individual payment
  methods — including Barter — on or off for your instance. The setup
  wizard has a step for it, your `/about-this-instance` page shows
  your policy, and the admin setup-wizard page gives you a checklist
  with a copy-paste env line. An order is only rejected if *every* one
  of its payment methods is disabled; mixed orders are kept. Default:
  every method enabled. See the "Payment-method configuration" section
  of `OPERATIONS.md` and the "Payment methods" section of
  `RUN-A-MORPHIT-NODE.md`.

## Changed

- **Clearer, friendlier orderbook filter wording** in all ten
  languages (for example "I want to see" / "Everything", "Highest
  rated users first", "Most experienced users first"), plus an
  animated example placeholder in the region field that cycles through
  real place names.

- **Buttons use the brand teal with legible white text.** The primary
  button face was retuned to a deeper teal so white labels meet the
  WCAG AA contrast bar, while the vivid teal stays in the animated
  border and accents.

- **A wider, dismissable FAQ search.** The search field is full-width
  on phones and centered on larger screens, dims the page behind it
  while open, and clears when you press Escape or tap outside.

- **A simpler, more honest Get-Morphit page.** A no-KYC *directory*
  that isn't a code mirror was removed from the mirrors list, and the
  "update available" prompt now says, plainly, that reloading the page
  applies the update.

- **A bigger homepage wordmark, with all three logo dots visible** and
  orbiting as intended.

- **Single-host nginx configs reconciled.** `ops/nginx/web.conf` is now
  the colocated single-server config — it serves the site and proxies
  `/v1/`, `/rss/`, and `/relay/` to the local indexer and relay — and
  the split-subdomain configs are clearly labeled optional/advanced. An
  operator who copies the shipped nginx files now gets a working
  single-host deploy. See `RUN-A-MORPHIT-NODE.md` §8 (Configure nginx).

## Fixed

- **Instance-local moderation now also covers your price feed.** When
  you block an account, its listings were already hidden from your
  orderbook; now its orders are also dropped from the median behind
  your instance's own derived `morphit_native` / depeg price, so a
  blocked seller can no longer skew the price your instance computes
  from its orderbook. Blocking remains instance-local, reversible, and
  off-chain. See `OPERATIONS.md` §6a and `RUN-A-MORPHIT-NODE.md` §9.1.2.

- **The mobile language picker is no longer clipped,** and the
  duplicate "Login / Register" link that showed on small screens has
  been removed (the avatar menu is the single sign-in entry point).

- **The security page no longer says "(in Phase 5)."**

## Upgrading

Use `morphit-ops upgrade` (or the **Upgrade** menu item). Your
configuration, signing key, and per-network keys are carried forward
automatically, and the services restart on the new code. There are no
database migrations and no required configuration changes. If you want
to disable any payment methods, set the optional
`MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS` (it defaults to all methods
enabled). Most of this release is front-end, operator tooling, and
documentation, but upgrading via a release is still the cleanest path.
