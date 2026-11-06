# Morphit v1.23.2

v1.23.1 was never released: everything in its notes ships here (the Blurt Nodes table's
heading row that stays in view, and witnesses' pictures from the Blurt image proxy), together
with a round of trade-chat fixes asked for after a real trade.

## For people using the site

### In a trade chat

**Amounts are filled in, with what they are worth.** "Send BLURT" opens with the amount
already there and its value beside it — `2752.096 BLURT (≈11 BRL)` — and the value follows
what you type. Before, after a chat had been open a while the window could open with 0.000:
the price it used had gone stale. It now fetches a fresh price as the window opens (for
market-price orders; it never waits more than a moment on a slow connection — the button
shows it is busy meanwhile — and a value it cannot work out stays blank rather than guessed).
When the other side has shared the Blurt account they want to be paid on, with an amount,
"Send BLURT" pays exactly that: their account, their amount and their memo, which is what
both screens check the payment against.

**Sharing an address is quicker.** In "Share address":

- the separate "For order: order-…" box is gone; that text is now the note's default, which
  you can change. The note travels with the address in the chat, encrypted on the chain like
  every chat message, so both of you can read it later.
- "Amount you ask to be paid" is filled in for the coin you pick — 11 BRL of BTC is
  `0.0000266 BTC (≈11 BRL)` — so "Share address" is ready as soon as the address is in. Pick
  another coin and its own amount appears; type your own and it is never overwritten. Only
  numbers can be typed in the field; picking another coin after typing fills in that coin's
  amount (a figure typed for BTC is no amount of XMR).
- This works for every coin with a live price: BLURT, BTC and XMR as before, and now also ETH,
  LTC, BCH, DASH, DOGE, ZEC, ARRR, DCR, SOL, XRP, USDT, USDC and DAI (see "Prices for the other
  coins" below). For eCash the amount stays for you to type.

**Real confirmation counts.** A payment check now says how many confirmations the payment
has — "0.0000266 BTC received · 7 confirmations" — instead of jumping from "0/3" straight to
"confirmed". When your instance could not reach a block explorer for a couple of minutes, the
line says when it last checked ("last checked 4 minutes ago"), so an old answer is not
mistaken for a fresh one. That age is measured by your instance, so a computer whose clock
is off does not make a fresh answer look old.

**"Sent as expected" for BLURT in seconds.** A BLURT payment's receipt now carries the block
the transfer went into, so both screens check it straight away instead of waiting for the
block to become irreversible. In a coin-for-coin trade, the other coin is still only asked
for once that block is irreversible (under a minute): until then a chain fork could, rarely,
drop the transfer. A receipt from an older instance (without the block) is checked the old
way; older instances read the new receipts and ignore the block.

**Less noise.** The "Waiting for @… to pay you in XMR, BTC, BLURT, … Send nothing until the
payment shows up here." line is gone from the chat.

**Chat Security means something simpler.** It now asks: "This chat is encrypted on-chain so
it's never lost, but if you share this computer with someone, they might be able to see this
unencrypted copy. Do you want this chat deleted from this computer after you leave the chat?"
— **Yes, delete it** / **No, keep it**.

- Morphit never saves chat text on your computer; it is decrypted into the open tab's memory
  only. With **Yes**, leaving that chat (another page, another chat, closing or reloading the
  tab) locks Morphit on this computer, in every tab, and wipes the decrypted chat from memory:
  nobody can reopen any chat there without your password.
- An unsent message you were typing in that chat is not kept as a draft either.
- It is set per chat, on this computer only.
- Your own messages are now always readable to you later, on any device: each one carries an
  encrypted copy for you. The old setting that left out that copy (so you could not reread
  your own side after leaving) is gone; if you had chosen it, your chats lock when you leave
  them instead, until you answer No in a chat.

### Elsewhere

**Re-list.** In My orders, the re-list hint now reads "Pre-fills the form for you with
original values that you can edit."

**Stars reward merit, not age or votes.** On the Blurt Nodes page:

- **Two years of producing blocks now earns full marks for time** (it took five), and a clean
  record shows early: a witness with no misses can reach 3⅓ stars after a year and 4 after
  eighteen months. Past two years, a witness is judged only on how well it does the job. A
  witness two years in that rarely misses had 1⅔ stars, below founders missing thousands of
  blocks; it now has 4, above them.
- **Missing blocks costs more:** an average of 25 missed a week halves the stars (it took 50).
- **A witness who starts missing loses stars the same day.** Blocks missed in the last day
  count extra: one costs about a third of a star, 5 a star, 20 halve the stars. Once the
  witness stops missing, they come back within a day. The red "missed" pill still shows the
  count.

**The Blurt Nodes page (/witnesses).** On a computer or a large tablet, the table's heading
row stays pinned just under the main menu as you scroll, so you can still see which column is
which; scroll back up and it settles back into the table. Every heading still sorts the table.
Witnesses whose pictures were on image hosts that no longer exist get their picture from the
Blurt image proxy (`imgp.blurt.blog`), still fetched by the instance, never by your browser.

**Stablecoin prices on order cards.** Orders in USDT, USDC or DAI now show the coin's live
price ("1 USDT = $1.00 live") under the amount: the line existed but had no price to show.

## For operators

Upgrade as usual. Nothing to configure.

- **Prices for the other coins** (OPERATIONS.md §56). Your indexer now keeps a USD price for
  ETH, LTC, BCH, DASH, DOGE, ZEC, ARRR, DCR, SOL, XRP, USDT, USDC and DAI — display only, never
  used for a fee or a check. Over Tor nothing new is asked: the Bisq and Haveno price nodes
  already quote these coins in the answer your instance fetches for BTC and XMR. Where your
  instance may use clearnet, it also sends one CoinGecko and one CryptoCompare request per
  price refresh, each for all thirteen coins together; a hidden-only instance sends neither.
  `MORPHIT_INDEXER_PRICE_FEED_ENABLED=false` turns it off with the rest of the price feed. See
  them on the server: `curl -s http://127.0.0.1:8080/v1/listing-fee | jq .asset_prices_usd`.
- **Your own row in the instance directory** (`/v1/instances`) now carries your own indexed
  block and chain lag. It never did: your own origin is never probed, so the row kept whatever
  an old probe had left (morphit.io listed itself about 1.6 million blocks behind). Peers'
  rows were always right.
- From the first day of v1.23.0 (OPERATIONS.md §55):
  - **The "missed in the last day" flag starts after an hour.** The chain only gives each
    witness's lifetime total of missed blocks, so an instance writes the totals down every 10
    minutes and compares. A newly installed or newly upgraded-to-v1.23 instance shows no flags
    for its first hour, then counts the misses since it started watching, and covers a full
    day after 24 hours. Upgrades and restarts keep the samples; only restoring an indexer
    snapshot empties them, and the hour starts again. To see it working, on the server:

    ```sh
    sudo -u postgres psql -d morphit_indexer -c "SELECT COUNT(*) AS samples, COUNT(DISTINCT owner) AS witnesses, MIN(sampled_at) AS first, MAX(sampled_at) AS last FROM witness_missed_samples"
    ```

  - **`[witnesses] avatar_unavailable … has no DNS records` in the indexer log**: the
    witness's picture was on a host name that no longer exists in DNS. On 2026-11-05 the
    `blurt.world` domain moved to parking nameservers, taking `img.blurt.world` with it, and
    `images.blurt.buzz` does not exist; most witnesses' pictures were on one of the two. The
    indexer now asks the Blurt image proxy,
    `https://imgp.blurt.blog/profileimage/<witness>/64x64`, and logs `avatar_via_proxy`;
    `avatar_unavailable` now means both failed (its reason names both). The proxy sees your
    server's address and the witness's name; a zero-clearnet instance still fetches no
    pictures at all.

## For developers

### Trade chat

- `chat/cryptoLegs.ts`: the `waiting_payment` hint is gone (`paymentState === 'unpaid'` →
  no hint); `chat.legs.waiting_payment` removed from the 10 locales.
- Chat Security (`stores/chatSecurity.ts`): `readChatSecurityMode` always answers `'keep'`
  (the self-copy is always attached); `writeChatSecurityMode` is gone. New
  `readLockOnLeave(account, peer, order)` / `writeLockOnLeave(…)`, key
  `morphit.chatSecurity.lockOnLeave.<account>\0<peer>\0<order>`; unset falls back to the
  legacy `morphit.chatSecurity.mode.<account> === 'destroy'`. `stores/identity.ts`:
  `holdLockOnLeave()` — while held, `handlePageHide` drops the reload stash, tells the other
  tabs to lock and resets, instead of stashing. `ConversationView.svelte` holds it while the
  chat's setting is on and calls `lockAllTabs()` when the view leaves that chat. The PDF
  reminder modal and the `current_keep` / `current_destroy` / `pdf_reminder.*` strings are
  gone.
- BLURT receipts: `FundsSentPayload.block?` (BLURT only; a safe integer in (0, 2³¹); the
  encoder throws and the decoder returns null otherwise). It is carried through
  `chatService` → `listenerDispatch` → `tradeVerify` → `blurtLegCheck` →
  `blurtVerify.verifyBlurtTransfer`, which, given a block, asks `get_block` through the
  indexer relay and checks the transaction found by its txid in that block; a block not
  there yet is an `rpc_error` (retried, not cached); a txid not in the block falls back to
  `get_transaction`. The verify cache key includes the block. Checked against the v1.23.0
  decoder: it decodes the new receipt and ignores `block`.
- Review fixes (each test seen failing first):
  - A transfer found in a block above `last_irreversible_block_num`
    (`get_dynamic_global_properties`, also through the relay) is
    `{kind: 'verified', provisional: true}`: shown, never cached; `blurtLegCheck` keeps it
    "checking" and looks again until it is final, so a coin-for-coin trade's other coin waits
    for it. The receipt's label records it at once (phases are first-wins, so a later fork
    would not undo it there; the gate that releases a coin is what waits).
  - A block the node does not have (or a bogus number) falls back to `get_transaction`
    instead of answering "try again" forever.
  - The toolbar "Send BLURT" pays the peer's newest BLURT ask in the thread (account, amount,
    memo; the amount then fixed) when there is one — read from the messages, since the
    two-leg `moneyFacts` is empty for a one-leg trade. Before, with the share window now
    filling in (and jittering) the ask, the order-price pre-fill paid a different amount and
    both screens showed an amount mismatch. A two-leg BLURT leg keeps its old rule (no
    pre-fill, no fiat value: the order's price is for the other coin).
  - "Send …" shows `aria-busy`/disabled while it waits for the price, and does not replace a
    pay window opened meanwhile.
  - `ChatComposer` takes `persistDraft` (false while the chat locks on leaving): no draft
    written, an existing one wiped at once.
  - `/v1/payment-check` answers carry `age_seconds` (the instance's clock);
    `paymentChecks.checkOnce` derives the age from it and no longer compares the device clock
    with `checked_at`. No age is shown once confirmed (the instance keeps a confirmed answer
    for 10 minutes on purpose).
  - The address card hides its "For order" line only when the note is exactly the reader's
    "For order: <permlink>", not whenever the note mentions the permlink.
  - Picking another coin in the share window after typing an amount refills it.
- Pay prefill: `startPayNow` awaits `refreshPayPrefill()` (market-price orders only: a fresh
  `getPrice` and the FX table, raced against `PAY_PREFILL_WAIT_MS` = 2500). The bug it fixes
  was reproduced in `ConversationView.auditFlows.test.ts` (a quote older than
  `MAX_QUOTE_AGE_MS` → 0.000) and the test was seen to fail without the fix.
- `PayBlurtModal.svelte` takes `fiatPerUnit` and shows `(≈<fiat>)` (`formatFiatCode` in
  `i18n/formatters.ts`: locale digits, 0–2 decimals, then the code).
- `AddressShareModal.svelte` takes `orderValue` and `coinValue(coin)`; new PURE
  `orders/coinValue.ts` (`fiatPerCoin`, `coinAmountForFiat`), amounts capped at 8 decimals.
  `ChatMessage.svelte` hides the address card's "For order" line when the note already names
  the order.
- Payment checks: `paymentChecks.ts` keeps `checkedAtMs`; `confirmationLine(c, now)` gives
  `{confirmed, n, required, staleMinutes}` (stale after
  `PAYMENT_CHECK_STALE_AFTER_MS` = 2 minutes). `chat.payment_check.confirmed` is an ICU plural
  on `n`; new `chat.payment_check.checked_ago`.
- `my_orders.order.action_relist_hint` updated in the 10 locales (pl had been out of date).
- The native-translations snapshot was rebuilt for the removed keys.

### Prices for the other coins

- `indexer/price/pricenodes.ts`: `PRICENODE_COINS` (the 13 coins); `parseAllMarketPrices`
  also returns `coinsUsd` — Bisq `currencyCode` entries are BTC per coin, Haveno
  `<COIN>/XMR` pairs XMR per coin, each times that node's own BTC/USD or XMR/USD;
  `PricenodeConsensus.coinUsd(code)` is their consensus (same rule as BTC/XMR).
- New `indexer/price/coinQuotes.ts`: `CoinQuoteSource` combines the pricenode consensus with
  one CoinGecko `/simple/price?ids=…&vs_currencies=usd` and one CryptoCompare
  `/data/pricemulti?fsyms=…&tsyms=USD` request per refresh (only while
  `sourceClearnetAllowed`), with `aggregateRobust`; plausibility bounds (stablecoins
  0.5–1.5 USD); a provider's answer is served for two refreshes plus a margin, then dropped.
  ECX is excluded (ticker collision). Started and stopped in `main.ts`.
- `/v1/listing-fee` gains `asset_prices_usd` (always USD; absent when empty;
  `ListingFeeResponse` in `@morphit/indexer-client`). `lib/prices/providers/indexer.ts`
  reads it for those 13 coins only, whatever the denomination.
- Tests: `onionPricenodes.test.ts` (2 new), `coinQuotes.test.ts` (9),
  `listingFeeCoinPrices.test.ts` (3), `prices.test.ts` (1 new); each seen failing first, and
  each guard in `coinQuotes.ts` removed once to see a test fail.

### Witness stars

- `witnessRanking.ts`: `score = 5 × time × reliability × lately × version`.
  - `time = √(min(weeks ÷ FULL_TIME_WEEKS, 1))`, `FULL_TIME_WEEKS` = 104 (was linear over 260).
  - `MISSES_PER_WEEK_HALVING` = 25 (was 50).
  - New `lately = 1 ÷ (1 + missed_recent ÷ RECENT_MISSES_HALVING)`, `RECENT_MISSES_HALVING` =
    20 (1 while `missed_recent` is null, i.e. under an hour of samples). `witnessScore` takes
    `recentMissed`; `rankWitnesses` passes the 24 h count it already computed.
- Chosen against all 31 producing witnesses on the live list (2026-11-06): the two cleanest
  (about 1.5 missed a week, vote ranks 24 and 48) stay on top at 4⅔; witnesses missing
  thousands drop to about 2; a half-year-old witness with a clean record gets 2⅓.
- Tests in `witnessRanking.test.ts` (3 new, seen failing first; the expected order updated):
  on the 2026-11-05 chain fixture, agorise-witness (108 weeks, 3.9 missed a week) goes from
  1⅔ to 4 and passes saboin and khrom; joviansummer 4⅔ → 4⅓ with one miss that day, 3⅔ with
  5, 2⅓ with 20.

### Instance directory

- `federationProbe.ts` `persistSelfReachable` writes `cached_indexed_block` and
  `cached_chain_lag_sec` (lag blocks × 3) from the new `localIndexedBlock` (poller); `COALESCE`
  keeps the stored values when unknown. Test in `federationProbeSelfBranding.test.ts`.

### The Blurt Nodes page

- `routes/[lang]/witnesses/+page.svelte`: each header cell is `position: sticky` (`.wit-th`;
  cells rather than the `<thead>`, which not every browser sticks), at `--wit-sticky-top` =
  the main menu's measured height (a `ResizeObserver` on the layout's
  `<header data-site-header>` and on the row). The cells get the header row's colours made
  opaque from the theme tokens, so rows pass under them and branded instances keep their
  colours; the row's bottom line moved from the `<thead>` border onto the cells.
- The table's card is `overflow-clip` instead of `overflow-hidden` (`hidden` makes the card a
  scroll box of its own, so the row would stick inside the card, that is, never).
- Review fixes, each checked in a browser and seen to fail without the fix: keyboard focus
  never lands under the stuck row (`lib/utils/stickyTableHead.ts`, PURE, with tests; the
  page's `scroll-padding-top` is the menu + the row + 8 px while the table shows); the
  notification banner publishes its bottom edge (`lib/stores/stickyBanner.ts`) and the row
  sticks below it; the menu is measured to the fraction of a pixel; forced colours get an
  outline; without `overflow: clip` (Safari before 16) the corner cells round themselves.
- Picture fallback (`indexer/witnessService.ts`): when the own picture URL fails, `getAvatar`
  asks `avatarProxyUrl(owner)` = `https://imgp.blurt.blog/profileimage/<owner>/64x64`, whose
  answer must pass the same checks (PNG/JPEG/GIF/WebP, at most 1 MiB and 4096 px a side).
  Only for a witness with a picture URL; never twice when the picture is on the proxy
  already; a failure of both is remembered for the hour.
- `fetchPublicBytes` (`indexer/federationProbe.ts`) takes `sameOriginRedirects` (default 0:
  a redirect is a failure). Above 0 it follows a 3xx ONLY to the same https origin, each hop
  through every check again (fresh lookup, public-address check, pinning); the proxy fallback
  allows 3 (`AVATAR_PROXY_REDIRECTS`), no caller more than 5
  (`FETCH_PUBLIC_MAX_REDIRECTS`), one timeout for the whole chain, each hop closing its
  connection before the next. Tests: `fetchPublicBytesRedirect.test.ts` (7) and 5 in
  `witnessService.test.ts`, each guard removed once to see its test fail.
