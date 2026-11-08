# Morphit v1.23.4

The chat keeps up with your wallet, and a few rough edges from a live trade are smoothed out.

## For people using the site

**"Share a receiving address" points at the address field.** The border of the address field
glows three times, the same pulse as your instance's card on the Instances page when you
arrive from the footer's Contact link. Your eye goes straight to where you paste your address.
It stops as soon as you type, paste or click there, and it never glows around an address shown
in red as wrong.

It glows when the field is on screen. For most coins that's as the window opens. For USDT,
USDC and DAI, the warning and the network choice come first, above the field, on purpose: you
read the one and pick the other before you paste an address. On a small screen the field is
further down there, and it glows once you scroll to it. Pick another coin before typing, and it
glows again for that one.

If your device asks for reduced motion, it doesn't glow.

**"Share your … address" goes away once you've shared it.** The button disappears the moment your
address is in the chat, instead of waiting for the payment. A small "Share a different address"
stays in its place, for another of the coins you accept or to fix a typo.

**Confirmations keep up with your wallet.** While a payment is confirming, the chat checks it
every 15 seconds instead of once a minute, and your instance brings the new count back on the same
check, as soon as the explorers it asks have seen the block. (A payment still unconfirmed after
half an hour goes back to once a minute until its first confirmation.)

**"Verify on block explorer" opens in a new tab, and finds a fresh payment.** Right after a
BLURT payment, some Blurt nodes don't know the transaction yet; the explorer now looks for it in
the block the receipt names, so it's found at once.

**The avatar badge clears.** Clicking Orders or Feedback under Notifications clears that count.
Opening the page a notification points to (the chat about an order, or My orders) clears it too,
and while My orders is open its order and feedback counts stay cleared. A tab in the background
still counts.

**A new order slides into the orderbook.** When an order is posted while you're looking at the
orderbook, its card slides down into place over a second, and the cards below glide down to make
room. It used to blink twice and pop in. With reduced motion, it simply appears.

**Type /about to get to "About this instance".** `/about` (and `/en/about`, `/es/about` and so
on) now opens the About this instance page in your language, instead of "page not found".

## For operators

Upgrade as usual. Nothing to configure.

- `GET /v1/chain/tx/:id?block=N` (optional): when a node's transaction index does not hold the
  transaction (not yet, or never), it is read from block N: one `get_block` more, only then. An
  unreadable block answers 502 ("could not check"), never 404.
- `GET /v1/payment-check`: a confirming answer is reused 15 s (was 30), and a request holding a
  stale answer waits up to 3 s for the re-check. Explorers are asked about a confirming payment at
  most every 15 s per instance.
- The TLS certificate alert no longer goes off at 30 days left. certbot renews a 90-day
  certificate by itself once fewer than 30 days are left (its timer tries twice a day), so that
  warning came the day before certbot was due, on every certificate, every time; and its "last
  successful renewal 999 days ago" was wrong too (certbot starts its log afresh on every run). It
  now warns only when a renewal is a week overdue (23 days left on a 90-day certificate), with the
  certificate's real age, and is critical at 7 days left — and, whatever the settings, with a day
  left and once expired. `MORPHIT_CERTBOT_RENEWAL_GRACE_DAYS` (7) sets that week; a
  `MORPHIT_CERTBOT_EXPIRY_WARN_DAYS` at or above that point is ignored. To see for yourself that a
  box renews: `sudo certbot renew --dry-run`.

## For developers

- `AddressShareModal`: the address input (`data-testid="address-share-address"`) gets
  `flash-address`, the Instances page's `flash-instance-border` pulse copied into the
  component (2 s, `ease-in-out`, 3 times, brand emerald), for `ADDRESS_FLASH_MS` = 6,200 ms.
  It starts once 90 % of the field is on screen (`IntersectionObserver`, thresholds 0 and 0.9;
  where there is none, at once). A change of coin arms it again until something has been
  typed; `input` ends it for good, `focus` ends it (review: the pulse hid the focus ring),
  and it is not shown while the address is invalid. The Instances page's own flash is
  unchanged.
- `$i18n/pageAliases.ts` (new): `PAGE_ALIASES` (`about` → `about-this-instance`) and
  `resolvePageAlias`. `routes/[lang]/+layout.ts` resolves it in its locale redirect, so
  `/about` is one hop to `/<locale>/about-this-instance` (query and fragment kept).
  `routes/[lang]/about/+page.ts` (new) forwards `/<lang>/about` with a 301, prerendered for
  every locale as SvelteKit's forwarding page (script and meta refresh, so it works without
  JavaScript too). That page's target is fixed: `/<lang>/about?x#y` loaded straight from the
  server lands without the `?x#y` (review: accepted; inside the app, and for bare `/about`, they
  are kept).
- Share buttons: `twoLegButtons` hides `sharePaymentAddress` once his address for a payment coin
  is in the thread (back for `no_address`) and `shareAssetAddress` once his asset address is;
  the one-coin button uses `iSharedAddress` over the thread (pending counts, failed does not).
  Review: a small "Share a different address" (`shareAgain`, `showShareAddressAgain`,
  `chat.address.share_another` in 10 locales) keeps another coin or a corrected address possible.
  "Record shipment" now derives from `iReceiveCryptoUnpaid`, not the share button.
- Confirmations: `PAYMENT_CHECK_CONFIRMING_INTERVAL_MS` (15 s) in the browser while seen and
  under the required depth — for `PAYMENT_CHECK_CONFIRMING_FAST_FOR_MS` (30 min) at 0
  confirmations, then from the first confirmation on (review: a low-fee payment can sit for
  hours); indexer `PAYMENT_CHECK_FRESH_MS.confirming` 15 s, `PAYMENT_CHECK_STALE_WAIT_MS` 3 s.
  The depth is still the lowest of the agreeing explorers, so one explorer that has not seen the
  block yet still holds it at 0 — deliberately: one explorer must not be able to confirm alone.
- Explorer: `txFromBlock` in `api/chainExplorer.ts`; `$lib/explorer/blockNumber.ts`;
  `morphitExplorerTxUrl(txid, block?)`, `fetchChainTx(…, block?)`; the tx page reads `?block=`;
  the receipt's link has `target="_blank"` and the receipt's block.
- Orderbook: `$lib/orderbook/slideIn.ts` (new) — `measureTops` before a live order is inserted,
  `playSlideIn` after it renders: Web Animations, `NEW_ORDER_SLIDE_MS` = 1,000 ms, the new card
  from opacity 0 and 24 px above, every card it pushed from its old position (FLIP). The blink
  was two entrances: `order-slide-in` (0.32 s) overrode each card's `animate-fade-up`, and
  removing the class restarted the fade-up. That class, its CSS and `justArrived` are gone;
  `OrderCard` takes `orderKey` (`data-order-key`). Review: a second order while the first still
  slid made the cards it pushed jump (the new glide replaced the running one); the pushes now
  use `composite: 'add'`, so they add up. Tests: `slideIn.test.ts` (5), 7 mutations.
  Replayed in a browser against the production build with a stream pushing a new order: before,
  the new card's opacity went 0 → 0.97 → 0.18 → 1 and the next card jumped 205 px at once; after,
  one entrance over ~1.07 s and the next card gliding the 205 px; reduced motion on a phone: in
  place at once, no errors.
- Certificate monitor (`ops/scripts/morphit-certbot-monitor.sh`): the age and expiry come from
  the certificate (notBefore, notAfter; the lifetime rounded to whole days, as Let's Encrypt's
  is 90 days less a second), not `letsencrypt.log` (certbot's `log.py` rolls it over on every
  run). The renewal point is the renewal file's `renew_before_expiry` (`N`, or days, weeks or
  months; quoted or not; above the first section, as certbot reads it), else the earlier of
  certbot 2.x's 30 days and certbot 4+'s third of the lifetime (half under 10 days).
  `cert_expiry_warn` fires at the renewal point minus the grace (at most half the window, at
  least a day); the critical events at the critical days, capped at the warning point, and
  always with a day left (certificates of 3 weeks or more) and once expired. Thresholds are
  plain whole numbers: leading zeros are dropped (dash reads `08` as bad octal, which stopped the
  check or broke the alert's JSON), anything else falls back to its default. Payload:
  `issued_days_ago`, `renew_due_days_left` and `overdue_days` replace
  `last_renewal_success_age_days`; the bot's text follows (and names `certbot.service`, not the
  snap's unit). Tests: `certbot-monitor-renewal-due-smoke` (49) runs the real script under dash
  on certificates issued with exact dates (`openssl ca -selfsign`), through a certificate's life
  and with each setting, and renders each alert through the classifier; the v1.23.3 script fails
  17 checks before its invalid JSON stops the run; 26 mutations, all caught. Checked against the
  certbot 2.9.0 (Ubuntu 24.04) and 5.9.0 sources. An independent review found 2 medium (a
  leading zero stopped the check or broke the JSON; no grace on the critical events and no floor
  at expiry) and 3 low (certbot 2.9's fixed 30 days and the 90-days-less-a-second lifetime; the
  forms of `renew_before_expiry`; test gaps), all fixed as above.
- Notifications: `keepReadWhileShown(['order', 'feedback'])` on My orders (visible only);
  `AvatarMenu.openCategory(path, category)` marks the category read; review: each counted order
  or feedback notification remembers its link, and `markSeenAt` (the `[lang]` layout, on each
  page and when the tab comes back into view) reads those pointing to the page shown
  (`pageKey`: no query, fragment or locale).
- Tests: `AddressShareModal.flash.test.ts` (13) and `pageAliases.test.ts` (4), each rule
  removed once to see a test fail (24 mutations); for the rest, `cryptoLegs.test.ts`,
  `ConversationView.auditFlows.test.ts` (3 new), `paymentChecks.test.ts`,
  `paymentCheck.test.ts`, `chainTxLookup.test.ts` (7 new), `chainExplorer.test.ts`,
  `blockNumber.test.ts`, `chatMessageVerify.test.ts`, `keepReadWhileShown.test.ts`,
  `AvatarMenu.notifications.test.ts` — each rule removed once to see a test fail. Checked in a
  browser:
  - the flash, phone and desktop, light and dark: on screen as the modal opens for every coin
    but USDT, USDC and DAI, three pulses gone by 6.3 s, a paste ends it, reduced motion shows
    none, the stablecoins glow once scrolled to;
  - `/about`, against the production build served the way nginx serves it, with its CSP: bare
    (an English and a Spanish browser), with a query and fragment, with a trailing slash,
    `/en/`, `/es/` and `/zh-CN/about`, and `/en/about` with JavaScript off. `/faq` and an
    unknown `/aboutx` are unchanged.
- Independent reviews before release. The address-field flash: 2 medium (a coin changed inside
  the modal never got its flash; the observer's threshold was untested) and 4 low, all fixed as
  above. The live-trade fixes: 1 medium (no way to share a second or corrected address) and
  low ones (404 for an unreadable block; quick polling of a stuck payment; an order
  notification's chat not clearing it), fixed as above. The whole release, the orderbook slide-in
  above all: no high or medium; 3 low (the slide-in's second order; a smoke check that no longer
  pinned the explorer link's return; `/<lang>/about` loaded straight from the server dropping its
  query), the first two fixed, the third written down.
- Not in this release: counting every repeat trade between the same two people toward their
  ratings (owner's request after the live trade). Three independent reviews found ways to fake a
  repeat trade with each rule tried, and two of the anti-ring signals (B, D) would undo honest
  repeat trades anyway. The owner chose to ship these fixes first; the rule comes in its own
  release, designed with the cited order's owner recorded on each review, a few days' spacing,
  the signals aware of proven trades, and repeat trades weighted less than new partners. Ratings
  are unchanged in v1.23.4: only a reviewer's latest review of a trader counts.
